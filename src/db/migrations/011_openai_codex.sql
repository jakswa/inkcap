-- OpenAI Codex (ChatGPT subscription OAuth) provider kind. Tokens live in a
-- jsonb bundle mirroring the Codex CLI's ~/.codex/auth.json `tokens` shape:
-- { id_token, access_token, refresh_token, account_id, last_refresh }.
ALTER TABLE providers DROP CONSTRAINT providers_kind_check;
ALTER TABLE providers
  ADD CONSTRAINT providers_kind_check
  CHECK (kind IN ('openai-compat', 'llama-server', 'openai-codex'));

ALTER TABLE providers
  ADD COLUMN oauth_credentials jsonb;
