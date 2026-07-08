import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function createArtifact(input: {
  accountId: string
  conversationId: string
  runId: string
  messageId?: string | null
  kind: string
  title: string
  summary?: string | null
  bodyMarkdown: string
}) {
  const [artifact] = await sql.CreateArtifact`
    INSERT INTO artifacts (
      id, account_id, conversation_id, run_id, message_id,
      kind, title, summary, body_markdown
    )
    VALUES (
      ${randomUUIDv7()}, ${input.accountId}, ${input.conversationId},
      ${input.runId}, ${input.messageId ?? null}, ${input.kind}, ${input.title},
      ${input.summary ?? null}, ${input.bodyMarkdown}
    )
    RETURNING id, account_id, conversation_id, run_id, message_id,
              kind, title, summary, body_markdown, created_at
  `
  return artifact
}

export async function getArtifactForUser(input: { id: string; userId: string }) {
  const [artifact] = await sql.GetArtifactForUser`
    SELECT a.id, a.account_id, a.conversation_id, a.run_id, a.message_id,
           a.kind, a.title, a.summary, a.body_markdown, a.created_at,
           c.title AS conversation_title
    FROM artifacts a
    JOIN conversations c ON c.id = a.conversation_id
    WHERE a.id = ${input.id} AND c.user_id = ${input.userId}
  `
  return artifact
}

export async function listArtifactsForConversation(input: {
  conversationId: string
  userId: string
}) {
  return sql.ListArtifactsForConversation`
    SELECT a.id, a.account_id, a.conversation_id, a.run_id, a.message_id,
           a.kind, a.title, a.summary, a.body_markdown, a.created_at
    FROM artifacts a
    JOIN conversations c ON c.id = a.conversation_id
    WHERE a.conversation_id = ${input.conversationId} AND c.user_id = ${input.userId}
    ORDER BY a.created_at DESC
  `
}
