import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

const { app } = await import('../../src/app')
const { createArtifact } = await import('../../src/db/queries/artifacts')
const { createConversation } = await import('../../src/db/queries/conversations')
const { createRun } = await import('../../src/db/queries/runs')
const { createUser } = await import('../../src/db/queries/users')
const { encryptSession } = await import('../../src/utils/private-session')

const origin = 'http://localhost:3000'

function url(path: string) {
  return `${origin}${path}`
}

async function makeUser() {
  const suffix = randomUUIDv7()
  return createUser({
    name: 'Artifact Test User',
    email: `artifact-${suffix}@example.com`,
    emailNormalized: `artifact-${suffix}@example.com`,
    passwordHash: 'x',
  })
}

function sessionFor(user: { id: string; name: string; email: string; created_at: Date }) {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + 1)
  const cookie = encryptSession({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      created_at: user.created_at.toISOString(),
    },
    issuedAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
  return `session=${cookie}`
}

describe('artifacts routes', () => {
  test('invalid artifact ids 404 before they reach Postgres uuid casts', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)

    const res = await app.request(url('/artifacts/not-a-uuid'), {
      headers: { Cookie: cookie },
    })

    expect(res.status).toBe(404)
  })

  test('artifact pages render and Markdown downloads work', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const conversation = await createConversation({
      userId: user.id,
      title: 'Artifact source chat',
    })
    const run = await createRun({ conversationId: conversation.id, status: 'done' })
    const artifact = await createArtifact({
      accountId: user.id,
      conversationId: conversation.id,
      runId: run.id,
      kind: 'briefing',
      title: 'Daily Briefing',
      summary: 'A short test artifact.',
      bodyMarkdown: '# Daily Briefing\n\nHello from an artifact.',
    })

    const page = await app.request(url(`/artifacts/${artifact.id}`), {
      headers: { Cookie: cookie },
    })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Daily Briefing')
    expect(html).toContain(`/artifacts/${artifact.id}/download`)

    const download = await app.request(url(`/artifacts/${artifact.id}/download`), {
      headers: { Cookie: cookie },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('text/markdown')
    expect(download.headers.get('content-disposition')).toContain('daily-briefing.md')
    expect(await download.text()).toBe('# Daily Briefing\n\nHello from an artifact.')
  })
})
