-- MCP tool servers: a global catalog (mcp_servers) plus a per-conversation
-- allow-list (conversation_mcp_servers). This mirrors the llama-ui fork's
-- two-layer model (docs/specs/mcp-and-ux.md §A.4): the global row carries the
-- connection details and an enabled kill-switch, while the per-conversation
-- override row is what actually decides whether a server's tools are exposed
-- to the model for a given conversation. Default is OFF: with no override row
-- a server is disabled for that conversation.

CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- Skip the waiting_approval park and run this server's tools straight away.
  auto_approve boolean NOT NULL DEFAULT false,
  -- Custom connection headers (e.g. auth), stored as a JSON object.
  headers jsonb,
  -- Per-server request timeout for tool calls / handshakes (milliseconds).
  request_timeout_ms integer NOT NULL DEFAULT 30000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-conversation override. Presence of a row with enabled = true is the ONLY
-- switch consulted at request time; absence means "disabled for this
-- conversation" regardless of the global mcp_servers.enabled flag.
CREATE TABLE conversation_mcp_servers (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, mcp_server_id)
);

CREATE INDEX conversation_mcp_servers_conversation_id_idx
  ON conversation_mcp_servers (conversation_id);

-- One row per tool call awaiting a human decision. When a run parks in
-- waiting_approval, the runner inserts a pending row per tool call the
-- assistant asked for; the conversation page renders these as approve/deny
-- forms, and resuming the run sets the decision. This is the audit trail and
-- the source of truth for "what is pending" while a run is parked.
CREATE TABLE tool_approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  arguments text NOT NULL DEFAULT '',
  decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'approved', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX tool_approvals_run_id_idx ON tool_approvals (run_id);

-- A role:'tool' message answers a specific assistant tool call. Persisting the
-- id lets the runner rebuild an OpenAI-well-formed message list (each
-- tool_calls[i].id matched by a tool message's tool_call_id) after a restart,
-- when history is re-derived from the message tree rather than kept in memory.
ALTER TABLE messages ADD COLUMN tool_call_id text;
