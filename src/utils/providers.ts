import { completeOnce } from '../services/provider-client'
import type { ProviderModelInfo, ProviderModelMetadata } from '../db/queries/providers'
import { assertSafeOutboundUrl } from './outbound-url'

export type ProviderKind = 'openai-compat' | 'llama-server' | 'openai-codex'

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
  | {
      ok: true
      models: string[]
      modelMetadata: ProviderModelMetadata
      contextSize: number | null
      inferenceModel: string | null
      inferenceText: string
    }
  | {
      ok: false
      error: string
      models?: string[]
      modelMetadata?: ProviderModelMetadata
      contextSize?: number | null
    }

const testTimeoutMs = 5000

export async function testProviderConnection(provider: {
  id?: string
  kind: string
  base_url: string
  api_key: string | null
  default_model?: string | null
  models?: string[] | null
}): Promise<ProviderTestResult> {
  const discovery = await discoverProviderModels(provider)
  if (!discovery.ok) return discovery

  const candidates = uniqueModels([
    ...(provider.default_model ? [provider.default_model] : []),
    ...(provider.models ?? []),
    ...discovery.models,
  ])
  const inferenceModel = candidates[0] ?? null

  try {
    const completion = await completeOnce(
      {
        id: provider.id,
        kind: provider.kind,
        base_url: provider.base_url,
        api_key: provider.api_key,
      },
      inferenceModel,
      [{ role: 'user', content: 'Reply with only: OK' }],
      { signal: AbortSignal.timeout(testTimeoutMs) },
    )
    const models = uniqueModels([
      ...discovery.models,
      ...(completion.model ? [completion.model] : []),
    ])
    return {
      ok: true,
      models,
      modelMetadata: ensureMetadataForModels(discovery.modelMetadata, models),
      contextSize: discovery.contextSize,
      inferenceModel: completion.model ?? inferenceModel,
      inferenceText: completion.content.trim().slice(0, 120),
    }
  } catch (error) {
    return {
      ok: false,
      error: `Model inference failed: ${describeError(error)}`,
      models: discovery.models,
      modelMetadata: discovery.modelMetadata,
      contextSize: discovery.contextSize,
    }
  }
}

async function discoverProviderModels(provider: {
  id?: string
  kind: string
  base_url: string
  api_key: string | null
}): Promise<ProviderTestResult> {
  if (provider.kind === 'openai-codex') {
    try {
      const { fetchCodexModels } = await import('../services/codex-client')
      const { models, modelMetadata } = await fetchCodexModels({
        id: provider.id,
        kind: provider.kind,
        base_url: provider.base_url,
        api_key: null,
      })
      return {
        ok: true,
        models,
        modelMetadata,
        contextSize: null,
        inferenceModel: null,
        inferenceText: '',
      }
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }
  if (provider.kind !== 'llama-server') return fetchModels(provider)

  const [propsResult, modelsResult] = await Promise.all([
    fetchProps(provider),
    fetchModels(provider),
  ])

  if (propsResult.ok && modelsResult.ok) {
    const modelProps = await fetchLlamaModelProps(provider, modelsResult.models)
    return mergeDiscoveryResults(propsResult, modelsResult, modelProps)
  }
  if (propsResult.ok) return propsResult
  if (modelsResult.ok) return modelsResult
  return propsResult
}

async function fetchProps(
  provider: { base_url: string; api_key: string | null },
  model?: string,
): Promise<ProviderTestResult> {
  try {
    const params = new URLSearchParams({ autoload: 'false' })
    if (model) params.set('model', model)
    const url = `${provider.base_url}/props?${params.toString()}`
    await assertSafeOutboundUrl(url)
    const res = await fetch(url, {
      headers: authHeaders(provider),
      redirect: 'manual',
      signal: AbortSignal.timeout(testTimeoutMs),
    })

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

    const data = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number }
      modalities?: { vision?: boolean; audio?: boolean; video?: boolean }
      chat_template?: string
      model_path?: string
    }

    const contextSize = data.default_generation_settings?.n_ctx
    const modelPath = data.model_path
    const modelName = model || (modelPath ? modelPath.split(/[\\/]/).pop() : undefined)
    const modelMetadata: ProviderModelMetadata = modelName
      ? { [modelName]: modelInfoFromProps(data, 'llama-server /props') }
      : {}

    return {
      ok: true,
      models: modelName ? [modelName] : [],
      modelMetadata,
      contextSize: typeof contextSize === 'number' ? contextSize : null,
      inferenceModel: null,
      inferenceText: '',
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
    const url = `${provider.base_url}/v1/models`
    await assertSafeOutboundUrl(url)
    const res = await fetch(url, {
      headers: authHeaders(provider),
      redirect: 'manual',
      signal: AbortSignal.timeout(testTimeoutMs),
    })

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

    const data = (await res.json()) as {
      data?: Array<{
        id?: string
        model?: string
        name?: string
        capabilities?: unknown
        modalities?: unknown
      }>
      models?: Array<{
        id?: string
        model?: string
        name?: string
        capabilities?: unknown
        modalities?: unknown
      }>
    }
    const entries = [
      ...(Array.isArray(data.data) ? data.data : []),
      ...(Array.isArray(data.models) ? data.models : []),
    ]
    const models = uniqueModels(
      entries.map((entry) => String(entry.id ?? entry.model ?? entry.name ?? '')),
    )
    const modelMetadata: ProviderModelMetadata = {}
    for (const entry of entries) {
      const name = String(entry.id ?? entry.model ?? entry.name ?? '').trim()
      if (!name) continue
      modelMetadata[name] = modelInfoFromModelEntry(entry)
    }

    return {
      ok: true,
      models,
      modelMetadata: ensureMetadataForModels(modelMetadata, models),
      contextSize: null,
      inferenceModel: null,
      inferenceText: '',
    }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

async function fetchLlamaModelProps(
  provider: { base_url: string; api_key: string | null },
  models: string[],
): Promise<ProviderModelMetadata> {
  const metadata: ProviderModelMetadata = {}
  for (const model of models.slice(0, 200)) {
    const result = await fetchProps(provider, model)
    if (result.ok) Object.assign(metadata, result.modelMetadata)
  }
  return metadata
}

function mergeDiscoveryResults(
  propsResult: Extract<ProviderTestResult, { ok: true }>,
  modelsResult: Extract<ProviderTestResult, { ok: true }>,
  extraMetadata: ProviderModelMetadata,
): Extract<ProviderTestResult, { ok: true }> {
  const modelMetadata: ProviderModelMetadata = {}
  Object.assign(modelMetadata, propsResult.modelMetadata)
  Object.assign(modelMetadata, modelsResult.modelMetadata)
  Object.assign(modelMetadata, extraMetadata)

  const unique = uniqueModels([...propsResult.models, ...modelsResult.models])
  return {
    ok: true,
    models: unique,
    modelMetadata: ensureMetadataForModels(modelMetadata, unique),
    contextSize: propsResult.contextSize ?? modelsResult.contextSize,
    inferenceModel: null,
    inferenceText: '',
  }
}

function modelInfoFromProps(
  data: {
    default_generation_settings?: { n_ctx?: number }
    modalities?: { vision?: boolean; audio?: boolean; video?: boolean }
    chat_template?: string
  },
  source: string,
): ProviderModelInfo {
  const modalities = data.modalities ?? {}
  const reasoning = detectThinkingSupport(data.chat_template ?? '')
  const capabilities = uniqueModels([
    'text',
    modalities.vision ? 'vision' : '',
    modalities.audio ? 'audio' : '',
    modalities.video ? 'video' : '',
    reasoning ? 'reasoning' : '',
  ]) as ProviderModelInfo['capabilities']

  return {
    capabilities,
    reasoning,
    contextSize:
      typeof data.default_generation_settings?.n_ctx === 'number'
        ? data.default_generation_settings.n_ctx
        : null,
    source,
  }
}

function modelInfoFromModelEntry(entry: {
  capabilities?: unknown
  modalities?: unknown
}): ProviderModelInfo {
  const capabilities = capabilitiesFromUnknown(entry.capabilities)
  const modalities = modalitiesFromUnknown(entry.modalities)
  const merged = uniqueModels([
    capabilities.length > 0 ? '' : 'text',
    ...capabilities,
    modalities.vision ? 'vision' : '',
    modalities.audio ? 'audio' : '',
    modalities.video ? 'video' : '',
  ]) as ProviderModelInfo['capabilities']
  return {
    capabilities: merged,
    reasoning: merged.includes('reasoning'),
    contextSize: null,
    source: '/v1/models',
  }
}

function capabilitiesFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item).toLowerCase()).filter(Boolean)
}

