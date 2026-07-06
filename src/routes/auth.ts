import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { createUser, getUserByEmailNormalized } from '../db/queries/users'
import { hashPassword, verifyPassword } from '../utils/password'
import { env } from '../utils/env'
import {
  encryptSession,
  sessionCookieName,
  sessionExpirationDate,
} from '../utils/private-session'
import { normalizeEmail, readString } from '../utils/validation'

export const authRoutes = new Hono()

const maxNameLength = 200
const maxEmailLength = 320
const dummyPasswordHash =
  '$argon2id$v=19$m=65536,t=2,p=1$LkhlmtRUmqfvrVhnuh5K7RTrBSlVT9ndhHDT/jsNa4o$0t5BuC8dkuwqqyKPd55X5k/S33WbWIfxKj8QXK2A+H4'

function setSessionCookie(
  c: Context,
  user: { id: string; name: string; email: string; created_at: Date },
) {
  const expiresAt = sessionExpirationDate()
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

  setCookie(c, sessionCookieName, cookie, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    expires: expiresAt,
  })
}

authRoutes.get('/register', async (c) => {
  return c.var.render('auth/register', {
    title: 'Register',
    errors: [],
    values: {},
  })
})

authRoutes.post('/register', async (c) => {
  const form = await c.req.formData()
  const name = readString(form, 'name').trim()
  const email = readString(form, 'email').trim()
  const password = readString(form, 'password')
  const emailNormalized = normalizeEmail(email)

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
    user = await createUser({ name, email, emailNormalized, passwordHash })
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
  return c.redirect('/dashboard')
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
  return c.redirect('/dashboard')
})

authRoutes.post('/logout', async (c) => {
  deleteCookie(c, sessionCookieName, {
    path: '/',
    secure: env.NODE_ENV === 'production',
  })
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
