import { describe, expect, test } from 'bun:test'
import { parseUserSettings } from '../src/utils/user-settings'

describe('parseUserSettings', () => {
  test('degrades unknown shapes and keeps only string default MCP ids', () => {
    for (const value of [null, undefined, {}, 'junk', 42, ['a']]) {
      expect(parseUserSettings(value)).toEqual({ defaultMcpServerIds: [] })
    }

    expect(
      parseUserSettings({ theme: 'dark', defaultMcpServerIds: ['a', 1, null, 'b', {}] }),
    ).toEqual({ defaultMcpServerIds: ['a', 'b'] })
    expect(parseUserSettings({ defaultMcpServerIds: 'a' })).toEqual({
      defaultMcpServerIds: [],
    })
  })
})
