-- next_fire_at is a local wall-clock cursor. The scheduler interprets it in
-- the owner's current timezone, so changing that setting takes effect without
-- rewriting every loop. Preserve existing cursors by converting each instant
-- through the timezone that originally produced it, then drop the snapshot.
ALTER TABLE loops
  ALTER COLUMN next_fire_at TYPE timestamp without time zone
  USING next_fire_at AT TIME ZONE timezone;

ALTER TABLE loops DROP COLUMN timezone;
