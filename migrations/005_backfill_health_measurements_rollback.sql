-- Rollback 005: backfill_health_measurements
-- Remove backfilled rows that came from apple_health_logs (identified by null external_id from known providers)

DELETE FROM health_measurements WHERE provider IN ('apple_health', 'google_fit') AND external_id IS NULL;

-- Note: this is a best-effort rollback. New data written to health_measurements directly won't be touched.
