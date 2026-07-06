import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

// Bun.SQL binds an empty JS array as '' (which array_in rejects), so encode
// the text[] literal ourselves; Postgres parses it against the column type.
function textArrayLiteral(values: string[]): string {
  const elements = values.map(
    (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
  )
  return `{${elements.join(',')}}`
}

export interface ProviderRow {
  id: string
  name: string
  kind: string
  base_url: string
  api_key: string | null
  default_model: string | null
  models: string[]
  model_metadata: ProviderModelMetadata
  oauth_credentials: CodexOauthCredentials | null
  enabled: boolean
  created_at: Date
  updated_at: Date
}

// Mirrors the Codex CLI's ~/.codex/auth.json `tokens` object plus its
// top-level last_refresh stamp. All three tokens are JWTs; refresh tokens
// ROTATE on every refresh, so this row is the single canonical store and
// every rotation must be written back before the old token is discarded.
export interface CodexOauthCredentials {
  id_token: string | null
  access_token: string
  refresh_token: string
  account_id: string | null
  last_refresh: string
}

export type ModelCapability = string

export interface ProviderModelInfo {
  capabilities: ModelCapability[]
  reasoning: boolean
  contextSize: number | null
  source: string | null
}

export type ProviderModelMetadata = Record<string, ProviderModelInfo>

export type ProviderKind = 'openai-compat' | 'llama-server' | 'openai-codex'

export async function createProvider(input: {
  accountId: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string | null
  defaultModel?: string | null
  models?: string[]
  modelMetadata?: ProviderModelMetadata
  oauthCredentials?: CodexOauthCredentials | null
  enabled?: boolean
}): Promise<ProviderRow> {
  const [provider] = await sql.CreateProvider`
    INSERT INTO providers (id, account_id, name, kind, base_url, api_key, default_model, models, model_metadata, oauth_credentials, enabled)
    VALUES (
      ${randomUUIDv7()},
      ${input.accountId},
      ${input.name},
      ${input.kind},
      ${input.baseUrl},
      ${input.apiKey ?? null},
      ${input.defaultModel ?? null},
      ${textArrayLiteral(input.models ?? [])},
      ${input.modelMetadata ?? {}},
      ${input.oauthCredentials ?? null},
      ${input.enabled ?? true}
    )
    RETURNING id, name, kind, base_url, api_key, default_model, models, model_metadata, oauth_credentials, enabled, created_at, updated_at
  `

  return provider as ProviderRow
}

// Internal, unscoped lookup — for callers that derived the id from a row the
// user already owns (the runner via conversations.provider_id, codex-auth
// token refresh). Routes must use getProviderForUser so a foreign id is
// indistinguishable from a missing one.
export async function getProviderById(id: string) {
  const [provider] = await sql.GetProviderById`
    SELECT id, name, kind, base_url, api_key, default_model, models, model_metadata, oauth_credentials, enabled, created_at, updated_at
    FROM providers
    WHERE id = ${id}
  `

  return provider
}

export async function getProviderForUser(input: { id: string; userId: string }) {
  const [provider] = await sql.GetProviderForUser`
    SELECT p.id, p.name, p.kind, p.base_url, p.api_key, p.default_model, p.models, p.model_metadata, p.oauth_credentials, p.enabled, p.created_at, p.updated_at
    FROM providers p
    JOIN account_memberships m ON m.account_id = p.account_id AND m.user_id = ${input.userId}
    WHERE p.id = ${input.id}
  `

  return provider
}

export async function listProvidersForUser(userId: string) {
  return sql.ListProvidersForUser`
    SELECT p.id, p.name, p.kind, p.base_url, p.api_key, p.default_model, p.models, p.model_metadata, p.oauth_credentials, p.enabled, p.created_at, p.updated_at
    FROM providers p
    JOIN account_memberships m ON m.account_id = p.account_id AND m.user_id = ${userId}
    ORDER BY p.created_at ASC
  `
}

export async function setProviderEnabled(input: { id: string; enabled: boolean }) {
  const [provider] = await sql.SetProviderEnabled`
    UPDATE providers
    SET enabled = ${input.enabled}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, name, kind, base_url, api_key, default_model, models, model_metadata, oauth_credentials, enabled, created_at, updated_at
  `

  return provider
}

export async function getProviderByNameForAccount(input: { name: string; accountId: string }) {
  const [provider] = await sql.GetProviderByNameForAccount`
    SELECT id, name, kind, base_url, api_key, default_model, models, model_metadata, oauth_credentials, enabled, created_at, updated_at
    FROM providers
    WHERE name = ${input.name} AND account_id = ${input.accountId}
  `

  return provider
}

export async function updateProvider(input: {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string | null
  defaultModel?: string | null
  models?: string[]
  modelMetadata?: ProviderModelMetadata
}): Promise<ProviderRow> {
  const [provider] = await sql.UpdateProvider`
    UPDATE providers
    SET name = ${input.name},
        kind = ${input.kind},
        base_url = ${input.baseUrl},
        api_key = ${input.apiKey ?? null},
        default_model = ${input.defaultModel ?? null},
        models = ${textArrayLiteral(input.models ?? [])},
        model_metadata = ${input.modelMetadata ?? {}},
        updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, name, kind, base_url, api_key, default_model, models, model_metadata, oauth_credentials, enabled, created_at, updated_at
  `

  return provider as ProviderRow
}

// Atomic write-back for token refresh/rotation and re-authentication. Never
// touches any other column so it can run concurrently with provider edits.
export async function updateProviderOauthCredentials(input: {
  id: string
  oauthCredentials: CodexOauthCredentials
}): Promise<ProviderRow | undefined> {
  const [provider] = await sql.UpdateProviderOauthCredentials`
    UPDATE providers
    SET oauth_credentials = ${input.oauthCredentials}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, name, kind, base_url, api_key, default_model, models, model_metadata, oauth_credentials, enabled, created_at, updated_at
  `

  return provider as ProviderRow | undefined
}

export async function deleteProvider(id: string) {
  await sql.DeleteProvider`
    DELETE FROM providers WHERE id = ${id}
  `
}
