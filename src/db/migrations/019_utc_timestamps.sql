-- Inkcap stores timestamps as UTC `timestamp without time zone` values. The
-- loop scheduler's next_fire_at is also timezone-free, but represents a local
-- wall clock interpreted using its owner's current timezone.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT
      table_schema,
      table_name,
      string_agg(
        format(
          'ALTER COLUMN %I TYPE timestamp without time zone USING %I AT TIME ZONE ''UTC''',
          column_name,
          column_name
        ),
        ', ' ORDER BY ordinal_position
      ) AS alterations
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp with time zone'
    GROUP BY table_schema, table_name
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I %s',
      target.table_schema,
      target.table_name,
      target.alterations
    );
  END LOOP;
END
$$;
