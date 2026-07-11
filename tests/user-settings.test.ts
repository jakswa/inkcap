import { describe, expect, test } from 'bun:test'
import { DEFAULT_AUTO_TITLE_PROMPT, DEFAULT_LOOP_NOTIFICATION_PROMPT, parseUserSettings } from '../src/utils/user-settings'

describe('parseUserSettings', () => {
  test('degrades unknown shapes and keeps only string default MCP ids', () => {
    for (const value of [null, undefined, {}, 'junk', 42, ['a']]) {
      expect(parseUserSettings(value)).toEqual({ defaultMcpServerIds: [], timeZone: 'UTC', loopNotificationPrompt: DEFAULT_LOOP_NOTIFICATION_PROMPT, autoTitleEnabled: false, autoTitlePrompt: DEFAULT_AUTO_TITLE_PROMPT })
    }

    expect(
      parseUserSettings({ theme: 'dark', defaultMcpServerIds: ['a', 1, null, 'b', {}] }),
    ).toEqual({ defaultMcpServerIds: ['a', 'b'], timeZone: 'UTC', loopNotificationPrompt: DEFAULT_LOOP_NOTIFICATION_PROMPT, autoTitleEnabled: false, autoTitlePrompt: DEFAULT_AUTO_TITLE_PROMPT })
    expect(parseUserSettings({ defaultMcpServerIds: 'a', timeZone: 'America/New_York' })).toEqual({
      defaultMcpServerIds: [],
      timeZone: 'America/New_York',
      loopNotificationPrompt: DEFAULT_LOOP_NOTIFICATION_PROMPT,
      autoTitleEnabled: false,
      autoTitlePrompt: DEFAULT_AUTO_TITLE_PROMPT,
    })
    expect(parseUserSettings({ timeZone: 'not/a-zone' }).timeZone).toBe('UTC')
  })
})
