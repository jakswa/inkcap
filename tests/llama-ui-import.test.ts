import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseExport } from '../src/utils/llama-ui-import'

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8')
}

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', name)))
}

describe('parseExport: JSONL, the spec sample (docs/specs/export-format.md §6)', () => {
  test('strips the synthetic root, links parent_id, resolves currNode to the regenerated sibling', () => {
    const { records, warnings } = parseExport(fixture('rust-ownership.jsonl'))

    expect(warnings).toEqual([])
    expect(records).toHaveLength(1)

    const [record] = records
    expect(record!.conversation.sourceId).toBe('9f13a7d0-2b41-4c9e-8f77-1d6b6a2e5c10')
    expect(record!.conversation.sourceIdIsUuid).toBe(true)
    expect(record!.conversation.title).toBe('Rust ownership Q&A')

    // The root row (msg-root) must not appear as an importable message.
    const ids = record!.messages.map((m) => m.sourceId)
    expect(ids).not.toContain('msg-root')
    expect(ids.sort()).toEqual(['msg-a1', 'msg-a4', 'msg-sys', 'msg-u1'])

    const bySourceId = new Map(record!.messages.map((m) => [m.sourceId, m]))
    // root -> null (root stripped), everything else chains through parent_id.
    expect(bySourceId.get('msg-sys')?.parentSourceId).toBeNull()
    expect(bySourceId.get('msg-u1')?.parentSourceId).toBe('msg-sys')
    expect(bySourceId.get('msg-a1')?.parentSourceId).toBe('msg-u1')
    expect(bySourceId.get('msg-a4')?.parentSourceId).toBe('msg-u1')

    // currNode ("msg-a4") is the regenerated sibling, per spec §6.
    expect(record!.conversation.currNodeSourceId).toBe('msg-a4')

    // reasoningContent/model/timings survive per-sibling, independently.
    expect(bySourceId.get('msg-a1')?.reasoningContent).toContain('E0515')
    expect(bySourceId.get('msg-a4')?.reasoningContent).toContain('lifetime elision')
    expect(bySourceId.get('msg-a4')?.model).toBe('qwen2.5-coder-32b-instruct')
    expect(bySourceId.get('msg-a1')?.toolCalls).toBeNull()
  })
})

describe('parseExport: attachment decoding (spec §4)', () => {
  test('decodes TEXT and IMAGE extras into normalized attachments, content stays plain text', () => {
    const { records, warnings } = parseExport(fixture('with-attachment.jsonl'))

    expect(warnings).toEqual([])
    expect(records).toHaveLength(1)
    const [record] = records

    const userMessage = record!.messages.find((m) => m.sourceId === 'msg-b1')!
    expect(userMessage.content).toBe("Here's my compose file and a screenshot of the error.")
    // No base64/data-URL leakage into message content.
    expect(userMessage.content).not.toContain('base64')
    expect(userMessage.content).not.toContain('data:')

    expect(record!.attachments).toHaveLength(2)

    const text = record!.attachments.find((a) => a.kind === 'text')!
    expect(text.messageSourceId).toBe('msg-b1')
    expect(text.mime).toBe('text/plain')
    expect(Buffer.from(text.bytes).toString('utf8')).toBe('services:\n  web:\n    image: nginx\n')

    const image = record!.attachments.find((a) => a.kind === 'image')!
    expect(image.messageSourceId).toBe('msg-b1')
    expect(image.mime).toBe('image/png')
    expect(image.name).toBe('error.png')
    // 1x1 PNG signature bytes.
    expect(image.bytes.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })
})

describe('parseExport: zip archives (spec §5)', () => {
  test('reads every .jsonl entry, ignores non-jsonl entries, no cross-entry contamination', () => {
    const { records, warnings } = parseExport(fixtureBytes('conversations.zip'))

    expect(warnings).toEqual([])
    expect(records).toHaveLength(2)

    const rust = records.find((r) => r.conversation.title === 'Rust ownership Q&A')
    const docker = records.find((r) => r.conversation.title === 'Docker compose help')
    expect(rust).toBeDefined()
    expect(docker).toBeDefined()
    expect(rust!.messages).toHaveLength(4)
    expect(docker!.messages).toHaveLength(2)
    expect(docker!.attachments).toHaveLength(2)
  })
})

describe('parseExport: lenient parsing (this task\'s "tolerate ambiguities" requirement)', () => {
  test('skips unparseable lines/messages, collects warnings, still imports the salvageable tree', () => {
    const { records, warnings } = parseExport(fixture('malformed.jsonl'))

    expect(records).toHaveLength(1)
    const [record] = records

    // Only the two well-formed, resolvable messages survive.
    const ids = record!.messages.map((m) => m.sourceId).sort()
    expect(ids).toEqual(['msg-1', 'msg-2'])

    // msg-2's dangling parent got nulled (attached at top level), not dropped.
    const msg2 = record!.messages.find((m) => m.sourceId === 'msg-2')!
    expect(msg2.parentSourceId).toBeNull()

    // currNode didn't resolve, so it fell back to the latest message by timestamp (msg-2).
    expect(record!.conversation.currNodeSourceId).toBe('msg-2')

    expect(warnings.some((w) => w.includes('invalid JSON'))).toBe(true)
    expect(warnings.some((w) => w.includes('message record before any session record'))).toBe(true)
    expect(warnings.some((w) => w.includes('unrecognized role'))).toBe(true)
    expect(warnings.some((w) => w.includes('dangling parent reference'))).toBe(true)
    expect(warnings.some((w) => w.includes('falling back to latest by timestamp'))).toBe(true)
    expect(warnings.some((w) => w.includes('unrecognized type'))).toBe(true)
  })
})

describe('parseExport: currNode ambiguity tolerance (spec §1.1/§7)', () => {
  test('treats an empty-string currNode the same as a missing one', () => {
    const line1 = JSON.stringify({
      type: 'session',
      harness: 'llama.app',
      id: 'c0ffee00-0000-4000-8000-000000000001',
      name: 'Empty currNode',
      currNode: '',
    })
    const line2 = JSON.stringify({
      type: 'message',
      message: {
        id: 'only-msg',
        convId: 'c0ffee00-0000-4000-8000-000000000001',
        type: 'text',
        role: 'user',
        content: 'hi',
        parent: null,
        timestamp: 1000,
      },
    })

    const { records, warnings } = parseExport([line1, line2].join('\n'))
    expect(warnings).toEqual([])
    expect(records[0]!.conversation.currNodeSourceId).toBe('only-msg')
  })

  test('a non-UUID-shaped conversation id (the fork\'s Math.random fallback) is flagged, not rejected', () => {
    const line1 = JSON.stringify({
      type: 'session',
      harness: 'llama.app',
      id: 'ab3xz9q1p',
      name: 'Fallback id convo',
    })
    const line2 = JSON.stringify({
      type: 'message',
      message: { id: 'm1', type: 'text', role: 'user', content: 'hi', parent: null, timestamp: 1 },
    })

    const { records } = parseExport([line1, line2].join('\n'))
    expect(records[0]!.conversation.sourceIdIsUuid).toBe(false)
  })
})
