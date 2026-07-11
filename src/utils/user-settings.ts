// The users.settings jsonb column (migration 013) is a per-user preference
// blob. This module is its single owner: every reader goes through
// parseUserSettings so a malformed, stale, or old-shaped blob degrades to
// defaults instead of throwing, and every key added here documents what it
// means. Keep the column generic and this type specific.

export const DEFAULT_LOOP_NOTIFICATION_PROMPT =
  'Notify me when the loop finds a meaningful change, produces a useful result, or reaches a conclusion worth reviewing. Do not notify me when nothing materially changed or the result is routine and uneventful.'

export type UserSettings = {
  // MCP servers pre-checked on the new-chat composer. Updated to the
  // selection of the last created conversation, so tool choices are sticky
  // across new chats. May contain ids of since-deleted servers — harmless,
  // because checkboxes render by intersecting with the live catalog.
  defaultMcpServerIds: string[]
  // IANA timezone used to build and summarize loop schedules.
  timeZone: string
  // Applied by an ephemeral model turn after a loop completes successfully.
  // The completed conversation remains the prefix so provider prompt caches can
  // be reused; this instruction is never persisted as a chat message.
  loopNotificationPrompt: string
}

export function parseUserSettings(raw: unknown): UserSettings {
  const settings = isRecord(raw) ? raw : {}
  return {
    defaultMcpServerIds: stringArray(settings.defaultMcpServerIds),
    timeZone: validStoredTimeZone(settings.timeZone),
    loopNotificationPrompt:
      typeof settings.loopNotificationPrompt === 'string' && settings.loopNotificationPrompt.trim()
        ? settings.loopNotificationPrompt.trim()
        : DEFAULT_LOOP_NOTIFICATION_PROMPT,
  }
}

function validStoredTimeZone(value: unknown): string {
  if (typeof value !== 'string') return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return value
  } catch {
    return 'UTC'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}
