-- Attachments live in their own table (not inline base64 in messages), served
-- by URL and size-capped. v1 supports text/image.

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text,
  mime text,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachments_message_id_idx ON attachments (message_id);
