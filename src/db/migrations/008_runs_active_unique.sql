-- Enforce one non-terminal run per conversation across processes.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY conversation_id
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at DESC
    ) AS rank
  FROM runs
  WHERE status IN ('running', 'waiting_approval')
)
UPDATE runs
SET
  status = 'error',
  error = coalesce(error, 'superseded by active-run uniqueness migration'),
  updated_at = now()
FROM ranked
WHERE runs.id = ranked.id
  AND ranked.rank > 1;

CREATE UNIQUE INDEX runs_one_active_per_conversation_idx
  ON runs (conversation_id)
  WHERE status IN ('running', 'waiting_approval');
