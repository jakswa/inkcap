// Branching (M7): the message-tree operations behind edit / regenerate /
// sibling-switch / delete / fork. The schema carried this from day one
// (messages.parent_id + conversations.curr_node); this module is the view/route
// glue that mutates the tree. Semantics follow the fork's UX answer key
// (docs/specs/mcp-and-ux.md Part C) — notably `findLeafByLastChild`, which
// resolves "which sub-branch a jump lands on" by following the most-recently
// created child at each level (spec's `findLeafNode`).

import {
  createConversation,
  setConversationCurrNode,
} from '../db/queries/conversations'
import {
  createMessage,
  getActivePath,
  listMessageChildren,
  listSiblings,
} from '../db/queries/messages'

// Walk DOWN from a node, always following the LAST (most-recently-created)
// child, until a childless node is reached. This is the fork's `findLeafNode`:
// switching to a sibling lands on that sibling's deepest most-recent branch,
// not the sibling row itself and not the oldest path. listMessageChildren is
// ordered created_at ASC, so the last element is the newest child. Trees have
// no cycles, so this terminates.
export async function findLeafByLastChild(startId: string): Promise<string> {
  let current = startId
  for (;;) {
    const children = await listMessageChildren(current)
    if (children.length === 0) return current
    const last = children[children.length - 1]
    if (!last?.id) return current
    current = last.id
  }
}

export interface SiblingNav {
  index: number // 1-based position of this message among its siblings
  total: number // how many siblings share this message's parent
  prevId: string | null // the sibling to switch to for "‹"
  nextId: string | null // the sibling to switch to for "›"
}

// Sibling navigation metadata for one message on the active path. `total > 1`
// is the signal the view uses to render the "‹ i/n ›" switcher. prevId/nextId
// are sibling ids the switch route resolves to their own leaves.
export async function siblingNavFor(input: {
  conversationId: string
  parentId: string | null
  messageId: string
}): Promise<SiblingNav> {
  const siblings = await listSiblings({
    conversationId: input.conversationId,
    parentId: input.parentId,
  })
  const idx = siblings.findIndex((s) => s.id === input.messageId)
  const total = siblings.length
  return {
    index: idx < 0 ? 1 : idx + 1,
    total,
    prevId: idx > 0 ? (siblings[idx - 1]!.id ?? null) : null,
    nextId: idx >= 0 && idx < total - 1 ? (siblings[idx + 1]!.id ?? null) : null,
  }
}

// Rows from getActivePath come back all-nullable (recursive CTE).
type PathRow = {
  id: string | null
  role: string | null
  content: string | null
  reasoning_content: string | null
  model: string | null
  status: string | null
  tool_calls: unknown
  tool_call_id: string | null
  timings: unknown
}

// Fork (M7 / spec C.9): copy the conversation's active path (root → curr_node)
// into a brand-new conversation and stamp forked_from_conversation_id. This is
// the one branching action that never mutates the source tree. The copy is
// linear (the active path is a single root-to-leaf chain), so each new message
// simply hangs off the previous copy; created_at defaults to now() which is
// fine since there are no siblings to order. Returns the new conversation id.
export async function forkConversationPath(conversation: {
  id: string
  user_id: string
  title: string | null
  provider_id: string | null
  model: string | null
  reasoning_effort?: string | null
  curr_node: string | null
}): Promise<string> {
  const forked = await createConversation({
    userId: conversation.user_id,
    title: conversation.title ? `${conversation.title} (fork)` : null,
    providerId: conversation.provider_id,
    model: conversation.model,
    reasoningEffort: conversation.reasoning_effort ?? null,
    forkedFromConversationId: conversation.id,
  })

  if (!conversation.curr_node) return forked.id

  const path = (await getActivePath(conversation.curr_node)) as PathRow[]
  let parentId: string | null = null
  let lastId: string | null = null
  for (const row of path) {
    const created = await createMessage({
      conversationId: forked.id,
      parentId,
      role: (row.role ?? 'user') as 'system' | 'user' | 'assistant' | 'tool',
      content: row.content ?? '',
      reasoningContent: row.reasoning_content,
      model: row.model,
      status: (row.status ?? 'complete') as 'complete' | 'streaming' | 'interrupted',
      toolCalls: row.tool_calls,
      toolCallId: row.tool_call_id,
      timings: row.timings,
    })
    parentId = created.id
    lastId = created.id
  }

  if (lastId) {
    await setConversationCurrNode({ id: forked.id, currNode: lastId })
  }
  return forked.id
}
