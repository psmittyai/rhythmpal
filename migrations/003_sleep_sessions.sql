-- Migration 003: sleep_sessions
-- First-class sleep model — canonical dataset for sleep intelligence

CREATE TABLE IF NOT EXISTS sleep_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES wearable_connections(id) ON DELETE SET NULL,
  provider VARCHAR(50) NOT NULL,
  provider_session_id VARCHAR(255) NOT NULL,  -- provider's own session ID
  sleep_date DATE NOT NULL,                    -- calendar date the sleep "belongs to"

  bedtime_start TIMESTAMPTZ,
  bedtime_end TIMESTAMPTZ,

  total_sleep_minutes INTEGER,
  time_in_bed_minutes INTEGER,
  awake_minutes INTEGER,

  rem_sleep_minutes INTEGER,
  deep_sleep_minutes INTEGER,
  light_sleep_minutes INTEGER,

  sleep_efficiency NUMERIC,                    -- 0–100
  sleep_latency_minutes INTEGER,

  average_hr NUMERIC,
  lowest_hr NUMERIC,
  average_hrv NUMERIC,
  respiratory_rate NUMERIC,
  spo2_avg NUMERIC,

  sleep_score INTEGER,
  readiness_score INTEGER,

  raw_provider_data JSONB NOT NULL,           -- full provider payload, never null
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, provider, provider_session_id)
);

CREATE INDEX IF NOT EXISTS idx_ss_user_date ON sleep_sessions(user_id, sleep_date DESC);
CREATE INDEX IF NOT EXISTS idx_ss_connection ON sleep_sessions(connection_id);
CREATE INDEX IF NOT EXISTS idx_ss_provider_session ON sleep_sessions(provider, provider_session_id);
