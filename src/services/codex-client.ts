// Wire client for the `openai-codex` provider kind: translates inkcap's
// OpenAI-chat-completions-shaped world to the Responses API served at
// https://chatgpt.com/backend-api/codex (the ChatGPT-subscription backend the
// Codex CLI talks to — NOT api.openai.com).
//
// Translation rules (docs/specs/openai-codex.md):
//   - system messages hoist into a top-level `instructions` string, prefixed
//     with a Codex-style preamble (the backend 400s on empty instructions and
//     is reported to reject non-Codex-style ones);
//   - chat history replays as `input[]` items every turn (`store: false`,
//     stateless), which matches how the runner already rebuilds history;
//   - assistant tool_calls become `function_call` items, role:'tool' results
//     become `function_call_output` items;
//   - streaming converts semantic `response.*` SSE events back into the
//     StreamDelta shape the runner consumes. Status events are parsed
//     tolerantly (they echo the full instructions payload and are known to
//     arrive truncated), and the final text is reconstructed from deltas —
//     the terminal `response.output` array is sometimes empty.
//
// Auth (Bearer JWT + chatgpt-account-id) comes from codex-auth, which owns
// refresh/rotation; on an upstream 401 we force one refresh and retry once.

import { assertSafeOutboundUrl } from '../utils/outbound-url'
import { getCodexAccess, type CodexAccess } from './codex-auth'
import type {
  ChatCompletion,
  ChatMessage,
  ProviderConfig,
  ReasoningEffort,
  StreamDelta,
  ToolCall,
} from './provider-client'
import type { ProviderModelInfo, ProviderModelMetadata } from '../db/queries/providers'

const CODEX_BASE_INSTRUCTIONS =
  "You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer."

// Static fallback when the live /models endpoint is unreachable or changes
// shape; the endpoint is server-/plan-controlled, so prefer it when it works.
export const CODEX_FALLBACK_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']

const NO_RESPONSE_MESSAGE = 'No response received from server. Please try again.'
const DEFAULT_STALL_TIMEOUT_MS = 120_000

function codexUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

