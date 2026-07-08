// The durable chat runner. A run is a server-side job: startRun() creates a
// runs row plus a status=streaming assistant message, then drives the provider
// completion DETACHED from any request. Browsers are spectators — token
// deltas persist to the message row on a debounce, ordered events persist to
// run_events for replay, and zero SSE subscribers changes nothing.
//
// Stopping points: completion finished with no tool calls (message complete,
// run done), a tool call requires approval (run parks in waiting_approval), the
// tool-turn budget is exhausted (run error with a budget marker), provider
// terminal error (partial kept, message interrupted, run error), provider stall
// — no bytes for the watchdog window (treated as a terminal provider error), or
// cancel (partial kept, run cancelled).
//
// M6 tool loop: an assistant turn that ends with tool_calls seals that message
// (complete, tool_calls kept) and then either executes the tools immediately
// (every owning server is auto_approve) or parks the run in waiting_approval
// for a human approve/deny decision from the conversation page. Executing a
// tool inserts a role='tool' message keyed by tool_call_id, appends it to the
// running context, opens the next streaming assistant message, and loops.

import { eta } from '../middleware/render'
import { toRenderable } from '../utils/message-view'
import {
  getConversationById,
  setConversationCurrNode,
} from '../db/queries/conversations'
import { getProviderById } from '../db/queries/providers'
import {
  appendMessageDeltas,
  createMessage,
  finalizeMessage,
  getActivePath,
  getMessageById,
} from '../db/queries/messages'
import {
  createRun,
  getBlockingRunForConversation,
  getLatestRunForConversation,
  getRunningRunForConversation,
  incrementRunTurnCount,
  listRunningRuns,
  setRunLeafMessage,
  setRunStatus,
} from '../db/queries/runs'
import {
  deleteExpiredRunEvents,
  insertRunEvent,
  listRunEventsAfter,
} from '../db/queries/run-events'
import { listEnabledMcpServersForConversation } from '../db/queries/mcp-servers'
import { createArtifact } from '../db/queries/artifacts'
import {
  createToolApproval,
  decideRunApprovals,
  listApprovalsForRun,
} from '../db/queries/tool-approvals'
import { notifyLoopRunStatus } from './push'
import {
  callTool,
  gatherTools,
  type McpServerConfig,
  type OpenAiTool,
} from './mcp-client'
import {
  DEFAULT_STALL_TIMEOUT_MS,
  streamChat,
  type ChatMessage,
  type ChatRole,
  type ProviderConfig,
  type ReasoningEffort,
  type ToolCall,
} from './provider-client'

// D2 — token persistence cadence: flush pending deltas to the message row
// (and emit one `delta` event) every 300ms OR every 24 deltas, whichever
// comes first. 300ms keeps the crash-loss window to "a blink"; 24 tokens
// caps write amplification on very fast providers (~1 write per ~2 words at
// typical tokenizers). Measured against the mock provider this yields a
// handful of UPDATEs per second worst-case, which local Postgres shrugs at.
const FLUSH_MS = 300
const FLUSH_TOKENS = 24

// Default tool-turn budget: how many assistant turns may end with tool_calls
// (and drive another completion) before the run parks. A turn that ends WITHOUT
// tool calls is the normal end and never consumes budget.
const DEFAULT_MAX_TURNS = 10

// Synthetic tool-result content for a denied call (spec §A.5): fed back to the
// model as if it were the tool's output so the loop keeps moving.
const DENIAL_RESULT = 'Tool execution was denied by the user.'

const SUBMIT_ARTIFACT_TOOL: OpenAiTool = {
  type: 'function',
  function: {
    name: 'submit_artifact',
    description:
      'Save a user-facing result from this run. Use this when you have a finished briefing, report, or other deliverable. Markdown only; no HTML.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', description: 'Short kind label, e.g. briefing.' },
        title: { type: 'string' },
        summary: { type: 'string' },
        body: { type: 'string', description: 'Markdown body.' },
      },
      required: ['title', 'body'],
    },
  },
}

// Stall watchdog for provider streams: a run may never wait on a silent
// provider longer than this — the stream is torn down and the run parks as
// `error` with every persisted token kept, so a hung provider can never pin
// the conversation's active-run slot until a restart. Read lazily so the
// PROVIDER_STALL_TIMEOUT_MS env knob works without module-load ordering.
function defaultStallTimeoutMs() {
  const raw = process.env['PROVIDER_STALL_TIMEOUT_MS']
  if (raw) {
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) return value
  }
  return DEFAULT_STALL_TIMEOUT_MS
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'error'])

