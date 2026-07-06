// HTTP client for OpenAI-compatible chat completions.
//
// M2 added the non-streaming subset (completeOnce). M3 adds streamChat(): POST
// with `stream: true`, consume the SSE body, and yield typed deltas (content,
// reasoning_content, merged tool_calls, model, timings, finish_reason) until
// the `data: [DONE]` sentinel. The runner drives the generator; cancellation
// arrives through an AbortSignal passed to fetch.
//
// Request/response shapes follow docs/specs/completions.md. We intentionally
// stay on the generic OpenAI-compatible subset here (messages, model, stream)
// and leave the llama-server-only knobs (samplers, reasoning_control, timings
// telemetry, etc.) for later waves.

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
  // Assistant messages may carry prior thinking; forwarded verbatim when set.
  reasoning_content?: string
  // Assistant messages that requested tools carry them (OpenAI shape); the
  // matching tool results come back as role:'tool' messages keyed by
  // tool_call_id (spec §1.2).
  tool_calls?: unknown[]
  tool_call_id?: string
}

// The subset of a providers row this client needs. Callers pass the row from
// getProviderById; base_url and api_key are the only fields read here.
export interface ProviderConfig {
  base_url: string
  api_key: string | null
}

export interface ChatRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export interface ChatCompletion {
  content: string
  reasoningContent: string | null
  model: string | null
  timings: unknown | null
}

const NO_RESPONSE_MESSAGE = 'No response received from server. Please try again.'

// Join a provider base URL with the completions path, tolerating a trailing
// slash on the configured base_url.
function completionsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
}

// First non-empty (trimmed) model name, mirroring extractModelName in the spec
// for the non-streaming response: root `model` then `choices[0].message.model`.
function extractModelName(data: {
  model?: unknown
  choices?: Array<{ message?: { model?: unknown } }>
}): string | null {
  const candidates = [data.model, data.choices?.[0]?.message?.model]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

// Build the request for POST <base>/v1/chat/completions. Only an api_key that
// is present and non-empty produces an Authorization header (an empty Bearer
// token is never sent — see spec §1.7).
export function buildChatRequest(
  provider: ProviderConfig,
  model: string | null,
  messages: ChatMessage[],
  options: { stream?: boolean; tools?: unknown[] } = {},
): ChatRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (provider.api_key && provider.api_key.length > 0) {
    headers.Authorization = `Bearer ${provider.api_key}`
  }

  const body: Record<string, unknown> = {
    messages,
    stream: options.stream ?? false,
  }
  if (model && model.length > 0) {
    body.model = model
  }
  // Only sent when non-empty, never as `[]` (spec §1.4).
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools
  }

  return { url: completionsUrl(provider.base_url), headers, body }
}

// Extract a human-readable message from an error response body (spec §6.1).
function parseErrorMessage(status: number, text: string): string {
  try {
    const data = JSON.parse(text) as { error?: { message?: string } }
    const message = data.error?.message
    if (typeof message === 'string' && message.trim().length > 0) {
      return message
    }
  } catch {
    // Non-JSON body — fall through to a status-based message.
  }
  return `Server error (${status})`
}

