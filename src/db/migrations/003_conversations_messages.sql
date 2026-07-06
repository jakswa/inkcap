-- Conversations and their branching message tree.
--
-- conversations.curr_node references messages.id, and messages.conversation_id
-- references conversations.id, so the two tables are mutually dependent. We
-- create conversations first (leaving curr_node unconstrained), then messages,
-- then add the curr_node foreign key.

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text,
  provider_id uuid REFERENCES providers(id) ON DELETE SET NULL,
  model text,
  curr_node uuid,
  pinned boolean NOT NULL DEFAULT false,
  forked_from_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content text NOT NULL DEFAULT '',
  reasoning_content text,
  model text,
  status text NOT NULL DEFAULT 'complete'
    CHECK (status IN ('complete', 'streaming', 'interrupted')),
  tool_calls jsonb,
  timings jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The active leaf of the tree. ON DELETE SET NULL so pruning the current leaf
-- message leaves the conversation intact (a caller re-points curr_node).
ALTER TABLE conversations
  ADD CONSTRAINT conversations_curr_node_fkey
  FOREIGN KEY (curr_node) REFERENCES messages(id) ON DELETE SET NULL;

-- Children are derived by querying parent_id; never stored as arrays.
CREATE INDEX messages_conversation_id_idx ON messages (conversation_id);
CREATE INDEX messages_parent_id_idx ON messages (parent_id);

-- Conversation list is per-user, most-recently-updated first.
CREATE INDEX conversations_user_id_updated_at_idx
  ON conversations (user_id, updated_at DESC);