export type RunEventType = 'message-start' | 'delta' | 'message-final' | 'run-status'

export interface RunEventRecord {
  runId: string
  seq: number
  type: RunEventType
  payload: unknown
}

interface RunHandle {
  runId: string
  conversationId: string
  messageId: string
  abort: AbortController
  cancelled: boolean
}

// One active run per conversation, keyed by conversation id. The entry is
// reserved synchronously at the top of startRun, so boot/test recovery can
// tell "in flight in this process" apart from "orphaned by a dead process".
const activeRuns = new Map<string, RunHandle>()

// SSE fan-out, keyed by run id. Subscribers are notified after each event row
// is persisted, so replay-from-cursor plus live-tail can never observe a gap.
const subscribers = new Map<string, Set<(event: RunEventRecord) => void>>()

export function isTerminalRunStatus(status: string) {
  return TERMINAL_STATUSES.has(status)
}

export function getActiveRunHandle(conversationId: string) {
  const handle = activeRuns.get(conversationId)
  return handle ? { runId: handle.runId, messageId: handle.messageId } : null
}

export function subscribeToRun(
  runId: string,
  listener: (event: RunEventRecord) => void,
) {
  let set = subscribers.get(runId)
  if (!set) {
    set = new Set()
    subscribers.set(runId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) subscribers.delete(runId)
  }
}

// Persist an event (atomically bumping runs.seq) and fan it out. Persistence
// happens BEFORE fan-out: a subscriber that replays rows `seq <= n` and then
// receives live events `seq > n` sees every event exactly once, in order.
async function emitEvent(runId: string, type: RunEventType, payload: unknown) {
  const row = await insertRunEvent({ runId, type, payload })
  const event: RunEventRecord = {
    runId,
    seq: Number(row!.seq),
    type,
    payload,
  }
  const set = subscribers.get(runId)
  if (set) {
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch (error) {
        console.error('run event listener failed', error)
      }
    }
  }
  return event
}

export async function renderMessageHtml<
  T extends Parameters<typeof toRenderable>[0],
>(message: T | null | undefined) {
  return eta.renderAsync('conversations/message', { message: toRenderable(message ?? {}) })
}

// Rows from getActivePath come back all-nullable (recursive CTE).
type PathRow = {
  role: string | null
  content: string | null
  reasoning_content: string | null
  tool_calls: unknown
  tool_call_id: string | null
}

// Map the active path (root-first) to OpenAI chat messages: drop empty system
// messages (spec §1.2), forward reasoning_content on assistant turns, carry an
// assistant turn's tool_calls, and key tool messages by tool_call_id so the
// list stays OpenAI-well-formed for the next completion turn.
function toChatMessages(path: PathRow[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const row of path) {
    const role = (row.role ?? '') as ChatRole
    const content = row.content ?? ''
    if (role === 'system' && content.trim().length === 0) continue
    const message: ChatMessage = { role, content }
    if (role === 'assistant') {
      if (row.reasoning_content) message.reasoning_content = row.reasoning_content
      if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
        message.tool_calls = row.tool_calls
      }
    }
    if (role === 'tool' && row.tool_call_id) {
      message.tool_call_id = row.tool_call_id
    }
    messages.push(message)
  }
  return messages
}

// Normalized OpenAI tool call: guaranteed id/type/function.name/arguments so we
// can persist it, key approvals/tool messages by id, and re-send it verbatim.
interface NormalizedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

// Ensure every streamed tool call has an id (synth `tool_${i}`), a type, and a
// function name/arguments (spec §B.3 normalize step).
function normalizeToolCalls(calls: ToolCall[]): NormalizedToolCall[] {
  return calls.map((call, index) => ({
    id: call.id && call.id.length > 0 ? call.id : `tool_${index}`,
    type: 'function',
    function: {
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
    },
  }))
}

