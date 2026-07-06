import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function createConversation(input: {
  userId: string
  title?: string | null
  providerId?: string | null
  model?: string | null
  forkedFromConversationId?: string | null
}) {
  const [conversation] = await sql.CreateConversation`
    INSERT INTO conversations (id, user_id, title, provider_id, model, forked_from_conversation_id)
    VALUES (
      ${randomUUIDv7()},
      ${input.userId},
      ${input.title ?? null},
      ${input.providerId ?? null},
      ${input.model ?? null},
      ${input.forkedFromConversationId ?? null}
    )
    RETURNING id, user_id, title, provider_id, model, curr_node, pinned,
              forked_from_conversation_id, created_at, updated_at
  `

  return conversation
}

export async function getConversationById(id: string) {
  const [conversation] = await sql.GetConversationById`
    SELECT id, user_id, title, provider_id, model, curr_node, pinned,
           forked_from_conversation_id, created_at, updated_at
    FROM conversations
    WHERE id = ${id}
  `

  return conversation
}

export async function listConversationsForUser(userId: string) {
  return sql.ListConversationsForUser`
    SELECT id, user_id, title, provider_id, model, curr_node, pinned,
           forked_from_conversation_id, created_at, updated_at
    FROM conversations
    WHERE user_id = ${userId}
    ORDER BY pinned DESC, updated_at DESC
  `
}

export async function setConversationCurrNode(input: { id: string; currNode: string | null }) {
  const [conversation] = await sql.SetConversationCurrNode`
    UPDATE conversations
    SET curr_node = ${input.currNode}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, user_id, title, provider_id, model, curr_node, pinned,
              forked_from_conversation_id, created_at, updated_at
  `

  return conversation
}
