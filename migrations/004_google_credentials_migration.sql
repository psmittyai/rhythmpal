-- Migration 004: google_credentials_migration
-- Copy Google credentials from user_profiles into wearable_connections
-- COPY not MOVE — legacy columns stay for rollback until verified

INSERT INTO wearable_connections (user_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, status, created_at, updated_at)
SELECT
  up.user_id,
  'google_fit',
  -- NOTE: existing tokens in user_profiles are NOT encrypted (legacy) — flag them distinctly
  'legacy:' || up.google_access_token,
  CASE WHEN up.google_refresh_token IS NOT NULL THEN 'legacy:' || up.google_refresh_token ELSE NULL END,
  up.google_token_expiry,
  'active',
  NOW(),
  NOW()
FROM user_profiles up
WHERE up.google_access_token IS NOT NULL
ON CONFLICT (user_id, provider) DO NOTHING;

-- Note: legacy: prefix signals these need re-encryption on next token refresh.
-- DO NOT drop google_access_token / google_refresh_token columns in this migration.
-- Rollback is: reads switch back to user_profiles columns. Legacy columns dropped in a later migration after verification.