// The originator + User-Agent pair is whitelisted server-side; a wrong
// originator is a hard 403.
function codexHeaders(access: CodexAccess): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.accessToken}`,
    originator: 'codex_cli_rs',
    'User-Agent': process.env['CODEX_USER_AGENT'] ?? 'codex_cli_rs/0.45.0 (Linux; x86_64) inkcap',
  }
  if (access.accountId) headers['chatgpt-account-id'] = access.accountId
  return headers
}

interface NormalizedCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

// Hoist system messages into `instructions` and map the rest to Responses
// input items. Exported for tests.
export function buildCodexInput(messages: ChatMessage[]): {
  instructions: string
  input: unknown[]
} {
  const systems: string[] = []
  const input: unknown[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim().length > 0) systems.push(message.content)
      continue
    }
    if (message.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: message.content }],
      })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }],
        })
      }
      if (Array.isArray(message.tool_calls)) {
        for (const raw of message.tool_calls as NormalizedCall[]) {
          input.push({
            type: 'function_call',
            call_id: raw.id ?? '',
            name: raw.function?.name ?? '',
            arguments: raw.function?.arguments ?? '{}',
          })
        }
      }
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: message.content,
      })
    }
  }

  const instructions = [CODEX_BASE_INSTRUCTIONS, ...systems].join('\n\n')
  return { instructions, input }
}

// OpenAI chat tools ({type:'function', function:{...}}) flatten to Responses
// tools ({type:'function', name, ...}).
function toResponsesTools(tools: unknown[] | undefined): unknown[] {
  if (!tools || tools.length === 0) return []
  return tools.map((tool) => {
    const record = tool as {
      type?: string
      function?: { name?: string; description?: string; parameters?: unknown }
    }
    return {
      type: 'function',
      name: record.function?.name ?? '',
      description: record.function?.description ?? '',
      parameters: record.function?.parameters ?? { type: 'object', properties: {} },
      strict: false,
    }
  })
}

function toReasoningParam(effort: ReasoningEffort | null | undefined) {
  if (!effort || effort === 'off') return null
  const mapped = effort === 'max' ? 'high' : effort
  return { effort: mapped, summary: 'auto' }
}

// Exported for tests. Codex backend quirks: `store: false` (stateless),
// non-empty `instructions`, `include: ["reasoning.encrypted_content"]`.
export function buildCodexRequestBody(
  model: string,
  messages: ChatMessage[],
  options: { tools?: unknown[]; reasoningEffort?: ReasoningEffort | null } = {},
): Record<string, unknown> {
  const { instructions, input } = buildCodexInput(messages)
  const body: Record<string, unknown> = {
    model,
    instructions,
    input,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
  const tools = toResponsesTools(options.tools)
  if (tools.length > 0) {
    body['tools'] = tools
    body['tool_choice'] = 'auto'
    body['parallel_tool_calls'] = true
  }
  const reasoning = toReasoningParam(options.reasoningEffort)
  if (reasoning) body['reasoning'] = reasoning
  return body
}

function requireModel(model: string | null): string {
  if (!model || model.length === 0) {
    throw new Error('Select a model for this ChatGPT Codex provider before sending.')
  }
  return model
}

function requireProviderId(provider: ProviderConfig): string {
  if (!provider.id) {
    throw new Error('ChatGPT Codex providers need a saved provider row before use.')
  }
  return provider.id
}

function parseCodexErrorMessage(status: number, text: string): string {
  try {
    const data = JSON.parse(text) as {
      detail?: unknown
      error?: { message?: unknown } | string
    }
    if (typeof data.detail === 'string' && data.detail.trim().length > 0) {
      return data.detail
    }
    if (typeof data.error === 'string' && data.error.trim().length > 0) {
      return data.error
    }
    if (
      data.error &&
      typeof data.error === 'object' &&
      typeof data.error.message === 'string' &&
      data.error.message.trim().length > 0
    ) {
      return data.error.message
    }
  } catch {
    // Non-JSON body — fall through.
  }
  if (status === 429) {
    return 'ChatGPT subscription usage limit reached (429). Wait for the rolling window to reset and try again.'
  }
  return `Server error (${status})`
}

// POST /responses, transparently refreshing the token and retrying ONCE on a
// 401 (reactive refresh — the local expiry check can be right while the
// server still rejects the token).
async function postResponses(
  provider: ProviderConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const providerId = requireProviderId(provider)
  const url = codexUrl(provider.base_url, '/responses')
  await assertSafeOutboundUrl(url)

  let access = await getCodexAccess(providerId)
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...codexHeaders(access),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        session_id: crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal,
    })
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel().catch(() => {})
      access = await getCodexAccess(providerId, { forceRefresh: true })
      continue
    }
    return response
  }
}

// --- SSE event translation ---

interface CodexStreamState {
  toolCalls: ToolCall[]
  callIndexByOutputIndex: Map<number, number>
  modelEmitted: boolean
  completed: boolean
}

interface CodexEvent {
  type?: string
  delta?: unknown
  output_index?: number
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
  }
  response?: {
    model?: unknown
    error?: { message?: unknown }
  }
  message?: unknown
  error?: { message?: unknown }
}

function cloneToolCalls(calls: ToolCall[]): ToolCall[] {
  return calls.map((call) => ({
    ...call,
    function: call.function ? { ...call.function } : undefined,
  }))
}

// Convert one parsed Responses event into zero or more StreamDeltas, mutating
// the accumulation state. Throws on terminal error events.
function translateCodexEvent(state: CodexStreamState, event: CodexEvent): StreamDelta[] {
  const deltas: StreamDelta[] = []
  switch (event.type) {
    case 'response.output_text.delta': {
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        deltas.push({ kind: 'content', text: event.delta })
      }
      break
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        deltas.push({ kind: 'reasoning', text: event.delta })
      }
      break
    }
    case 'response.output_item.added': {
      if (event.item?.type === 'function_call') {
        const index = state.toolCalls.length
        state.toolCalls.push({
          id: event.item.call_id ?? event.item.id ?? '',
          type: 'function',
          function: {
            name: event.item.name ?? '',
            arguments: event.item.arguments ?? '',
          },
        })
        if (typeof event.output_index === 'number') {
          state.callIndexByOutputIndex.set(event.output_index, index)
        }
        deltas.push({ kind: 'tool-calls', toolCalls: cloneToolCalls(state.toolCalls) })
      }
      break
    }
    case 'response.function_call_arguments.delta': {
      const index =
        typeof event.output_index === 'number'
          ? state.callIndexByOutputIndex.get(event.output_index)
          : state.toolCalls.length - 1
      const call = index !== undefined ? state.toolCalls[index] : undefined
      if (call?.function && typeof event.delta === 'string') {
        call.function.arguments = (call.function.arguments ?? '') + event.delta
        deltas.push({ kind: 'tool-calls', toolCalls: cloneToolCalls(state.toolCalls) })
      }
      break
    }
    case 'response.output_item.done': {
      if (event.item?.type === 'function_call') {
        const index =
          typeof event.output_index === 'number'
            ? state.callIndexByOutputIndex.get(event.output_index)
            : undefined
        const call = index !== undefined ? state.toolCalls[index] : undefined
        if (call?.function && typeof event.item.arguments === 'string') {
          // The done item carries the authoritative full arguments string.
          call.function.arguments = event.item.arguments
          if (event.item.call_id) call.id = event.item.call_id
          deltas.push({ kind: 'tool-calls', toolCalls: cloneToolCalls(state.toolCalls) })
        }
      }
      break
    }
    case 'response.created': {
      const model = event.response?.model
      if (!state.modelEmitted && typeof model === 'string' && model.length > 0) {
        state.modelEmitted = true
        deltas.push({ kind: 'model', model })
      }
      break
    }
    case 'response.completed':
    case 'response.incomplete': {
      state.completed = true
      const model = event.response?.model
      if (!state.modelEmitted && typeof model === 'string' && model.length > 0) {
        state.modelEmitted = true
        deltas.push({ kind: 'model', model })
      }
      deltas.push({
        kind: 'finish',
        finishReason: state.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      })
      break
    }
    case 'response.failed': {
      const message = event.response?.error?.message
      throw new Error(
        typeof message === 'string' && message.length > 0
          ? message
          : 'The ChatGPT backend reported the response failed.',
      )
    }
    case 'error': {
      const message =
        (typeof event.message === 'string' && event.message) ||
        (typeof event.error?.message === 'string' && event.error.message) ||
        'The ChatGPT backend reported an error.'
      throw new Error(message)
    }
    default:
      // Status/lifecycle events (in_progress, content_part.*, output_text.done,
      // …) carry nothing we need; some arrive as truncated JSON and never
      // reach here at all.
      break
  }
  return deltas
}

// Stream one Responses completion as StreamDeltas. Mirrors provider-client's
// streamChat contract: same stall watchdog semantics (a silent provider is a
// PLAIN Error, not AbortError), partial deltas are already yielded when it
// throws, and a stream that ends without `response.completed` throws.
export async function* streamCodexChat(
  provider: ProviderConfig,
  model: string | null,
  messages: ChatMessage[],
  signal?: AbortSignal,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
  tools?: unknown[],
  reasoningEffort?: ReasoningEffort | null,
): AsyncGenerator<StreamDelta, void, undefined> {
  const body = buildCodexRequestBody(requireModel(model), messages, {
    tools,
    reasoningEffort,
  })

  const stallAbort = new AbortController()
  let stalled = false
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStallWatchdog = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      stallAbort.abort()
    }, stallTimeoutMs)
  }
  const disarmStallWatchdog = () => {
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
  }
  const stallError = () =>
    new Error(
      `The provider stopped responding (no data for ${Math.round(stallTimeoutMs / 1000)}s).`,
    )
  const fetchSignal = signal
    ? AbortSignal.any([signal, stallAbort.signal])
    : stallAbort.signal

  armStallWatchdog()
  let response: Response
  try {
    response = await postResponses(provider, body, fetchSignal)
  } catch (error) {
    disarmStallWatchdog()
    if (stalled && !signal?.aborted) throw stallError()
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw error instanceof Error
      ? error
      : new Error(`Unable to reach the provider at ${provider.base_url}: ${String(error)}`)
  }
  disarmStallWatchdog()

  if (!response.ok) {
    armStallWatchdog()
    let errorText = ''
    try {
      errorText = await response.text()
    } catch (error) {
      if (stalled && !signal?.aborted) throw stallError()
      throw error
    } finally {
      disarmStallWatchdog()
    }
    throw new Error(parseCodexErrorMessage(response.status, errorText))
  }
  if (!response.body) {
    throw new Error(NO_RESPONSE_MESSAGE)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  const state: CodexStreamState = {
    toolCalls: [],
    callIndexByOutputIndex: new Map(),
    modelEmitted: false,
    completed: false,
  }

  // Flush one SSE event's accumulated data lines into deltas. Malformed JSON
  // (the truncated-status-event pitfall) is skipped, never fatal.
  function* flushEvent(): Generator<StreamDelta> {
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')
    dataLines = []
    if (payload === '[DONE]') return
    let event: CodexEvent
    try {
      event = JSON.parse(payload) as CodexEvent
    } catch {
      return
    }
    yield* translateCodexEvent(state, event)
  }

  try {
    while (!state.completed) {
      armStallWatchdog()
      let done: boolean
      let value: Uint8Array | undefined
      try {
        ;({ done, value } = await reader.read())
      } catch (error) {
        if (stalled && !signal?.aborted) throw stallError()
        throw error
      } finally {
        disarmStallWatchdog()
      }
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
        if (trimmed === '') {
          yield* flushEvent()
          if (state.completed) break
        } else if (trimmed.startsWith('data:')) {
          dataLines.push(trimmed.slice('data:'.length).replace(/^ /, ''))
        }
        // `event:`/`id:`/comment lines are ignored — the payload's own
        // `type` field is authoritative.
      }
    }
    if (!state.completed) yield* flushEvent()
  } finally {
    disarmStallWatchdog()
    await reader.cancel().catch(() => {})
  }

  if (!state.completed) {
    if (stalled && !signal?.aborted) throw stallError()
    throw new Error('The stream ended unexpectedly. Please try again.')
  }
}

// Non-streaming convenience used by the provider test flow. Implemented by
// draining the stream — the /responses route's non-streaming mode is less
// traveled by real clients, so we stay on the well-worn path.
export async function completeCodexOnce(
  provider: ProviderConfig,
  model: string | null,
  messages: ChatMessage[],
  options: { signal?: AbortSignal } = {},
): Promise<ChatCompletion> {
  let content = ''
  let reasoning = ''
  let modelName: string | null = null
  for await (const delta of streamCodexChat(provider, model, messages, options.signal)) {
    if (delta.kind === 'content') content += delta.text
    else if (delta.kind === 'reasoning') reasoning += delta.text
    else if (delta.kind === 'model') modelName = delta.model
  }
  if (content.trim().length === 0) {
    throw new Error(NO_RESPONSE_MESSAGE)
  }
  return {
    content,
    reasoningContent: reasoning.length > 0 ? reasoning : null,
    model: modelName,
    timings: null,
  }
}

function codexModelInfo(): ProviderModelInfo {
  return {
    capabilities: ['text', 'reasoning'],
    reasoning: true,
    contextSize: null,
    source: 'codex /models',
  }
}

export function codexModelMetadata(models: string[]): ProviderModelMetadata {
  const metadata: ProviderModelMetadata = {}
  for (const model of models) metadata[model] = codexModelInfo()
  return metadata
}

// Live model listing: GET /models?client_version=1.0.0, keeping slugs the
// subscription backend will actually accept (supported_in_api + visible).
// Falls back to the static list when the response parses but lists nothing;
// throws on transport/auth errors so callers can surface them.
export async function fetchCodexModels(provider: ProviderConfig): Promise<{
  models: string[]
  modelMetadata: ProviderModelMetadata
}> {
  const providerId = requireProviderId(provider)
  const url = codexUrl(provider.base_url, '/models?client_version=1.0.0')
  await assertSafeOutboundUrl(url)
  const access = await getCodexAccess(providerId)

  const response = await fetch(url, {
    headers: codexHeaders(access),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(parseCodexErrorMessage(response.status, await response.text()))
  }

  let models: string[] = []
  try {
    const data = (await response.json()) as {
      models?: Array<{ slug?: unknown; supported_in_api?: unknown; visibility?: unknown }>
    }
    models = (data.models ?? [])
      .filter(
        (entry) =>
          typeof entry.slug === 'string' &&
          entry.slug.length > 0 &&
          entry.supported_in_api !== false &&
          (entry.visibility === undefined || entry.visibility === 'list'),
      )
      .map((entry) => entry.slug as string)
  } catch {
    models = []
  }
  if (models.length === 0) models = [...CODEX_FALLBACK_MODELS]
  return { models, modelMetadata: codexModelMetadata(models) }
}
