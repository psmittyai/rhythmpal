'use strict';

/**
 * Oura API Mock Data — development/testing when OURA_MOCK=true
 * Provides realistic V2 API responses without hitting live endpoints.
 *
 * Field names match Oura V2 API spec exactly.
 */

const TODAY = new Date();

function daysAgo(n) {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function isoHoursAgo(n) {
  const d = new Date(TODAY);
  d.setHours(d.getHours() - n);
  return d.toISOString();
}

// -----------------------------------------------------------------------
// Token exchange mock response
// -----------------------------------------------------------------------
const MOCK_TOKEN_RESPONSE = {
  access_token: 'mock_access_token_abc123xyz789',
  refresh_token: 'mock_refresh_token_def456uvw012',
  token_type: 'bearer',
  expires_in: 86400, // 24 hours
};

// -----------------------------------------------------------------------
// GET /v2/usercollection/sleep — detailed sleep sessions
// -----------------------------------------------------------------------
const MOCK_SLEEP_SESSIONS = {
  data: [
    {
      id: 'mock-sleep-session-001',
      type: 'long_sleep',
      day: daysAgo(0),
      bedtime_start: `${daysAgo(1)}T22:45:00+00:00`,
      bedtime_end: `${daysAgo(0)}T07:15:00+00:00`,
      total_sleep_duration: 24300,   // 405 minutes
      time_in_bed: 27000,            // 450 minutes
      awake_time: 2700,              // 45 minutes
      rem_sleep_duration: 5400,      // 90 minutes
      deep_sleep_duration: 4500,     // 75 minutes
      light_sleep_duration: 14400,   // 240 minutes
      efficiency: 90,
      latency: 10,
      average_heart_rate: 57.4,
      lowest_heart_rate: 51,
      average_hrv: 48.2,
      breathing_regularity: 96.5,
      sleep_phase_5_min: 'vvvvllllrrrrddddllllllrrrrvvvvvvvv',
    },
    {
      id: 'mock-sleep-session-002',
      type: 'long_sleep',
      day: daysAgo(1),
      bedtime_start: `${daysAgo(2)}T23:10:00+00:00`,
      bedtime_end: `${daysAgo(1)}T07:00:00+00:00`,
      total_sleep_duration: 22200,   // 370 minutes
      time_in_bed: 25800,            // 430 minutes
      awake_time: 3600,              // 60 minutes
      rem_sleep_duration: 4800,      // 80 minutes
      deep_sleep_duration: 3600,     // 60 minutes
      light_sleep_duration: 13800,   // 230 minutes
      efficiency: 86,
      latency: 18,
      average_heart_rate: 59.1,
      lowest_heart_rate: 53,
      average_hrv: 42.7,
      breathing_regularity: 95.1,
      sleep_phase_5_min: 'vvvvvllllrrrrdddddllllrrrrrvvvvvv',
    },
    {
      id: 'mock-sleep-session-003',
      type: 'long_sleep',
      day: daysAgo(2),
      bedtime_start: `${daysAgo(3)}T22:30:00+00:00`,
      bedtime_end: `${daysAgo(2)}T06:45:00+00:00`,
      total_sleep_duration: 25500,   // 425 minutes
      time_in_bed: 28500,            // 475 minutes
      awake_time: 3000,              // 50 minutes
      rem_sleep_duration: 6000,      // 100 minutes
      deep_sleep_duration: 5400,     // 90 minutes
      light_sleep_duration: 14100,   // 235 minutes
      efficiency: 89,
      latency: 14,
      average_heart_rate: 56.8,
      lowest_heart_rate: 50,
      average_hrv: 51.3,
      breathing_regularity: 97.2,
      sleep_phase_5_min: 'vvvlllllrrrrdddddddllllrrrrrvvvvvv',
    },
  ],
  next_token: null,
};

// -----------------------------------------------------------------------
// GET /v2/usercollection/daily_sleep — daily summaries with scores
// -----------------------------------------------------------------------
const MOCK_DAILY_SLEEP = {
  data: [
    {
      id: `daily-sleep-${daysAgo(0)}`,
      day: daysAgo(0),
      score: 83,
      contributors: {
        deep_sleep: 88,
        efficiency: 90,
        latency: 92,
        rem_sleep: 81,
        restfulness: 78,
        timing: 74,
        total_sleep: 85,
      },
    },
    {
      id: `daily-sleep-${daysAgo(1)}`,
      day: daysAgo(1),
      score: 76,
      contributors: {
        deep_sleep: 72,
        efficiency: 86,
        latency: 78,
        rem_sleep: 75,
        restfulness: 70,
        timing: 80,
        total_sleep: 79,
      },
    },
    {
      id: `daily-sleep-${daysAgo(2)}`,
      day: daysAgo(2),
      score: 85,
      contributors: {
        deep_sleep: 92,
        efficiency: 89,
        latency: 88,
        rem_sleep: 85,
        restfulness: 82,
        timing: 76,
        total_sleep: 88,
      },
    },
  ],
  next_token: null,
};

// -----------------------------------------------------------------------
// GET /v2/usercollection/daily_readiness — readiness scores
// -----------------------------------------------------------------------
const MOCK_DAILY_READINESS = {
  data: [
    {
      id: `daily-readiness-${daysAgo(0)}`,
      day: daysAgo(0),
      score: 78,
      temperature_deviation: 0.1,
      contributors: {
        activity_balance: 80,
        body_temperature: 96,
        hrv_balance: 75,
        previous_day_activity: 82,
        previous_night: 78,
        recovery_index: 74,
        resting_heart_rate: 84,
        sleep_balance: 79,
      },
    },
    {
      id: `daily-readiness-${daysAgo(1)}`,
      day: daysAgo(1),
      score: 71,
      temperature_deviation: -0.2,
      contributors: {
        activity_balance: 72,
        body_temperature: 94,
        hrv_balance: 68,
        previous_day_activity: 75,
        previous_night: 71,
        recovery_index: 70,
        resting_heart_rate: 76,
        sleep_balance: 73,
      },
    },
    {
      id: `daily-readiness-${daysAgo(2)}`,
      day: daysAgo(2),
      score: 80,
      temperature_deviation: 0.0,
      contributors: {
        activity_balance: 83,
        body_temperature: 97,
        hrv_balance: 79,
        previous_day_activity: 80,
        previous_night: 82,
        recovery_index: 78,
        resting_heart_rate: 85,
        sleep_balance: 81,
      },
    },
  ],
  next_token: null,
};

// -----------------------------------------------------------------------
// GET /v2/usercollection/heartrate — 24 hours of HR data points
// -----------------------------------------------------------------------
function generateHrData() {
  const points = [];
  for (let i = 0; i < 24; i++) {
    // Simulate realistic resting/awake HR variation
    const hour = (new Date().getHours() - 24 + i + 24) % 24;
    let bpm;
    if (hour >= 22 || hour < 7) {
      // Sleeping — lower HR, 50–60
      bpm = Math.round(50 + Math.random() * 10);
    } else if (hour >= 7 && hour < 9) {
      // Morning rise — 65–75
      bpm = Math.round(65 + Math.random() * 10);
    } else {
      // Daytime — 62–80
      bpm = Math.round(62 + Math.random() * 18);
    }
    points.push({
      timestamp: isoHoursAgo(24 - i),
      bpm,
      source: 'awake',
    });
  }
  return points;
}

const MOCK_HEARTRATE = {
  data: generateHrData(),
  next_token: null,
};

// -----------------------------------------------------------------------
// GET /v2/usercollection/daily_spo2 — SpO2 averages
// -----------------------------------------------------------------------
const MOCK_DAILY_SPO2 = {
  data: [
    {
      id: `spo2-${daysAgo(0)}`,
      day: daysAgo(0),
      spo2_percentage: { average: 97.8 },
    },
    {
      id: `spo2-${daysAgo(1)}`,
      day: daysAgo(1),
      spo2_percentage: { average: 98.1 },
    },
    {
      id: `spo2-${daysAgo(2)}`,
      day: daysAgo(2),
      spo2_percentage: { average: 97.4 },
    },
  ],
  next_token: null,
};

// -----------------------------------------------------------------------
// Dispatch function — return mock data by endpoint
// -----------------------------------------------------------------------
function getMockResponse(endpoint, params = {}) {
  if (endpoint.includes('/sleep') && !endpoint.includes('daily')) {
    return JSON.parse(JSON.stringify(MOCK_SLEEP_SESSIONS));
  }
  if (endpoint.includes('/daily_sleep')) {
    return JSON.parse(JSON.stringify(MOCK_DAILY_SLEEP));
  }
  if (endpoint.includes('/daily_readiness')) {
    return JSON.parse(JSON.stringify(MOCK_DAILY_READINESS));
  }
  if (endpoint.includes('/heartrate')) {
    return JSON.parse(JSON.stringify(MOCK_HEARTRATE));
  }
  if (endpoint.includes('/daily_spo2')) {
    return JSON.parse(JSON.stringify(MOCK_DAILY_SPO2));
  }
  throw new Error(`No mock defined for endpoint: ${endpoint}`);
}

module.exports = {
  MOCK_TOKEN_RESPONSE,
  MOCK_SLEEP_SESSIONS,
  MOCK_DAILY_SLEEP,
  MOCK_DAILY_READINESS,
  MOCK_HEARTRATE,
  MOCK_DAILY_SPO2,
  getMockResponse,
};
