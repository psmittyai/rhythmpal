-- Migration 001: wearable_connections
-- Canonical provider/credential table

CREATE TABLE IF NOT EXISTS wearable_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL,           -- 'oura', 'apple_health', 'google_fit', etc.
  provider_user_id VARCHAR(255),
  access_token_encrypted TEXT,             -- v1:<iv>:<tag>:<ciphertext>
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes TEXT,
  status VARCHAR(20) DEFAULT 'active',     -- active, disconnected, error
  last_sync_at TIMESTAMPTZ,
  sync_cursor TEXT,                        -- provider-specific cursor/checkpoint
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_wc_user_provider ON wearable_connections(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_wc_status ON wearable_connections(status);
