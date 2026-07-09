// View-model builder for the chat transcript. A message row is enriched with
// the fields the `conversations/message` partial needs but should not compute
// itself (templates display, they don't run markdown or arithmetic):
//
//   - contentHtml: sanitized markdown HTML for a *settled* message (complete or
//     interrupted). NULL while streaming — the live tail shows plain-text
//     deltas in a <pre> and only swaps in server-rendered HTML at
//     message-final (THE_PLAN: "finalize-swap"), so we never render markdown
//     over a half-arrived message.
//   - stats: structured footer figures (prompt/generation token count, seconds,
//     tokens/second) derived from the provider's `timings` payload, or NULL when
//     there's nothing to show. Structured (not a prebuilt string) so the
//     template can give each figure its own icon chip.
//
// Both the SSR transcript (routes/conversations) and the runner's
// message-final event (services/runner) render the partial through this so the
// streamed swap-in is byte-identical to a fresh page load.

import { renderMarkdown } from './markdown'

// Loose structural shape (no index signature) so the generated, concrete
// message-row types from bun-sqlgen satisfy the constraint without a cast.
interface MessageFields {
  id?: string | null
  role?: string | null
  content?: string | null
  reasoning_content?: string | null
  model?: string | null
  status?: string | null
  timings?: unknown
  tool_calls?: unknown
  toolCall?: ToolCallView | null
  toolCalls?: ToolCallView[]
  hideMessage?: boolean
}

export interface MessageStats {
  prompt: TimingStats | null
  generation: TimingStats | null
}

export interface TimingStats {
  tokens: string
  seconds: string | null
  rate: string | null
}

export interface ArtifactLink {
  id: string
  title: string
  href: string
  downloadHref: string
}

export interface ToolCallView {
  id: string | null
  name: string
  arguments: string
  icon: string
  tone: 'artifact' | 'search' | 'file' | 'shell' | 'database' | 'web' | 'generic'
}

export interface RenderableExtras {
  contentHtml: string | null
  stats: MessageStats | null
  timingLabel: string | null
  clipContent: string
  artifactLinks: ArtifactLink[]
  toolCalls: ToolCallView[]
  toolCall: ToolCallView | null
  showReasoning: boolean
  showContent: boolean
  showFooter: boolean
  showActions: boolean
  hideMessage: boolean
}

// llama.cpp / OpenAI-compatible timings block (see mock-provider finishChunk):
// { prompt_n, prompt_ms, predicted_n, predicted_ms }. All optional/defensive —
// a provider may send a subset or nothing.
function tokenLabel(count: number) {
  return `${count} token${count === 1 ? '' : 's'}`
}

function timingStatsFor(count: unknown, ms: unknown): TimingStats | null {
  if (typeof count !== 'number' || count <= 0) return null
  let seconds: string | null = null
  let rate: string | null = null
  if (typeof ms === 'number' && ms > 0) {
    seconds = `${(ms / 1000).toFixed(1)}s`
    const perSecond = count / (ms / 1000)
    if (Number.isFinite(perSecond)) rate = `${perSecond.toFixed(1)} tok/s`
  }
  return {
    tokens: tokenLabel(count),
    seconds,
    rate,
  }
}

function statsFor(timings: unknown): MessageStats | null {
  if (!timings || typeof timings !== 'object') return null
  const t = timings as Record<string, unknown>
  const prompt = timingStatsFor(t['prompt_n'], t['prompt_ms'])
  const generation = timingStatsFor(t['predicted_n'], t['predicted_ms'])
  if (!prompt && !generation) return null
  return { prompt, generation }
}

function timingLabelFor(stats: MessageStats | null) {
  if (!stats) return null
  const parts: string[] = []
  if (stats.prompt) {
    parts.push(
      `prompt ${[stats.prompt.tokens, stats.prompt.seconds, stats.prompt.rate]
        .filter(Boolean)
        .join(' · ')}`,
    )
  }
  if (stats.generation) {
    parts.push(
      `generation ${[
        stats.generation.tokens,
        stats.generation.seconds,
        stats.generation.rate,
      ]
        .filter(Boolean)
        .join(' · ')}`,
    )
  }
  return parts.join(' · ')
}

function clipContentFor(content: string | null | undefined) {
  return Buffer.from(content ?? '', 'utf8').toString('base64')
}

