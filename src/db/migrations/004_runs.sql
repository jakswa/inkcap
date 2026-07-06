-- A run is the unit of durable server-side work for a conversation.

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting_approval', 'done', 'cancelled', 'error')),
  leaf_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  turn_count integer NOT NULL DEFAULT 0,
  budget jsonb,
  error text,
  seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runs_conversation_id_idx ON runs (conversation_id);

-- Boot recovery scans only for in-flight runs; a partial index keeps it tiny.
CREATE INDEX runs_running_idx ON runs (conversation_id) WHERE status = 'running';
