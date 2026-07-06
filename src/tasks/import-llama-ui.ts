// CLI: bun src/tasks/import-llama-ui.ts <file> --user <email>
//
// Imports a llama-ui fork export (.jsonl or .zip, see docs/specs/export-format.md)
// into spail's conversations/messages/attachments tables for the named user.

import { sql } from '../db/client'
import { getUserByEmailNormalized } from '../db/queries/users'
import {
  createImportedConversation,
  findConversationMatch,
  getConversationById,
  setConversationCurrNode,
} from '../db/queries/conversations'
import { createImportedMessage, setMessageParentId } from '../db/queries/messages'
import { createAttachment } from '../db/queries/attachments'
import { isUuidLike, parseExport, type ParsedRecord } from '../utils/llama-ui-import'
import { randomUUIDv7 } from 'bun'

async function main() {
  const { file, userEmail } = parseArgs(Bun.argv.slice(2))

  const bunFile = Bun.file(file)
  if (!(await bunFile.exists())) {
    console.error(`File not found: ${file}`)
    process.exitCode = 1
    return
  }

  const emailNormalized = userEmail.trim().toLowerCase()
  const user = await getUserByEmailNormalized(emailNormalized)
  if (!user) {
    console.error(`No user found with email: ${userEmail}`)
    process.exitCode = 1
    return
  }

  const input = file.toLowerCase().endsWith('.zip')
    ? new Uint8Array(await bunFile.arrayBuffer())
    : await bunFile.text()

  const { records, warnings } = parseExport(input)

  const totals = {
    conversationsImported: 0,
    conversationsSkipped: 0,
    messages: 0,
    branchPoints: 0,
    attachments: 0,
  }

  for (const record of records) {
    const outcome = await importRecord(record, user.id)
    if (outcome.skipped) {
      totals.conversationsSkipped++
      continue
    }
    totals.conversationsImported++
    totals.messages += outcome.messageCount
    totals.branchPoints += outcome.branchPoints
    totals.attachments += outcome.attachmentCount
  }

  printSummary(totals, warnings)

  await sql.close()
}

function parseArgs(argv: string[]): { file: string; userEmail: string } {
  let file: string | undefined
  let userEmail: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--user') {
      userEmail = argv[++i]
    } else if (!file) {
      file = arg
    }
  }

  if (!file || !userEmail) {
    throw new Error('Usage: bun src/tasks/import-llama-ui.ts <file> --user <email>')
  }

  return { file, userEmail }
}

interface ImportOutcome {
  skipped: boolean
  messageCount: number
  attachmentCount: number
  branchPoints: number
}

// Idempotency strategy (see docs on ParsedConversation.sourceIdIsUuid):
//  - When the source conversation id is UUID-shaped (the common case — the
//    fork uses crypto.randomUUID()), we reuse it verbatim as our own
//    conversations.id. Re-running the import is then a plain existence
//    check on that id, mirroring the fork's own "dedupe purely on conv.id"
//    behavior (spec §5.4).
//  - When it isn't UUID-shaped (the fork's Math.random() fallback, or a
//    hand-edited export), we generate a fresh id and instead match on
//    (user, title, created_at). created_at is deliberately set to the
//    export's earliest-message timestamp (not import time) specifically so
//    that re-importing the same file reproduces the same created_at and
//    trips this match.
async function importRecord(record: ParsedRecord, userId: string): Promise<ImportOutcome> {
  const { conversation, messages, attachments } = record

  const createdAtMs = conversation.earliestMessageMs ?? conversation.lastModifiedMs ?? Date.now()
  const createdAt = new Date(createdAtMs)

  if (conversation.sourceIdIsUuid) {
    const existing = await getConversationById(conversation.sourceId)
    if (existing) return { skipped: true, messageCount: 0, attachmentCount: 0, branchPoints: 0 }
  } else {
    const existing = await findConversationMatch({ userId, title: conversation.title, createdAt })
    if (existing) return { skipped: true, messageCount: 0, attachmentCount: 0, branchPoints: 0 }
  }

  const conversationId = conversation.sourceIdIsUuid ? conversation.sourceId : randomUUIDv7()

  // forked_from_conversation_id is a self-referencing FK into our own
  // conversations table; only wire it up if the source's forked-from id is
  // itself UUID-shaped (so the FK query is even well-typed) and was actually
  // imported (e.g. in an earlier run, keeping its source id verbatim).
  let forkedFromConversationId: string | null = null
  if (conversation.forkedFromConversationSourceId && isUuidLike(conversation.forkedFromConversationSourceId)) {
    const source = await getConversationById(conversation.forkedFromConversationSourceId)
    forkedFromConversationId = source ? source.id : null
  }

  await createImportedConversation({
    id: conversationId,
    userId,
    title: conversation.title,
    pinned: conversation.pinned,
    forkedFromConversationId,
    createdAt,
  })

  const idMap = new Map<string, string>()
  const childCounts = new Map<string, number>()

  for (const message of messages) {
    const newId = randomUUIDv7()
    idMap.set(message.sourceId, newId)

    await createImportedMessage({
      id: newId,
      conversationId,
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      model: message.model,
      toolCalls: message.toolCalls,
      timings: message.timings,
      createdAt: new Date(message.timestampMs),
    })

    if (message.parentSourceId) {
      childCounts.set(message.parentSourceId, (childCounts.get(message.parentSourceId) ?? 0) + 1)
    }
  }

  // Second pass: every message row in this batch now exists, so parent_id
  // links can be wired up regardless of the source array's order.
  for (const message of messages) {
    if (!message.parentSourceId) continue
    const parentId = idMap.get(message.parentSourceId)
    const childId = idMap.get(message.sourceId)
    if (!parentId || !childId) continue // shouldn't happen; parser already dropped dangling links
    await setMessageParentId({ id: childId, parentId })
  }

  let attachmentCount = 0
  for (const attachment of attachments) {
    const messageId = idMap.get(attachment.messageSourceId)
    if (!messageId) continue // the message itself was dropped during parsing
    await createAttachment({
      messageId,
      kind: attachment.kind,
      name: attachment.name,
      mime: attachment.mime,
      bytes: attachment.bytes,
    })
    attachmentCount++
  }

  if (conversation.currNodeSourceId) {
    const currNode = idMap.get(conversation.currNodeSourceId) ?? null
    if (currNode) await setConversationCurrNode({ id: conversationId, currNode })
  }

  const branchPoints = [...childCounts.values()].filter((count) => count > 1).length

  return { skipped: false, messageCount: messages.length, attachmentCount, branchPoints }
}

function printSummary(
  totals: {
    conversationsImported: number
    conversationsSkipped: number
    messages: number
    branchPoints: number
    attachments: number
  },
  warnings: string[],
) {
  console.log('llama-ui import summary')
  console.table({
    conversations_imported: totals.conversationsImported,
    conversations_skipped: totals.conversationsSkipped,
    messages: totals.messages,
    branch_points: totals.branchPoints,
    attachments: totals.attachments,
    warnings: warnings.length,
  })

  if (warnings.length) {
    console.log('\nWarnings:')
    for (const warning of warnings) console.log(`  - ${warning}`)
  }
}

await main()
