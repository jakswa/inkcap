ALTER TABLE providers
  ADD COLUMN model_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE conversations
  ADD COLUMN reasoning_effort text CHECK (reasoning_effort IN ('off', 'low', 'medium', 'high', 'max'));
