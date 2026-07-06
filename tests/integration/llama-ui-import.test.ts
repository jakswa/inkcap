import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { sql } = await import('../../src/db/client')
const { createUser } = await import('../../src/db/queries/users')
const { getConversationById } = await import('../../src/db/queries/conversations')
const { getActivePath, listMessageChildren } = await import('../../src/db/queries/messages')

// Drives the actual `bun src/tasks/import-llama-ui.ts` entrypoint as a
// subprocess, so these tests exercise the real CLI path end-to-end (argument
// parsing, user lookup, DB writes, summary printing) rather than a copy of
// its logic.
async function runImportTask(args: string[]) {
  const proc = Bun.spawn(['bun', 'src/tasks/import-llama-ui.ts', ...args], {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'Import Test User',
    email: `import-${suffix}@example.com`,
    emailNormalized: `import-${suffix}@example.com`,
    passwordHash: 'x',
  })
}

// Fixtures are committed with fixed ids (readable, matches the spec sample
// verbatim). Tests run concurrently and conversation-id dedup is global, so
// rewrite the session/message convId to a fresh id per test run before
// invoking the CLI against a scratch copy.
function materializeWithFreshId(fixtureName: string): { path: string; id: string } {
  const original = readFileSync(join(import.meta.dir, '..', 'fixtures', fixtureName), 'utf8')
  const id = randomUUIDv7()

  const rewritten = original
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      let record: any
      try {
        record = JSON.parse(line)
      } catch {
        return line // intentionally-malformed lines (fixture coverage) pass through untouched
      }
      if (record.type === 'session') record.id = id
      else if (record.type === 'message' && record.message?.convId) record.message.convId = id
      return JSON.stringify(record)
    })
    .join('\n')

  const path = join(tmpdir(), `llama-ui-import-test-${id}.jsonl`)
  writeFileSync(path, rewritten)
  return { path, id }
}

