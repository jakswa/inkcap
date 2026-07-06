// HTTP client for OpenAI-compatible chat completions.
//
// M2 speaks only the non-streaming subset: build a `/v1/chat/completions`
// request from a provider + model + the active-path messages, POST it with
// `stream: false`, and normalize the single response. M3 will extend this file
// with the streaming path — keep the request builder reusable and small.
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
): ChatRequest {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (provider.api_key && provider.api_key.length > 0) {
    headers.Authorization = `Bearer ${provider.api_key}`
  }

  const body: Record<string, unknown> = {
    messages,
    stream: false,
  }
  if (model && model.length > 0) {
    body.model = model
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
