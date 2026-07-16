import { sql } from '../client'
import { randomUUIDv7 } from 'bun'

export async function createRun(input: {
  conversationId: string
  status?: 'running' | 'waiting_approval' | 'done' | 'cancelled' | 'error'
  leafMessageId?: string | null
  turnCount?: number
  budget?: unknown
}) {
  const [run] = await sql.CreateRun`
    INSERT INTO runs (id, conversation_id, status, leaf_message_id, turn_count, budget)
    VALUES (
      ${randomUUIDv7()},
      ${input.conversationId},
      ${input.status ?? 'running'},
      ${input.leafMessageId ?? null},
      ${input.turnCount ?? 0},
      ${input.budget ?? null}
    )
    RETURNING id, conversation_id, status, leaf_message_id, turn_count, budget,
              error, seq, created_at, updated_at
  `

  return run
}

export async function getRunById(id: string) {
  const [run] = await sql.GetRunById`
    SELECT id, conversation_id, status, leaf_message_id, turn_count, budget,
           error, seq, created_at, updated_at
    FROM runs
    WHERE id = ${id}
  `

  return run
}

export async function setRunStatus(input: {
  id: string
  status: 'running' | 'waiting_approval' | 'done' | 'cancelled' | 'error'
  error?: string | null
}) {
  const [run] = await sql.SetRunStatus`
    UPDATE runs
    SET status = ${input.status}, error = ${input.error ?? null}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, conversation_id, status, leaf_message_id, turn_count, budget,
              error, seq, created_at, updated_at
  `

  return run
}

// Atomically bump the SSE event cursor and return the new value.
export async function incrementRunSeq(id: string) {
  const [run] = await sql.IncrementRunSeq`
    UPDATE runs
    SET seq = seq + 1, updated_at = now()
    WHERE id = ${id}
    RETURNING id, seq
  `

  return run
}

// The in-flight run for a conversation, if any (hits the partial index).
export async function getRunningRunForConversation(conversationId: string) {
  const [run] = await sql.GetRunningRunForConversation`
    SELECT id, conversation_id, status, leaf_message_id, turn_count, budget,
           error, seq, created_at, updated_at
    FROM runs
    WHERE conversation_id = ${conversationId} AND status = 'running'
    ORDER BY created_at DESC
    LIMIT 1
  `

  return run
}

// Any non-terminal run that blocks starting another run for the conversation.
export async function getBlockingRunForConversation(conversationId: string) {
  const [run] = await sql.GetBlockingRunForConversation`
    SELECT id, conversation_id, status, leaf_message_id, turn_count, budget,
           error, seq, created_at, updated_at
    FROM runs
    WHERE conversation_id = ${conversationId}
      AND status IN ('running', 'waiting_approval')
    ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `

  return run
}

// The most recent run for a conversation regardless of status; the SSE
// endpoint attaches to this when no run is currently in flight.
export async function getLatestRunForConversation(conversationId: string) {
  const [run] = await sql.GetLatestRunForConversation`
    SELECT id, conversation_id, status, leaf_message_id, turn_count, budget,
           error, seq, created_at, updated_at
    FROM runs
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC
    LIMIT 1
  `

  return run
}

export async function isOriginatingRun(input: { runId: string; conversationId: string }) {
  const [row] = await sql.IsOriginatingRun`
    SELECT id = ${input.runId} AS is_originating
    FROM runs
    WHERE conversation_id = ${input.conversationId}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `
  return row?.is_originating ?? false
}

// Advance the run's leaf pointer as the tool loop creates each next assistant
// message. Recovery/replay use leaf_message_id to find the message to seal.
export async function setRunLeafMessage(input: { id: string; leafMessageId: string }) {
  const [run] = await sql.SetRunLeafMessage`
    UPDATE runs
    SET leaf_message_id = ${input.leafMessageId}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id, leaf_message_id
  `

  return run
}

// One completed provider turn. Kept separate from setRunStatus so the M6 tool
// loop can bump it once per turn without touching status.
export async function incrementRunTurnCount(id: string) {
  const [run] = await sql.IncrementRunTurnCount`
    UPDATE runs
    SET turn_count = turn_count + 1, updated_at = now()
    WHERE id = ${id}
    RETURNING id, turn_count
  `

  return run
}

// Boot recovery: find in-flight runs (hits the partial index).
export async function listRunningRuns() {
  return sql.ListRunningRuns`
    SELECT id, conversation_id, status, leaf_message_id, turn_count, budget,
           error, seq, created_at, updated_at
    FROM runs
    WHERE status = 'running'
    ORDER BY created_at ASC
  `
}
