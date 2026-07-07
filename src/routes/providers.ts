import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  type CodexOauthCredentials,
  type ProviderKind,
  type ProviderModelMetadata,
  createProvider,
  deleteProvider,
  getProviderForUser,
  listProvidersForUser,
  setProviderEnabled,
  updateProvider,
  updateProviderOauthCredentials,
} from '../db/queries/providers'
import {
  codexDefaultBaseUrl,
  completeCodexLoginFromCallbackUrl,
  startCodexLogin,
} from '../services/codex-auth'
import {
  CODEX_FALLBACK_MODELS,
  codexModelMetadata,
  fetchCodexModels,
} from '../services/codex-client'
import {
  maskApiKey,
  normalizeBaseUrl,
  testProviderConnection,
  uniqueModels,
} from '../utils/providers'
import { publicOrigin } from '../utils/public-origin'
import { readString } from '../utils/validation'

export const providerRoutes = new Hono()

const maxNameLength = 200
const maxUrlLength = 2048
const maxModelLength = 200
const maxModels = 200
const validKinds = new Set(['openai-compat', 'llama-server', 'openai-codex'])

// Views never receive the OAuth token bundle — only its presence and the
// (non-secret) account id for display.
function toProviderView<
  T extends { api_key: string | null; oauth_credentials?: unknown },
>(provider: T) {
  const { oauth_credentials, ...rest } = provider
  const credentials = (oauth_credentials ?? null) as CodexOauthCredentials | null
  return {
    ...rest,
    maskedApiKey: maskApiKey(provider.api_key),
    oauthConnected: Boolean(credentials?.access_token),
    oauthAccountId: credentials?.account_id ?? null,
  }
}

type ProviderFormValues = {
  name: string
  kind: string
  baseUrl: string
  apiKey: string
  clearApiKey: boolean
  defaultModel: string
  modelsText: string
}

function emptyProviderFormValues(): ProviderFormValues {
  return {
    name: '',
    kind: 'llama-server',
    baseUrl: '',
    apiKey: '',
    clearApiKey: false,
    defaultModel: '',
    modelsText: '',
  }
}

function readProviderForm(form: FormData): ProviderFormValues {
  return {
    name: readString(form, 'name').trim(),
    kind: readString(form, 'kind').trim(),
    baseUrl: readString(form, 'base_url').trim(),
    apiKey: readString(form, 'api_key').trim(),
    clearApiKey: readString(form, 'clear_api_key') === 'on',
    defaultModel: readString(form, 'default_model').trim(),
    modelsText: readString(form, 'models').trim(),
  }
}

function parseModelList(raw: string): string[] {
  return uniqueModels(raw.split(/[\n,]/g))
}

function modelsText(models: string[]) {
  return models.join('\n')
}

function validateProviderForm(values: ProviderFormValues): string[] {
  const errors: string[] = []

  if (!values.name) errors.push('Name is required')
  if (values.name.length > maxNameLength) {
    errors.push(`Name must be ${maxNameLength} characters or fewer`)
  }
  if (!validKinds.has(values.kind)) {
    errors.push('Kind must be openai-compat, llama-server, or openai-codex')
  }
  if (!values.baseUrl) errors.push('Base URL is required')
  if (values.baseUrl.length > maxUrlLength) {
    errors.push(`Base URL must be ${maxUrlLength} characters or fewer`)
  }
  if (values.baseUrl && !/^https?:\/\//i.test(values.baseUrl)) {
    errors.push('Base URL must start with http:// or https://')
  }
  if (values.defaultModel.length > maxModelLength) {
    errors.push(`Default model must be ${maxModelLength} characters or fewer`)
  }

  const models = parseModelList(values.modelsText)
  if (models.length > maxModels) {
    errors.push(`Model list must contain ${maxModels} models or fewer`)
  }
  if (models.some((model) => model.length > maxModelLength)) {
    errors.push(`Each model must be ${maxModelLength} characters or fewer`)
  }
  if (values.clearApiKey && values.apiKey) {
    errors.push('Choose one: clear the stored API key, or enter a replacement — not both')
  }

  return errors
}

function mergeTestedModels(inputModels: string[], defaultModel: string, testModels: string[]) {
  return uniqueModels([
    ...(defaultModel ? [defaultModel] : []),
    ...inputModels,
    ...testModels,
  ])
}

function mergeModelMetadata(
  models: string[],
  metadata: ProviderModelMetadata | undefined,
): ProviderModelMetadata {
  const result: ProviderModelMetadata = { ...(metadata ?? {}) }
  for (const model of models) {
    result[model] ??= {
      capabilities: ['text'],
      reasoning: false,
      contextSize: null,
      source: null,
    }
  }
  return result
}

providerRoutes.get('/providers', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  c.header('Cache-Control', 'private, no-store')
  const providers = await listProvidersForUser(user.id)
  return c.var.render('providers/index', {
    title: 'Providers',
    providers: providers.map(toProviderView),
    testResult: null,
  })
})

