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
  timings?: unknown
}) {
  const [message] = await sql.CreateMessage`
    INSERT INTO messages (
      id, conversation_id, parent_id, role, content, reasoning_content,
      model, status, tool_calls, timings
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
      ${input.toolCalls == null ? null : JSON.stringify(input.toolCalls)},
      ${input.timings == null ? null : JSON.stringify(input.timings)}
    )
    RETURNING id, conversation_id, parent_id, role, content, reasoning_content,
              model, status, tool_calls, timings, created_at
  `

  return message
}

export async function getMessageById(id: string) {
  const [message] = await sql.GetMessageById`
    SELECT id, conversation_id, parent_id, role, content, reasoning_content,
           model, status, tool_calls, timings, created_at
    FROM messages
    WHERE id = ${id}
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
           model, status, tool_calls, timings, created_at
    FROM active_path
    ORDER BY depth DESC
  `
}
