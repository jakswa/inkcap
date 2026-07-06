import { Hono } from 'hono'
import {
  createProvider,
  deleteProvider,
  getProviderById,
  listProviders,
  setProviderEnabled,
  updateProvider,
} from '../db/queries/providers'
import { maskApiKey, normalizeBaseUrl, testProviderConnection } from '../utils/providers'
import { readString } from '../utils/validation'

export const providerRoutes = new Hono()

const maxNameLength = 200
const maxUrlLength = 2048
const validKinds = new Set(['openai-compat', 'llama-server'])

function toProviderView<T extends { api_key: string | null }>(provider: T) {
  return { ...provider, maskedApiKey: maskApiKey(provider.api_key) }
}

type ProviderFormValues = {
  name: string
  kind: string
  baseUrl: string
  apiKey: string
  clearApiKey: boolean
  defaultModel: string
}

function readProviderForm(form: FormData): ProviderFormValues {
  return {
    name: readString(form, 'name').trim(),
    kind: readString(form, 'kind').trim(),
    baseUrl: readString(form, 'base_url').trim(),
    apiKey: readString(form, 'api_key').trim(),
    clearApiKey: readString(form, 'clear_api_key') === 'on',
    defaultModel: readString(form, 'default_model').trim(),
  }
}

function validateProviderForm(values: ProviderFormValues): string[] {
  const errors: string[] = []

  if (!values.name) errors.push('Name is required')
  if (values.name.length > maxNameLength) {
    errors.push(`Name must be ${maxNameLength} characters or fewer`)
  }
  if (!validKinds.has(values.kind)) errors.push('Kind must be openai-compat or llama-server')
  if (!values.baseUrl) errors.push('Base URL is required')
  if (values.baseUrl.length > maxUrlLength) {
    errors.push(`Base URL must be ${maxUrlLength} characters or fewer`)
  }
  if (values.baseUrl && !/^https?:\/\//i.test(values.baseUrl)) {
    errors.push('Base URL must start with http:// or https://')
  }

  return errors
}

providerRoutes.get('/providers', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  c.header('Cache-Control', 'private, no-store')
  const providers = await listProviders()
  return c.var.render('providers/index', {
    title: 'Providers',
    providers: providers.map(toProviderView),
    testResult: null,
  })
})

providerRoutes.post('/providers/:id/test', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const id = c.req.param('id')
  const provider = await getProviderById(id)
  if (!provider) return c.notFound()

  const result = await testProviderConnection(provider)
  const providers = await listProviders()

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
    values: { name: '', kind: 'llama-server', baseUrl: '', apiKey: '', defaultModel: '' },
  })
})

providerRoutes.post('/providers', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const form = await c.req.formData()
  const values = readProviderForm(form)
  const errors = validateProviderForm(values)

  if (errors.length > 0) {
    return c.var.render('providers/new', {
      title: 'Add provider',
      errors,
      values,
    })
  }

  await createProvider({
    name: values.name,
    kind: values.kind as 'openai-compat' | 'llama-server',
    baseUrl: normalizeBaseUrl(values.baseUrl),
    apiKey: values.apiKey || null,
    defaultModel: values.defaultModel || null,
    enabled: true,
  })

  return c.redirect('/providers')
})

providerRoutes.get('/providers/:id/edit', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const provider = await getProviderById(c.req.param('id'))
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
    },
  })
})

providerRoutes.post('/providers/:id', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  const id = c.req.param('id')
  const provider = await getProviderById(id)
  if (!provider) return c.notFound()

  const form = await c.req.formData()
  const values = readProviderForm(form)
  const errors = validateProviderForm(values)

  if (errors.length > 0) {
    return c.var.render('providers/edit', {
      title: 'Edit provider',
      errors,
      provider: toProviderView(provider),
      values,
    })
  }

  // The stored key is never sent back to the browser, so the field always
  // renders empty. A blank submission means "keep the current key"; the
  // explicit "clear stored API key" checkbox is the only way to remove it.
  const apiKey = values.clearApiKey ? null : values.apiKey ? values.apiKey : provider.api_key

  await updateProvider({
    id,
    name: values.name,
    kind: values.kind as 'openai-compat' | 'llama-server',
    baseUrl: normalizeBaseUrl(values.baseUrl),
    apiKey,
    defaultModel: values.defaultModel || null,
  })

  return c.redirect('/providers')
})

providerRoutes.post('/providers/:id/enable', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  await setProviderEnabled({ id: c.req.param('id'), enabled: true })
  return c.redirect('/providers')
})

providerRoutes.post('/providers/:id/disable', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  await setProviderEnabled({ id: c.req.param('id'), enabled: false })
  return c.redirect('/providers')
})

providerRoutes.post('/providers/:id/delete', async (c) => {
  if (!c.var.user) return c.redirect('/login')

  await deleteProvider(c.req.param('id'))
  return c.redirect('/providers')
})