// Debounced persistence of stream deltas (see D2 above). add() buffers;
// flushes are serialized on a promise chain so the UPDATE and its `delta`
// event always land in stream order, even when the timer races the
// 24-token threshold. close() flushes the tail and must be awaited before
// finalizing the message — on error/cancel paths too, so no yielded token
// is ever dropped.
class DeltaFlusher {
  private pendingContent = ''
  private pendingReasoning = ''
  private count = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(private handle: RunHandle) {}

  add(kind: 'content' | 'reasoning', text: string) {
    if (kind === 'content') this.pendingContent += text
    else this.pendingReasoning += text
    this.count += 1
    if (this.count >= FLUSH_TOKENS) {
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, FLUSH_MS)
    }
  }

  private flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const content = this.pendingContent
    const reasoning = this.pendingReasoning
    this.pendingContent = ''
    this.pendingReasoning = ''
    this.count = 0
    if (content === '' && reasoning === '') return
    const { messageId, runId } = this.handle
    this.chain = this.chain
      .then(async () => {
        await appendMessageDeltas({ id: messageId, content, reasoning })
        await emitEvent(runId, 'delta', { messageId, content, reasoning })
      })
  }

  async close() {
    this.flush()
    await this.chain
  }
}

interface TurnResult {
  toolCalls: ToolCall[]
  timings: unknown
  model: string | null
  finishReason: string | null
}

// Drive one provider turn: consume the SSE stream, debounce-persist deltas,
// and return the turn's aggregates. Throws on provider failure or abort —
// after the finally block has persisted every delta received so far.
async function streamTurn(
  handle: RunHandle,
  provider: ProviderConfig,
  model: string | null,
  history: ChatMessage[],
  stallTimeoutMs: number,
  tools: unknown[],
  reasoningEffort: ReasoningEffort | null,
): Promise<TurnResult> {
  const result: TurnResult = {
    toolCalls: [],
    timings: null,
    model: null,
    finishReason: null,
  }
  const flusher = new DeltaFlusher(handle)
  try {
    for await (const delta of streamChat(
      provider,
      model,
      history,
      handle.abort.signal,
      stallTimeoutMs,
      tools,
      reasoningEffort,
    )) {
      switch (delta.kind) {
        case 'content':
          flusher.add('content', delta.text)
          break
        case 'reasoning':
          flusher.add('reasoning', delta.text)
          break
        case 'tool-calls':
          // Full merged array every time; keep the latest.
          result.toolCalls = delta.toolCalls
          break
        case 'model':
          result.model = delta.model
          break
        case 'timings':
          result.timings = delta.timings
          break
        case 'finish':
          result.finishReason = delta.finishReason
          break
      }
    }
  } finally {
    await flusher.close()
  }
  return result
}

// Seal the run's streaming message and the run row, then emit the
// message-final (with the server-rendered final block) and run-status events.
async function finishRun(
  handle: RunHandle,
  status: 'done' | 'cancelled' | 'error',
  errorMessage: string | null,
  turn?: TurnResult,
) {
  const messageStatus = status === 'done' ? 'complete' : 'interrupted'
  await finalizeMessage({
    id: handle.messageId,
    status: messageStatus,
    model: turn?.model ?? null,
    timings: turn?.timings ?? null,
    toolCalls: turn && turn.toolCalls.length > 0 ? turn.toolCalls : null,
  })
  const message = await getMessageById(handle.messageId)
  await emitEvent(handle.runId, 'message-final', {
    messageId: handle.messageId,
    status: messageStatus,
    html: await renderMessageHtml(message),
  })
  await setRunStatus({ id: handle.runId, status, error: errorMessage })
  await emitEvent(handle.runId, 'run-status', {
    status,
    error: errorMessage,
  })
  if (status === 'done' || status === 'error') {
    void notifyLoopRunStatus(handle.conversationId, status, errorMessage).catch((error) =>
      console.warn('loop notification failed', error),
    )
  }
}

// Everything the tool loop needs beyond the handle. Bundled so the loop, the
// inline auto-approve path, and the resume-after-park path all share one shape.
interface RunContext {
  provider: ProviderConfig
  model: string | null
  reasoningEffort: ReasoningEffort | null
  history: ChatMessage[]
  maxTurns: number
  stallTimeoutMs: number
  tools: OpenAiTool[]
  servers: McpServerConfig[]
  toolIndex: Map<string, string>
}

const reasoningEfforts = new Set(['off', 'low', 'medium', 'high', 'max'])

