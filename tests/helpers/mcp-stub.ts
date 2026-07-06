// A minimal MCP server over the streamable-HTTP transport, implemented as raw
// JSON-RPC on Bun.serve — enough for the SDK client to initialize, list tools,
// and call them. Records every tools/call for assertions. Mount path is /mcp.

const PROTOCOL_VERSION = '2025-06-18'

export interface StubTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface StubMcpOptions {
  tools?: StubTool[]
  // Produce the text result for a tools/call; defaults to echoing the args.
  onCall?: (name: string, args: Record<string, unknown>) => string
}

export interface StubMcpServer {
  port: number
  url: string
  calls: { name: string; args: Record<string, unknown> }[]
  stop: () => void
}

export function startStubMcpServer(options: StubMcpOptions = {}): StubMcpServer {
  const tools: StubTool[] = options.tools ?? [
    {
      name: 'echo',
      description: 'Echoes its text argument',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ]
  const onCall =
    options.onCall ?? ((name, args) => `${name}: ${JSON.stringify(args)}`)
  const calls: { name: string; args: Record<string, unknown> }[] = []

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })
      // The client may open a GET SSE channel or DELETE the session; neither is
      // needed for request/response JSON-RPC, so answer benignly.
      if (req.method === 'GET') return new Response(null, { status: 405 })
      if (req.method === 'DELETE') return new Response(null, { status: 200 })
      if (req.method !== 'POST') return new Response(null, { status: 405 })

      const body = (await req.json()) as {
        id?: unknown
        method?: string
        params?: { name?: string; arguments?: Record<string, unknown> }
      }
      // Stateless server: no mcp-session-id, so independent concurrent clients
      // never share (and collide on) a session.
      const respond = (result: unknown) =>
        Response.json({ jsonrpc: '2.0', id: body.id, result })

      switch (body.method) {
        case 'initialize':
          return respond({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'stub-mcp', version: '1.0.0' },
          })
        case 'notifications/initialized':
          return new Response(null, { status: 202 })
        case 'tools/list':
          // The MCP schema requires an object inputSchema on every tool.
          return respond({
            tools: tools.map((tool) => ({
              ...tool,
              inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
            })),
          })
        case 'tools/call': {
          const name = body.params?.name ?? ''
          const args = body.params?.arguments ?? {}
          calls.push({ name, args })
          return respond({ content: [{ type: 'text', text: onCall(name, args) }] })
        }
        default:
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32601, message: 'method not found' },
          })
      }
    },
  })

  const port = server.port ?? 0
  return {
    port,
    url: `http://localhost:${port}/mcp`,
    calls,
    stop: () => server.stop(true),
  }
}
