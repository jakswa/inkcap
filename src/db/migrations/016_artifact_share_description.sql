-- Optional human/share-channel description for public artifacts. This is meant
-- to be filled by future "AI decoration" jobs (cheap separate inference runs)
-- or manually, and used for OpenGraph/meta descriptions without changing the
-- artifact's actual user-facing summary/body.

ALTER TABLE artifacts
  ADD COLUMN share_description text;
