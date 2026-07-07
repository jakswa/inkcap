import { describe, expect, test } from 'bun:test'
import { randomUUIDv7 } from 'bun'

// Trailing slash on purpose: entries are normalized before comparison with
// the browser's Origin header, which never carries one.
process.env['CSRF_TRUSTED_ORIGINS'] = 'http://192.168.1.160/'
const { app } = await import('../../src/app')

const password = 'correct horse battery staple'
const origin = 'http://localhost:3000'

function url(path: string) {
  return `${origin}${path}`
}

function uniqueEmail() {
  return `user-${randomUUIDv7()}@example.com`
}

function form(input: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(input)) body.set(key, value)
  return body
}

function sessionCookie(res: Response) {
  const cookie = res.headers.get('set-cookie')
  expect(cookie).toContain('session=')
  return cookie?.split(';')[0] ?? ''
}

async function registerUser(input: { name?: string; email?: string; password?: string } = {}) {
  const user = {
    name: input.name ?? 'Test User',
    email: input.email ?? uniqueEmail(),
    password: input.password ?? password,
  }

  const res = await app.request(url('/register'), {
    method: 'POST',
    headers: { Origin: origin },
    body: form(user),
  })

  return { res, user }
}

describe('auth integration', () => {
  test('register, login, and logout lifecycle', async () => {
    const { res, user } = await registerUser()

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/conversations')
    const registrationCookie = sessionCookie(res)

    const dashboard = await app.request('/dashboard', {
      headers: { Cookie: registrationCookie },
    })

    expect(dashboard.status).toBe(200)
    expect(await dashboard.text()).toContain(`Signed in as <strong>${user.name}</strong>`)

    const second = await registerUser({ email: user.email })
    expect(second.res.status).toBe(200)
    expect(await second.res.text()).toContain('Email is already registered')

    const invalidLogin = await app.request(url('/login'), {
      method: 'POST',
      headers: { Origin: origin },
      body: form({ email: user.email, password: 'wrong password' }),
    })

    expect(invalidLogin.status).toBe(200)
    expect(await invalidLogin.text()).toContain('Invalid email or password')

    const login = await app.request(url('/login'), {
      method: 'POST',
      headers: { Origin: origin },
      body: form({ email: user.email, password: user.password }),
    })

    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/conversations')
    const loginCookie = sessionCookie(login)

    const lanOriginLogin = await app.request(url('/login'), {
      method: 'POST',
      headers: { Origin: 'http://192.168.1.160' },
      body: form({ email: user.email, password: user.password }),
    })

    expect(lanOriginLogin.status).toBe(302)
    expect(lanOriginLogin.headers.get('location')).toBe('/conversations')
    const lanLoginCookie = sessionCookie(lanOriginLogin)

    const lanDashboard = await app.request('/dashboard', {
      headers: { Cookie: lanLoginCookie },
    })
    expect(lanDashboard.status).toBe(200)

    const hostileOriginLogin = await app.request(url('/login'), {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
      body: form({ email: user.email, password: user.password }),
    })
    expect(hostileOriginLogin.status).toBe(403)

    const logout = await app.request(url('/logout'), {
      method: 'POST',
      headers: { Cookie: loginCookie, Origin: origin },
    })

    expect(logout.status).toBe(302)
    expect(logout.headers.get('location')).toBe('/')
    expect(logout.headers.get('set-cookie')).toContain('session=')

    const loggedOutDashboard = await app.request('/dashboard', {
      headers: { Cookie: logout.headers.get('set-cookie') ?? '' },
    })
    expect(loggedOutDashboard.status).toBe(302)
    expect(loggedOutDashboard.headers.get('location')).toBe('/login')
  })

  test('PUBLIC_ORIGIN is trusted as a CSRF origin', async () => {
    const { user } = await registerUser()
    process.env['PUBLIC_ORIGIN'] = 'https://chat.public.example/'
    try {
      const login = await app.request(url('/login'), {
        method: 'POST',
        headers: { Origin: 'https://chat.public.example' },
        body: form({ email: user.email, password: user.password }),
      })
      expect(login.status).toBe(302)
      expect(login.headers.get('location')).toBe('/conversations')
    } finally {
      delete process.env['PUBLIC_ORIGIN']
    }
  })
})
