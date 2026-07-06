-- Ordered, replayable SSE events for a run. Any server process can replay a
-- run's stream to a late-joining client from these rows; seq is per-run and
-- monotonically increasing (runs.seq is the cursor of the last event written).
--
-- Rows are transient: once a run reaches a terminal state and is older than an
-- hour, its events are deleted (cleanup runs at boot). The permanent record of
-- a run's output is the messages table, not run_events.

CREATE TABLE run_events (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  type text NOT NULL
    CHECK (type IN ('message-start', 'delta', 'message-final', 'run-status')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
