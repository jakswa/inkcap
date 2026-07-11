import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { createUser, getUserByEmailNormalized } from '../db/queries/users'
import { hashPassword, verifyPassword } from '../utils/password'
import { env } from '../utils/env'
import {
  encryptSession,
  insecureSessionCookieAllowed,
  insecureSessionCookieName,
  secureSessionCookieName,
  sessionCookieNameForSecureRequest,
  sessionCookieNames,
  sessionExpirationDate,
} from '../utils/private-session'
import { requestIsSecure } from '../utils/public-origin'
import { normalizeEmail, readString } from '../utils/validation'
import { validTimeZone } from '../utils/timezone'

export const authRoutes = new Hono()

const maxNameLength = 200
const maxEmailLength = 320
const maxPasswordLength = 1024
const authWindowMs = 15 * 60 * 1000
const maxLoginAttempts = 10
const maxRegisterAttempts = 20
const dummyPasswordHash =
  '$argon2id$v=19$m=65536,t=2,p=1$LkhlmtRUmqfvrVhnuh5K7RTrBSlVT9ndhHDT/jsNa4o$0t5BuC8dkuwqqyKPd55X5k/S33WbWIfxKj8QXK2A+H4'

const authAttempts = new Map<string, { count: number; resetAt: number }>()

function setSessionCookie(
  c: Context,
  user: { id: string; name: string; email: string; created_at: Date },
) {
  const expiresAt = sessionExpirationDate()
  // Without the split-origin opt-in, production always issues __Host-session
  // — a proxy that forgets x-forwarded-proto must not downgrade the cookie.
  const secure = requestIsSecure(c) || !insecureSessionCookieAllowed()
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

  setCookie(c, sessionCookieNameForSecureRequest(secure), cookie, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  })

  // A leftover insecure cookie must not linger next to a fresh secure one.
  // (The reverse cleanup is impossible: browsers reject Secure Set-Cookie —
  // including deletions — over plain http. docs/issues/18.)
  if (secure) deleteCookie(c, insecureSessionCookieName, { path: '/' })
}

authRoutes.get('/register', async (c) => {
  // Closed registration 404s rather than redirecting: the page's existence
  // is not advertised, matching the hidden register links in the views.
  if (env.REGISTRATION !== 'open') return c.notFound()

  return c.var.render('auth/register', {
    title: 'Register',
    errors: [],
    values: {},
  })
})

authRoutes.post('/register', async (c) => {
  if (env.REGISTRATION !== 'open') return c.notFound()

  const form = await c.req.formData()
  const name = readString(form, 'name').trim()
  const email = readString(form, 'email').trim()
  const password = readString(form, 'password')
  const timeZone = validTimeZone(readString(form, 'timezone')) ?? 'UTC'
  const emailNormalized = normalizeEmail(email)

  if (!allowAttempt(`register:${clientKey(c)}`, maxRegisterAttempts)) {
    c.status(429)
    return c.var.render('auth/register', {
      title: 'Register',
      errors: ['Too many registration attempts. Try again later.'],
      values: { name, email },
    })
  }

  const errors: string[] = []
  if (!name) errors.push('Name is required')
  if (name.length > maxNameLength) {
    errors.push(`Name must be ${maxNameLength} characters or fewer`)
  }
  if (!emailNormalized) errors.push('Email is required')
  if (email.length > maxEmailLength) {
    errors.push(`Email must be ${maxEmailLength} characters or fewer`)
  }
  if (password.length < 8) errors.push('Password must be at least 8 characters')
  if (password.length > maxPasswordLength) {
    errors.push(`Password must be ${maxPasswordLength} characters or fewer`)
  }

  if (errors.length > 0) {
    return c.var.render('auth/register', {
      title: 'Register',
      errors,
      values: { name, email },
    })
  }

  const existingUser = await getUserByEmailNormalized(emailNormalized)
  if (existingUser) {
    return c.var.render('auth/register', {
      title: 'Register',
      errors: ['Email is already registered'],
      values: { name, email },
    })
  }

  const passwordHash = await hashPassword(password)
  let user: Awaited<ReturnType<typeof createUser>>

  try {
    user = await createUser({ name, email, emailNormalized, passwordHash, timeZone })
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.var.render('auth/register', {
        title: 'Register',
        errors: ['Email is already registered'],
        values: { name, email },
      })
    }

    throw error
  }

  setSessionCookie(c, user)
  return c.redirect('/conversations')
})

authRoutes.get('/login', async (c) => {
  return c.var.render('auth/login', {
    title: 'Login',
    errors: [],
    values: {},
  })
})

authRoutes.post('/login', async (c) => {
  const form = await c.req.formData()
  const email = readString(form, 'email').trim()
  const password = readString(form, 'password')
  const emailNormalized = normalizeEmail(email)

  if (!allowAttempt(`login:${clientKey(c)}:${emailNormalized}`, maxLoginAttempts)) {
    c.status(429)
    return c.var.render('auth/login', {
      title: 'Login',
      errors: ['Too many login attempts. Try again later.'],
      values: { email },
    })
  }

  if (password.length > maxPasswordLength) {
    return c.var.render('auth/login', {
      title: 'Login',
      errors: ['Invalid email or password'],
      values: { email },
    })
  }

  const user = await getUserByEmailNormalized(emailNormalized)
  const passwordHash = user?.password_hash ?? dummyPasswordHash
  const valid = await verifyPassword(password, passwordHash)

  if (!user || !valid) {
    return c.var.render('auth/login', {
      title: 'Login',
      errors: ['Invalid email or password'],
      values: { email },
    })
  }

  setSessionCookie(c, user)
  return c.redirect('/conversations')
})

authRoutes.post('/logout', async (c) => {
  for (const name of sessionCookieNames) {
    deleteCookie(c, name, { path: '/', secure: name === secureSessionCookieName })
  }
  return c.redirect('/')
})

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  )
}

function clientKey(c: Context) {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-real-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

function allowAttempt(key: string, limit: number) {
  const now = Date.now()
  const current = authAttempts.get(key)
  if (!current || current.resetAt <= now) {
    authAttempts.set(key, { count: 1, resetAt: now + authWindowMs })
    return true
  }
  if (current.count >= limit) return false
  current.count += 1
  return true
}
