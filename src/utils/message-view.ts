// View-model builder for the chat transcript. A message row is enriched with
// the fields the `conversations/message` partial needs but should not compute
// itself (templates display, they don't run markdown or arithmetic):
//
//   - contentHtml: sanitized markdown HTML for a *settled* message (complete or
//     interrupted). NULL while streaming — the live tail shows plain-text
//     deltas in a <pre> and only swaps in server-rendered HTML at
//     message-final (THE_PLAN: "finalize-swap"), so we never render markdown
//     over a half-arrived message.
//   - stats: structured footer figures (token count, generation seconds,
//     tokens/second) derived from the provider's `timings` payload, or NULL
//     when there's nothing to show. Structured (not a prebuilt string) so the
//     template can give each figure its own icon chip.
//
// Both the SSR transcript (routes/conversations) and the runner's
// message-final event (services/runner) render the partial through this so the
// streamed swap-in is byte-identical to a fresh page load.

import { renderMarkdown } from './markdown'

// Loose structural shape (no index signature) so the generated, concrete
// message-row types from bun-sqlgen satisfy the constraint without a cast.
interface MessageFields {
  content?: string | null
  status?: string | null
  timings?: unknown
}

export interface MessageStats {
  tokens: string
  seconds: string | null
  rate: string | null
}

export interface RenderableExtras {
  contentHtml: string | null
  stats: MessageStats | null
  timingLabel: string | null
  clipContent: string
}

// llama.cpp / OpenAI-compatible timings block (see mock-provider finishChunk):
// { prompt_n, prompt_ms, predicted_n, predicted_ms }. All optional/defensive —
// a provider may send a subset or nothing.
function statsFor(timings: unknown): MessageStats | null {
  if (!timings || typeof timings !== 'object') return null
  const t = timings as Record<string, unknown>
  const predictedN = typeof t['predicted_n'] === 'number' ? t['predicted_n'] : null
  const predictedMs = typeof t['predicted_ms'] === 'number' ? t['predicted_ms'] : null
  if (predictedN == null || predictedN <= 0) return null

  let seconds: string | null = null
  let rate: string | null = null
  if (predictedMs != null && predictedMs > 0) {
    seconds = `${(predictedMs / 1000).toFixed(1)}s`
    const perSecond = predictedN / (predictedMs / 1000)
    if (Number.isFinite(perSecond)) rate = `${perSecond.toFixed(1)} tok/s`
  }
  return { tokens: `${predictedN} tokens`, seconds, rate }
}

function timingLabelFor(stats: MessageStats | null) {
  if (!stats) return null
  return [stats.tokens, stats.seconds, stats.rate].filter(Boolean).join(' · ')
}

function clipContentFor(content: string | null | undefined) {
  return Buffer.from(content ?? '', 'utf8').toString('base64')
}

export function toRenderable<T extends MessageFields>(
  message: T,
): T & RenderableExtras {
  const status = message.status ?? 'complete'
  const stats = statsFor(message.timings)
  return {
    ...message,
    contentHtml: status === 'streaming' ? null : renderMarkdown(message.content ?? ''),
    stats,
    timingLabel: timingLabelFor(stats),
    clipContent: clipContentFor(message.content),
  }
}
