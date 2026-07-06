import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

// The global MCP server catalog. `headers` is a JSON object of extra connection
// headers; `request_timeout_ms` bounds tool calls and handshakes.

export async function createMcpServer(input: {
  name: string
  url: string
  enabled?: boolean
  autoApprove?: boolean
  headers?: unknown
  requestTimeoutMs?: number
}) {
  const [server] = await sql.CreateMcpServer`
    INSERT INTO mcp_servers (id, name, url, enabled, auto_approve, headers, request_timeout_ms)
    VALUES (
      ${randomUUIDv7()},
      ${input.name},
      ${input.url},
      ${input.enabled ?? true},
      ${input.autoApprove ?? false},
      ${input.headers ?? null},
      ${input.requestTimeoutMs ?? 30000}
    )
    RETURNING id, name, url, enabled, auto_approve, headers, request_timeout_ms,
              created_at, updated_at
  `

  return server
}

export async function getMcpServerById(id: string) {
  const [server] = await sql.GetMcpServerById`
    SELECT id, name, url, enabled, auto_approve, headers, request_timeout_ms,
           created_at, updated_at
    FROM mcp_servers
    WHERE id = ${id}
  `

  return server
}

export async function listMcpServers() {
  return sql.ListMcpServers`
    SELECT id, name, url, enabled, auto_approve, headers, request_timeout_ms,
           created_at, updated_at
    FROM mcp_servers
    ORDER BY created_at ASC
  `
}

export async function updateMcpServer(input: {
  id: string
  name: string
  url: string
  autoApprove: boolean
  headers?: unknown
  requestTimeoutMs: number
}) {
  const [server] = await sql.UpdateMcpServer`
    UPDATE mcp_servers
    SET name = ${input.name},
        url = ${input.url},
        auto_approve = ${input.autoApprove},
        headers = ${input.headers ?? null},
        request_timeout_ms = ${input.requestTimeoutMs},
        updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, name, url, enabled, auto_approve, headers, request_timeout_ms,
              created_at, updated_at
  `

  return server
}

export async function setMcpServerEnabled(input: { id: string; enabled: boolean }) {
  const [server] = await sql.SetMcpServerEnabled`
    UPDATE mcp_servers
    SET enabled = ${input.enabled}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, name, url, enabled, auto_approve, headers, request_timeout_ms,
              created_at, updated_at
  `

  return server
}

export async function deleteMcpServer(id: string) {
  await sql.DeleteMcpServer`
    DELETE FROM mcp_servers WHERE id = ${id}
  `
}

// --- Per-conversation overrides (docs/specs/mcp-and-ux.md §A.4) ---

// Upsert a conversation's override for one server. enabled = true turns the
// server on for the conversation; enabled = false leaves an explicit off row
// (behaviourally identical to no row, but keeps the toggle sticky in the UI).
export async function setConversationMcpOverride(input: {
  conversationId: string
  mcpServerId: string
  enabled: boolean
}) {
  const [override] = await sql.SetConversationMcpOverride`
    INSERT INTO conversation_mcp_servers (conversation_id, mcp_server_id, enabled)
    VALUES (${input.conversationId}, ${input.mcpServerId}, ${input.enabled})
    ON CONFLICT (conversation_id, mcp_server_id)
    DO UPDATE SET enabled = ${input.enabled}, updated_at = now()
    RETURNING conversation_id, mcp_server_id, enabled, created_at, updated_at
  `

  return override
}

// Every catalog server with the conversation's override state attached (null
// when there is no override row). Drives the per-conversation tools picker.
export async function listMcpServersWithOverride(conversationId: string) {
  return sql.ListMcpServersWithOverride`
    SELECT s.id, s.name, s.url, s.enabled, s.auto_approve,
           s.request_timeout_ms, s.created_at, s.updated_at,
           cms.enabled AS override_enabled
    FROM mcp_servers s
    LEFT JOIN conversation_mcp_servers cms
      ON cms.mcp_server_id = s.id AND cms.conversation_id = ${conversationId}
    ORDER BY s.created_at ASC
  `
}

// The servers whose tools are exposed to the model for this conversation:
// override enabled = true AND the server not globally disabled (the global
// flag acts as a kill-switch; see the runner notes).
export async function listEnabledMcpServersForConversation(conversationId: string) {
  return sql.ListEnabledMcpServersForConversation`
    SELECT s.id, s.name, s.url, s.enabled, s.auto_approve, s.headers,
           s.request_timeout_ms, s.created_at, s.updated_at
    FROM mcp_servers s
    JOIN conversation_mcp_servers cms
      ON cms.mcp_server_id = s.id AND cms.conversation_id = ${conversationId}
    WHERE cms.enabled = true AND s.enabled = true
    ORDER BY s.created_at ASC
  `
}
