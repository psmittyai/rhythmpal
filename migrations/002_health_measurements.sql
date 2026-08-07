-- Migration 002: health_measurements
-- Normalized time-series health measurements — replaces apple_health_logs

CREATE TABLE IF NOT EXISTS health_measurements (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES wearable_connections(id) ON DELETE SET NULL,
  provider VARCHAR(50) NOT NULL,
  source_device VARCHAR(255),
  metric_type VARCHAR(100) NOT NULL,       -- 'heart_rate', 'hrv', 'steps', 'spo2', etc.
  value NUMERIC NOT NULL,
  unit VARCHAR(50),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ,
  external_id VARCHAR(255),               -- provider's own ID for deduplication
  raw_metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider, metric_type, start_at, COALESCE(external_id, ''))
);

CREATE INDEX IF NOT EXISTS idx_hm_user_metric_time ON health_measurements(user_id, metric_type, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_hm_connection ON health_measurements(connection_id);
CREATE INDEX IF NOT EXISTS idx_hm_provider_ext ON health_measurements(provider, external_id) WHERE external_id IS NOT NULL;
