// The users.settings jsonb column (migration 013) is a per-user preference
// blob. This module is its single owner: every reader goes through
// parseUserSettings so a malformed, stale, or old-shaped blob degrades to
// defaults instead of throwing, and every key added here documents what it
// means. Keep the column generic and this type specific.

export type UserSettings = {
  // MCP servers pre-checked on the new-chat composer. Updated to the
  // selection of the last created conversation, so tool choices are sticky
  // across new chats. May contain ids of since-deleted servers — harmless,
  // because checkboxes render by intersecting with the live catalog.
  defaultMcpServerIds: string[]
}

export function parseUserSettings(raw: unknown): UserSettings {
  const settings = isRecord(raw) ? raw : {}
  return {
    defaultMcpServerIds: stringArray(settings.defaultMcpServerIds),
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
