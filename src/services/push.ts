import * as webpush from 'web-push'
import { getLatestArtifactForConversation } from '../db/queries/artifacts'
import { getConversationById } from '../db/queries/conversations'
import { getActivePath } from '../db/queries/messages'
import { getProviderById } from '../db/queries/providers'
import { isOriginatingRun } from '../db/queries/runs'
import { getUserSettings } from '../db/queries/users'
import { completeOnce, type ChatMessage, type ChatRole } from './provider-client'
import {
  countPushSubscriptionsForUser,
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

async function completedLoopWarrantsNotification(conversation: NonNullable<Awaited<ReturnType<typeof getConversationById>>>) {
  if (!conversation.provider_id || !conversation.curr_node) return true
  const [provider, path, settings] = await Promise.all([
    getProviderById(conversation.provider_id),
    getActivePath(conversation.curr_node),
    getUserSettings(conversation.user_id),
  ])
  if (!provider?.enabled) return true

  const messages: ChatMessage[] = path.flatMap((row) => {
    const role = row.role as ChatRole | null
    if (!role || (role === 'system' && !(row.content ?? '').trim())) return []
    const message: ChatMessage = { role, content: row.content ?? '' }
    if (role === 'assistant') {
      if (row.reasoning_content) message.reasoning_content = row.reasoning_content
      if (Array.isArray(row.tool_calls) && row.tool_calls.length) message.tool_calls = row.tool_calls
    }
    if (role === 'tool' && row.tool_call_id) message.tool_call_id = row.tool_call_id
    return [message]
  })
  messages.push({
    role: 'user',
    content: `This is an ephemeral notification checkpoint; do not continue the task. Decide whether the completed loop warrants interrupting the user. Apply this app-wide notification guidance:\n\n${settings.loopNotificationPrompt}\n\nReply with only JSON in exactly this shape: {"notify":true} or {"notify":false}.`,
  })

  const result = await completeOnce(provider, conversation.model, messages)
  const match = result.content.match(/\{\s*"notify"\s*:\s*(true|false)\s*\}/i)
  if (!match) throw new Error('notification checkpoint returned an invalid decision')
  return match[1]?.toLowerCase() === 'true'
}

export async function notifyLoopRunStatus(
  runId: string,
  conversationId: string,
  status: 'done' | 'waiting_approval' | 'error',
  errorMessage?: string | null,
) {
  const conversation = await getConversationById(conversationId)
  if (!conversation?.routine_id || !pushConfigured()) return
  if ((await countPushSubscriptionsForUser(conversation.user_id)) === 0) return

  // routine_id remains on later user continuations, but loop notification
  // hooks belong only to the run that created the conversation.
  if (!(await isOriginatingRun({ runId, conversationId }))) return

  // Attention-required states are unconditional. Successful runs get one
  // ephemeral provider turn over the completed conversation. On judge failure
  // preserve the old, fail-open behavior rather than silently losing a result.
  if (status === 'done') {
    try {
      if (!(await completedLoopWarrantsNotification(conversation))) return
    } catch (error) {
      console.warn('loop notification checkpoint failed; notifying by default', error)
    }
  }

  const origin = publicOrigin()
  const latestArtifact =
    status === 'done'
      ? await getLatestArtifactForConversation({
          conversationId: conversation.id,
          userId: conversation.user_id,
        })
      : null
  const path = latestArtifact ? `/artifacts/${latestArtifact.id}` : `/conversations/${conversation.id}`
  const title =
    status === 'done'
      ? latestArtifact
        ? `Artifact ready: ${latestArtifact.title}`
        : 'Loop finished'
      : status === 'waiting_approval'
        ? 'Loop needs approval'
        : 'Loop failed'
  const body =
    status === 'done'
      ? latestArtifact?.summary || conversation.title || 'Your scheduled loop is ready.'
      : status === 'waiting_approval'
        ? 'A tool call is waiting for your approval.'
        : errorMessage || 'Open the chat to inspect the failed loop run.'

  await sendPushToUser(conversation.user_id, {
    title: title.slice(0, 140),
    body: body.slice(0, 240),
    url: origin ? `${origin}${path}` : path,
  })
}

export async function notifyLoopStartFailure(input: {
  userId: string
  loopId: string
  loopName: string
  error: unknown
}) {
  const origin = publicOrigin()
  const path = `/loops/${input.loopId}`
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  await sendPushToUser(input.userId, {
    title: `Loop failed to start: ${input.loopName}`.slice(0, 140),
    body: message.slice(0, 240),
    url: origin ? `${origin}${path}` : path,
  })
}
