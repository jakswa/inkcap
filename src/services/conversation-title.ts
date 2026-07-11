import { setGeneratedConversationTitle } from '../db/queries/conversations'
import { getUserSettings } from '../db/queries/users'
import { completeOnce, type ChatMessage } from './provider-client'
import type { ProviderConfig } from './provider-client'

const TITLE_TIMEOUT_MS = 30_000
const MAX_TITLE_LENGTH = 100

function titleSource(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>)['titleSource']
  return typeof value === 'string' ? value : null
}

function cleanTitle(content: string) {
  let title = content.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  title = title.replace(/^title\s*:\s*/i, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  if (!title) return null
  return title.slice(0, MAX_TITLE_LENGTH).trim()
}

export function maybeGenerateConversationTitle(input: {
  conversation: { id: string; user_id: string; model: string | null; metadata: unknown }
  provider: ProviderConfig
  history: ChatMessage[]
}) {
  // Null metadata is intentionally the safe application default for old and
  // otherwise undecorated rows: only an explicit fallback title is replaceable.
  if (titleSource(input.conversation.metadata) !== 'fallback') return
  if (input.history.filter((message) => message.role === 'user').length !== 1) return
  if (input.history.some((message) => message.role === 'assistant' || message.role === 'tool')) return

  void (async () => {
    const settings = await getUserSettings(input.conversation.user_id)
    if (!settings.autoTitleEnabled) return

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
    try {
      const result = await completeOnce(
        input.provider,
        input.conversation.model,
        [
          ...input.history,
          {
            role: 'user',
            content: settings.autoTitlePrompt,
          },
        ],
        { signal: controller.signal },
      )
      const title = cleanTitle(result.content)
      if (title) await setGeneratedConversationTitle({ id: input.conversation.id, title })
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        console.warn('conversation title inference failed', error)
      }
    } finally {
      clearTimeout(timeout)
    }
  })().catch((error) => console.warn('conversation title decoration failed', error))
}
