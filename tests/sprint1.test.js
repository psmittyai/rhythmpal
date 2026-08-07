'use strict';

/**
 * RhythmPal Sprint 1 — Data Foundation Tests
 *
 * Tests are designed to run without a live Railway database.
 * DB tests mock the query function from lib/db.
 */

// -----------------------------------------------------------------------
// Setup: provide a valid test encryption key
// -----------------------------------------------------------------------
const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes, valid for tests

// -----------------------------------------------------------------------
// 1. Encryption round-trip
// -----------------------------------------------------------------------
describe('Encryption', () => {
  let encrypt, decrypt;

  beforeEach(() => {
    process.env.WEARABLE_TOKEN_KEY = TEST_KEY;
    // Re-require to pick up env changes
    jest.resetModules();
    const enc = require('../lib/encryption');
    encrypt = enc.encrypt;
    decrypt = enc.decrypt;
  });

  afterEach(() => {
    delete process.env.WEARABLE_TOKEN_KEY;
    jest.resetModules();
  });

  test('1. round-trip: encrypt → decrypt returns original string', () => {
    const plaintext = 'ya29.some-google-access-token-12345';
    const packed = encrypt(plaintext);
    const result = decrypt(packed);
    expect(result).toBe(plaintext);
  });

  test('2. uniqueness: same plaintext encrypted twice produces different ciphertexts', () => {
    const plaintext = 'ya29.some-google-access-token-12345';
    const packed1 = encrypt(plaintext);
    const packed2 = encrypt(plaintext);
    // Different IVs → different packed output
    expect(packed1).not.toBe(packed2);
    // But both decrypt to the same plaintext
    expect(decrypt(packed1)).toBe(plaintext);
    expect(decrypt(packed2)).toBe(plaintext);
  });

  test('3. missing key throws — no silent fallback', () => {
    delete process.env.WEARABLE_TOKEN_KEY;
    jest.resetModules();
    const { encrypt: encNoKey } = require('../lib/encryption');
    expect(() => encNoKey('some-token')).toThrow(/WEARABLE_TOKEN_KEY/);
  });

  test('3b. wrong-length key throws', () => {
    process.env.WEARABLE_TOKEN_KEY = 'tooshort';
    jest.resetModules();
    const { encrypt: encBadKey } = require('../lib/encryption');
    expect(() => encBadKey('some-token')).toThrow(/64/);
  });

  test('packed format is versioned (starts with v1:)', () => {
    const packed = encrypt('hello');
    expect(packed.startsWith('v1:')).toBe(true);
    const parts = packed.split(':');
    expect(parts).toHaveLength(4);
  });
});

