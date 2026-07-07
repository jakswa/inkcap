import { describe, expect, test } from 'bun:test'
import { parseUserSettings } from '../src/utils/user-settings'

describe('parseUserSettings', () => {
  test('empty and non-object blobs degrade to defaults', () => {
    expect(parseUserSettings(null)).toEqual({ defaultMcpServerIds: [] })
    expect(parseUserSettings(undefined)).toEqual({ defaultMcpServerIds: [] })
    expect(parseUserSettings({})).toEqual({ defaultMcpServerIds: [] })
    expect(parseUserSettings('junk')).toEqual({ defaultMcpServerIds: [] })
    expect(parseUserSettings(42)).toEqual({ defaultMcpServerIds: [] })
    expect(parseUserSettings(['a'])).toEqual({ defaultMcpServerIds: [] })
  })

  test('reads defaultMcpServerIds and drops non-string entries', () => {
    expect(
      parseUserSettings({ defaultMcpServerIds: ['a', 1, null, 'b', {}] }),
    ).toEqual({ defaultMcpServerIds: ['a', 'b'] })
  })

  test('wrong-typed key degrades to default', () => {
    expect(parseUserSettings({ defaultMcpServerIds: 'a' })).toEqual({
      defaultMcpServerIds: [],
    })
  })

  test('unknown keys are ignored, not fatal', () => {
    expect(
      parseUserSettings({ theme: 'dark', defaultMcpServerIds: ['a'] }),
    ).toEqual({ defaultMcpServerIds: ['a'] })
  })
})
