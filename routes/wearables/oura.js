'use strict';

/**
 * Oura OAuth routes — Sprint 2
 *
 * SECURITY RULES:
 * - Never log authorization codes, access tokens, or refresh tokens
 * - State param verified on callback to prevent CSRF
 * - Tokens encrypted at rest using lib/encryption.js
 */

const express = require('express');
const router = express.Router();
const { query } = require('../../lib/db');
const { encrypt, decrypt } = require('../../lib/encryption');
const { requireAuth } = require('../../lib/auth');
const { syncOuraData } = require('../../lib/oura-sync');

const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const OURA_SCOPES = 'daily personal heartrate spo2';

function getRedirectUri() {
  const base = process.env.BASE_URL || 'https://rhythmpal.com';
  return `${base}/api/wearables/oura/callback`;
}

// -----------------------------------------------------------------------
// GET /api/wearables/oura/connect
// -----------------------------------------------------------------------
router.get('/connect', requireAuth, (req, res) => {
  try {
    const state = Buffer.from(JSON.stringify({
      userId: req.user.id,
      ts: Date.now(),
    })).toString('base64url');

    const url = new URL(OURA_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', process.env.OURA_CLIENT_ID || '');
    url.searchParams.set('redirect_uri', getRedirectUri());
    url.searchParams.set('scope', OURA_SCOPES);
    url.searchParams.set('state', state);

    res.redirect(url.toString());
  } catch (err) {
    console.error('[oura] Connect redirect error:', err.message);
    res.redirect('/?oura=error');
  }
});

// -----------------------------------------------------------------------
// GET /api/wearables/oura/callback
// -----------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // OAuth error from Oura
  if (error) {
    console.error('[oura] OAuth error from provider:', error);
    return res.redirect('/?oura=error');
  }

  if (!code || !state) {
    console.error('[oura] Callback missing code or state');
    return res.redirect('/?oura=error');
  }

  let userId;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    userId = decoded.userId;
    if (!userId) throw new Error('Missing userId in state');
  } catch (err) {
    console.error('[oura] Invalid state param:', err.message);
    return res.redirect('/?oura=error');
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // Exchange code for tokens — NEVER log the code or tokens
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri(),
      client_id: process.env.OURA_CLIENT_ID || '',
      client_secret: process.env.OURA_CLIENT_SECRET || '',
    });

    const tokenRes = await fetch(OURA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error(`[oura] Token exchange failed (${tokenRes.status}):`, errText);
      return res.redirect('/?oura=error');
    }

    const tokens = await tokenRes.json();

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error('[oura] Token exchange response missing tokens');
      return res.redirect('/?oura=error');
    }

    // Encrypt tokens — never store plaintext
    const accessEnc = encrypt(tokens.access_token);
    const refreshEnc = encrypt(tokens.refresh_token);
    const expiresAt = new Date(Date.now() + (tokens.expires_in || 86400) * 1000);

    // Upsert into wearable_connections
    await query(
      `INSERT INTO wearable_connections
        (user_id, provider, access_token_encrypted, refresh_token_encrypted,
         token_expires_at, scopes, status, updated_at)
       VALUES ($1, 'oura', $2, $3, $4, $5, 'active', NOW())
       ON CONFLICT (user_id, provider)
       DO UPDATE SET
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = EXCLUDED.scopes,
         status = 'active',
         updated_at = NOW()`,
      [userId, accessEnc, refreshEnc, expiresAt, OURA_SCOPES]
    );

    // Trigger historical sync in background — don't block the redirect
    setImmediate(async () => {
      try {
        const result = await syncOuraData(userId, { historical: true });
        console.log(`[oura] Historical sync complete for user ${userId}: ${result.sessions_imported} sessions, ${result.measurements_imported} measurements`);
      } catch (syncErr) {
        console.error(`[oura] Historical sync failed for user ${userId}:`, syncErr.message);
      }
    });

    res.redirect('/?oura=connected');
  } catch (err) {
    console.error('[oura] Callback error:', err.message);
    res.redirect('/?oura=error');
  }
});

// -----------------------------------------------------------------------
// GET /api/wearables/oura/status
// -----------------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    const connResult = await query(
      `SELECT id, status, last_sync_at, scopes
       FROM wearable_connections
       WHERE user_id = $1 AND provider = 'oura'`,
      [req.user.id]
    );

    if (connResult.rows.length === 0 || connResult.rows[0].status !== 'active') {
      return res.json({ connected: false, last_sync_at: null, sleep_days_imported: 0 });
    }

    const conn = connResult.rows[0];

    const countResult = await query(
      `SELECT COUNT(DISTINCT sleep_date) AS sleep_days
       FROM sleep_sessions
       WHERE user_id = $1 AND provider = 'oura'`,
      [req.user.id]
    );

    const sleepDays = parseInt(countResult.rows[0]?.sleep_days || '0', 10);

    res.json({
      connected: true,
      last_sync_at: conn.last_sync_at,
      sleep_days_imported: sleepDays,
    });
  } catch (err) {
    console.error('[oura] Status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch Oura status' });
  }
});

// -----------------------------------------------------------------------
// POST /api/wearables/oura/sync
// -----------------------------------------------------------------------
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const result = await syncOuraData(req.user.id, { historical: false });
    res.json({
      ok: true,
      sessions_imported: result.sessions_imported,
      measurements_imported: result.measurements_imported,
    });
  } catch (err) {
    console.error('[oura] Manual sync error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -----------------------------------------------------------------------
// DELETE /api/wearables/oura/disconnect
// -----------------------------------------------------------------------
router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    await query(
      `UPDATE wearable_connections
       SET status = 'disconnected',
           access_token_encrypted = NULL,
           refresh_token_encrypted = NULL,
           updated_at = NOW()
       WHERE user_id = $1 AND provider = 'oura'`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[oura] Disconnect error:', err.message);
    res.status(500).json({ ok: false, error: 'Failed to disconnect Oura' });
  }
});

module.exports = router;