describe('import-llama-ui CLI: tree shape lands correctly in Postgres', () => {
  test('parent_id links, curr_node, and sibling branches match the spec sample', async () => {
    const user = await makeUser()
    const { path, id } = materializeWithFreshId('rust-ownership.jsonl')

    try {
      const { exitCode, stdout } = await runImportTask([path, '--user', user.email])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('conversations_imported')

      const convo = await getConversationById(id)
      expect(convo).toBeDefined()
      expect(convo?.user_id).toBe(user.id)
      expect(convo?.title).toBe('Rust ownership Q&A')
      expect(convo?.curr_node).toBeTruthy()

      // The synthetic root row must not have been imported.
      const [{ count }] = await sql`
        SELECT count(*)::int AS count FROM messages WHERE conversation_id = ${id}
      `
      expect(count).toBe(4)

      // Active path (root->leaf via curr_node) is [system, user, regenerated assistant] —
      // branch A (the original, non-regenerated reply) is excluded.
      const path_ = await getActivePath(convo!.curr_node!)
      expect(path_.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
      expect(path_[1]!.content).toBe("Why can't I return a reference to a local variable in Rust?")
      const activeReply = path_[2]!
      expect(activeReply.reasoning_content).toContain('lifetime elision')
      expect(activeReply.model).toBe('qwen2.5-coder-32b-instruct')

      // The user message has two children (the sibling branch point) — both
      // stored, even though only one is on the active path.
      const userMessageId = path_[1]!.id!
      const children = await listMessageChildren(userMessageId)
      expect(children).toHaveLength(2)
      const contents = children.map((c) => c.content).sort()
      expect(contents[0]).toContain('borrow checker rejects this at compile time')
      expect(contents[1]).toContain('E0515')
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('import-llama-ui CLI: attachment decoding', () => {
  test('inline base64 extras decode into the attachments table (bytea), message content stays plain text', async () => {
    const user = await makeUser()
    const { path, id } = materializeWithFreshId('with-attachment.jsonl')

    try {
      const { exitCode } = await runImportTask([path, '--user', user.email])
      expect(exitCode).toBe(0)

      const [userMessage] = await sql`
        SELECT id, content FROM messages
        WHERE conversation_id = ${id} AND role = 'user'
      `
      expect(userMessage?.content).toBe("Here's my compose file and a screenshot of the error.")
      expect(userMessage?.content).not.toContain('base64')

      const attachments = await sql`
        SELECT kind, name, mime, bytes FROM attachments
        WHERE message_id = ${userMessage!.id}
        ORDER BY kind
      `
      expect(attachments).toHaveLength(2)

      const image = attachments.find((a: { kind: string }) => a.kind === 'image')!
      expect(image.mime).toBe('image/png')
      expect(image.name).toBe('error.png')
      expect(Buffer.from(image.bytes).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))

      const text = attachments.find((a: { kind: string }) => a.kind === 'text')!
      expect(text.mime).toBe('text/plain')
      expect(Buffer.from(text.bytes).toString('utf8')).toBe('services:\n  web:\n    image: nginx\n')
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('import-llama-ui CLI: lenient parsing', () => {
  test('malformed lines/messages are skipped with warnings; the salvageable tree still imports', async () => {
    const user = await makeUser()
    const { path, id } = materializeWithFreshId('malformed.jsonl')

    try {
      const { exitCode, stdout } = await runImportTask([path, '--user', user.email])
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Warnings:')
      expect(stdout).toContain('unrecognized role')
      expect(stdout).toContain('dangling parent reference')

      const [{ count }] = await sql`
        SELECT count(*)::int AS count FROM messages WHERE conversation_id = ${id}
      `
      // Only the two well-formed messages (msg-1, msg-2) survive; msg-wizard
      // (bad role) and the orphan pre-session message are dropped.
      expect(count).toBe(2)

      const convo = await getConversationById(id)
      expect(convo?.curr_node).toBeTruthy()
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('import-llama-ui CLI: idempotency', () => {
  test('re-importing the same UUID-id conversation is skipped, not duplicated', async () => {
    const user = await makeUser()
    const { path, id } = materializeWithFreshId('rust-ownership.jsonl')

    try {
      const first = await runImportTask([path, '--user', user.email])
      expect(first.exitCode).toBe(0)

      const second = await runImportTask([path, '--user', user.email])
      expect(second.exitCode).toBe(0)

      const [{ count }] = await sql`
        SELECT count(*)::int AS count FROM conversations WHERE id = ${id}
      `
      expect(count).toBe(1)

      const [{ count: messageCount }] = await sql`
        SELECT count(*)::int AS count FROM messages WHERE conversation_id = ${id}
      `
      expect(messageCount).toBe(4) // not doubled by the second (skipped) import
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('a non-UUID-shaped source id falls back to (user, title, created_at) matching', async () => {
    const user = await makeUser()
    const title = `Fallback dedupe ${randomUUIDv7()}`
    const nonUuidId = `legacy-${Math.random().toString(36).slice(2)}`

    const lines = [
      JSON.stringify({ type: 'session', harness: 'llama.app', id: nonUuidId, name: title }),
      JSON.stringify({
        type: 'message',
        message: {
          id: 'm1',
          convId: nonUuidId,
          type: 'text',
          role: 'user',
          content: 'hello',
          parent: null,
          timestamp: 1751900000000,
        },
      }),
    ]
    const path = join(tmpdir(), `llama-ui-import-test-${randomUUIDv7()}.jsonl`)
    writeFileSync(path, lines.join('\n'))

    try {
      const first = await runImportTask([path, '--user', user.email])
      expect(first.exitCode).toBe(0)

      const second = await runImportTask([path, '--user', user.email])
      expect(second.exitCode).toBe(0)

      const [{ count }] = await sql`
        SELECT count(*)::int AS count FROM conversations WHERE user_id = ${user.id} AND title = ${title}
      `
      expect(count).toBe(1)
    } finally {
      rmSync(path, { force: true })
    }
  })
})
