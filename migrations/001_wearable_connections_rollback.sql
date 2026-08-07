-- Rollback 001: wearable_connections
-- Only drop if empty to prevent data loss

DO $$ BEGIN
  IF (SELECT COUNT(*) FROM wearable_connections) = 0 THEN
    DROP TABLE IF EXISTS wearable_connections;
  ELSE
    RAISE NOTICE 'wearable_connections has data — skipping drop. Manual cleanup required.';
  END IF;
END $$;