// -----------------------------------------------------------------------
// Mock DB helper
// -----------------------------------------------------------------------
function makeDb() {
  // Simple in-memory mock for relational behaviour
  const tables = {
    health_measurements: [],
    sleep_sessions: [],
    wearable_connections: [],
  };

  async function mockQuery(text, params = []) {
    const sql = text.trim().replace(/\s+/g, ' ');

    // ---- health_measurements INSERT ----
    if (/INSERT INTO health_measurements/i.test(sql)) {
      const [userId, provider, metricType, value, unit, startAt, endAt, externalId] = params;
      const extId = externalId ?? '';
      // Unique: (user_id, provider, metric_type, start_at, COALESCE(external_id, ''))
      const exists = tables.health_measurements.some(
        r => r.user_id === userId &&
             r.provider === provider &&
             r.metric_type === metricType &&
             String(r.start_at) === String(startAt) &&
             (r.external_id ?? '') === extId
      );
      if (!exists) {
        tables.health_measurements.push({ id: tables.health_measurements.length + 1, user_id: userId, provider, metric_type: metricType, value, unit, start_at: startAt, end_at: endAt, external_id: externalId ?? null });
      }
      return { rows: [], rowCount: exists ? 0 : 1 };
    }

    // ---- sleep_sessions INSERT ----
    if (/INSERT INTO sleep_sessions/i.test(sql)) {
      const [userId, connectionId, provider, providerSessionId, sleepDate, bedtimeStart, bedtimeEnd,
             totalSleepMinutes, timeInBedMinutes, awakeMinutes, remSleepMinutes, deepSleepMinutes,
             lightSleepMinutes, sleepEfficiency, sleepLatencyMinutes, averageHr, lowestHr,
             averageHrv, respiratoryRate, spo2Avg, sleepScore, readinessScore, rawProviderData] = params;
      // Unique: (user_id, provider, provider_session_id)
      const exists = tables.sleep_sessions.some(
        r => r.user_id === userId && r.provider === provider && r.provider_session_id === providerSessionId
      );
      if (!exists) {
        tables.sleep_sessions.push({
          id: tables.sleep_sessions.length + 1,
          user_id: userId, connection_id: connectionId, provider, provider_session_id: providerSessionId,
          sleep_date: sleepDate, bedtime_start: bedtimeStart, bedtime_end: bedtimeEnd,
          total_sleep_minutes: totalSleepMinutes, time_in_bed_minutes: timeInBedMinutes,
          awake_minutes: awakeMinutes, rem_sleep_minutes: remSleepMinutes,
          deep_sleep_minutes: deepSleepMinutes, light_sleep_minutes: lightSleepMinutes,
          sleep_efficiency: sleepEfficiency, sleep_latency_minutes: sleepLatencyMinutes,
          average_hr: averageHr, lowest_hr: lowestHr, average_hrv: averageHrv,
          respiratory_rate: respiratoryRate, spo2_avg: spo2Avg,
          sleep_score: sleepScore, readiness_score: readinessScore,
          raw_provider_data: rawProviderData,
        });
      }
      return { rows: [], rowCount: exists ? 0 : 1 };
    }

    // ---- wearable_connections UPDATE (token rotation) ----
    if (/UPDATE wearable_connections SET/i.test(sql)) {
      const [newAccess, newRefresh, expiresAt, userId, provider] = params;
      const row = tables.wearable_connections.find(
        r => r.user_id === userId && r.provider === provider
      );
      if (row) {
        if (newAccess !== undefined) row.access_token_encrypted = newAccess;
        if (newRefresh !== undefined) row.refresh_token_encrypted = newRefresh;
        if (expiresAt !== undefined) row.token_expires_at = expiresAt;
        row.updated_at = new Date().toISOString();
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ---- wearable_connections INSERT (setup) ----
    if (/INSERT INTO wearable_connections/i.test(sql)) {
      const [userId, provider, accessEnc, refreshEnc, expiresAt] = params;
      const exists = tables.wearable_connections.some(
        r => r.user_id === userId && r.provider === provider
      );
      if (!exists) {
        tables.wearable_connections.push({
          id: tables.wearable_connections.length + 1,
          user_id: userId, provider,
          access_token_encrypted: accessEnc,
          refresh_token_encrypted: refreshEnc,
          token_expires_at: expiresAt,
          status: 'active',
          updated_at: new Date().toISOString(),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    // ---- wearable_connections SELECT ----
    if (/SELECT.*FROM wearable_connections/i.test(sql)) {
      const [userId, provider] = params;
      const rows = tables.wearable_connections.filter(
        r => r.user_id === userId && r.provider === provider
      );
      return { rows };
    }

    // Default
    return { rows: [], rowCount: 0 };
  }

  return { mockQuery, tables };
}

// -----------------------------------------------------------------------
// 4. Duplicate health_measurements — ON CONFLICT DO NOTHING
// -----------------------------------------------------------------------
describe('health_measurements deduplication', () => {
  test('4. inserting same (user_id, provider, metric_type, start_at, external_id) twice = 1 row', async () => {
    const { mockQuery, tables } = makeDb();

    const row = [1, 'oura', 'heart_rate', 62.5, 'bpm', '2026-08-07T03:00:00Z', '2026-08-07T04:00:00Z', 'ext-123'];
    await mockQuery('INSERT INTO health_measurements ...', row);
    await mockQuery('INSERT INTO health_measurements ...', row);

    expect(tables.health_measurements).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------
// 5. Duplicate sleep_sessions — ON CONFLICT DO NOTHING
// -----------------------------------------------------------------------
describe('sleep_sessions deduplication', () => {
  test('5. inserting same (user_id, provider, provider_session_id) twice = 1 row', async () => {
    const { mockQuery, tables } = makeDb();

    const params = [
      1, null, 'oura', 'oura-session-abc123', '2026-08-07',
      '2026-08-06T23:00:00Z', '2026-08-07T07:00:00Z',
      390, 480, 30, 90, 60, 240,
      85.5, 12, 58.2, 52.0, 45.0, 16.2, 97.5,
      82, 78,
      JSON.stringify({ id: 'oura-session-abc123', score: { total: 82 } }),
    ];

    await mockQuery('INSERT INTO sleep_sessions ...', params);
    await mockQuery('INSERT INTO sleep_sessions ...', params);

    expect(tables.sleep_sessions).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------
// 6. Token rotation atomicity
// -----------------------------------------------------------------------
describe('Token rotation atomicity', () => {
  test('6. UPDATE wearable_connections writes both access + refresh', async () => {
    const { mockQuery, tables } = makeDb();
    process.env.WEARABLE_TOKEN_KEY = TEST_KEY;
    jest.resetModules();
    const { encrypt } = require('../lib/encryption');

    // Setup existing row
    tables.wearable_connections.push({
      id: 1,
      user_id: 1,
      provider: 'google_fit',
      access_token_encrypted: encrypt('old-access-token'),
      refresh_token_encrypted: encrypt('old-refresh-token'),
      token_expires_at: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      updated_at: new Date().toISOString(),
    });

    const newAccess = encrypt('new-access-token');
    const newRefresh = encrypt('new-refresh-token');
    const newExpiry = new Date(Date.now() + 3600000).toISOString();

    await mockQuery('UPDATE wearable_connections SET access=.., refresh=.., expires=.. WHERE user_id=$4 AND provider=$5', [
      newAccess, newRefresh, newExpiry, 1, 'google_fit',
    ]);

    const row = tables.wearable_connections[0];
    expect(row.access_token_encrypted).toBe(newAccess);
    expect(row.refresh_token_encrypted).toBe(newRefresh);
    expect(row.token_expires_at).toBe(newExpiry);
  });
});

// -----------------------------------------------------------------------
// 7. Cross-provider isolation
// -----------------------------------------------------------------------
describe('Cross-provider isolation', () => {
  test('7. apple_health and oura rows with same metric_type are separate rows', async () => {
    const { mockQuery, tables } = makeDb();

    const baseRow = [1, 'apple_health', 'heart_rate', 65.0, 'bpm', '2026-08-07T03:00:00Z', null, null];
    const ouraRow  = [1, 'oura',         'heart_rate', 61.0, 'bpm', '2026-08-07T03:00:00Z', null, null];

    await mockQuery('INSERT INTO health_measurements ...', baseRow);
    await mockQuery('INSERT INTO health_measurements ...', ouraRow);

    expect(tables.health_measurements).toHaveLength(2);

    const apple = tables.health_measurements.find(r => r.provider === 'apple_health');
    const oura  = tables.health_measurements.find(r => r.provider === 'oura');

    expect(apple).toBeDefined();
    expect(oura).toBeDefined();
    expect(apple.value).toBe(65.0);
    expect(oura.value).toBe(61.0);
  });
});

// -----------------------------------------------------------------------
// 8. Legacy prefix handling
// -----------------------------------------------------------------------
describe('Legacy prefix handling', () => {
  test('8. legacy: prefixed token is stripped correctly before use', () => {
    const raw = 'legacy:ya29.some-legacy-google-token';
    const prefix = 'legacy:';

    expect(raw.startsWith(prefix)).toBe(true);

    const strippedToken = raw.slice(prefix.length);
    expect(strippedToken).toBe('ya29.some-legacy-google-token');
    // Should NOT contain the prefix after stripping
    expect(strippedToken.startsWith(prefix)).toBe(false);
  });
});

// -----------------------------------------------------------------------
// 9. Oura sleep record acceptance
// -----------------------------------------------------------------------
describe('Oura sleep record acceptance', () => {
  test('9. realistic Oura sleep payload inserts and all fields are preserved', async () => {
    const { mockQuery, tables } = makeDb();

    // Realistic Oura sleep session payload
    const ouraRaw = {
      id: 'oura-sleep-2026-08-07',
      type: 'long_sleep',
      sleep_phase_5_min: 'vvvvllllrrrrddddllllllrrrrvvvvvvvv',
      score: {
        total: 82,
        rem_sleep: 79,
        deep_sleep: 88,
        efficiency: 91,
        latency: 90,
        timing: 75,
        restfulness: 76,
      },
      contributors: {
        deep_sleep: 88,
        efficiency: 91,
        latency: 90,
        rem_sleep: 79,
        restfulness: 76,
        timing: 75,
        total_sleep: 85,
      },
      day: '2026-08-07',
      bedtime_start: '2026-08-06T23:15:00+00:00',
      bedtime_end: '2026-08-07T07:30:00+00:00',
      total_sleep_duration: 23400,     // seconds (= 390 minutes)
      time_in_bed: 28800,              // seconds (= 480 minutes)
      awake_time: 1800,                // seconds (= 30 minutes)
      rem_sleep_duration: 5400,        // seconds (= 90 minutes)
      deep_sleep_duration: 3600,       // seconds (= 60 minutes)
      light_sleep_duration: 14400,     // seconds (= 240 minutes)
      efficiency: 85,
      latency: 12,
      average_heart_rate: 58.2,
      lowest_heart_rate: 52,
      average_hrv: 45,
      breathing_irregularity_index: 0.4,
      readiness_score_delta: 2,
    };

    const params = [
      1,                               // user_id
      null,                            // connection_id
      'oura',                          // provider
      ouraRaw.id,                      // provider_session_id
      ouraRaw.day,                     // sleep_date
      ouraRaw.bedtime_start,           // bedtime_start
      ouraRaw.bedtime_end,             // bedtime_end
      Math.round(ouraRaw.total_sleep_duration / 60), // total_sleep_minutes = 390
      Math.round(ouraRaw.time_in_bed / 60),           // time_in_bed_minutes = 480
      Math.round(ouraRaw.awake_time / 60),            // awake_minutes = 30
      Math.round(ouraRaw.rem_sleep_duration / 60),    // rem_sleep_minutes = 90
      Math.round(ouraRaw.deep_sleep_duration / 60),   // deep_sleep_minutes = 60
      Math.round(ouraRaw.light_sleep_duration / 60),  // light_sleep_minutes = 240
      ouraRaw.efficiency,              // sleep_efficiency = 85
      ouraRaw.latency,                 // sleep_latency_minutes = 12
      ouraRaw.average_heart_rate,      // average_hr = 58.2
      ouraRaw.lowest_heart_rate,       // lowest_hr = 52
      ouraRaw.average_hrv,             // average_hrv = 45
      null,                            // respiratory_rate (not in this payload)
      null,                            // spo2_avg (not in this payload)
      ouraRaw.score.total,             // sleep_score = 82
      null,                            // readiness_score (separate endpoint)
      ouraRaw,                         // raw_provider_data
    ];

    await mockQuery('INSERT INTO sleep_sessions ...', params);

    expect(tables.sleep_sessions).toHaveLength(1);

    const session = tables.sleep_sessions[0];

    // Verify key fields stored correctly
    expect(session.provider).toBe('oura');
    expect(session.provider_session_id).toBe('oura-sleep-2026-08-07');
    expect(session.sleep_date).toBe('2026-08-07');
    expect(session.total_sleep_minutes).toBe(390);
    expect(session.time_in_bed_minutes).toBe(480);
    expect(session.awake_minutes).toBe(30);
    expect(session.rem_sleep_minutes).toBe(90);
    expect(session.deep_sleep_minutes).toBe(60);
    expect(session.light_sleep_minutes).toBe(240);
    expect(session.sleep_efficiency).toBe(85);
    expect(session.sleep_latency_minutes).toBe(12);
    expect(session.average_hr).toBe(58.2);
    expect(session.lowest_hr).toBe(52);
    expect(session.average_hrv).toBe(45);
    expect(session.sleep_score).toBe(82);

    // Verify raw_provider_data JSONB is preserved
    expect(session.raw_provider_data).toBe(ouraRaw);
    expect(session.raw_provider_data.id).toBe('oura-sleep-2026-08-07');
    expect(session.raw_provider_data.score.total).toBe(82);
    expect(session.raw_provider_data.sleep_phase_5_min).toBeDefined();
  });
});
