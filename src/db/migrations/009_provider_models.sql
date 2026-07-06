ALTER TABLE providers
  ADD COLUMN models text[] NOT NULL DEFAULT '{}';
