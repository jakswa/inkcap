// The durable chat runner. A run is a server-side job: startRun() creates a
// runs row plus a status=streaming assistant message, then drives the provider
// completion DETACHED from any request. Browsers are spectators — token
// deltas persist to the message row on a debounce, ordered events persist to
// run_events for replay, and zero SSE subscribers changes nothing.
//
// Stopping points (M3): completion finished (message complete, run done),
// provider terminal error (partial kept, message interrupted, run error),
// provider stall — no bytes for the watchdog window (treated as a terminal
// provider error), cancel (partial kept, run cancelled), turn budget
// exhausted (single-turn for now — the M6 SEAM in driveRun is where tool
// turns will extend the loop).

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
  getRunningRunForConversation,
  incrementRunTurnCount,
  listRunningRuns,
  setRunStatus,
} from '../db/queries/runs'
import {
  deleteExpiredRunEvents,
  insertRunEvent,
  listRunEventsAfter,
} from '../db/queries/run-events'
import {
  DEFAULT_STALL_TIMEOUT_MS,
  streamChat,
  type ChatMessage,
  type ChatRole,
  type ProviderConfig,
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

const DEFAULT_MAX_TURNS = 1

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
}

// Map the active path (root-first) to OpenAI chat messages: drop empty system
// messages (spec §1.2) and forward reasoning_content on assistant turns.
function toChatMessages(path: PathRow[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const row of path) {
    const role = (row.role ?? '') as ChatRole
    const content = row.content ?? ''
    if (role === 'system' && content.trim().length === 0) continue
    const message: ChatMessage = { role, content }
    if (role === 'assistant' && row.reasoning_content) {
      message.reasoning_content = row.reasoning_content
    }
    messages.push(message)
  }
  return messages
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
      .catch((error) => {
        console.error('delta flush failed', error)
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
}

// The detached completion loop. Never throws (a runner crash must not take
// the process down); all stopping points funnel through finishRun.
async function driveRun(
  handle: RunHandle,
  provider: ProviderConfig,
  model: string | null,
  history: ChatMessage[],
  maxTurns: number,
  stallTimeoutMs: number,
) {
  try {
    let turns = 0
    let turn: TurnResult
    for (;;) {
      turn = await streamTurn(handle, provider, model, history, stallTimeoutMs)
      turns += 1
      await incrementRunTurnCount(handle.runId)

      if (turn.toolCalls.length > 0 && turns < maxTurns) {
        // M6 SEAM: execute the tool calls here, append the tool-result
        // messages to `history` and the message tree, create the next
        // status=streaming assistant message (updating handle.messageId and
        // runs.leaf_message_id), then `continue` the loop. With the M3
        // single-turn budget this branch is unreachable.
        continue
      }
      break
    }
    await finishRun(handle, 'done', null, turn)
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
  options: { stallTimeoutMs?: number } = {},
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

    void driveRun(
      handle,
      { base_url: provider.base_url, api_key: provider.api_key },
      conversation.model,
      history,
      DEFAULT_MAX_TURNS,
      options.stallTimeoutMs ?? defaultStallTimeoutMs(),
    )

    return { runId: run!.id, messageId: assistantMessage!.id }
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

  const run = await getRunningRunForConversation(conversationId)
  if (!run) return false
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