function normalizeReasoningEffort(value: string | null | undefined): ReasoningEffort {
  return reasoningEfforts.has(value ?? '') ? (value as ReasoningEffort) : 'medium'
}

function providerSupportsReasoning(
  provider: { default_model: string | null; model_metadata?: unknown },
  model: string | null,
): boolean {
  const metadata = provider.model_metadata
  if (!metadata || typeof metadata !== 'object') return false
  const selected = model || provider.default_model
  if (!selected) return false
  const info = (metadata as Record<string, { reasoning?: unknown }>)[selected]
  return info?.reasoning === true
}

// One tool call to run during a batch: its identity, args, and the human (or
// auto) decision. `denied` short-circuits to the synthetic denial result.
interface ToolExecution {
  toolCallId: string
  toolName: string
  arguments: string
  decision: 'approved' | 'denied'
}

function isAutoApproved(name: string, ctx: RunContext): boolean {
  if (name === SUBMIT_ARTIFACT_TOOL.function.name) return true
  const serverId = ctx.toolIndex.get(name)
  const server = serverId ? ctx.servers.find((s) => s.id === serverId) : undefined
  return server?.auto_approve === true
}

// Seal the assistant turn that asked for tools: persist its content + the
// normalized tool_calls, emit message-final so a live island swaps in the
// rendered node, and append it to the running context.
async function sealToolCallTurn(
  handle: RunHandle,
  turn: TurnResult,
  calls: NormalizedToolCall[],
) {
  await finalizeMessage({
    id: handle.messageId,
    status: 'complete',
    model: turn.model ?? null,
    timings: turn.timings ?? null,
    toolCalls: calls,
  })
  const message = await getMessageById(handle.messageId)
  await emitEvent(handle.runId, 'message-final', {
    messageId: handle.messageId,
    status: 'complete',
    html: await renderMessageHtml(message),
  })
  return message
}

// Execute a batch of tool calls in issue order, then open the next streaming
// assistant message. Each result becomes a role='tool' message (keyed by
// tool_call_id) on the active path and in `ctx.history`; a failed/denied call
// still yields a tool message so the model can react and the loop continues.
// Mutates handle.messageId to the fresh assistant message and advances the
// run's leaf pointer + conversation curr_node.
async function submitArtifactTool(handle: RunHandle, args: Record<string, unknown>) {
  const conversation = await getConversationById(handle.conversationId)
  if (!conversation) throw new Error('Conversation not found.')
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const body = typeof args.body === 'string' ? args.body.trim() : ''
  const kind = typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'generic'
  const summary = typeof args.summary === 'string' ? args.summary.trim() : null
  if (!title) throw new Error('Artifact title is required.')
  if (!body) throw new Error('Artifact body is required.')

  const artifact = await createArtifact({
    accountId: conversation.user_id,
    conversationId: handle.conversationId,
    runId: handle.runId,
    messageId: null,
    kind: kind.slice(0, 80),
    title: title.slice(0, 300),
    summary: summary ? summary.slice(0, 1000) : null,
    bodyMarkdown: body.slice(0, 200_000),
  })

  return `Artifact saved: ${artifact.title}\nOpen it at /artifacts/${artifact.id}`
}

