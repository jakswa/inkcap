import { sql } from '../db/client'
import {
  createProvider,
  getProviderByName,
  setProviderEnabled,
  updateProvider,
} from '../db/queries/providers'
import { normalizeBaseUrl } from '../utils/providers'

const name = 'llama-server'

try {
  const baseUrl = process.env['DEV_LLAMA_SERVER']
  const apiKey = process.env['DEV_LLAMA_KEY'] ?? null

  if (!baseUrl) {
    throw new Error('Missing required environment variable: DEV_LLAMA_SERVER')
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const existing = await getProviderByName(name)

  if (existing) {
    await updateProvider({
      id: existing.id,
      name,
      kind: 'llama-server',
      baseUrl: normalizedBaseUrl,
      apiKey,
      defaultModel: existing.default_model,
    })
    if (!existing.enabled) {
      await setProviderEnabled({ id: existing.id, enabled: true })
    }
    console.log(`Updated provider "${name}" (${normalizedBaseUrl})`)
  } else {
    await createProvider({
      name,
      kind: 'llama-server',
      baseUrl: normalizedBaseUrl,
      apiKey,
      enabled: true,
    })
    console.log(`Created provider "${name}" (${normalizedBaseUrl})`)
  }
} finally {
  await sql.close()
}
