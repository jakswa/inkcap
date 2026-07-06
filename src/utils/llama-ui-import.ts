// Parses the llama-ui fork's conversation export (JSONL or a .zip bundle of
// JSONL files) into normalized records inkcap can import. See
// docs/specs/export-format.md for the wire format this file implements.
//
// This is a lenient parser: malformed lines/messages/attachments are skipped
// with a warning appended to the returned `warnings` list rather than
// aborting the whole parse, matching this task's "tolerate the ambiguities"
// requirement.

import { unzipSync, strFromU8 } from 'fflate'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type AttachmentKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'text'
  | 'mcp_prompt'
  | 'mcp_resource'
  | 'legacy_context'

export interface ParsedAttachment {
  messageSourceId: string
  kind: AttachmentKind
  name: string | null
  mime: string | null
  bytes: Uint8Array
}

export interface ParsedMessage {
  sourceId: string
  // Already resolved: the synthetic root (if any) is stripped out and mapped
  // to null; a parent pointing at a message this parser dropped is also
  // nulled out (with a warning) rather than left dangling.
  parentSourceId: string | null
  role: MessageRole
  content: string
  reasoningContent: string | null
  model: string | null
  toolCalls: unknown[] | null
  timings: unknown | null
  timestampMs: number
}

export interface ParsedConversation {
  sourceId: string
  // Whether sourceId is RFC-4122-UUID-shaped. The fork falls back to a
  // short Math.random()-based id when crypto.randomUUID is unavailable (see
  // spec §1.4 / §7) — inkcap's importer only reuses the source id as our own
  // conversations.id (a uuid column) when this is true.
  sourceIdIsUuid: boolean
  title: string | null
  pinned: boolean
  forkedFromConversationSourceId: string | null
  // Resolved per spec §2.2: '' / null / an id absent from this export all
  // fall back to the message with the max timestamp; already guaranteed to
  // reference a message present in `messages` below, or be null if the
  // conversation has no importable messages at all.
  currNodeSourceId: string | null
  earliestMessageMs: number | null
  lastModifiedMs: number | null
}

export interface ParsedRecord {
  conversation: ParsedConversation
  messages: ParsedMessage[]
  attachments: ParsedAttachment[]
}

export interface ParseResult {
  records: ParsedRecord[]
  warnings: string[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value)
}

export function parseExport(input: string | Uint8Array): ParseResult {
  const warnings: string[] = []
  const rawSessions: RawSession[] = []

  if (typeof input === 'string') {
    rawSessions.push(...parseSessionsJsonl(input, warnings))
  } else if (isZip(input)) {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(input)
    } catch (error) {
      warnings.push(`zip archive: failed to read (${(error as Error).message})`)
      entries = {}
    }
    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.toLowerCase().endsWith('.jsonl')) continue // non-jsonl entries are silently skipped, per spec §5.2
      rawSessions.push(...parseSessionsJsonl(strFromU8(bytes), warnings, name))
    }
  } else {
    rawSessions.push(...parseSessionsJsonl(new TextDecoder().decode(input), warnings))
  }

  const records: ParsedRecord[] = []
  for (const raw of rawSessions) {
    const record = normalizeSession(raw, warnings)
    if (record) records.push(record)
  }

  return { records, warnings }
}

// --- JSONL line-level parsing (spec §3.2) ---------------------------------

interface RawSession {
  conv: Record<string, unknown>
  messages: Record<string, unknown>[]
}

function parseSessionsJsonl(text: string, warnings: string[], label = 'input'): RawSession[] {
  const sessions: RawSession[] = []
  let current: RawSession | null = null

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (!trimmed) continue

    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch (error) {
      warnings.push(`${label}:${i + 1}: skipped line, invalid JSON (${(error as Error).message})`)
      continue
    }

    if (record == null || typeof record !== 'object') {
      warnings.push(`${label}:${i + 1}: skipped line, not a JSON object`)
      continue
    }

    const type = (record as Record<string, unknown>)['type']

    if (type === 'session') {
      const conv = { ...(record as Record<string, unknown>) }
      delete conv.type
      delete conv.harness
      current = { conv, messages: [] }
      sessions.push(current)
    } else if (type === 'message') {
      // The fork throws here; we're deliberately more lenient (skip + warn)
      // per this task's tolerance requirement rather than aborting the file.
      if (!current) {
        warnings.push(`${label}:${i + 1}: skipped, message record before any session record`)
        continue
      }
      const message = (record as Record<string, unknown>)['message']
      if (message == null || typeof message !== 'object') {
        warnings.push(`${label}:${i + 1}: skipped, message record missing a "message" object`)
        continue
      }
      current.messages.push(message as Record<string, unknown>)
    }
    // Unknown record types are ignored for forward compatibility, matching parseSessionsJsonl.
  }

  return sessions
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b // 'PK'
}

// --- Session normalization (spec §1, §2, §4) ------------------------------

