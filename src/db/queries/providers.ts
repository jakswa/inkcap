import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function createProvider(input: {
  name: string
  kind: 'openai-compat' | 'llama-server'
  baseUrl: string
  apiKey?: string | null
  defaultModel?: string | null
  enabled?: boolean
}) {
  const [provider] = await sql.CreateProvider`
    INSERT INTO providers (id, name, kind, base_url, api_key, default_model, enabled)
    VALUES (
      ${randomUUIDv7()},
      ${input.name},
      ${input.kind},
      ${input.baseUrl},
      ${input.apiKey ?? null},
      ${input.defaultModel ?? null},
      ${input.enabled ?? true}
    )
    RETURNING id, name, kind, base_url, api_key, default_model, enabled, created_at, updated_at
  `

  return provider
}

export async function getProviderById(id: string) {
  const [provider] = await sql.GetProviderById`
    SELECT id, name, kind, base_url, api_key, default_model, enabled, created_at, updated_at
    FROM providers
    WHERE id = ${id}
  `

  return provider
}

export async function listProviders() {
  return sql.ListProviders`
    SELECT id, name, kind, base_url, api_key, default_model, enabled, created_at, updated_at
    FROM providers
    ORDER BY created_at ASC
  `
}

export async function setProviderEnabled(input: { id: string; enabled: boolean }) {
  const [provider] = await sql.SetProviderEnabled`
    UPDATE providers
    SET enabled = ${input.enabled}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, name, kind, base_url, api_key, default_model, enabled, created_at, updated_at
  `

  return provider
}

export async function getProviderByName(name: string) {
  const [provider] = await sql.GetProviderByName`
    SELECT id, name, kind, base_url, api_key, default_model, enabled, created_at, updated_at
    FROM providers
    WHERE name = ${name}
  `

  return provider
}

export async function updateProvider(input: {
  id: string
  name: string
  kind: 'openai-compat' | 'llama-server'
  baseUrl: string
  apiKey?: string | null
  defaultModel?: string | null
}) {
  const [provider] = await sql.UpdateProvider`
    UPDATE providers
    SET name = ${input.name},
        kind = ${input.kind},
        base_url = ${input.baseUrl},
        api_key = ${input.apiKey ?? null},
        default_model = ${input.defaultModel ?? null},
        updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, name, kind, base_url, api_key, default_model, enabled, created_at, updated_at
  `

  return provider
}

export async function deleteProvider(id: string) {
  await sql.DeleteProvider`
    DELETE FROM providers WHERE id = ${id}
  `
}
