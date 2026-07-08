import * as webpush from 'web-push'
import { getConversationById } from '../db/queries/conversations'
import {
  deletePushSubscriptionByEndpoint,
  listPushSubscriptionsForUser,
  markPushSubscriptionUsed,
} from '../db/queries/push-subscriptions'
import { publicOrigin } from '../utils/public-origin'

export interface PushPayload {
  title: string
  body: string
  url: string
}

export function vapidPublicKey() {
  return process.env['VAPID_PUBLIC_KEY']?.trim() || null
}

function vapidPrivateKey() {
  return process.env['VAPID_PRIVATE_KEY']?.trim() || null
}

function vapidSubject() {
  return process.env['VAPID_SUBJECT']?.trim() || 'mailto:admin@localhost'
}

export function pushConfigured() {
  return Boolean(vapidPublicKey() && vapidPrivateKey())
}

let vapidConfigured = false
function configureVapid() {
  if (vapidConfigured) return true
  const publicKey = vapidPublicKey()
  const privateKey = vapidPrivateKey()
  if (!publicKey || !privateKey) return false
  webpush.setVapidDetails(vapidSubject(), publicKey, privateKey)
  vapidConfigured = true
  return true
}

export async function sendPushToUser(userId: string, payload: PushPayload) {
  if (!configureVapid()) return
  const subscriptions = await listPushSubscriptionsForUser(userId)
  const body = JSON.stringify(payload)
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        body,
      )
      await markPushSubscriptionUsed(subscription.id)
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode
      if (statusCode === 404 || statusCode === 410) {
        await deletePushSubscriptionByEndpoint({ endpoint: subscription.endpoint })
      } else {
        console.warn('push send failed', error)
      }
    }
  }
}

export async function notifyLoopRunStatus(
  conversationId: string,
  status: 'done' | 'waiting_approval' | 'error',
  errorMessage?: string | null,
) {
  const conversation = await getConversationById(conversationId)
  if (!conversation?.routine_id) return

  const origin = publicOrigin()
  const path = `/conversations/${conversation.id}`
  const title =
    status === 'done'
      ? 'Loop finished'
      : status === 'waiting_approval'
        ? 'Loop needs approval'
        : 'Loop failed'
  const body =
    status === 'done'
      ? conversation.title || 'Your scheduled loop is ready.'
      : status === 'waiting_approval'
        ? 'A tool call is waiting for your approval.'
        : errorMessage || 'Open the chat to inspect the failed loop run.'

  await sendPushToUser(conversation.user_id, {
    title,
    body,
    url: origin ? `${origin}${path}` : path,
  })
}
