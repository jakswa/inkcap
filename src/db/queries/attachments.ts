import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function createAttachment(input: {
  messageId: string
  kind: string
  name?: string | null
  mime?: string | null
  bytes: Uint8Array
}) {
  const [attachment] = await sql.CreateAttachment`
    INSERT INTO attachments (id, message_id, kind, name, mime, bytes)
    VALUES (
      ${randomUUIDv7()},
      ${input.messageId},
      ${input.kind},
      ${input.name ?? null},
      ${input.mime ?? null},
      ${Buffer.from(input.bytes)}
    )
    RETURNING id, message_id, kind, name, mime, created_at
  `

  return attachment
}

export async function listAttachmentsForMessage(messageId: string) {
  return sql.ListAttachmentsForMessage`
    SELECT id, message_id, kind, name, mime, bytes, created_at
    FROM attachments
    WHERE message_id = ${messageId}
    ORDER BY created_at ASC
  `
}
