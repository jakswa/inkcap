import { describe, expect, test } from 'bun:test'
import {
  buildChatRequest,
  mergeToolCallDeltas,
  streamChat,
  type StreamDelta,
} from '../src/services/provider-client'
import { startMockProvider } from '../src/tasks/mock-provider'

describe('buildChatRequest streaming flag', () => {
  test('stream defaults to false and can be enabled', () => {
    const provider = { base_url: 'http://x', api_key: null }
    const messages = [{ role: 'user' as const, content: 'hi' }]
    expect(buildChatRequest(provider, null, messages).body['stream']).toBe(false)
    expect(
      buildChatRequest(provider, null, messages, { stream: true }).body['stream'],
    ).toBe(true)
  })

  test('llama-server streaming requests opt into live progress timings', () => {
    const provider = { kind: 'llama-server', base_url: 'http://x', api_key: null }
    const messages = [{ role: 'user' as const, content: 'hi' }]
    const body = buildChatRequest(provider, null, messages, { stream: true }).body
    expect(body['return_progress']).toBe(true)
    expect(body['timings_per_token']).toBe(true)
    expect(body['sse_ping_interval']).toBe(1)
  })

  test('non-empty tools opt the request into automatic tool choice', () => {
    const provider = { base_url: 'http://x', api_key: null }
    const messages = [{ role: 'user' as const, content: 'hi' }]
    const tools = [
      {
        type: 'function',
        function: { name: 'search', parameters: { type: 'object', properties: {} } },
      },
    ]

    const body = buildChatRequest(provider, null, messages, { tools }).body
    expect(body['tools']).toBe(tools)
    expect(body['tool_choice']).toBe('auto')

    const emptyBody = buildChatRequest(provider, null, messages, { tools: [] }).body
    expect(emptyBody['tools']).toBeUndefined()
    expect(emptyBody['tool_choice']).toBeUndefined()
  })
})

describe('mergeToolCallDeltas (spec §2.3)', () => {
  test('concatenates arguments and overwrites the rest on matching index', () => {
    let calls = mergeToolCallDeltas(
      [],
      [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }],
    )
    calls = mergeToolCallDeltas(calls, [{ index: 0, function: { arguments: '{"city":' } }])
    calls = mergeToolCallDeltas(calls, [{ index: 0, function: { arguments: '"NYC"}' } }])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.id).toBe('call_1')
    expect(calls[0]?.function?.name).toBe('get_weather')
    expect(calls[0]?.function?.arguments).toBe('{"city":"NYC"}')
  })

  test('indexOffset keeps a second batch from colliding with the first', () => {
    const first = mergeToolCallDeltas(
      [],
      [{ index: 0, id: 'call_1', function: { name: 'a', arguments: '{}' } }],
    )
    // A later run of deltas restarts at index 0; the offset appends instead.
    const merged = mergeToolCallDeltas(
      first,
      [{ index: 0, id: 'call_2', function: { name: 'b', arguments: '{}' } }],
      first.length,
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]?.id).toBe('call_1')
    expect(merged[1]?.id).toBe('call_2')
  })

  test('missing index appends', () => {
    const merged = mergeToolCallDeltas(
      [{ id: 'call_1', function: { name: 'a', arguments: '' } }],
      [{ id: 'call_2', function: { name: 'b', arguments: '' } }],
    )
    expect(merged).toHaveLength(2)
    expect(merged[1]?.id).toBe('call_2')
  })
})

// Regression (QA panel, races-and-cancel #3): a provider that streams K
// tokens and then holds the socket open forever must NOT block streamChat
// forever — the stall watchdog aborts the transport and throws a plain
// terminal error, keeping every delta yielded before the silence.
describe('streamChat stall watchdog', () => {
  const collect = async (
    baseUrl: string,
    stallTimeoutMs: number,
    signal?: AbortSignal,
  ) => {
    const received: string[] = []
    let error: Error | null = null
    try {
      const deltas: AsyncGenerator<StreamDelta, void, undefined> = streamChat(
        { base_url: baseUrl, api_key: null },
        'mock-model',
        [{ role: 'user', content: 'hi' }],
        signal,
        stallTimeoutMs,
      )
      for await (const delta of deltas) {
        if (delta.kind === 'content') received.push(delta.text)
      }
    } catch (caught) {
      error = caught as Error
    }
    return { received, error }
  }

  test('a provider that hangs mid-stream throws a stall error, keeping earlier deltas', async () => {
    const mock = startMockProvider()
    try {
      const { received, error } = await collect(
        `http://localhost:${mock.port}/hang,after=3,interval=3`,
        80,
      )
      expect(error?.message).toContain('stopped responding')
      // A stall is a terminal provider failure, not a cancellation.
      expect(error?.name).not.toBe('AbortError')
      expect(received.join('')).toBe('t0 t1 t2 ')
    } finally {
      mock.stop(true)
    }
  }, 10_000)

  test('a slow drip inside the per-chunk deadline never trips the watchdog', async () => {
    const mock = startMockProvider()
    try {
      // Six 25ms gaps: total (~150ms) exceeds the 75ms deadline but each
      // individual gap stays inside it — the watchdog must re-arm per chunk.
      const { received, error } = await collect(
        `http://localhost:${mock.port}/drip,tokens=6,interval=25`,
        75,
      )
      expect(error).toBeNull()
      expect(received.join('')).toBe('t0 t1 t2 t3 t4 t5 ')
    } finally {
      mock.stop(true)
    }
  }, 10_000)

  test('caller abort during a hang still surfaces as AbortError, not a stall', async () => {
    const mock = startMockProvider()
    try {
      const abort = new AbortController()
      setTimeout(() => abort.abort(), 25)
      const { error } = await collect(
        `http://localhost:${mock.port}/hang,after=2,interval=5`,
        5_000,
        abort.signal,
      )
      expect(error?.name).toBe('AbortError')
    } finally {
      mock.stop(true)
    }
  }, 10_000)
})
