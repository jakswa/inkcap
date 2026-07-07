import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { CurrentUser } from '../app-types'
import { acceptedSessionCookieNames, decryptSession } from '../utils/private-session'

export const currentUser = createMiddleware<{
  Variables: {
    user: CurrentUser
  }
}>(async (c, next) => {
  const cookies = getCookie(c)

  // First cookie that decrypts wins — a stale or undecryptable
  // __Host-session must not shadow a valid `session` from a plain-http
  // login on the same host (docs/issues/18).
  for (const name of acceptedSessionCookieNames()) {
    const value = cookies[name]
    if (!value) continue
    const session = decryptSession(value)
    if (session) {
      c.set('user', {
        ...session.user,
        created_at: new Date(session.user.created_at),
      })
      await next()
      return
    }
  }

  c.set('user', null)
  await next()
})