function artifactLinksFor(message: MessageFields): ArtifactLink[] {
  if (message.role !== 'tool') return []
  const content = message.content ?? ''
  const match = content.match(
    /^Artifact saved:\s*(.+?)\s*\nOpen it at\s+(\/artifacts\/([0-9a-f-]{36}))\s*$/im,
  )
  if (!match) return []
  const title = match[1]?.trim() || 'Artifact'
  const href = match[2]
  const id = match[3]
  if (!href || !id) return []
  return [
    {
      id,
      title,
      href,
      downloadHref: `${href}/download`,
    },
  ]
}

function prettyToolArguments(raw: unknown): string {
  if (typeof raw !== 'string') return '{}'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function toolDecorationFor(name: string): Pick<ToolCallView, 'icon' | 'tone'> {
  const normalized = name.toLowerCase().replace(/[-:.]/g, '_')
  if (normalized.includes('artifact')) return { icon: 'sparkles', tone: 'artifact' }
  if (/\b(search|grep|find|lookup|query_web)\b/.test(normalized)) {
    return { icon: 'search', tone: 'search' }
  }
  if (/\b(file|read|write|edit|patch|list|ls|open)\b/.test(normalized)) {
    return { icon: 'file', tone: 'file' }
  }
  if (/\b(bash|shell|terminal|exec|command|run)\b/.test(normalized)) {
    return { icon: 'terminal', tone: 'shell' }
  }
  if (/\b(sql|db|database|postgres|sqlite)\b/.test(normalized)) {
    return { icon: 'database', tone: 'database' }
  }
  if (/\b(web|url|fetch|http|browser|visit)\b/.test(normalized)) {
    return { icon: 'globe', tone: 'web' }
  }
  return { icon: 'wrench', tone: 'generic' }
}

export function toolCallViewFor(input: {
  id?: string | null
  name: string
  arguments?: unknown
}): ToolCallView {
  return {
    id: input.id ?? null,
    name: input.name,
    arguments: prettyToolArguments(input.arguments),
    ...toolDecorationFor(input.name),
  }
}

export function toolCallsFor(message: MessageFields): ToolCallView[] {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return []
  return message.tool_calls
    .map((call): ToolCallView | null => {
      if (!call || typeof call !== 'object') return null
      const record = call as Record<string, unknown>
      const fn = record['function']
      const functionRecord =
        fn && typeof fn === 'object' ? (fn as Record<string, unknown>) : null
      const name =
        functionRecord && typeof functionRecord['name'] === 'string'
          ? functionRecord['name'].trim()
          : ''
      if (!name) return null
      return toolCallViewFor({
        id: typeof record['id'] === 'string' ? record['id'] : null,
        name,
        arguments: functionRecord?.['arguments'],
      })
    })
    .filter((call): call is ToolCallView => call !== null)
}

export function toRenderable<T extends MessageFields>(
  message: T,
): T & RenderableExtras {
  const status = message.status ?? 'complete'
  const role = message.role ?? null
  const rendersMarkdown = role === 'assistant' || role === 'user'
  const hasActions = rendersMarkdown
  const stats = statsFor(message.timings)
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : toolCallsFor(message)
  const contentHtml =
    status === 'streaming' || !rendersMarkdown
      ? null
      : renderMarkdown(message.content ?? '')
  const showReasoning =
    role === 'assistant' && (message.reasoning_content ?? '').trim().length > 0
  const showContent =
    status === 'streaming' ||
    (rendersMarkdown && contentHtml !== null && contentHtml.trim().length > 0)
  const visibleAssistant = role !== 'assistant' || status === 'streaming' || showReasoning || showContent
  const showFooter =
    role === 'assistant' &&
    status !== 'streaming' &&
    visibleAssistant &&
    Boolean(message.model || stats || message.id)
  const showActions = showFooter && Boolean(message.id)
  return {
    ...message,
    contentHtml,
    stats,
    timingLabel: timingLabelFor(stats),
    clipContent: hasActions ? clipContentFor(message.content) : '',
    artifactLinks: artifactLinksFor(message),
    toolCalls,
    toolCall: message.toolCall ?? null,
    showReasoning,
    showContent,
    showFooter,
    showActions,
    hideMessage: message.hideMessage === true || !visibleAssistant,
  }
}
