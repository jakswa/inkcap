import { Hono } from 'hono'
import { deletePushSubscriptionByEndpoint, upsertPushSubscription } from '../db/queries/push-subscriptions'

export const pushRoutes = new Hono()

pushRoutes.post('/push/subscribe', async (c) => {
  const user = c.var.user
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json().catch(() => null) as {
    endpoint?: unknown
    keys?: { p256dh?: unknown; auth?: unknown }
  } | null
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : ''
  const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : ''
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: 'Invalid push subscription' }, 400)
  }

  await upsertPushSubscription({
    userId: user.id,
    endpoint,
    p256dh,
    auth,
    userAgent: c.req.header('user-agent') ?? null,
  })
  return c.json({ ok: true })
})

pushRoutes.post('/push/unsubscribe', async (c) => {
  const user = c.var.user
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json().catch(() => null) as { endpoint?: unknown } | null
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
  if (endpoint) await deletePushSubscriptionByEndpoint({ userId: user.id, endpoint })
  return c.json({ ok: true })
})