providerRoutes.post('/providers/:id/test', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const id = c.req.param('id')
  const provider = await getProviderForUser({ id, userId: user.id })
  if (!provider) return c.notFound()

  const result = await testProviderConnection(provider)
  const providers = await listProvidersForUser(user.id)

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('providers/index', {
    title: 'Providers',
    providers: providers.map(toProviderView),
    testResult: { providerId: id, result },
  })
})

providerRoutes.get('/providers/new', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  return c.var.render('providers/new', {
    title: 'Add provider',
    errors: [],
    values: emptyProviderFormValues(),
    testResult: null,
  })
})

providerRoutes.post('/providers', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const form = await c.req.formData()
  const values = readProviderForm(form)
  const errors = validateProviderForm(values)
  if (values.kind === 'openai-codex') {
    errors.push('ChatGPT Codex providers are added with the "Sign in with ChatGPT" button, not this form')
  }

  if (errors.length > 0) {
    return c.var.render('providers/new', {
      title: 'Add provider',
      errors,
      values,
      testResult: null,
    })
  }

  const normalizedBaseUrl = normalizeBaseUrl(values.baseUrl)
  const inputModels = parseModelList(values.modelsText)
  const testResult = await testProviderConnection({
    kind: values.kind,
    base_url: normalizedBaseUrl,
    api_key: values.apiKey || null,
    default_model: values.defaultModel || null,
    models: inputModels,
  })

  if (!testResult.ok) {
    const discoveredModels = testResult.models ?? []
    return c.var.render('providers/new', {
      title: 'Add provider',
      errors: ['Provider test must pass before it can be added', testResult.error],
      values: {
        ...values,
        baseUrl: normalizedBaseUrl,
        modelsText: modelsText(mergeTestedModels(inputModels, values.defaultModel, discoveredModels)),
      },
      testResult,
    })
  }

  const models = mergeTestedModels(inputModels, values.defaultModel, testResult.models)
  const defaultModel = values.defaultModel || testResult.inferenceModel || models[0] || null
  const savedModels = mergeTestedModels(models, defaultModel ?? '', [])

  await createProvider({
    // Personal account id === user id (migration 012); when shared accounts
    // grow a picker, this is the one line that changes.
    accountId: user.id,
    name: values.name,
    kind: values.kind as ProviderKind,
    baseUrl: normalizedBaseUrl,
    apiKey: values.apiKey || null,
    defaultModel,
    models: savedModels,
    modelMetadata: mergeModelMetadata(savedModels, testResult.modelMetadata),
    enabled: true,
  })

  return c.redirect('/providers')
})

const defaultCodexName = 'ChatGPT Codex'

function appOrigin(c: Context) {
  return publicOrigin() ?? new URL(c.req.url).origin
}

// Login completion for a NEW codex provider: persist the token bundle first
// (the row is the canonical credential store), then best-effort model
// discovery — a changed /models endpoint must not strand a fresh login.
// The OAuth callback arrives sessionless on the loopback listener, so the
// owning account is captured here, when the signed-in user starts the flow.
async function connectCodexProvider(
  accountId: string,
  name: string,
  credentials: CodexOauthCredentials,
) {
  const provider = await createProvider({
    accountId,
    name,
    kind: 'openai-codex',
    baseUrl: codexDefaultBaseUrl(),
    oauthCredentials: credentials,
    enabled: true,
  })

  let models = [...CODEX_FALLBACK_MODELS]
  let modelMetadata = codexModelMetadata(models)
  try {
    const discovered = await fetchCodexModels({
      id: provider.id,
      kind: 'openai-codex',
      base_url: provider.base_url,
      api_key: null,
    })
    models = discovered.models
    modelMetadata = discovered.modelMetadata
  } catch (error) {
    console.error('codex model discovery failed; keeping the fallback list', error)
  }
  await updateProvider({
    id: provider.id,
    name,
    kind: 'openai-codex',
    baseUrl: provider.base_url,
    apiKey: null,
    defaultModel: models[0] ?? null,
    models,
    modelMetadata,
  })
}

function codexLoginError(c: Context, error: unknown) {
  c.status(500)
  return c.var.render('error', {
    title: 'ChatGPT sign-in could not start',
    status: 500,
    message: error instanceof Error ? error.message : String(error),
  })
}

providerRoutes.post('/providers/codex/connect', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const form = await c.req.formData()
  const name = (readString(form, 'name').trim() || defaultCodexName).slice(0, maxNameLength)
  const returnTo = `${appOrigin(c)}/providers`
  const accountId = user.id

  try {
    const { authorizeUrl } = startCodexLogin({
      returnTo,
      complete: async (credentials) => {
        await connectCodexProvider(accountId, name, credentials)
        return returnTo
      },
    })
    return c.redirect(authorizeUrl)
  } catch (error) {
    return codexLoginError(c, error)
  }
})

