import { afterAll, describe, expect, test } from 'bun:test'
import {
  callTool,
  gatherTools,
  listServerTools,
  testMcpConnection,
  type McpServerConfig,
} from '../src/services/mcp-client'
import { startStubMcpServer } from './helpers/mcp-stub'

function config(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id: 'srv-1', name: 'stub', url, request_timeout_ms: 5000, ...overrides }
}

describe('mcp-client', () => {
  const stub = startStubMcpServer({
    tools: [
      { name: 'echo', description: 'Echoes', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'ping', description: 'Pings' },
    ],
    onCall: (name, args) => `${name}(${JSON.stringify(args)})`,
  })

  afterAll(() => stub.stop())

  test('listServerTools returns the server tools', async () => {
    const tools = await listServerTools(config(stub.url))
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'ping'])
  })

  test('testMcpConnection reports a failure for an unreachable server', async () => {
    const result = await testMcpConnection(
      config('http://127.0.0.1:1/mcp', { request_timeout_ms: 1000 }),
    )
    expect(result.ok).toBe(false)
  })

  test('gatherTools builds OpenAI tools and a routing index', async () => {
    const server = config(stub.url, { id: 'srv-A' })
    const { tools, toolIndex } = await gatherTools([server])
    expect(tools.every((t) => t.type === 'function')).toBe(true)
    expect(new Set(tools.map((t) => t.function.name))).toEqual(new Set(['echo', 'ping']))
    expect(toolIndex.get('echo')).toBe('srv-A')
  })

  test('callTool routes to the owning server and returns text', async () => {
    const server = config(stub.url, { id: 'srv-A' })
    const { toolIndex } = await gatherTools([server])
    const result = await callTool([server], toolIndex, 'echo', { text: 'hi' })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('echo(')
  })

  test('callTool throws for an unroutable tool name', async () => {
    const server = config(stub.url, { id: 'srv-A' })
    let threw = false
    try {
      await callTool([server], new Map(), 'missing', {})
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('does not follow redirects (SSRF guard cannot be bypassed via 3xx)', async () => {
    // In production a server whose URL passes the outbound guard could 302 the
    // request toward a blocked address (loopback / metadata endpoint). Here we
    // redirect to the reachable stub with a 307 (which preserves the POST), so
    // that *following* the redirect would succeed — proving it's the guard, not
    // an unreachable target, that makes the connection fail.
    const redirector = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, { status: 307, headers: { Location: stub.url } }),
    })
    try {
      const result = await testMcpConnection(
        config(`http://127.0.0.1:${redirector.port}/mcp`, { request_timeout_ms: 1000 }),
      )
      expect(result.ok).toBe(false)
    } finally {
      redirector.stop(true)
    }
  })
})
