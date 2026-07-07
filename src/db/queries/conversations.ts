import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function createConversation(input: {
  userId: string
  title?: string | null
  providerId?: string | null
  model?: string | null
  reasoningEffort?: string | null
  forkedFromConversationId?: string | null
}) {
  const [conversation] = await sql.CreateConversation`
    INSERT INTO conversations (id, user_id, title, provider_id, model, reasoning_effort, forked_from_conversation_id)
    VALUES (
      ${randomUUIDv7()},
      ${input.userId},
      ${input.title ?? null},
      ${input.providerId ?? null},
      ${input.model ?? null},
      ${input.reasoningEffort ?? null},
      ${input.forkedFromConversationId ?? null}
    )
    RETURNING id, user_id, title, provider_id, model, reasoning_effort, curr_node, pinned,
              forked_from_conversation_id, created_at, updated_at
  `

  return conversation
}

export async function getConversationById(id: string) {
  const [conversation] = await sql.GetConversationById`
    SELECT id, user_id, title, provider_id, model, curr_node, pinned,
           reasoning_effort,
           forked_from_conversation_id, created_at, updated_at
    FROM conversations
    WHERE id = ${id}
  `

  return conversation
}

export async function listConversationsForUser(userId: string) {
  return sql.ListConversationsForUser`
    SELECT id, user_id, title, provider_id, model, curr_node, pinned,
           reasoning_effort,
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
    RETURNING id, user_id, title, provider_id, model, reasoning_effort, curr_node, pinned,
              forked_from_conversation_id, created_at, updated_at
  `

  return conversation
}

export async function updateConversationModelSettings(input: {
  id: string
  model: string | null
  reasoningEffort: string | null
}) {
  const [conversation] = await sql.UpdateConversationModelSettings`
    UPDATE conversations
    SET model = ${input.model}, reasoning_effort = ${input.reasoningEffort}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, user_id, title, provider_id, model, reasoning_effort, curr_node, pinned,
              forked_from_conversation_id, created_at, updated_at
  `

  return conversation
}

// Delete a conversation the given user owns. Scoped by user_id so one user can
// never delete another's conversation. Messages, runs, and run_events cascade
// (ON DELETE CASCADE). Returns the deleted id, or undefined if nothing matched.
export async function deleteConversation(input: { id: string; userId: string }) {
  const [conversation] = await sql.DeleteConversation`
    DELETE FROM conversations
    WHERE id = ${input.id} AND user_id = ${input.userId}
    RETURNING id
  `

  return conversation
}

// Importer-only: the llama-ui export carries its own id (reused verbatim as
// our conversation id when it's UUID-shaped) and original timestamps, so this
// bypasses the randomUUIDv7()/now() defaults that createConversation uses.
export async function createImportedConversation(input: {
  id: string
  userId: string
  title?: string | null
  pinned?: boolean
  forkedFromConversationId?: string | null
  createdAt: Date
}) {
  const [conversation] = await sql.CreateImportedConversation`
    INSERT INTO conversations (
      id, user_id, title, pinned, forked_from_conversation_id, created_at, updated_at
    )
    VALUES (
      ${input.id},
      ${input.userId},
      ${input.title ?? null},
      ${input.pinned ?? false},
      ${input.forkedFromConversationId ?? null},
      ${input.createdAt},
      ${input.createdAt}
    )
    RETURNING id, user_id, title, provider_id, model, reasoning_effort, curr_node, pinned,
              forked_from_conversation_id, created_at, updated_at
  `

  return conversation
}

// Seeder-only: pin created_at/updated_at (and the pinned flag) after content
// insertion — the helpers above stamp now(), which would flatten a seeded
// history into a single moment (src/tasks/seed-demo.ts staggers the sidebar).
export async function setConversationSeedState(input: {
  id: string
  createdAt: Date
  updatedAt: Date
  pinned: boolean
}) {
  const [conversation] = await sql.SetConversationSeedState`
    UPDATE conversations
    SET created_at = ${input.createdAt}, updated_at = ${input.updatedAt}, pinned = ${input.pinned}
    WHERE id = ${input.id}
    RETURNING id
  `

  return conversation
}

// Importer idempotency fallback for conversations whose source id isn't
// UUID-shaped (the fork's crypto.randomUUID-unavailable fallback): match on
// (user, title, created_at) instead, since we set created_at from the
// export's earliest-message timestamp specifically so a re-import matches.
export async function findConversationMatch(input: {
  userId: string
  title: string | null
  createdAt: Date
}) {
  const [conversation] = await sql.FindConversationMatch`
    SELECT id, user_id, title, provider_id, model, reasoning_effort, curr_node, pinned,
           forked_from_conversation_id, created_at, updated_at
    FROM conversations
    WHERE user_id = ${input.userId}
      AND title IS NOT DISTINCT FROM ${input.title}
      AND created_at = ${input.createdAt}
  `

  return conversation
}
