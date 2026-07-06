// An OpenAI-compatible mock provider for exercising the durable runner.
// Streaming-only (`stream: true` requests); modes select failure shapes:
//
//   instant             — whole reply in one chunk, then finish + [DONE].
//   drip                — `tokens` content chunks (`t0 t1 …`), one every
//                         `interval` ms; optional `reasoning` chunks first.
//   hang                — emit `after` tokens, then keep the stream open
//                         forever (no more data) until the client aborts.
//   fail                — emit `after` tokens, then close the stream WITHOUT
//                         the [DONE] sentinel (a mid-stream provider failure).
//   error500            — immediate HTTP 500 with a JSON error body.
//
// Mode selection, in priority order:
//   1. query params:  POST /v1/chat/completions?mode=drip&tokens=8&interval=5
//   2. header:        x-mock-mode: drip,tokens=8,interval=5
//   3. path segment:  POST /drip,tokens=8,interval=5/v1/chat/completions
//
// The path-segment form exists because spail's provider base_url can carry a
// path but not a query string — tests point a provider at
// `http://localhost:<port>/<modeSegment>` and the client appends
// `/v1/chat/completions`.
//
// Tests import startMockProvider() on an ephemeral port; `bun
// src/tasks/mock-provider.ts [port]` runs it standalone.

export interface MockMode {
  mode: 'instant' | 'drip' | 'hang' | 'fail' | 'error500'
  tokens: number
  interval: number
  after: number
  reasoning: number
}

const DEFAULTS: MockMode = {
  mode: 'instant',
  tokens: 8,
  interval: 5,
  after: 3,
  reasoning: 0,
}

export function mockToken(index: number) {
  return `t${index} `
}

export function mockContent(tokens: number) {
  let content = ''
  for (let i = 0; i < tokens; i += 1) content += mockToken(i)
  return content
}

function parseSegment(segment: string): Partial<MockMode> {
  const out: Record<string, string> = {}
  const parts = segment.split(',')
  if (parts[0] && !parts[0].includes('=')) out['mode'] = parts.shift()!
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return normalize(out)
}

function normalize(raw: Record<string, string | null | undefined>): Partial<MockMode> {
  const out: Partial<MockMode> = {}
  const mode = raw['mode']
  if (mode === 'instant' || mode === 'drip' || mode === 'hang' || mode === 'fail' || mode === 'error500') {
    out.mode = mode
  }
  for (const key of ['tokens', 'interval', 'after', 'reasoning'] as const) {
    const rawValue = raw[key]
    if (rawValue == null || rawValue === '') continue
    const value = Number(rawValue)
    if (Number.isFinite(value) && value >= 0) out[key] = value
  }
  return out
}

function resolveMode(url: URL, headers: Headers, pathSegment: string | undefined): MockMode {
  const fromPath = pathSegment ? parseSegment(pathSegment) : {}
  const fromHeader = headers.get('x-mock-mode')
    ? parseSegment(headers.get('x-mock-mode')!)
    : {}
  const fromQuery = normalize({
    mode: url.searchParams.get('mode'),
    tokens: url.searchParams.get('tokens'),
    interval: url.searchParams.get('interval'),
    after: url.searchParams.get('after'),
    reasoning: url.searchParams.get('reasoning'),
  })
  return { ...DEFAULTS, ...fromPath, ...fromHeader, ...fromQuery }
}

function sseLine(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function contentChunk(text: string) {
  return sseLine({ choices: [{ delta: { content: text } }] })
}

function reasoningChunk(text: string) {
  return sseLine({ choices: [{ delta: { reasoning_content: text } }] })
}

function finishChunk(predicted: number) {
  return sseLine({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    timings: { prompt_n: 7, prompt_ms: 12.5, predicted_n: predicted, predicted_ms: predicted * 5 },
  })
}

export function startMockProvider(port = 0) {
  return Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const match = url.pathname.match(/^(?:\/([^/]+))?\/v1\/chat\/completions$/)
      if (!match || req.method !== 'POST') {
        return new Response('not found', { status: 404 })
      }

      const mode = resolveMode(url, req.headers, match[1])

      if (mode.mode === 'error500') {
        return Response.json(
          { error: { code: 500, message: 'mock provider exploded', type: 'server_error' } },
          { status: 500 },
        )
      }

      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (line: string) => controller.enqueue(encoder.encode(line))
          const aborted = () => req.signal.aborted
          try {
            // First chunk carries id + model (spec §2.2 sample sequence).
            send(sseLine({ id: 'mock-cmpl-1', model: 'mock-model', choices: [{ delta: { content: '' } }] }))

            if (mode.mode === 'instant') {
              send(contentChunk(mockContent(mode.tokens)))
              send(finishChunk(mode.tokens))
              send('data: [DONE]\n\n')
              controller.close()
              return
            }

            const total = mode.mode === 'drip' ? mode.tokens : mode.after

            for (let i = 0; i < mode.reasoning && !aborted(); i += 1) {
              send(reasoningChunk(`r${i} `))
              await Bun.sleep(mode.interval)
            }
            for (let i = 0; i < total && !aborted(); i += 1) {
              send(contentChunk(mockToken(i)))
              await Bun.sleep(mode.interval)
            }

            if (mode.mode === 'hang') {
              await new Promise<void>((resolve) => {
                if (req.signal.aborted) return resolve()
                req.signal.addEventListener('abort', () => resolve(), { once: true })
              })
              controller.close()
              return
            }

            if (mode.mode === 'fail') {
              // Mid-stream terminal failure: close without [DONE].
              controller.close()
              return
            }

            send(finishChunk(total))
            send('data: [DONE]\n\n')
            controller.close()
          } catch {
            // Client went away mid-enqueue; nothing to clean up.
          }
        },
      })

      return new Response(body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
        },
      })
    },
  })
}

if (import.meta.main) {
  const port = Number(Bun.argv[2] ?? 8010)
  const server = startMockProvider(port)
  console.log(`mock provider listening on ${server.url}`)
}
