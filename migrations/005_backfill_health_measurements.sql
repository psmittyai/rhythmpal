-- Migration 005: backfill_health_measurements
-- Backfill existing apple_health_logs into health_measurements
-- Idempotent via ON CONFLICT DO NOTHING

INSERT INTO health_measurements (user_id, provider, metric_type, value, unit, start_at, end_at, external_id, created_at)
SELECT
  ahl.user_id,
  CASE WHEN ahl.source = 'google_fit' THEN 'google_fit' ELSE 'apple_health' END,
  ahl.data_type,
  ahl.value,
  ahl.unit,
  COALESCE(ahl.start_date, ahl.received_at),
  ahl.end_date,
  NULL,  -- apple_health_logs had no external_id
  ahl.received_at
FROM apple_health_logs ahl
ON CONFLICT DO NOTHING;
