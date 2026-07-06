import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function createMessage(input: {
  conversationId: string
  parentId?: string | null
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  reasoningContent?: string | null
  model?: string | null
  status?: 'complete' | 'streaming' | 'interrupted'
  toolCalls?: unknown
  toolCallId?: string | null
  timings?: unknown
}) {
  const [message] = await sql.CreateMessage`
    INSERT INTO messages (
      id, conversation_id, parent_id, role, content, reasoning_content,
      model, status, tool_calls, tool_call_id, timings
    )
    VALUES (
      ${randomUUIDv7()},
      ${input.conversationId},
      ${input.parentId ?? null},
      ${input.role},
      ${input.content ?? ''},
      ${input.reasoningContent ?? null},
      ${input.model ?? null},
      ${input.status ?? 'complete'},
      ${input.toolCalls ?? null},
      ${input.toolCallId ?? null},
      ${input.timings ?? null}
    )
    RETURNING id, conversation_id, parent_id, role, content, reasoning_content,
              model, status, tool_calls, tool_call_id, timings, created_at
  `

  return message
}

export async function getMessageById(id: string) {
  const [message] = await sql.GetMessageById`
    SELECT id, conversation_id, parent_id, role, content, reasoning_content,
           model, status, tool_calls, tool_call_id, timings, created_at
    FROM messages
    WHERE id = ${id}
  `

  return message
}

// Runner: append flushed stream deltas to a streaming message. Empty strings
// are no-ops per column, so a content-only flush leaves reasoning_content NULL
// (the column stays NULL until the first reasoning token actually arrives).
export async function appendMessageDeltas(input: {
  id: string
  content: string
  reasoning: string
}) {
  const [message] = await sql.AppendMessageDeltas`
    UPDATE messages
    SET content = content || ${input.content},
        reasoning_content = CASE
          WHEN ${input.reasoning} = '' THEN reasoning_content
          ELSE coalesce(reasoning_content, '') || ${input.reasoning}
        END
    WHERE id = ${input.id}
    RETURNING id, content, reasoning_content
  `

  return message
}

// Runner: seal a streaming message at a stopping point. NULL model/timings/
// tool_calls leave the existing value untouched (COALESCE), so finalizing an
// interrupted message never erases what was already persisted.
export async function finalizeMessage(input: {
  id: string
  status: 'complete' | 'interrupted'
  model?: string | null
  timings?: unknown
  toolCalls?: unknown
}) {
  const [message] = await sql.FinalizeMessage`
    UPDATE messages
    SET status = ${input.status},
        model = coalesce(${input.model ?? null}, model),
        timings = coalesce(${input.timings ?? null}, timings),
        tool_calls = coalesce(${input.toolCalls ?? null}, tool_calls)
    WHERE id = ${input.id}
    RETURNING id, conversation_id, parent_id, role, content, reasoning_content,
              model, status, tool_calls, timings, created_at
  `

  return message
}

export async function listMessageChildren(parentId: string) {
  return sql.ListMessageChildren`
    SELECT id, conversation_id, parent_id, role, content, reasoning_content,
           model, status, tool_calls, timings, created_at
    FROM messages
    WHERE parent_id = ${parentId}
    ORDER BY created_at ASC
  `
}

// Branching (M7): the siblings of a message are the rows in the same
// conversation sharing its parent. `parent_id IS NOT DISTINCT FROM` makes the
// NULL-parent case (top-of-tree messages) a plain equality too, so a system
// prompt or first user turn still gets sibling navigation. Ordered by
// created_at so the "‹ i/n ›" index is stable and matches the fork's tree.
export async function listSiblings(input: {
  conversationId: string
  parentId: string | null
}) {
  return sql.ListSiblings`
    SELECT id, conversation_id, parent_id, role, content, reasoning_content,
           model, status, tool_calls, timings, created_at
    FROM messages
    WHERE conversation_id = ${input.conversationId}
      AND parent_id IS NOT DISTINCT FROM ${input.parentId}
    ORDER BY created_at ASC, id ASC
  `
}

// Branching (M7): in-place content edit of a message (no new node). Used when a
// user edits a message that has no downstream responses yet — same id, same
// tree position. Messages carry no updated_at column, so only content changes.
export async function updateMessageContent(input: { id: string; content: string }) {
  const [message] = await sql.UpdateMessageContent`
    UPDATE messages
    SET content = ${input.content}
    WHERE id = ${input.id}
    RETURNING id, conversation_id, parent_id, role, content, reasoning_content,
              model, status, tool_calls, timings, created_at
  `

  return message
}

// Branching (M7): delete a message and its whole subtree. parent_id is
// ON DELETE CASCADE, so deleting this one row prunes every descendant; scoped
// by conversation_id so one conversation can never delete another's node.
// conversations.curr_node is ON DELETE SET NULL, so a caller repositions the
// active leaf afterward. Returns the deleted id, or undefined if nothing matched.
export async function deleteMessageSubtree(input: {
  id: string
  conversationId: string
}) {
  const [message] = await sql.DeleteMessageSubtree`
    DELETE FROM messages
    WHERE id = ${input.id} AND conversation_id = ${input.conversationId}
    RETURNING id
  `

  return message
}

// Importer-only: inserts with the original export timestamp (so sibling
// ordering by created_at matches the source tree) and always parent_id NULL —
// the importer wires up parent_id in a second pass once every row in the
// batch exists, so a message can be inserted before its parent shows up.
export async function createImportedMessage(input: {
  id: string
  conversationId: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoningContent?: string | null
  model?: string | null
  toolCalls?: unknown
  timings?: unknown
  createdAt: Date
}) {
  const [message] = await sql.CreateImportedMessage`
    INSERT INTO messages (
      id, conversation_id, parent_id, role, content, reasoning_content,
      model, tool_calls, timings, created_at
    )
    VALUES (
      ${input.id},
      ${input.conversationId},
      NULL,
      ${input.role},
      ${input.content},
      ${input.reasoningContent ?? null},
      ${input.model ?? null},
      ${input.toolCalls ?? null},
      ${input.timings ?? null},
      ${input.createdAt}
    )
    RETURNING id, conversation_id, parent_id, role, content, reasoning_content,
              model, status, tool_calls, timings, created_at
  `

  return message
}

export async function setMessageParentId(input: { id: string; parentId: string }) {
  const [message] = await sql.SetMessageParentId`
    UPDATE messages
    SET parent_id = ${input.parentId}
    WHERE id = ${input.id}
    RETURNING id, conversation_id, parent_id, role, content, reasoning_content,
              model, status, tool_calls, timings, created_at
  `

  return message
}

// Walk from a leaf message (typically conversations.curr_node) up to the root
// via parent_id, returning the linear active path in root-first order.
export async function getActivePath(leafId: string) {
  return sql.GetActivePath`
    WITH RECURSIVE active_path AS (
      SELECT m.*, 0 AS depth
      FROM messages m
      WHERE m.id = ${leafId}
      UNION ALL
      SELECT m.*, ap.depth + 1
      FROM messages m
      JOIN active_path ap ON m.id = ap.parent_id
    )
    SELECT id, conversation_id, parent_id, role, content, reasoning_content,
           model, status, tool_calls, tool_call_id, timings, created_at
    FROM active_path
    ORDER BY depth DESC
  `
}
