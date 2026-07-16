-- A loop follows its owner's current timezone. Keeping a timezone snapshot on
-- the loop made later timezone corrections ineffective and left schedules
-- permanently pinned to stale settings.

-- Mark enabled schedules for application-level recalculation: PostgreSQL does
-- not understand our cron/once syntax. Scheduler startup fills these cursors
-- using each owner's current setting before checking for due work.
UPDATE loops SET next_fire_at = NULL WHERE enabled = true;

ALTER TABLE loops DROP COLUMN timezone;
