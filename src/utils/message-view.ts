// View-model builder for the chat transcript. A message row is enriched with
// the fields the `conversations/message` partial needs but should not compute
// itself (templates display, they don't run markdown or arithmetic):
//
//   - contentHtml: sanitized markdown HTML for a *settled* message (complete or
//     interrupted). NULL while streaming — the live tail shows plain-text
//     deltas in a <pre> and only swaps in server-rendered HTML at
//     message-final (THE_PLAN: "finalize-swap"), so we never render markdown
//     over a half-arrived message.
//   - timingLabel: a subtle "N tok · X tok/s" footer string derived from the
//     provider's `timings` payload, or NULL when there's nothing to show.
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

export interface RenderableExtras {
  contentHtml: string | null
  timingLabel: string | null
}

// llama.cpp / OpenAI-compatible timings block (see mock-provider finishChunk):
// { prompt_n, prompt_ms, predicted_n, predicted_ms }. All optional/defensive —
// a provider may send a subset or nothing.
function timingLabelFor(timings: unknown): string | null {
  if (!timings || typeof timings !== 'object') return null
  const t = timings as Record<string, unknown>
  const predictedN = typeof t['predicted_n'] === 'number' ? t['predicted_n'] : null
  const predictedMs = typeof t['predicted_ms'] === 'number' ? t['predicted_ms'] : null
  if (predictedN == null || predictedN <= 0) return null

  const parts = [`${predictedN} tok`]
  if (predictedMs != null && predictedMs > 0) {
    const perSecond = predictedN / (predictedMs / 1000)
    if (Number.isFinite(perSecond)) parts.push(`${perSecond.toFixed(1)} tok/s`)
  }
  return parts.join(' · ')
}

export function toRenderable<T extends MessageFields>(
  message: T,
): T & RenderableExtras {
  const status = message.status ?? 'complete'
  return {
    ...message,
    contentHtml: status === 'streaming' ? null : renderMarkdown(message.content ?? ''),
    timingLabel: timingLabelFor(message.timings),
  }
}
