import { Hono } from 'hono'
import { countPushSubscriptionsForUser } from '../db/queries/push-subscriptions'
import { pushConfigured, vapidPublicKey } from '../services/push'
import { getUserSettings, patchUserSettings } from '../db/queries/users'
import { readString } from '../utils/validation'
import { validTimeZone } from '../utils/timezone'

export const settingsRoutes = new Hono()

settingsRoutes.get('/settings', async (c) => {
  if (!c.var.user) {
    return c.redirect('/login')
  }

  const [pushSubscriptionCount, userSettings] = await Promise.all([
    countPushSubscriptionsForUser(c.var.user.id),
    getUserSettings(c.var.user.id),
  ])

  c.header('Cache-Control', 'private, no-store')
  return c.var.render('settings', {
    title: 'Settings',
    pushConfigured: pushConfigured(),
    vapidPublicKey: vapidPublicKey(),
    pushSubscriptionCount,
    pushTestSent: c.req.query('push_test') === 'sent',
    timeZone: userSettings.timeZone,
    timeZoneSaved: c.req.query('timezone') === 'saved',
    timeZoneError: c.req.query('timezone') === 'invalid',
    loopNotificationPrompt: userSettings.loopNotificationPrompt,
    notificationPolicySaved: c.req.query('notification_policy') === 'saved',
    notificationPolicyError: c.req.query('notification_policy') === 'invalid',
  })
})

settingsRoutes.post('/settings/notification-policy', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')
  const form = await c.req.formData()
  const loopNotificationPrompt = readString(form, 'loop_notification_prompt').trim()
  if (!loopNotificationPrompt || loopNotificationPrompt.length > 4_000) {
    return c.redirect('/settings?notification_policy=invalid#notifications')
  }
  await patchUserSettings({ userId: user.id, patch: { loopNotificationPrompt } })
  return c.redirect('/settings?notification_policy=saved#notifications')
})

settingsRoutes.post('/settings/timezone', async (c) => {
  const user = c.var.user
  if (!user) return c.redirect('/login')
  const form = await c.req.formData()
  const timeZone = validTimeZone(readString(form, 'timezone'))
  if (!timeZone) return c.redirect('/settings?timezone=invalid#regional')
  await patchUserSettings({ userId: user.id, patch: { timeZone } })
  return c.redirect('/settings?timezone=saved#regional')
})
