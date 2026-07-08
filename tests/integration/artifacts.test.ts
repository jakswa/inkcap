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

function form(input: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) body.set(key, value)
  return body
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

async function makeArtifactForUser(user: { id: string }) {
  const conversation = await createConversation({
    userId: user.id,
    title: 'Artifact source chat',
  })
  const run = await createRun({ conversationId: conversation.id, status: 'done' })
  return createArtifact({
    accountId: user.id,
    conversationId: conversation.id,
    runId: run.id,
    kind: 'briefing',
    title: 'Daily Briefing',
    summary: 'A short test artifact.',
    bodyMarkdown: '# Daily Briefing\n\nHello from an artifact.',
  })
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
    const artifact = await makeArtifactForUser(user)

    const page = await app.request(url(`/artifacts/${artifact.id}`), {
      headers: { Cookie: cookie },
    })
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('Daily Briefing')
    expect(html).toContain(`/artifacts/${artifact.id}/download`)
    expect(html).toContain('download="daily-briefing.md"')

    const download = await app.request(url(`/artifacts/${artifact.id}/download`), {
      headers: { Cookie: cookie },
    })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('application/octet-stream')
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(download.headers.get('content-disposition')).toContain('daily-briefing.md')
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await download.text()).toBe('# Daily Briefing\n\nHello from an artifact.')
  })

  test('owners can make the normal artifact URL public and revoke it', async () => {
    const user = await makeUser()
    const cookie = sessionFor(user)
    const artifact = await makeArtifactForUser(user)

    const privateGuest = await app.request(url(`/artifacts/${artifact.id}`))
    expect(privateGuest.status).toBe(302)
    expect(privateGuest.headers.get('location')).toBe('/login')

    const share = await app.request(url(`/artifacts/${artifact.id}/share`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
      body: form({ expires: 'forever' }),
    })
    expect(share.status).toBe(302)
    expect(share.headers.get('location')).toBe(`/artifacts/${artifact.id}?shared=1`)

    const publicPage = await app.request(url(`/artifacts/${artifact.id}`))
    expect(publicPage.status).toBe(200)
    const html = await publicPage.text()
    expect(html).toContain('public share')
    expect(html).toContain('Daily Briefing')
    expect(html).not.toContain('Open source chat')

    const publicDownload = await app.request(url(`/artifacts/${artifact.id}/download`))
    expect(publicDownload.status).toBe(200)
    expect(await publicDownload.text()).toBe('# Daily Briefing\n\nHello from an artifact.')

    const unshare = await app.request(url(`/artifacts/${artifact.id}/unshare`), {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    })
    expect(unshare.status).toBe(302)

    const guestAfterRevoke = await app.request(url(`/artifacts/${artifact.id}`))
    expect(guestAfterRevoke.status).toBe(302)
    expect(guestAfterRevoke.headers.get('location')).toBe('/login')
  })
})
