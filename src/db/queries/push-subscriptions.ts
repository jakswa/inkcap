import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function upsertPushSubscription(input: {
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string | null
}) {
  const [subscription] = await sql.UpsertPushSubscription`
    INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
    VALUES (${randomUUIDv7()}, ${input.userId}, ${input.endpoint}, ${input.p256dh}, ${input.auth}, ${input.userAgent ?? null})
    ON CONFLICT (endpoint)
    DO UPDATE SET user_id = ${input.userId},
                  p256dh = ${input.p256dh},
                  auth = ${input.auth},
                  user_agent = ${input.userAgent ?? null}
    RETURNING id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at
  `
  return subscription
}

export async function deletePushSubscriptionByEndpoint(input: {
  userId?: string
  endpoint: string
}) {
  const [subscription] = await sql.DeletePushSubscriptionByEndpoint`
    DELETE FROM push_subscriptions
    WHERE endpoint = ${input.endpoint}
      AND (${input.userId ?? null}::uuid IS NULL OR user_id = ${input.userId ?? null})
    RETURNING id
  `
  return subscription
}

export async function listPushSubscriptionsForUser(userId: string) {
  return sql.ListPushSubscriptionsForUser`
    SELECT id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at
    FROM push_subscriptions
    WHERE user_id = ${userId}
    ORDER BY created_at ASC
  `
}

export async function countPushSubscriptionsForUser(userId: string) {
  const [row] = await sql.CountPushSubscriptionsForUser`
    SELECT count(*)::int AS count
    FROM push_subscriptions
    WHERE user_id = ${userId}
  `
  return Number(row?.count ?? 0)
}

export async function markPushSubscriptionUsed(id: string) {
  const [subscription] = await sql.MarkPushSubscriptionUsed`
    UPDATE push_subscriptions
    SET last_used_at = now()
    WHERE id = ${id}
    RETURNING id
  `
  return subscription
}
