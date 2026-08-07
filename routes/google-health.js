'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { encrypt, decrypt } = require('../lib/encryption');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://rhythmpal.com';
const REDIRECT_URI = `${BASE_URL}/api/health/google/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/fitness.sleep.read',
  'https://www.googleapis.com/auth/fitness.heart_rate.read',
  'https://www.googleapis.com/auth/fitness.body.read',
].join(' ');

// GET /api/health/google/connect — redirect user to Google OAuth
router.get('/connect', requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ userId: req.user.id })).toString('base64');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// GET /api/health/google/callback — handle OAuth callback
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?google_health=error');
  }

  try {
    const { userId } = JSON.parse(Buffer.from(state, 'base64').toString());

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token returned');

    // Encrypt tokens before storage
    const accessEncrypted = encrypt(tokens.access_token);
    const refreshEncrypted = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

    // Write to wearable_connections — both access + refresh atomically
    await query(
      `INSERT INTO wearable_connections
         (user_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, status, updated_at)
       VALUES ($1, 'google_fit', $2, $3, $4, $5, 'active', NOW())
       ON CONFLICT (user_id, provider) DO UPDATE SET
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, wearable_connections.refresh_token_encrypted),
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = EXCLUDED.scopes,
         status = 'active',
         updated_at = NOW()`,
      [userId, accessEncrypted, refreshEncrypted, expiresAt, SCOPES]
    );

    // Also keep user_profiles in sync during migration window (dual-write)
    await query(
      `INSERT INTO user_profiles (user_id, google_access_token, google_refresh_token, google_token_expiry)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         google_access_token = $2,
         google_refresh_token = COALESCE($3, user_profiles.google_refresh_token),
         google_token_expiry = $4`,
      [
        userId,
        tokens.access_token,
        tokens.refresh_token || null,
        expiresAt,
      ]
    );

    // Immediately fetch and store initial data
    await syncGoogleFitData(userId, tokens.access_token);

    res.redirect('/?google_health=connected');
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);
    res.redirect('/?google_health=error');
  }
});

// GET /api/health/google/status — check connection status
// Reads from wearable_connections first, falls back to user_profiles
router.get('/status', requireAuth, async (req, res) => {
  try {
    // Try wearable_connections first
    const wcResult = await query(
      `SELECT status, token_expires_at FROM wearable_connections
       WHERE user_id = $1 AND provider = 'google_fit'`,
      [req.user.id]
    );

    if (wcResult.rows.length > 0) {
      const row = wcResult.rows[0];
      const connected = row.status === 'active';
      return res.json({ connected });
    }

    // Fall back to user_profiles during migration window
    const profileResult = await query(
      'SELECT google_access_token FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const connected = !!(profileResult.rows[0]?.google_access_token);
    res.json({ connected });
  } catch (err) {
    console.error('Google status error:', err.message);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// POST /api/health/google/sync — manual sync
router.post('/sync', requireAuth, async (req, res) => {
  try {
    let accessToken = null;
    let needsReencryption = false;

    // Try wearable_connections first
    const wcResult = await query(
      `SELECT access_token_encrypted, refresh_token_encrypted, token_expires_at
       FROM wearable_connections
       WHERE user_id = $1 AND provider = 'google_fit' AND status = 'active'`,
      [req.user.id]
    );

    if (wcResult.rows.length > 0) {
      const row = wcResult.rows[0];
      const raw = row.access_token_encrypted;

      if (raw && raw.startsWith('legacy:')) {
        // Legacy token — strip prefix, flag for re-encryption on next refresh
        accessToken = raw.slice('legacy:'.length);
        needsReencryption = true;
      } else if (raw) {
        accessToken = decrypt(raw);
      }

      // Refresh if expired
      if (row.token_expires_at && new Date(row.token_expires_at) < new Date()) {
        const rawRefresh = row.refresh_token_encrypted;
        let refreshToken;
        if (rawRefresh && rawRefresh.startsWith('legacy:')) {
          refreshToken = rawRefresh.slice('legacy:'.length);
          needsReencryption = true;
        } else if (rawRefresh) {
          refreshToken = decrypt(rawRefresh);
        }
        if (refreshToken) {
          accessToken = await refreshAccessToken(req.user.id, refreshToken);
          needsReencryption = false; // freshly encrypted in refreshAccessToken
        }
      }
    } else {
      // Fall back to user_profiles during migration window
      const profileResult = await query(
        'SELECT google_access_token, google_refresh_token, google_token_expiry FROM user_profiles WHERE user_id = $1',
        [req.user.id]
      );
      const profile = profileResult.rows[0];
      if (!profile?.google_access_token) {
        return res.status(400).json({ error: 'Google Fit not connected' });
      }
      accessToken = profile.google_access_token;

      if (profile.google_token_expiry && new Date(profile.google_token_expiry) < new Date()) {
        accessToken = await refreshAccessToken(req.user.id, profile.google_refresh_token);
      }
    }

    if (!accessToken) {
      return res.status(400).json({ error: 'Google Fit not connected' });
    }

    const synced = await syncGoogleFitData(req.user.id, accessToken);
    res.json({ ok: true, synced });
  } catch (err) {
    console.error('Google Fit sync error:', err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// DELETE /api/health/google/disconnect
router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    // Disconnect in wearable_connections — null out tokens, mark disconnected
    await query(
      `UPDATE wearable_connections
       SET status = 'disconnected',
           access_token_encrypted = NULL,
           refresh_token_encrypted = NULL,
           updated_at = NOW()
       WHERE user_id = $1 AND provider = 'google_fit'`,
      [req.user.id]
    );

    // Keep user_profiles updated during migration window
    await query(
      `UPDATE user_profiles SET google_access_token = NULL, google_refresh_token = NULL, google_token_expiry = NULL
       WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Google disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ---- Helpers ----

