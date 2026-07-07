import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { CurrentUser } from '../app-types'
import { decryptSession, sessionCookieNames } from '../utils/private-session'

export const currentUser = createMiddleware<{
  Variables: {
    user: CurrentUser
  }
}>(async (c, next) => {
  const cookie = sessionCookieNames.map((name) => getCookie(c, name)).find(Boolean)

  if (!cookie) {
    c.set('user', null)
    await next()
    return
  }

  const session = decryptSession(cookie)
  c.set(
    'user',
    session
      ? {
          ...session.user,
          created_at: new Date(session.user.created_at),
        }
      : null,
  )

  await next()
})
