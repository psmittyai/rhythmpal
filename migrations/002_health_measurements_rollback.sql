-- Rollback 002: health_measurements

DO $$ BEGIN
  IF (SELECT COUNT(*) FROM health_measurements) = 0 THEN
    DROP TABLE IF EXISTS health_measurements;
  ELSE
    RAISE NOTICE 'health_measurements has data — skipping drop.';
  END IF;
END $$;
