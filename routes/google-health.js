const express = require('express');
const router = express.Router();
const { query } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

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

    // Store tokens in user_profiles
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
        tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      ]
    );

    // Immediately fetch and store initial data
    await syncGoogleFitData(userId, tokens.access_token);

    res.redirect('/?google_health=connected');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('/?google_health=error');
  }
});

// GET /api/health/google/status — check connection status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT google_access_token, google_token_expiry FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const connected = !!(result.rows[0]?.google_access_token);
    res.json({ connected });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// POST /api/health/google/sync — manual sync
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT google_access_token, google_refresh_token, google_token_expiry FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const profile = result.rows[0];
    if (!profile?.google_access_token) {
      return res.status(400).json({ error: 'Google Fit not connected' });
    }

    let token = profile.google_access_token;

    // Refresh token if expired
    if (profile.google_token_expiry && new Date(profile.google_token_expiry) < new Date()) {
      token = await refreshAccessToken(req.user.id, profile.google_refresh_token);
    }

    const synced = await syncGoogleFitData(req.user.id, token);
    res.json({ ok: true, synced });
  } catch (err) {
    console.error('Google Fit sync error:', err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// DELETE /api/health/google/disconnect
router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    await query(
      `UPDATE user_profiles SET google_access_token = NULL, google_refresh_token = NULL, google_token_expiry = NULL
       WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ---- Helpers ----

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

  await query(
    `UPDATE user_profiles SET google_access_token = $1, google_token_expiry = $2 WHERE user_id = $3`,
    [data.access_token, new Date(Date.now() + data.expires_in * 1000), userId]
  );
  return data.access_token;
}

async function syncGoogleFitData(userId, accessToken) {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const dataTypes = [
    { type: 'com.google.step_count.delta', name: 'steps' },
    { type: 'com.google.sleep.segment', name: 'sleep_analysis' },
    { type: 'com.google.heart_rate.bpm', name: 'heart_rate' },
    { type: 'com.google.heart_rate.bpm', name: 'hrv', aggregate: 'STDDEV' },
    { type: 'com.google.active_minutes', name: 'active_minutes' },
    { type: 'com.google.calories.expended', name: 'active_calories' },
  ];

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

        await query(
          `INSERT INTO apple_health_logs (user_id, data_type, value, unit, source, start_date, end_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [userId, dataType, value, 'google_fit', 'google_fit', startDate, endDate]
        );
        inserted++;
      }
    }
  }
  return inserted;
}

module.exports = router;
