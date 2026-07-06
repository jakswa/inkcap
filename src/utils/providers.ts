export type ProviderKind = 'openai-compat' | 'llama-server'

/**
 * Users often paste a base URL that already includes the OpenAI-compat
 * `/v1` suffix (copied straight from an API docs page). Store the origin
 * root instead so every call site can append `/v1/...` or `/props`
 * consistently.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  url = url.replace(/\/v1$/, '')
  url = url.replace(/\/+$/, '')
  return url
}

/**
 * Fixed-width mask so the UI never leaks the stored key's length. Shows at
 * most the last 4 characters.
 */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return 'Not set'
  if (key.length <= 4) return '•'.repeat(8)
  return `${'•'.repeat(8)}${key.slice(-4)}`
}

export type ProviderTestResult =
  | { ok: true; models: string[]; contextSize: number | null }
  | { ok: false; error: string }

const testTimeoutMs = 5000

export async function testProviderConnection(provider: {
  kind: string
  base_url: string
  api_key: string | null
}): Promise<ProviderTestResult> {
  if (provider.kind === 'llama-server') {
    const propsResult = await fetchProps(provider)
    if (propsResult.ok) return propsResult
    return fetchModels(provider)
  }

  return fetchModels(provider)
}

async function fetchProps(provider: {
  base_url: string
  api_key: string | null
}): Promise<ProviderTestResult> {
  try {
    const res = await fetch(`${provider.base_url}/props?autoload=false`, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(testTimeoutMs),
    })

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

    const data = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number }
      model_path?: string
    }

    const contextSize = data.default_generation_settings?.n_ctx
    const modelPath = data.model_path
    const modelName = modelPath ? modelPath.split(/[\\/]/).pop() : undefined

    return {
      ok: true,
      models: modelName ? [modelName] : [],
      contextSize: typeof contextSize === 'number' ? contextSize : null,
    }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

async function fetchModels(provider: {
  base_url: string
  api_key: string | null
}): Promise<ProviderTestResult> {
  try {
    const res = await fetch(`${provider.base_url}/v1/models`, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(testTimeoutMs),
    })

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

    const data = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = Array.isArray(data.data)
      ? data.data.map((model) => String(model?.id ?? '')).filter(Boolean)
      : []

    return { ok: true, models, contextSize: null }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

function authHeaders(provider: { api_key: string | null }): HeadersInit {
  return provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'Timed out'
    }
    return error.message
  }

  return 'Unknown error'
}
