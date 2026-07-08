-- Loops (scheduled prompts), artifacts, and browser push subscriptions.

CREATE TABLE loops (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prompt text NOT NULL,
  system_prompt text,
  provider_id uuid REFERENCES providers(id) ON DELETE SET NULL,
  model text,
  reasoning_effort text,
  schedule text,
  timezone text NOT NULL DEFAULT 'UTC',
  enabled boolean NOT NULL DEFAULT false,
  last_fired_at timestamptz,
  next_fire_at timestamptz,
  last_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX loops_account_id_updated_at_idx ON loops (account_id, updated_at DESC);
CREATE INDEX loops_due_idx ON loops (next_fire_at) WHERE enabled = true AND next_fire_at IS NOT NULL;

CREATE TABLE loop_mcp_servers (
  loop_id uuid NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
  mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  auto_approve boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (loop_id, mcp_server_id)
);

CREATE INDEX loop_mcp_servers_loop_id_idx ON loop_mcp_servers (loop_id);

ALTER TABLE conversations
  ADD COLUMN routine_id uuid REFERENCES loops(id) ON DELETE SET NULL;

CREATE INDEX conversations_routine_id_updated_at_idx
  ON conversations (routine_id, updated_at DESC) WHERE routine_id IS NOT NULL;

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'generic',
  title text NOT NULL,
  summary text,
  body_markdown text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX artifacts_conversation_id_created_at_idx ON artifacts (conversation_id, created_at DESC);
CREATE INDEX artifacts_run_id_idx ON artifacts (run_id);

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);