async function executeToolBatch(
  handle: RunHandle,
  ctx: RunContext,
  batch: ToolExecution[],
) {
  let parentId = handle.messageId
  for (const item of batch) {
    let resultText: string
    if (item.decision === 'denied') {
      resultText = DENIAL_RESULT
    } else {
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(item.arguments || '{}')
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch {
        // Malformed arguments — call with an empty object, let the tool complain.
      }
      try {
        if (item.toolName === SUBMIT_ARTIFACT_TOOL.function.name) {
          resultText = await submitArtifactTool(handle, args)
        } else {
          const result = await callTool(ctx.servers, ctx.toolIndex, item.toolName, args)
          resultText = result.content
        }
      } catch (error) {
        resultText = `Tool execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }

    const toolMessage = await createMessage({
      conversationId: handle.conversationId,
      parentId,
      role: 'tool',
      content: resultText,
      toolCallId: item.toolCallId,
    })
    await setConversationCurrNode({
      id: handle.conversationId,
      currNode: toolMessage!.id,
    })
    parentId = toolMessage!.id
    ctx.history.push({
      role: 'tool',
      tool_call_id: item.toolCallId,
      content: resultText,
    })

    // Mirror the assistant lifecycle so a live island can append the tool
    // result and replay stays complete.
    await emitEvent(handle.runId, 'message-start', {
      messageId: toolMessage!.id,
      role: 'tool',
    })
    await emitEvent(handle.runId, 'message-final', {
      messageId: toolMessage!.id,
      status: 'complete',
      html: await renderMessageHtml(toolMessage),
    })
  }

  // Open the next streaming assistant message the loop will generate into.
  const assistant = await createMessage({
    conversationId: handle.conversationId,
    parentId,
    role: 'assistant',
    content: '',
    status: 'streaming',
    model: ctx.model,
  })
  handle.messageId = assistant!.id
  await setConversationCurrNode({
    id: handle.conversationId,
    currNode: assistant!.id,
  })
  await setRunLeafMessage({ id: handle.runId, leafMessageId: assistant!.id })
  await emitEvent(handle.runId, 'message-start', {
    messageId: assistant!.id,
    role: 'assistant',
  })
}

// Park the run pending a human decision: record one tool_approvals row per
// call, flip the run to waiting_approval, and emit the run-status event so the
// M4 island shows "waiting for approval" live. The assistant message is already
// sealed (complete, tool_calls kept) by the caller.
async function parkForApproval(
  handle: RunHandle,
  calls: NormalizedToolCall[],
) {
  for (const call of calls) {
    await createToolApproval({
      runId: handle.runId,
      messageId: handle.messageId,
      toolCallId: call.id,
      toolName: call.function.name,
      arguments: call.function.arguments,
    })
  }
  await setRunStatus({ id: handle.runId, status: 'waiting_approval', error: null })
  await emitEvent(handle.runId, 'run-status', {
    status: 'waiting_approval',
    error: null,
  })
  void notifyLoopRunStatus(handle.conversationId, 'waiting_approval').catch((error) =>
    console.warn('loop approval notification failed', error),
  )
}

// The detached completion loop. Never throws (a runner crash must not take
// the process down); all stopping points funnel through finishRun / a park.
// `startTurns` seeds the tool-turn counter so a resumed run keeps counting
// toward the same budget across a park/restart.
async function driveRun(
  handle: RunHandle,
  ctx: RunContext,
  options: { startTurns?: number; resume?: ToolExecution[] } = {},
) {
  try {
    let turns = options.startTurns ?? 0

    // Resume-after-park: run the approved/denied batch, then fall into the loop
    // streaming the freshly opened assistant message.
    if (options.resume) {
      await executeToolBatch(handle, ctx, options.resume)
    }

    for (;;) {
      const turn = await streamTurn(
        handle,
        ctx.provider,
        ctx.model,
        ctx.history,
        ctx.stallTimeoutMs,
        ctx.tools,
        ctx.reasoningEffort,
      )
      await incrementRunTurnCount(handle.runId)

      if (turn.toolCalls.length === 0) {
        // Normal end: a turn with no tool calls is the final answer.
        await finishRun(handle, 'done', null, turn)
        return
      }

      // Tool-calling turn: seal it and decide how to proceed.
      const calls = normalizeToolCalls(turn.toolCalls)
      const sealed = await sealToolCallTurn(handle, turn, calls)
      ctx.history.push({
        role: 'assistant',
        content: (sealed?.content as string | undefined) ?? '',
        tool_calls: calls,
      })
      turns += 1

      if (turns >= ctx.maxTurns) {
        // Budget exhausted: park the run with a budget marker in `error`. The
        // sealed assistant message (with its unanswered tool_calls) stays on
        // the path as the durable record; the user can start a fresh turn.
        await setRunStatus({
          id: handle.runId,
          status: 'error',
          error: `Tool turn budget exhausted (${ctx.maxTurns} turns).`,
        })
        await emitEvent(handle.runId, 'run-status', {
          status: 'error',
          error: `Tool turn budget exhausted (${ctx.maxTurns} turns).`,
        })
        return
      }

      const needsApproval = calls.some((call) => !isAutoApproved(call.function.name, ctx))
      if (needsApproval) {
        await parkForApproval(handle, calls)
        return
      }

      // Every owning server is auto_approve: run the batch inline and loop.
      await executeToolBatch(
        handle,
        ctx,
        calls.map((call) => ({
          toolCallId: call.id,
          toolName: call.function.name,
          arguments: call.function.arguments,
          decision: 'approved' as const,
        })),
      )
    }
  } catch (error) {
    const aborted =
      handle.cancelled ||
      (error instanceof Error && error.name === 'AbortError')
    try {
      if (aborted) {
        await finishRun(handle, 'cancelled', null)
      } else {
        const message = error instanceof Error ? error.message : String(error)
        await finishRun(handle, 'error', message)
      }
    } catch (finalizeError) {
      console.error('run finalization failed', finalizeError)
    }
  } finally {
    activeRuns.delete(handle.conversationId)
  }
}

// Create the run + streaming assistant message and launch the detached loop.
// Resolves once the run is durably started (message row, run row, and the
// message-start event exist); the completion itself continues without any
// request or subscriber. Throws before anything is written when the
// conversation can't run (active run, no leaf, provider missing/disabled).
// `options.stallTimeoutMs` overrides the provider-silence watchdog (mainly
// for tests); production callers rely on the env-backed default.
export async function startRun(
  conversationId: string,
  options: { stallTimeoutMs?: number; maxTurns?: number } = {},
) {
  if (activeRuns.has(conversationId)) {
    throw new Error('A reply is already streaming for this conversation.')
  }
  // Reserve the conversation synchronously so a concurrent startRun (or a
  // recovery sweep) never doubles up while our setup awaits are in flight.
  const handle: RunHandle = {
    runId: '',
    conversationId,
    messageId: '',
    abort: new AbortController(),
    cancelled: false,
  }
  activeRuns.set(conversationId, handle)

  try {
    const conversation = await getConversationById(conversationId)
    if (!conversation) throw new Error('Conversation not found.')
    const blockingRun = await getBlockingRunForConversation(conversationId)
    if (blockingRun) {
      throw new Error(
        blockingRun.status === 'waiting_approval'
          ? 'A reply is waiting for tool approval. Approve, deny, or stop it first.'
          : 'A reply is already streaming for this conversation.',
      )
    }
    if (!conversation.curr_node) {
      throw new Error('Nothing to reply to yet — send a message first.')
    }

    const provider = conversation.provider_id
      ? await getProviderById(conversation.provider_id)
      : null
    if (!provider) {
      throw new Error('This conversation has no provider. Assign one before sending.')
    }
    if (!provider.enabled) {
      throw new Error(`Provider "${provider.name}" is disabled. Enable it before sending.`)
    }

    const path = await getActivePath(conversation.curr_node)
    const history = toChatMessages(path as PathRow[])

    const assistantMessage = await createMessage({
      conversationId,
      parentId: conversation.curr_node,
      role: 'assistant',
      content: '',
      status: 'streaming',
      model: conversation.model,
    })
    handle.messageId = assistantMessage!.id
    await setConversationCurrNode({ id: conversationId, currNode: assistantMessage!.id })

    const run = await createRun({
      conversationId,
      leafMessageId: assistantMessage!.id,
      budget: { maxTurns: DEFAULT_MAX_TURNS },
    })
    handle.runId = run!.id

    await emitEvent(run!.id, 'message-start', {
      messageId: assistantMessage!.id,
      role: 'assistant',
    })

    // Gather the tools exposed to the model for this conversation (connecting to
    // each enabled MCP server, best-effort). Empty when no server is enabled —
    // the request then carries no `tools` and the run behaves exactly as M3.
    // Loop-created conversations also get inkcap's private artifact tool.
    const { servers, tools, toolIndex } = await buildToolContext(
      conversationId,
      conversation.routine_id != null,
    )

    const ctx: RunContext = {
      provider: {
        id: provider.id,
        kind: provider.kind,
        base_url: provider.base_url,
        api_key: provider.api_key,
      },
      model: conversation.model,
      reasoningEffort: providerSupportsReasoning(provider, conversation.model)
        ? normalizeReasoningEffort(conversation.reasoning_effort)
        : null,
      history,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      stallTimeoutMs: options.stallTimeoutMs ?? defaultStallTimeoutMs(),
      tools,
      servers,
      toolIndex,
    }
    void driveRun(handle, ctx)

    return { runId: run!.id, messageId: assistantMessage!.id }
  } catch (error) {
    activeRuns.delete(conversationId)
    throw error
  }
}

// Connect to the conversation's enabled MCP servers and collect the OpenAI
// tool definitions + a name→server routing index. Best-effort (one dead server
// never blocks the others); returns empty when nothing is enabled.
async function buildToolContext(conversationId: string, includeInternalTools = false): Promise<{
  servers: McpServerConfig[]
  tools: OpenAiTool[]
  toolIndex: Map<string, string>
}> {
  const internalTools = includeInternalTools ? [SUBMIT_ARTIFACT_TOOL] : []
  const rows = await listEnabledMcpServersForConversation(conversationId)
  const servers: McpServerConfig[] = rows.map((row) => ({
    id: row.id!,
    name: row.name!,
    url: row.url!,
    headers: row.headers,
    request_timeout_ms: row.request_timeout_ms,
    auto_approve: row.auto_approve,
  }))
  if (servers.length === 0) {
    return { servers, tools: internalTools, toolIndex: new Map() }
  }
  const { tools, toolIndex } = await gatherTools(servers)
  return { servers, tools: [...tools, ...internalTools], toolIndex }
}

// Resume a run parked in waiting_approval after the user approves or denies the
// pending tool call(s). Records the decision on every pending approval row,
// then re-launches the detached loop: the batch runs (approved calls execute,
// denied calls yield the synthetic denial result), a fresh assistant turn
// streams, and the loop continues. Throws (before writing) when there is no
// pending approval, the conversation is already running, or the provider is
// gone/disabled — the caller surfaces the message.
export async function resumeParkedRun(
  conversationId: string,
  decision: 'approve' | 'deny',
  options: { stallTimeoutMs?: number; maxTurns?: number } = {},
) {
  if (activeRuns.has(conversationId)) {
    // The detached driver flips the durable row to waiting_approval just
    // before its finally{} removes the in-memory handle. A form submit can hit
    // that tiny window; trust the durable parked state and clear the stale
    // reservation instead of surfacing a spurious "already streaming" error.
    const run = await getLatestRunForConversation(conversationId)
    if (run?.status === 'waiting_approval') {
      for (let i = 0; i < 20 && activeRuns.has(conversationId); i += 1) {
        await Bun.sleep(1)
      }
      if (activeRuns.has(conversationId)) activeRuns.delete(conversationId)
    } else {
      throw new Error('A reply is already streaming for this conversation.')
    }
  }
  const handle: RunHandle = {
    runId: '',
    conversationId,
    messageId: '',
    abort: new AbortController(),
    cancelled: false,
  }
  activeRuns.set(conversationId, handle)

  try {
    const run = await getLatestRunForConversation(conversationId)
    if (!run || run.status !== 'waiting_approval' || !run.leaf_message_id) {
      throw new Error('There is no pending tool approval to act on.')
    }

    const conversation = await getConversationById(conversationId)
    if (!conversation) throw new Error('Conversation not found.')

    const provider = conversation.provider_id
      ? await getProviderById(conversation.provider_id)
      : null
    if (!provider) {
      throw new Error('This conversation has no provider. Assign one before sending.')
    }
    if (!provider.enabled) {
      throw new Error(`Provider "${provider.name}" is disabled. Enable it before sending.`)
    }

    handle.runId = run.id
    handle.messageId = run.leaf_message_id

    // Record the decision, then read every approval row back in issue order.
    await decideRunApprovals({
      runId: run.id,
      decision: decision === 'approve' ? 'approved' : 'denied',
    })
    const approvals = await listApprovalsForRun(run.id)
    const batch: ToolExecution[] = approvals.map((row) => ({
      toolCallId: row.tool_call_id!,
      toolName: row.tool_name!,
      arguments: row.arguments ?? '',
      decision: (row.decision as 'approved' | 'denied') ?? 'denied',
    }))

    // Rebuild the running context from the tree (up to and including the sealed
    // assistant message that holds the tool_calls) so a resume works even in a
    // fresh process after a restart.
    const path = await getActivePath(run.leaf_message_id)
    const history = toChatMessages(path as PathRow[])
    const { servers, tools, toolIndex } = await buildToolContext(
      conversationId,
      conversation.routine_id != null,
    )

    await setRunStatus({ id: run.id, status: 'running', error: null })
    await emitEvent(run.id, 'run-status', { status: 'running', error: null })

    const ctx: RunContext = {
      provider: {
        id: provider.id,
        kind: provider.kind,
        base_url: provider.base_url,
        api_key: provider.api_key,
      },
      model: conversation.model,
      reasoningEffort: providerSupportsReasoning(provider, conversation.model)
        ? normalizeReasoningEffort(conversation.reasoning_effort)
        : null,
      history,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      stallTimeoutMs: options.stallTimeoutMs ?? defaultStallTimeoutMs(),
      tools,
      servers,
      toolIndex,
    }
    void driveRun(handle, ctx, {
      startTurns: Number(run.turn_count ?? 0),
      resume: batch,
    })

    return { runId: run.id }
  } catch (error) {
    activeRuns.delete(conversationId)
    throw error
  }
}

// Stop the active run for a conversation, keeping the partial message.
// Returns false when there is nothing to cancel. Also sweeps up an orphaned
// `running` row (from a dead process) by parking it as cancelled.
export async function cancelRun(conversationId: string) {
  const handle = activeRuns.get(conversationId)
  if (handle) {
    handle.cancelled = true
    handle.abort.abort()
    return true
  }

  const run = await getBlockingRunForConversation(conversationId)
  if (!run) return false
  if (run.status === 'waiting_approval') {
    await decideRunApprovals({ runId: run.id, decision: 'denied' })
  }
  await parkOrphanedRun(
    { id: run.id, leaf_message_id: run.leaf_message_id },
    'cancelled',
    null,
    null,
  )
  return true
}

// Finalize an orphaned run's streaming message (keeping every persisted
// token, optionally appending a visible marker) and park the run. Emits the
// same message-final/run-status events a live run would, so replay works.
async function parkOrphanedRun(
  run: { id: string; leaf_message_id: string | null },
  status: 'cancelled' | 'error',
  errorMessage: string | null,
  marker: string | null,
) {
  if (run.leaf_message_id) {
    const message = await getMessageById(run.leaf_message_id)
    if (message && message.status === 'streaming') {
      if (marker) {
        await appendMessageDeltas({
          id: run.leaf_message_id,
          content: marker,
          reasoning: '',
        })
      }
      await finalizeMessage({ id: run.leaf_message_id, status: 'interrupted' })
      const finalized = await getMessageById(run.leaf_message_id)
      await emitEvent(run.id, 'message-final', {
        messageId: run.leaf_message_id,
        status: 'interrupted',
        html: await renderMessageHtml(finalized),
      })
    }
  }
  await setRunStatus({ id: run.id, status, error: errorMessage })
  await emitEvent(run.id, 'run-status', { status, error: errorMessage })
}

// Boot recovery (called from src/index.ts before serving): any run still
// `running` in the DB but not driven by this process was orphaned by a crash
// or restart. Finalize its streaming message as interrupted — appending a
// visible marker, never touching the tokens already persisted — and park the
// run as error. Resume is a non-goal for now.
//
// `scope.conversationId` narrows the sweep to one conversation — boot always
// sweeps everything; tests scope to their own data because the suite runs
// concurrently and other tests hand-craft `running` rows of their own.
export async function recoverInterruptedRuns(scope: { conversationId?: string } = {}) {
  const running = await listRunningRuns()
  let recovered = 0
  for (const run of running) {
    if (scope.conversationId && run.conversation_id !== scope.conversationId) continue
    // Skip runs this process is actively driving (matters when recovery is
    // exercised inside the concurrently-running test suite).
    if (activeRuns.has(run.conversation_id!)) continue
    await parkOrphanedRun(
      { id: run.id!, leaf_message_id: run.leaf_message_id ?? null },
      'error',
      'interrupted by server restart',
      '\n\n[interrupted by restart]',
    )
    recovered += 1
  }
  return recovered
}

// Boot cleanup: drop replay events for runs terminal for over an hour.
export async function cleanupExpiredRunEvents() {
  const deleted = await deleteExpiredRunEvents()
  return deleted.length
}

// Replay helper for the SSE endpoint: events strictly after `afterSeq`.
export async function replayRunEvents(runId: string, afterSeq: number) {
  const rows = await listRunEventsAfter({ runId, afterSeq })
  return rows.map((row) => ({
    runId,
    seq: Number(row.seq),
    type: row.type as RunEventType,
    payload: row.payload as unknown,
  }))
}
