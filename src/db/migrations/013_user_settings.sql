-- Per-user preference blob. Generic on purpose: future user settings become
-- keys in this JSON instead of new columns or tables. The application owns the
-- shape (src/utils/user-settings.ts) — readers parse defensively and writers
-- merge patches (settings || patch), so old blobs and unknown keys are fine.
-- There are deliberately no FKs into the blob: references (e.g. MCP server
-- ids) are validated against live rows at read time and self-heal on the next
-- write.
--
-- First key: defaultMcpServerIds — the MCP servers pre-checked on the
-- new-chat composer, kept in sync with the last created conversation so tool
-- selections carry over to new chats.

ALTER TABLE users ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;
