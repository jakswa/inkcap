import { Hono } from 'hono'
import { deletePushSubscriptionByEndpoint, upsertPushSubscription } from '../db/queries/push-subscriptions'
import { sendPushToUser } from '../services/push'
import { assertSafeOutboundUrl } from '../utils/outbound-url'

export const pushRoutes = new Hono()

async function validatePushEndpoint(endpoint: string) {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return 'Invalid push endpoint'
  }
  if (url.protocol !== 'https:') return 'Push endpoint must use https'
  if (endpoint.length > 4096) return 'Push endpoint is too long'
  try {
    await assertSafeOutboundUrl(endpoint)
  } catch {
    return 'Push endpoint is not allowed'
  }
  return null
}

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
  const endpointError = await validatePushEndpoint(endpoint)
  if (endpointError) return c.json({ error: endpointError }, 400)
  if (p256dh.length > 512 || auth.length > 512) {
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

pushRoutes.post('/push/test', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')

  await sendPushToUser(user.id, {
    title: 'inkcap notifications are ready',
    body: 'Loop updates will open the relevant chat or artifact.',
    url: '/settings',
  })
  return c.redirect('/settings?push_test=sent')
})