const VALID_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool'])

interface NodeInfo {
  parent: string | null
  type: string
}

function normalizeSession(raw: RawSession, warnings: string[]): ParsedRecord | null {
  const convId = raw.conv['id']
  if (typeof convId !== 'string' || convId.length === 0) {
    warnings.push('skipped a session: missing/invalid conversation id')
    return null
  }

  const title = typeof raw.conv['name'] === 'string' ? (raw.conv['name'] as string) : null
  const pinned = raw.conv['pinned'] === true
  const forkedFromRaw = raw.conv['forkedFromConversationId']
  const forkedFromConversationSourceId =
    typeof forkedFromRaw === 'string' && forkedFromRaw.length > 0 ? forkedFromRaw : null
  const lastModifiedRaw = raw.conv['lastModified']
  const lastModifiedMs = typeof lastModifiedRaw === 'number' ? lastModifiedRaw : null

  const nodes = new Map<string, NodeInfo>()
  const parsedMessages: ParsedMessage[] = []
  const attachments: ParsedAttachment[] = []
  let rootSourceId: string | null = null

  for (const m of raw.messages) {
    if (m == null || typeof m !== 'object') {
      warnings.push(`${convId}: skipped a message record that was not an object`)
      continue
    }

    const id = m['id']
    if (typeof id !== 'string' || id.length === 0) {
      warnings.push(`${convId}: skipped a message with a missing/invalid id`)
      continue
    }
    if (nodes.has(id)) {
      warnings.push(`${convId}: duplicate message id "${id}", keeping the first occurrence`)
      continue
    }

    const parentRaw = m['parent']
    const parent = typeof parentRaw === 'string' && parentRaw.length > 0 ? parentRaw : null
    const type = typeof m['type'] === 'string' ? (m['type'] as string) : 'text'
    nodes.set(id, { parent, type })

    if (type === 'root') {
      if (rootSourceId) {
        warnings.push(`${convId}: multiple root messages found, keeping the first`)
      } else {
        rootSourceId = id
      }
      continue // the synthetic root is never imported as a message row (spec §1.4)
    }

    const role = m['role']
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      warnings.push(`${convId}: skipped message "${id}", unrecognized role ${JSON.stringify(role)}`)
      continue
    }

    const content = typeof m['content'] === 'string' ? (m['content'] as string) : ''
    const reasoningContent = typeof m['reasoningContent'] === 'string' ? (m['reasoningContent'] as string) : null
    const model = typeof m['model'] === 'string' ? (m['model'] as string) : null
    const timestampRaw = m['timestamp']
    const timestampMs = typeof timestampRaw === 'number' ? timestampRaw : 0
    const timings = m['timings'] != null && typeof m['timings'] === 'object' ? m['timings'] : null

    parsedMessages.push({
      sourceId: id,
      parentSourceId: parent,
      role: role as MessageRole,
      content,
      reasoningContent,
      model,
      toolCalls: normalizeToolCalls(m['toolCalls'], convId, id, warnings),
      timings,
      timestampMs,
    })

    const extra = m['extra']
    if (Array.isArray(extra)) {
      for (const item of extra) {
        const decoded = decodeAttachment(item, id, convId, warnings)
        if (decoded) attachments.push(decoded)
      }
    }
  }

  // Fix up parent links: root -> null, dangling (points at a dropped/missing
  // message) -> null with a warning, per spec §2.3/§2.4 tolerance guidance.
  const importableIds = new Set(parsedMessages.map((pm) => pm.sourceId))
  for (const pm of parsedMessages) {
    if (pm.parentSourceId === null) continue
    if (pm.parentSourceId === rootSourceId) {
      pm.parentSourceId = null
    } else if (!importableIds.has(pm.parentSourceId)) {
      warnings.push(`${convId}: message "${pm.sourceId}" has a dangling parent reference, attaching at top level`)
      pm.parentSourceId = null
    }
  }

  const currNodeSourceId = resolveCurrNode(raw.conv['currNode'], parsedMessages, importableIds, convId, warnings)

  const earliestMessageMs = parsedMessages.length
    ? Math.min(...parsedMessages.map((m) => m.timestampMs))
    : null

  return {
    conversation: {
      sourceId: convId,
      sourceIdIsUuid: isUuidLike(convId),
      title,
      pinned,
      forkedFromConversationSourceId,
      currNodeSourceId,
      earliestMessageMs,
      lastModifiedMs,
    },
    messages: parsedMessages,
    attachments,
  }
}

