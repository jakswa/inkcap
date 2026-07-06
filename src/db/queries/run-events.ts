import { sql } from '../client'

// Append one event to a run's ordered log. The CTE bumps runs.seq and uses the
// new value as the event's seq in a single atomic statement, so seq is gapless
// and monotonically increasing per run even if callers ever raced.
//
// NOTE: bun-sqlgen types bigint columns as string — convert seq with Number()
// at call sites.
export async function insertRunEvent(input: {
  runId: string
  type: 'message-start' | 'delta' | 'message-final' | 'run-status'
  payload: unknown
}) {
  const [event] = await sql.InsertRunEvent`
    WITH bumped AS (
      UPDATE runs
      SET seq = seq + 1, updated_at = now()
      WHERE id = ${input.runId}
      RETURNING seq
    )
    INSERT INTO run_events (run_id, seq, type, payload)
    SELECT ${input.runId}, bumped.seq, ${input.type}, ${input.payload}
    FROM bumped
    RETURNING run_id, seq, type, payload, created_at
  `

  return event
}

// Replay: all of a run's events with seq strictly after the cursor, in order.
// Pass afterSeq = 0 for a full replay.
export async function listRunEventsAfter(input: { runId: string; afterSeq: number }) {
  return sql.ListRunEventsAfter`
    SELECT run_id, seq, type, payload, created_at
    FROM run_events
    WHERE run_id = ${input.runId} AND seq > ${input.afterSeq}
    ORDER BY seq ASC
  `
}

// Cleanup (called at boot): drop events for runs that reached a terminal state
// more than an hour ago. Live and freshly-finished runs keep their events so
// late joiners can still replay.
export async function deleteExpiredRunEvents() {
  return sql.DeleteExpiredRunEvents`
    DELETE FROM run_events
    USING runs
    WHERE run_events.run_id = runs.id
      AND runs.status IN ('done', 'cancelled', 'error')
      AND runs.updated_at < now() - interval '1 hour'
    RETURNING run_events.run_id, run_events.seq
  `
}
