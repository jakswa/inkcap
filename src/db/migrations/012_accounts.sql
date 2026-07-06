-- Accounts scope ownership of providers and MCP servers (issue 02: the old
-- schema was a global unowned catalog every authenticated user could read and
-- mutate). Every user gets a personal account whose id EQUALS their user id —
-- a deliberate invariant so app code can address "my account" without a
-- lookup. Reads always go through account_memberships, so future sharing is
-- additive: invite another user into an account by inserting a membership row,
-- and every scoped query already grants them access.

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_memberships (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

CREATE INDEX account_memberships_user_id_idx ON account_memberships (user_id);

-- Backfill: a personal account (id = user id) per existing user.
INSERT INTO accounts (id, name)
SELECT id, name FROM users;

INSERT INTO account_memberships (account_id, user_id, role)
SELECT id, id, 'owner' FROM users;

ALTER TABLE providers
  ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE mcp_servers
  ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;

-- Existing rows predate ownership; assign them to the earliest-registered
-- user (the deployment operator). If providers exist but no users do, the
-- SET NOT NULL below aborts the whole transaction — register a user or delete
-- the orphan rows, then re-run migrations.
UPDATE providers
SET account_id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1);
UPDATE mcp_servers
SET account_id = (SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1);

ALTER TABLE providers ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE mcp_servers ALTER COLUMN account_id SET NOT NULL;

-- Pre-012 conversations may reference a provider their owner can no longer
-- see (the backfill above gave everything to the earliest user). Detach those
-- references so a legacy conversation cannot keep spending another account's
-- provider; the UI already handles provider-less conversations ("assign one
-- before sending").
UPDATE conversations c
SET provider_id = NULL
WHERE c.provider_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM providers p
    JOIN account_memberships m
      ON m.account_id = p.account_id AND m.user_id = c.user_id
    WHERE p.id = c.provider_id
  );

CREATE INDEX providers_account_id_idx ON providers (account_id);
CREATE INDEX mcp_servers_account_id_idx ON mcp_servers (account_id);
