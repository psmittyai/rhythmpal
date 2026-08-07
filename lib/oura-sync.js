'use strict';

/**
 * Oura Sync Engine — Sprint 2
 *
 * Handles OAuth token refresh, historical (90-day) and incremental syncs,
 * sleep session upserts, and health measurement inserts.
 *
 * SECURITY RULES:
 * - Never log access tokens, refresh tokens, or authorization codes
 * - Token refresh is atomic — both tokens written in one UPDATE, never partial
 * - Oura rotates refresh tokens — always store the new refresh token returned
 */

const { query } = require('./db');
const { encrypt, decrypt } = require('./encryption');

const OURA_API_BASE = 'https://api.ouraring.com';
const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const MOCK_MODE = () => process.env.OURA_MOCK === 'true';

// -----------------------------------------------------------------------
// Custom errors
// -----------------------------------------------------------------------
class TokenExpiredError extends Error {
  constructor(message) {
    super(message || 'Oura access token expired or invalid — refresh required');
    this.name = 'TokenExpiredError';
  }
}

class OuraApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'OuraApiError';
    this.statusCode = statusCode;
  }
}

// -----------------------------------------------------------------------
// Helper: sleep ms
// -----------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------
// Helper: date arithmetic
// -----------------------------------------------------------------------
function dateString(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgoDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// -----------------------------------------------------------------------
// ouraApiGet — single endpoint GET with pagination + rate-limit retry
// -----------------------------------------------------------------------
async function ouraApiGet(endpoint, accessToken, params = {}) {
  if (MOCK_MODE()) {
    const { getMockResponse } = require('./oura-mock');
    return getMockResponse(endpoint, params);
  }

  const fetch = (await import('node-fetch')).default;
  const allData = [];
  let nextToken = null;

  do {
    const url = new URL(OURA_API_BASE + endpoint);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    if (nextToken) url.searchParams.set('next_token', nextToken);

    let res;
    try {
      res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch (networkErr) {
      throw new OuraApiError(`Network error calling Oura API: ${networkErr.message}`, 0);
    }

    // 401 — token expired
    if (res.status === 401) {
      throw new TokenExpiredError();
    }

    // 429 — rate limited — wait and retry once
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
      console.log(`[oura-sync] Rate limited — waiting ${retryAfter}s before retry`);
      await sleep(retryAfter * 1000);

      res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (res.status === 429) {
        throw new OuraApiError('Oura API rate limit exceeded after retry', 429);
      }
    }

    if (!res.ok) {
      throw new OuraApiError(`Oura API error ${res.status} for ${endpoint}`, res.status);
    }

    const json = await res.json();
    const items = json.data || json;

    if (Array.isArray(items)) {
      allData.push(...items);
    } else {
      // Single object response — wrap it
      allData.push(items);
    }

    nextToken = json.next_token || null;
  } while (nextToken);

  return { data: allData, next_token: null };
}

// -----------------------------------------------------------------------
// refreshOuraToken — atomic token rotation
// CRITICAL: Oura rotates refresh tokens — always write the new refresh token
// -----------------------------------------------------------------------
async function refreshOuraToken(userId, connection) {
  const fetch = (await import('node-fetch')).default;

  const currentRefreshToken = decrypt(connection.refresh_token_encrypted);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: currentRefreshToken,
    client_id: process.env.OURA_CLIENT_ID,
    client_secret: process.env.OURA_CLIENT_SECRET,
  });

  const res = await fetch(OURA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new OuraApiError(`Token refresh failed (${res.status}): ${text}`, res.status);
  }

  const tokens = await res.json();

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new OuraApiError('Token refresh response missing access_token or refresh_token', 0);
  }

  // Encrypt both tokens
  const newAccessEnc = encrypt(tokens.access_token);
  // Oura rotates refresh tokens — store the NEW one, never reuse the old
  const newRefreshEnc = encrypt(tokens.refresh_token);
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 86400) * 1000);

  // Atomic write — both tokens updated in one statement
  await query(
    `UPDATE wearable_connections
     SET access_token_encrypted = $1,
         refresh_token_encrypted = $2,
         token_expires_at = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [newAccessEnc, newRefreshEnc, expiresAt, connection.id]
  );

  // Return the new plaintext access token for immediate use
  return tokens.access_token;
}

// -----------------------------------------------------------------------
// fetchAndStoreSleepSessions
// -----------------------------------------------------------------------
async function fetchAndStoreSleepSessions(userId, connectionId, accessToken, startDate, endDate) {
  const dateParams = { start_date: startDate, end_date: endDate };

  // Fetch all three endpoints in parallel
  const [sleepResp, dailySleepResp, readinessResp] = await Promise.all([
    ouraApiGet('/v2/usercollection/sleep', accessToken, dateParams),
    ouraApiGet('/v2/usercollection/daily_sleep', accessToken, dateParams),
    ouraApiGet('/v2/usercollection/daily_readiness', accessToken, dateParams),
  ]);

  const sessions = sleepResp.data || [];
  const dailySleep = dailySleepResp.data || [];
  const readiness = readinessResp.data || [];

  // Build lookup maps by date for O(1) enrichment
  const sleepScoreByDay = {};
  for (const ds of dailySleep) {
    sleepScoreByDay[ds.day] = ds.score;
  }

  const readinessScoreByDay = {};
  for (const r of readiness) {
    readinessScoreByDay[r.day] = r.score;
  }

  let upsertCount = 0;

  for (const session of sessions) {
    try {
      const sleepScore = sleepScoreByDay[session.day] ?? null;
      const readinessScore = readinessScoreByDay[session.day] ?? null;

      const result = await query(
        `INSERT INTO sleep_sessions (
          user_id, connection_id, provider, provider_session_id, sleep_date,
          bedtime_start, bedtime_end,
          total_sleep_minutes, time_in_bed_minutes, awake_minutes,
          rem_sleep_minutes, deep_sleep_minutes, light_sleep_minutes,
          sleep_efficiency, sleep_latency_minutes,
          average_hr, lowest_hr, average_hrv, respiratory_rate,
          sleep_score, readiness_score,
          raw_provider_data, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,
          $8,$9,$10,
          $11,$12,$13,
          $14,$15,
          $16,$17,$18,$19,
          $20,$21,
          $22,NOW()
        )
        ON CONFLICT (user_id, provider, provider_session_id)
        DO UPDATE SET
          bedtime_start = EXCLUDED.bedtime_start,
          bedtime_end = EXCLUDED.bedtime_end,
          total_sleep_minutes = EXCLUDED.total_sleep_minutes,
          time_in_bed_minutes = EXCLUDED.time_in_bed_minutes,
          awake_minutes = EXCLUDED.awake_minutes,
          rem_sleep_minutes = EXCLUDED.rem_sleep_minutes,
          deep_sleep_minutes = EXCLUDED.deep_sleep_minutes,
          light_sleep_minutes = EXCLUDED.light_sleep_minutes,
          sleep_efficiency = EXCLUDED.sleep_efficiency,
          sleep_latency_minutes = EXCLUDED.sleep_latency_minutes,
          average_hr = EXCLUDED.average_hr,
          lowest_hr = EXCLUDED.lowest_hr,
          average_hrv = EXCLUDED.average_hrv,
          respiratory_rate = EXCLUDED.respiratory_rate,
          sleep_score = EXCLUDED.sleep_score,
          readiness_score = EXCLUDED.readiness_score,
          raw_provider_data = EXCLUDED.raw_provider_data,
          updated_at = NOW()
        WHERE EXCLUDED.updated_at > sleep_sessions.updated_at
        RETURNING id`,
        [
          userId,
          connectionId,
          'oura',
          session.id,
          session.day,
          session.bedtime_start || null,
          session.bedtime_end || null,
          session.total_sleep_duration != null ? Math.round(session.total_sleep_duration / 60) : null,
          session.time_in_bed != null ? Math.round(session.time_in_bed / 60) : null,
          session.awake_time != null ? Math.round(session.awake_time / 60) : null,
          session.rem_sleep_duration != null ? Math.round(session.rem_sleep_duration / 60) : null,
          session.deep_sleep_duration != null ? Math.round(session.deep_sleep_duration / 60) : null,
          session.light_sleep_duration != null ? Math.round(session.light_sleep_duration / 60) : null,
          session.efficiency != null ? session.efficiency : null,
          session.latency != null ? session.latency : null,
          session.average_heart_rate != null ? session.average_heart_rate : null,
          session.lowest_heart_rate != null ? session.lowest_heart_rate : null,
          session.average_hrv != null ? session.average_hrv : null,
          session.breathing_regularity != null
            ? session.breathing_regularity
            : (session.respiratory_rate != null ? session.respiratory_rate : null),
          sleepScore,
          readinessScore,
          JSON.stringify(session),
        ]
      );

      if (result.rowCount > 0) upsertCount++;
    } catch (err) {
      console.error(`[oura-sync] Failed to upsert sleep session ${session.id}:`, err.message);
      // Continue processing other sessions — one failure doesn't abort the batch
    }
  }

  return upsertCount;
}

// -----------------------------------------------------------------------
// fetchAndStoreHealthMeasurements
// -----------------------------------------------------------------------
async function fetchAndStoreHealthMeasurements(userId, connectionId, accessToken, startDate, endDate) {
  const dateParams = { start_date: startDate, end_date: endDate };
  let insertCount = 0;

  // Fetch HR and SpO2 in parallel
  const [hrResp, spo2Resp] = await Promise.all([
    ouraApiGet('/v2/usercollection/heartrate', accessToken, dateParams),
    ouraApiGet('/v2/usercollection/daily_spo2', accessToken, dateParams),
  ]);

  // Store heart rate time-series
  const hrPoints = hrResp.data || [];
  for (const point of hrPoints) {
    try {
      // External ID: use timestamp string for deduplication
      const externalId = `oura-hr-${point.timestamp}`;
      const result = await query(
        `INSERT INTO health_measurements (
          user_id, connection_id, provider, source_device,
          metric_type, value, unit, start_at, end_at,
          external_id, raw_metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (user_id, provider, metric_type, start_at, COALESCE(external_id, ''))
        DO NOTHING`,
        [
          userId,
          connectionId,
          'oura',
          'Oura Ring',
          'heart_rate',
          point.bpm,
          'bpm',
          point.timestamp,
          null,
          externalId,
          JSON.stringify({ source: point.source }),
        ]
      );
      if (result.rowCount > 0) insertCount++;
    } catch (err) {
      console.error(`[oura-sync] Failed to insert HR measurement:`, err.message);
    }
  }

  // Store SpO2 daily averages
  const spo2Points = spo2Resp.data || [];
  for (const point of spo2Points) {
    try {
      const spo2Value = point.spo2_percentage?.average ?? null;
      if (spo2Value == null) continue;

      const externalId = `oura-spo2-${point.day}`;
      const startAt = new Date(point.day + 'T00:00:00Z').toISOString();

      const result = await query(
        `INSERT INTO health_measurements (
          user_id, connection_id, provider, source_device,
          metric_type, value, unit, start_at, end_at,
          external_id, raw_metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (user_id, provider, metric_type, start_at, COALESCE(external_id, ''))
        DO NOTHING`,
        [
          userId,
          connectionId,
          'oura',
          'Oura Ring',
          'spo2_avg',
          spo2Value,
          '%',
          startAt,
          null,
          externalId,
          JSON.stringify({ day: point.day }),
        ]
      );
      if (result.rowCount > 0) insertCount++;
    } catch (err) {
      console.error(`[oura-sync] Failed to insert SpO2 measurement:`, err.message);
    }
  }

  return insertCount;
}

// -----------------------------------------------------------------------
// syncOuraData — main orchestrator
// -----------------------------------------------------------------------
async function syncOuraData(userId, options = {}) {
  const historical = options.historical === true;

  // Load connection
  const connResult = await query(
    `SELECT id, access_token_encrypted, refresh_token_encrypted,
            token_expires_at, sync_cursor, status
     FROM wearable_connections
     WHERE user_id = $1 AND provider = 'oura' AND status = 'active'`,
    [userId]
  );

  if (connResult.rows.length === 0) {
    throw new Error(`No active Oura connection for user ${userId}`);
  }

  const connection = connResult.rows[0];

  // Decrypt access token
  let accessToken = decrypt(connection.access_token_encrypted);

  // Check token expiry — refresh if expired or expiring within 5 minutes
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at) : null;
  const nowPlus5 = new Date(Date.now() + 5 * 60 * 1000);
  if (expiresAt && expiresAt < nowPlus5) {
    console.log(`[oura-sync] Access token expiring/expired for user ${userId} — refreshing`);
    try {
      accessToken = await refreshOuraToken(userId, connection);
    } catch (refreshErr) {
      // Mark connection as error state
      await query(
        `UPDATE wearable_connections SET status = 'error', updated_at = NOW()
         WHERE id = $1`,
        [connection.id]
      );
      throw refreshErr;
    }
  }

  // Determine date range
  let startDate, endDate;
  endDate = dateString(new Date());

  if (historical) {
    // Last 90 days
    startDate = dateString(daysAgoDate(90));
  } else {
    // Incremental — use sync_cursor or default to last 7 days
    if (connection.sync_cursor) {
      startDate = connection.sync_cursor;
    } else {
      startDate = dateString(daysAgoDate(7));
    }
  }

  console.log(`[oura-sync] Syncing user ${userId} from ${startDate} to ${endDate} (historical=${historical})`);

  let sessionsImported = 0;
  let measurementsImported = 0;

  try {
    sessionsImported = await fetchAndStoreSleepSessions(
      userId, connection.id, accessToken, startDate, endDate
    );
    measurementsImported = await fetchAndStoreHealthMeasurements(
      userId, connection.id, accessToken, startDate, endDate
    );
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // Token expired during sync — try refresh once
      console.log(`[oura-sync] Token expired mid-sync for user ${userId} — refreshing`);
      accessToken = await refreshOuraToken(userId, connection);
      sessionsImported = await fetchAndStoreSleepSessions(
        userId, connection.id, accessToken, startDate, endDate
      );
      measurementsImported = await fetchAndStoreHealthMeasurements(
        userId, connection.id, accessToken, startDate, endDate
      );
    } else {
      throw err;
    }
  }

  // Update last_sync_at and sync_cursor to today
  await query(
    `UPDATE wearable_connections
     SET last_sync_at = NOW(),
         sync_cursor = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [endDate, connection.id]
  );

  return { sessions_imported: sessionsImported, measurements_imported: measurementsImported };
}

module.exports = {
  syncOuraData,
  refreshOuraToken,
  fetchAndStoreSleepSessions,
  fetchAndStoreHealthMeasurements,
  ouraApiGet,
  TokenExpiredError,
  OuraApiError,
};
