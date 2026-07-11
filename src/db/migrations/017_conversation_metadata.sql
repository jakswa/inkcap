-- Sparse, application-owned conversation metadata. NULL means no metadata;
-- callers coalesce only when writing a key so rows without metadata stay quiet.
ALTER TABLE conversations ADD COLUMN metadata jsonb;
