// MCP client: connect to a Model Context Protocol server over streamable HTTP,
// list its tools, and call them. Tools from the servers enabled for a
// conversation are injected into the completion request as OpenAI-style
// function tools; when the model calls one, the runner routes it back here.
//
// Connections are short-lived here (connect → do work → close): the runner is a
// detached, restart-safe loop, so re-establishing a session on each phase is
// simpler and more robust than holding sockets across a parked approval than
// the fork's long-lived reference-counted connections buy us. Per-server
// request timeouts (request_timeout_ms) bound both the handshake and each call.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { assertSafeOutboundUrl } from '../utils/outbound-url'

const CLIENT_INFO = { name: 'inkcap', version: '1.0.0' }
const DEFAULT_TIMEOUT_MS = 30_000

// The subset of an mcp_servers row this service needs.
export interface McpServerConfig {
  id: string
  name: string
  url: string
  headers?: unknown
  request_timeout_ms?: number | null
  // Consumed by the runner to decide whether to skip the approval park.
  auto_approve?: boolean | null
}

// One OpenAI-compatible function tool as sent in the completion request.
export interface OpenAiTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

// Result of executing one tool call: text fed back to the model as the tool
// message content, plus whether the server flagged it as an error.
export interface ToolCallResult {
  content: string
  isError: boolean
}

function timeoutMs(server: McpServerConfig): number {
  const raw = server.request_timeout_ms
  return typeof raw === 'number' && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

// Parse the stored headers jsonb into a plain string map. Tolerates the value
// being stored as an object (normal) or a JSON string (defensive); a malformed
// value is swallowed with a warning, matching the fork's forgiving behaviour.
function parseHeaders(headers: unknown): Record<string, string> {
  if (!headers) return {}
  let value = headers
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      console.warn('mcp: ignoring unparseable headers')
      return {}
    }
  }
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw
  }
  return out
}

// Connect to one server (with a handshake timeout) and hand the live client to
// `fn`, always closing afterwards. Throws on connect failure or timeout.
async function withClient<T>(
  server: McpServerConfig,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await assertSafeOutboundUrl(server.url)
  const headers = parseHeaders(server.headers)
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  })
  const client = new Client(CLIENT_INFO)

  const limit = timeoutMs(server)
  let timer: ReturnType<typeof setTimeout> | null = null
  const handshake = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP server "${server.name}" timed out connecting`)),
      limit,
    )
  })

  try {
    await Promise.race([client.connect(transport), handshake])
    if (timer) clearTimeout(timer)
    return await fn(client)
  } finally {
    if (timer) clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

function toOpenAiTool(tool: McpTool): OpenAiTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }
}

// Extract the callable text of a tool result: join text content parts; fall
// back to a JSON dump so the model always sees *something* actionable.
function extractResultText(result: {
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
}): ToolCallResult {
  const parts = Array.isArray(result.content) ? result.content : []
  const text = parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
  const content = text.length > 0 ? text : JSON.stringify(parts)
  return { content, isError: result.isError === true }
}

// List one server's tools (used by the test-connection button and for building
// a name→server routing index).
export async function listServerTools(server: McpServerConfig): Promise<McpTool[]> {
  return withClient(server, async (client) => {
    const { tools } = await client.listTools()
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  })
}

export type McpTestResult =
  | { ok: true; tools: McpTool[] }
  | { ok: false; error: string }

// Server-side "test connection": connect + list tools, never throwing.
export async function testMcpConnection(server: McpServerConfig): Promise<McpTestResult> {
  try {
    const tools = await listServerTools(server)
    return { ok: true, tools }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// Gather the OpenAI tool definitions for a set of enabled servers. Servers are
// connected in parallel (allSettled) so one dead server never blocks the rest;
// on a tool-name collision the last server wins, matching the fork (§A.3).
export async function gatherTools(servers: McpServerConfig[]): Promise<{
  tools: OpenAiTool[]
  // tool name → server id, for routing a call back to its owner.
  toolIndex: Map<string, string>
}> {
  const toolIndex = new Map<string, string>()
  const byName = new Map<string, OpenAiTool>()

  const results = await Promise.allSettled(
    servers.map(async (server) => ({ server, tools: await listServerTools(server) })),
  )
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('mcp: skipping server that failed to list tools', result.reason)
      continue
    }
    for (const tool of result.value.tools) {
      if (byName.has(tool.name)) {
        console.warn(`mcp: tool name collision "${tool.name}" — last server wins`)
      }
      byName.set(tool.name, toOpenAiTool(tool))
      toolIndex.set(tool.name, result.value.server.id)
    }
  }

  return { tools: [...byName.values()], toolIndex }
}

// Execute one tool call against its owning server. Throws with a descriptive
// message if the tool can't be routed or the server errors/times out — the
// runner turns that into a tool-result message so the loop keeps moving.
export async function callTool(
  servers: McpServerConfig[],
  toolIndex: Map<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const serverId = toolIndex.get(name)
  const server = serverId ? servers.find((s) => s.id === serverId) : undefined
  if (!server) {
    throw new Error(`No enabled MCP server exposes a tool named "${name}"`)
  }

  return withClient(server, async (client) => {
    const result = (await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs(server) },
    )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
    return extractResultText(result)
  })
}