providerRoutes.post('/providers/codex/callback', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const form = await c.req.formData()
  const callbackUrl = readString(form, 'callback_url').trim()
  try {
    const redirectTo = await completeCodexLoginFromCallbackUrl(callbackUrl)
    return c.redirect(redirectTo)
  } catch (error) {
    c.status(400)
    return c.var.render('providers/new', {
      title: 'Add provider',
      errors: [error instanceof Error ? error.message : String(error)],
      values: emptyProviderFormValues(),
      testResult: null,
    })
  }
})

providerRoutes.post('/providers/:id/reauth', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const id = c.req.param('id')
  const provider = await getProviderForUser({ id, userId: user.id })
  if (!provider || provider.kind !== 'openai-codex') return c.notFound()

  const returnTo = `${appOrigin(c)}/providers`
  try {
    const { authorizeUrl } = startCodexLogin({
      returnTo,
      complete: async (credentials) => {
        await updateProviderOauthCredentials({ id, oauthCredentials: credentials })
        return returnTo
      },
    })
    return c.redirect(authorizeUrl)
  } catch (error) {
    return codexLoginError(c, error)
  }
})

providerRoutes.get('/providers/:id/edit', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const provider = await getProviderForUser({ id: c.req.param('id'), userId: user.id })
  if (!provider) return c.notFound()

  return c.var.render('providers/edit', {
    title: 'Edit provider',
    errors: [],
    provider: toProviderView(provider),
    values: {
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.base_url,
      apiKey: '',
      defaultModel: provider.default_model ?? '',
      modelsText: modelsText(provider.models ?? []),
    },
    testResult: null,
  })
})

providerRoutes.post('/providers/:id', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const id = c.req.param('id')
  const provider = await getProviderForUser({ id, userId: user.id })
  if (!provider) return c.notFound()

  const form = await c.req.formData()
  const values = readProviderForm(form)
  // A codex provider's kind is fixed at connect time; the edit form carries it
  // in a hidden field, but never trust the browser with a kind change here.
  if (provider.kind === 'openai-codex') values.kind = 'openai-codex'
  const errors = validateProviderForm(values)

  if (errors.length > 0) {
    return c.var.render('providers/edit', {
      title: 'Edit provider',
      errors,
      provider: toProviderView(provider),
      values,
      testResult: null,
    })
  }

  // The stored key is never sent back to the browser, so the field always
  // renders empty. A blank submission means "keep the current key"; the
  // explicit "clear stored API key" checkbox is the only way to remove it.
  const apiKey =
    provider.kind === 'openai-codex'
      ? null
      : values.clearApiKey
        ? null
        : values.apiKey
          ? values.apiKey
          : provider.api_key
  const normalizedBaseUrl = normalizeBaseUrl(values.baseUrl)
  const inputModels = parseModelList(values.modelsText)
  const testResult = await testProviderConnection({
    id,
    kind: values.kind,
    base_url: normalizedBaseUrl,
    api_key: apiKey,
    default_model: values.defaultModel || null,
    models: inputModels,
  })

  if (!testResult.ok) {
    const discoveredModels = testResult.models ?? []
    return c.var.render('providers/edit', {
      title: 'Edit provider',
      errors: ['Provider test must pass before changes are saved', testResult.error],
      provider: toProviderView(provider),
      values: {
        ...values,
        baseUrl: normalizedBaseUrl,
        modelsText: modelsText(mergeTestedModels(inputModels, values.defaultModel, discoveredModels)),
      },
      testResult,
    })
  }

  const models = mergeTestedModels(inputModels, values.defaultModel, testResult.models)
  const defaultModel = values.defaultModel || testResult.inferenceModel || models[0] || null
  const savedModels = mergeTestedModels(models, defaultModel ?? '', [])

  await updateProvider({
    id,
    name: values.name,
    kind: values.kind as ProviderKind,
    baseUrl: normalizedBaseUrl,
    apiKey,
    defaultModel,
    models: savedModels,
    modelMetadata: mergeModelMetadata(savedModels, testResult.modelMetadata),
  })

  return c.redirect('/providers')
})

providerRoutes.post('/providers/:id/enable', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const provider = await getProviderForUser({ id: c.req.param('id'), userId: user.id })
  if (!provider) return c.notFound()

  await setProviderEnabled({ id: provider.id, enabled: true })
  return c.redirect('/providers')
})

providerRoutes.post('/providers/:id/disable', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const provider = await getProviderForUser({ id: c.req.param('id'), userId: user.id })
  if (!provider) return c.notFound()

  await setProviderEnabled({ id: provider.id, enabled: false })
  return c.redirect('/providers')
})

providerRoutes.post('/providers/:id/delete', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  const provider = await getProviderForUser({ id: c.req.param('id'), userId: user.id })
  if (!provider) return c.notFound()

  await deleteProvider(provider.id)
  return c.redirect('/providers')
})
