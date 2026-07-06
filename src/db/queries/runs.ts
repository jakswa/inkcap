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
      ${input.budget == null ? null : JSON.stringify(input.budget)}
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
