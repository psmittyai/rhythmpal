-- Rollback 003: sleep_sessions

DO $$ BEGIN
  IF (SELECT COUNT(*) FROM sleep_sessions) = 0 THEN
    DROP TABLE IF EXISTS sleep_sessions;
  ELSE
    RAISE NOTICE 'sleep_sessions has data — skipping drop.';
  END IF;
END $$;