/**
 * Refresh an access token and atomically write both access + refresh tokens.
 * @param {number} userId
 * @param {string} refreshToken — plaintext refresh token
 * @returns {string} new plaintext access token
 */
async function refreshAccessToken(userId, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed');

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);

  // Encrypt new tokens — always re-encrypt fresh tokens (including former legacy: tokens)
  const newAccessEncrypted = encrypt(data.access_token);
  // Refresh token is not always returned on refresh — keep existing if not
  const newRefreshEncrypted = data.refresh_token ? encrypt(data.refresh_token) : null;

  // Atomic update: write both access + refresh in one statement
  await query(
    `UPDATE wearable_connections SET
       access_token_encrypted = $1,
       refresh_token_encrypted = CASE WHEN $2::TEXT IS NOT NULL THEN $2 ELSE refresh_token_encrypted END,
       token_expires_at = $3,
       updated_at = NOW()
     WHERE user_id = $4 AND provider = 'google_fit'`,
    [newAccessEncrypted, newRefreshEncrypted, newExpiresAt, userId]
  );

  // Keep user_profiles in sync during migration window
  await query(
    `UPDATE user_profiles SET google_access_token = $1, google_token_expiry = $2 WHERE user_id = $3`,
    [data.access_token, newExpiresAt, userId]
  );

  return data.access_token;
}

async function syncGoogleFitData(userId, accessToken) {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const body = {
    aggregateBy: [
      { dataTypeName: 'com.google.step_count.delta' },
      { dataTypeName: 'com.google.sleep.segment' },
      { dataTypeName: 'com.google.heart_rate.bpm' },
      { dataTypeName: 'com.google.active_minutes' },
      { dataTypeName: 'com.google.calories.expended' },
    ],
    bucketByTime: { durationMillis: 86400000 },
    startTimeMillis: oneDayAgo,
    endTimeMillis: now,
  };

  const fitRes = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const fitData = await fitRes.json();
  if (!fitData.bucket) return 0;

  let inserted = 0;
  for (const bucket of fitData.bucket) {
    const startDate = new Date(parseInt(bucket.startTimeMillis));
    const endDate = new Date(parseInt(bucket.endTimeMillis));

    for (const dataset of bucket.dataset) {
      const dataType = dataset.dataSourceId?.includes('step') ? 'stepCount' :
                       dataset.dataSourceId?.includes('sleep') ? 'sleep_analysis' :
                       dataset.dataSourceId?.includes('heart_rate') ? 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN' :
                       dataset.dataSourceId?.includes('active_minutes') ? 'active_minutes' :
                       dataset.dataSourceId?.includes('calories') ? 'active_calories' : null;

      if (!dataType) continue;

      for (const point of dataset.point || []) {
        const value = point.value?.[0]?.intVal ?? point.value?.[0]?.fpVal;
        if (value === undefined || value === null) continue;

        // Dual-write: apple_health_logs (existing source of truth) + health_measurements (new)
        await query(
          `INSERT INTO apple_health_logs (user_id, data_type, value, unit, source, start_date, end_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [userId, dataType, value, 'google_fit', 'google_fit', startDate, endDate]
        );

        await query(
          `INSERT INTO health_measurements (user_id, provider, metric_type, value, unit, start_at, end_at)
           VALUES ($1, 'google_fit', $2, $3, 'google_fit', $4, $5)
           ON CONFLICT DO NOTHING`,
          [userId, dataType, value, startDate, endDate]
        ).catch(err => {
          // health_measurements is new — don't fail the whole sync if it's not ready yet
          console.error('health_measurements dual-write error (non-fatal):', err.message);
        });

        inserted++;
      }
    }
  }
  return inserted;
}

module.exports = router;