function modalitiesFromUnknown(value: unknown): {
  vision: boolean
  audio: boolean
  video: boolean
} {
  if (!value || typeof value !== 'object') {
    return { vision: false, audio: false, video: false }
  }
  const record = value as Record<string, unknown>
  return {
    vision: record.vision === true,
    audio: record.audio === true,
    video: record.video === true,
  }
}

function ensureMetadataForModels(
  metadata: ProviderModelMetadata,
  models: string[],
): ProviderModelMetadata {
  const result = { ...metadata }
  for (const model of models) {
    if (!result[model]) {
      result[model] = {
        capabilities: ['text'],
        reasoning: false,
        contextSize: null,
        source: null,
      }
    }
  }
  return result
}

function authHeaders(provider: { api_key: string | null }): HeadersInit {
  return provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}
}

export function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const model of models) {
    const value = model.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

// Copied from llama-ui's chat-template-thinking-detector in compact form. The
// server does not expose a dedicated supports-thinking flag yet.
function detectThinkingSupport(template: string): boolean {
  if (!template) return false
  for (const kwarg of ['enable_thinking', 'reasoning_effort', 'thinking_budget']) {
    const regex = new RegExp(
      `(\\{\\{[^{}]*\\b${kwarg}\\b[^{}]*\\}\\}|\\{%[^{}]*\\b${kwarg}\\b[^{}]*%\\})`,
      'i',
    )
    if (regex.test(template)) return true
  }

  const conditionals = [
    /\{%-?\s*if\s+\(?\s*\w*enable[\s_]+\w*(thinking|think|reasoning)/i,
    /\{%-?\s*if\s+\w*(thinking|reasoning)\s*(is not|==|!=)/i,
    /\{%-?\s*if\s+not\s+\w*enable/i,
    /\{%-?\s*if\s+ns\.enable_thinking/i,
  ]
  if (conditionals.some((regex) => regex.test(template))) return true

  const tags: Array<[string, string | null]> = [
    ['<think>', '</think>'],
    ['<|channel>thought', '<|channel|>'],
    ['<|think|>', '</|think|>'],
    ['<seed:think|>', '</seed:think|>'],
    ['<think></think>', null],
  ]
  return tags.some(([start, end]) => template.includes(start) && (!end || template.includes(end)))
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