// spec §2.2: '' / null / an id not present in this export all mean "no
// current node" -> fall back to the message with the max timestamp.
// Restricted to *importable* messages (root and dropped messages can't be a
// inkcap curr_node, since that column FKs into our messages table).
function resolveCurrNode(
  rawCurrNode: unknown,
  parsedMessages: ParsedMessage[],
  importableIds: Set<string>,
  convId: string,
  warnings: string[],
): string | null {
  const candidate = typeof rawCurrNode === 'string' && rawCurrNode.length > 0 ? rawCurrNode : null

  if (candidate && importableIds.has(candidate)) return candidate

  if (candidate) {
    warnings.push(
      `${convId}: currNode "${candidate}" does not resolve to an importable message, falling back to latest by timestamp`,
    )
  }

  let latest: ParsedMessage | null = null
  for (const pm of parsedMessages) {
    if (!latest || pm.timestampMs > latest.timestampMs) latest = pm
  }
  return latest?.sourceId ?? null
}

function normalizeToolCalls(
  raw: unknown,
  convId: string,
  messageId: string,
  warnings: string[],
): unknown[] | null {
  if (raw == null || raw === '') return null
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
      warnings.push(`${convId}: message "${messageId}" had a non-array toolCalls string, dropping`)
      return null
    } catch {
      warnings.push(`${convId}: message "${messageId}" had unparseable toolCalls JSON, dropping`)
      return null
    }
  }
  warnings.push(`${convId}: message "${messageId}" had an unrecognized toolCalls shape, dropping`)
  return null
}

// --- Attachment decoding (spec §4) -----------------------------------------

function decodeAttachment(
  item: unknown,
  messageSourceId: string,
  convId: string,
  warnings: string[],
): ParsedAttachment | null {
  if (item == null || typeof item !== 'object') {
    warnings.push(`${convId}: skipped an attachment on message "${messageSourceId}", not an object`)
    return null
  }

  const record = item as Record<string, unknown>
  const type = record['type']
  const name = typeof record['name'] === 'string' ? (record['name'] as string) : null

  try {
    switch (type) {
      case 'IMAGE': {
        const url = record['base64Url']
        if (typeof url !== 'string') throw new Error('missing base64Url')
        const commaIdx = url.indexOf(',')
        if (commaIdx === -1) throw new Error('malformed data URL')
        const mimeMatch = /^data:([^;]+);base64$/.exec(url.slice(0, commaIdx))
        return {
          messageSourceId,
          kind: 'image',
          name,
          mime: mimeMatch ? mimeMatch[1]! : null,
          bytes: base64ToBytes(url.slice(commaIdx + 1)),
        }
      }
      case 'AUDIO':
      case 'VIDEO': {
        const data = record['base64Data']
        if (typeof data !== 'string') throw new Error('missing base64Data')
        return {
          messageSourceId,
          kind: type === 'AUDIO' ? 'audio' : 'video',
          name,
          mime: typeof record['mimeType'] === 'string' ? (record['mimeType'] as string) : null,
          bytes: base64ToBytes(data),
        }
      }
      case 'PDF': {
        const data = record['base64Data']
        if (typeof data !== 'string') throw new Error('missing base64Data')
        warnings.push(
          `${convId}: PDF attachment on message "${messageSourceId}" imported as raw bytes only; extracted text and rendered page images are dropped`,
        )
        return { messageSourceId, kind: 'pdf', name, mime: 'application/pdf', bytes: base64ToBytes(data) }
      }
      case 'TEXT': {
        const content = typeof record['content'] === 'string' ? (record['content'] as string) : ''
        return { messageSourceId, kind: 'text', name, mime: 'text/plain', bytes: new TextEncoder().encode(content) }
      }
      case 'LEGACY_CONTEXT':
      case 'context': {
        const content = typeof record['content'] === 'string' ? (record['content'] as string) : ''
        return {
          messageSourceId,
          kind: 'legacy_context',
          name,
          mime: 'text/plain',
          bytes: new TextEncoder().encode(content),
        }
      }
      case 'MCP_PROMPT': {
        const content = typeof record['content'] === 'string' ? (record['content'] as string) : ''
        warnings.push(
          `${convId}: MCP prompt attachment on message "${messageSourceId}" imported as text only; server/prompt/argument metadata dropped`,
        )
        return {
          messageSourceId,
          kind: 'mcp_prompt',
          name,
          mime: 'text/plain',
          bytes: new TextEncoder().encode(content),
        }
      }
      case 'MCP_RESOURCE': {
        const content = typeof record['content'] === 'string' ? (record['content'] as string) : ''
        warnings.push(
          `${convId}: MCP resource attachment on message "${messageSourceId}" imported as text only; uri/server metadata dropped`,
        )
        return {
          messageSourceId,
          kind: 'mcp_resource',
          name,
          mime: typeof record['mimeType'] === 'string' ? (record['mimeType'] as string) : 'text/plain',
          bytes: new TextEncoder().encode(content),
        }
      }
      default:
        warnings.push(
          `${convId}: skipped an attachment on message "${messageSourceId}" with unrecognized type ${JSON.stringify(type)}`,
        )
        return null
    }
  } catch (error) {
    warnings.push(`${convId}: skipped an attachment on message "${messageSourceId}": ${(error as Error).message}`)
    return null
  }
}

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}
