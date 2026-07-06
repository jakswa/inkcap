import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'

const { app } = await import('../src/app')
const { encryptSession } = await import('../src/utils/private-session')

const compressedAssetPath = 'src/static/compressed-test.js'

beforeAll(async () => {
  await Bun.write(compressedAssetPath, 'console.log("compressed test")\n')
  await Bun.write(`${compressedAssetPath}.br`, 'brotli compressed test')
  await Bun.write(`${compressedAssetPath}.gz`, 'gzip compressed test')
})

afterAll(async () => {
  await Promise.all([
    rm(compressedAssetPath, { force: true }),
    rm(`${compressedAssetPath}.br`, { force: true }),
    rm(`${compressedAssetPath}.gz`, { force: true }),
  ])
})

describe('app', () => {
  test('home page renders', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(await res.text()).toContain('<!doctype html>')
  })

  test('tracked asset renders without database lookup', async () => {
    const res = await app.request('/assets/test/logo.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
  })

  test('asset server prefers brotli when compressed variants exist', async () => {
    const res = await app.request('/assets/test/compressed-test.js', {
      headers: { 'Accept-Encoding': 'gzip, br' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
  })

  test('asset server serves gzip when brotli is not accepted', async () => {
    const res = await app.request('/assets/test/compressed-test.js', {
      headers: { 'Accept-Encoding': 'gzip' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
  })

  test('dashboard redirects anonymous users', async () => {
    const res = await app.request('/dashboard')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  test('dashboard accepts encrypted private session cookie', async () => {
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 1)
    const cookie = encryptSession({
      expiresAt: expiresAt.toISOString(),
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Test User',
        email: 'test@example.com',
        created_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      },
      issuedAt: new Date().toISOString(),
    })

    const res = await app.request('/dashboard', {
      headers: { Cookie: `session=${cookie}` },
    })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Signed in as <strong>Test User</strong>')
  })

  test('missing pages render a styled 404', async () => {
    const res = await app.request('/does-not-exist')

    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Page not found')
  })
})
