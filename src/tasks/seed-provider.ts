import { sql } from '../db/client'
import {
  type ProviderModelMetadata,
  createProvider,
  getProviderByNameForAccount,
  setProviderEnabled,
  updateProvider,
} from '../db/queries/providers'
import { getUserByEmailNormalized } from '../db/queries/users'
import { normalizeBaseUrl } from '../utils/providers'
import { normalizeEmail } from '../utils/validation'

const name = 'llama-server'

function readArg(flag: string): string | null {
  const index = Bun.argv.indexOf(flag)
  const value = index >= 0 ? Bun.argv[index + 1] : undefined
  return value ?? null
}

try {
  const baseUrl = process.env['DEV_LLAMA_SERVER']
  const apiKey = process.env['DEV_LLAMA_KEY'] ?? null
  const userEmail = readArg('--user')

  if (!baseUrl) {
    throw new Error('Missing required environment variable: DEV_LLAMA_SERVER')
  }
  if (!userEmail) {
    throw new Error('Usage: seed-provider --user <email> (providers are account-owned; register first)')
  }

  const user = await getUserByEmailNormalized(normalizeEmail(userEmail))
  if (!user) {
    throw new Error(`No user with email ${userEmail}; register first`)
  }

  // Personal account id === user id (migration 012).
  const accountId = user.id
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const existing = await getProviderByNameForAccount({ name, accountId })

  if (existing) {
    await updateProvider({
      id: existing.id,
      name,
      kind: 'llama-server',
      baseUrl: normalizedBaseUrl,
      apiKey,
      defaultModel: existing.default_model,
      models: existing.models ?? [],
      modelMetadata: existing.model_metadata as ProviderModelMetadata,
    })
    if (!existing.enabled) {
      await setProviderEnabled({ id: existing.id, enabled: true })
    }
    console.log(`Updated provider "${name}" (${normalizedBaseUrl}) for ${user.email}`)
  } else {
    await createProvider({
      accountId,
      name,
      kind: 'llama-server',
      baseUrl: normalizedBaseUrl,
      apiKey,
      enabled: true,
    })
    console.log(`Created provider "${name}" (${normalizedBaseUrl}) for ${user.email}`)
  }
} finally {
  await sql.close()
}
