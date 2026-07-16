-- Inkcap stores timestamps as UTC `timestamp without time zone` values. The
-- loop scheduler's next_fire_at is also timezone-free, but represents a local
-- wall clock interpreted using its owner's current timezone.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp with time zone'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE timestamp without time zone USING %I AT TIME ZONE ''UTC''',
      target.table_schema,
      target.table_name,
      target.column_name,
      target.column_name
    );
  END LOOP;
END
$$;