// POST the request and normalize the single non-streaming completion. Throws an
// Error (with a user-facing message) on transport failure, non-2xx responses,
// and degenerate empty bodies/content, so callers can surface reply failures
// without leaking internals.
export async function completeOnce(
  provider: ProviderConfig,
  model: string | null,
  messages: ChatMessage[],
): Promise<ChatCompletion> {
  const request = buildChatRequest(provider, model, messages)

  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    })
  } catch (error) {
    throw new Error(
      `Unable to reach the provider at ${provider.base_url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const text = await response.text()

  if (!response.ok) {
    throw new Error(parseErrorMessage(response.status, text))
  }

  if (text.trim().length === 0) {
    throw new Error(NO_RESPONSE_MESSAGE)
  }

  let data: {
    model?: unknown
    choices?: Array<{
      message?: {
        content?: unknown
        reasoning_content?: unknown
        model?: unknown
      }
    }>
    timings?: unknown
  }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(NO_RESPONSE_MESSAGE)
  }

  const message = data.choices?.[0]?.message
  const content = typeof message?.content === 'string' ? message.content : ''

  if (content.trim().length === 0) {
    throw new Error(NO_RESPONSE_MESSAGE)
  }

  const reasoningContent =
    typeof message?.reasoning_content === 'string'
      ? message.reasoning_content
      : null

  return {
    content,
    reasoningContent,
    model: extractModelName(data),
    timings: data.timings ?? null,
  }
}

// --- Streaming (spec §2.2–§2.5) ---

export interface ToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

export interface ToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

// One parsed unit of the SSE stream. `tool-calls` carries the FULL merged
// array accumulated so far (mirroring the fork's onToolCallChunk), so the
// consumer can just keep the last one it saw.
export type StreamDelta =
  | { kind: 'content'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-calls'; toolCalls: ToolCall[] }
  | { kind: 'model'; model: string }
  | { kind: 'timings'; timings: unknown }
  | { kind: 'finish'; finishReason: string | null }

// Merge streamed tool-call deltas into the running aggregate (spec §2.3):
// `function.arguments` concatenates, everything else overwrites on match.
// `indexOffset` supports multi-batch streams where a later run of tool-call
// deltas restarts at index 0 after intervening content/reasoning text.
export function mergeToolCallDeltas(
  existing: ToolCall[],
  deltas: ToolCallDelta[],
  indexOffset = 0,
): ToolCall[] {
  const result = existing.map((call) => ({
    ...call,
    function: call.function ? { ...call.function } : undefined,
  }))
  for (const delta of deltas) {
    const index =
      typeof delta.index === 'number' && delta.index >= 0
        ? delta.index + indexOffset
        : result.length
    while (result.length <= index) result.push({ function: undefined })
    const target = result[index]!
    if (delta.id) target.id = delta.id
    if (delta.type) target.type = delta.type
    if (delta.function) {
      const fn = target.function ? { ...target.function } : {}
      if (delta.function.name) fn.name = delta.function.name
      if (delta.function.arguments) {
        fn.arguments = (fn.arguments ?? '') + delta.function.arguments
      }
      target.function = fn
    }
  }
  return result
}

interface StreamChunk {
  id?: string
  model?: unknown
  choices?: Array<{
    delta?: {
      content?: unknown
      reasoning_content?: unknown
      model?: unknown
      tool_calls?: ToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  timings?: unknown
}

// First non-empty model name for a streaming chunk: root `model`, then
// `choices[0].delta.model` (spec §2.4; `metadata.model` intentionally unread).
function extractStreamModelName(chunk: StreamChunk): string | null {
  const candidates = [chunk.model, chunk.choices?.[0]?.delta?.model]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }
  return null
}

// Default stall watchdog: how long the provider may go with NO bytes on the
// wire (headers pending or mid-stream silence) before the run gives up. Two
// minutes tolerates slow prompt processing on local llama-server while still
// guaranteeing a hung socket can never pin a run forever. Overridable per
// call; the runner reads PROVIDER_STALL_TIMEOUT_MS for the process default.
export const DEFAULT_STALL_TIMEOUT_MS = 120_000

// POST with `stream: true` and yield deltas until `data: [DONE]`. Lines that
// don't start with `data:` (SSE ping comments) are ignored; malformed JSON
// lines are skipped. A stream that ends without the [DONE] sentinel is a
// provider failure and throws — callers keep whatever was yielded so far.
// Aborting `signal` surfaces as the usual AbortError from fetch/read.
//
// A stall watchdog guards every wait on the provider (the fetch itself and
// each reader.read()): if `stallTimeoutMs` passes without any bytes, the
// transport is aborted internally and a PLAIN Error (not AbortError) is
// thrown, so callers treat a silently-hung provider exactly like any other
// terminal provider failure — partial output was already yielded.
export async function* streamChat(
  provider: ProviderConfig,
  model: string | null,
  messages: ChatMessage[],
  signal?: AbortSignal,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
  tools?: unknown[],
): AsyncGenerator<StreamDelta, void, undefined> {
  const request = buildChatRequest(provider, model, messages, { stream: true, tools })

  // The watchdog aborts through its own controller, merged with the caller's
  // cancel signal, so a stall tears down the socket without the caller's
  // signal ever firing. `stalled` disambiguates the resulting abort.
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
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: fetchSignal,
    })
  } catch (error) {
    disarmStallWatchdog()
    if (stalled && !signal?.aborted) throw stallError()
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new Error(
      `Unable to reach the provider at ${provider.base_url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  disarmStallWatchdog()

  if (!response.ok) {
    // The error body is read under the watchdog too — a provider that sends
    // 4xx/5xx headers and then hangs the body must not pin the caller.
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
    throw new Error(parseErrorMessage(response.status, errorText))
  }
  if (!response.body) {
    throw new Error(NO_RESPONSE_MESSAGE)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let modelEmitted = false
  let aggregatedToolCalls: ToolCall[] = []
  let toolCallIndexOffset = 0
  let sawDone = false

  try {
    while (!sawDone) {
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
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (payload === '[DONE]') {
          sawDone = true
          break
        }

        let chunk: StreamChunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }

        const choice = chunk.choices?.[0]

        const content = choice?.delta?.content
        if (typeof content === 'string' && content.length > 0) {
          // Text after tool-call deltas closes the open batch (spec §2.3).
          toolCallIndexOffset = aggregatedToolCalls.length
          yield { kind: 'content', text: content }
        }

        const reasoning = choice?.delta?.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          toolCallIndexOffset = aggregatedToolCalls.length
          yield { kind: 'reasoning', text: reasoning }
        }

        const toolCallDeltas = choice?.delta?.tool_calls
        if (Array.isArray(toolCallDeltas) && toolCallDeltas.length > 0) {
          aggregatedToolCalls = mergeToolCallDeltas(
            aggregatedToolCalls,
            toolCallDeltas,
            toolCallIndexOffset,
          )
          yield { kind: 'tool-calls', toolCalls: aggregatedToolCalls }
        }

        if (!modelEmitted) {
          const modelName = extractStreamModelName(chunk)
          if (modelName) {
            modelEmitted = true
            yield { kind: 'model', model: modelName }
          }
        }

        if (chunk.timings != null) {
          yield { kind: 'timings', timings: chunk.timings }
        }

        if (choice?.finish_reason != null) {
          // Read but never hard-fail on the value (spec §2.2).
          yield { kind: 'finish', finishReason: choice.finish_reason }
        }
      }
    }
  } finally {
    disarmStallWatchdog()
    // Release the connection whether we finished, threw, or were cancelled.
    await reader.cancel().catch(() => {})
  }

  if (!sawDone) {
    // Some runtimes resolve an aborted body read as {done: true} instead of
    // rejecting — surface the stall rather than the generic truncation error.
    if (stalled && !signal?.aborted) throw stallError()
    throw new Error('The stream ended unexpectedly. Please try again.')
  }
}
