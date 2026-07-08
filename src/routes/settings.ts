import { Hono } from 'hono'
import { countPushSubscriptionsForUser } from '../db/queries/push-subscriptions'
import { pushConfigured, vapidPublicKey } from '../services/push'

export const settingsRoutes = new Hono()

settingsRoutes.get('/settings', async (c) => {
  if (!c.var.user) {
    return c.redirect('/login')
  }

  const pushSubscriptionCount = await countPushSubscriptionsForUser(c.var.user.id)

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('settings', {
    title: 'Settings',
    pushConfigured: pushConfigured(),
    vapidPublicKey: vapidPublicKey(),
    pushSubscriptionCount,
  })
})
