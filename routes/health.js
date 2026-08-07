'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

// GET /api/health/summary — today's health snapshot
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get today's food logs for calorie summary
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const foodResult = await query(
      `SELECT COALESCE(SUM(calories), 0) as total_calories,
              COALESCE(SUM(protein), 0) as total_protein,
              COALESCE(SUM(carbs), 0) as total_carbs,
              COALESCE(SUM(fat), 0) as total_fat,
              COUNT(*) as entries
       FROM food_logs
       WHERE user_id = $1 AND logged_at >= $2`,
      [userId, todayStart.toISOString()]
    );

    const food = foodResult.rows[0];

    const profileResult = await query(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    const profile = profileResult.rows[0] || {};

    // --- Health data: read from health_measurements first, fall back to apple_health_logs ---
    let appleData = {};
    let dataSource = 'none';

    // Try health_measurements (new canonical table)
    let healthMeasurementsRows = [];
    try {
      const hmResult = await query(
        `SELECT DISTINCT ON (metric_type) metric_type, value, unit, start_at
         FROM health_measurements
         WHERE user_id = $1 AND start_at >= NOW() - INTERVAL '24 hours'
         ORDER BY metric_type, start_at DESC`,
        [userId]
      );
      healthMeasurementsRows = hmResult.rows;
    } catch (err) {
      // Table may not exist yet — non-fatal
      if (process.env.NODE_ENV !== 'production') {
        console.debug('health_measurements read error (falling back):', err.message);
      }
    }

    if (healthMeasurementsRows.length > 0) {
      dataSource = 'health_measurements';
      for (const row of healthMeasurementsRows) {
        appleData[row.metric_type] = {
          value: parseFloat(row.value),
          unit: row.unit,
          date: row.start_at,
        };
      }
    } else {
      // Fall back to apple_health_logs (migration window safety)
      if (process.env.NODE_ENV !== 'production') {
        console.debug('health_measurements: zero results, falling back to apple_health_logs');
      }
      dataSource = 'apple_health_logs';
      const appleHealthResult = await query(
        `SELECT DISTINCT ON (data_type) data_type, value, unit, start_date
         FROM apple_health_logs
         WHERE user_id = $1 AND start_date >= NOW() - INTERVAL '24 hours'
         ORDER BY data_type, start_date DESC`,
        [userId]
      );
      for (const row of appleHealthResult.rows) {
        appleData[row.data_type] = {
          value: parseFloat(row.value),
          unit: row.unit,
          date: row.start_date,
        };
      }
    }

    // Helper to get health value by common name variants
    const ah = (names) => {
      for (const n of names) {
        if (appleData[n]) return appleData[n].value;
      }
      return null;
    };

    const sleepHours = ah(['sleep_analysis', 'HKCategoryTypeIdentifierSleepAnalysis', 'sleepAnalysis']);
    const hrvValue = ah(['HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'heartRateVariabilitySDNN', 'hrv']);
    const stepCount = ah(['HKQuantityTypeIdentifierStepCount', 'stepCount', 'steps']);

    // Build health snapshot with real health data where available
    const snapshot = {
      date: new Date().toISOString().split('T')[0],
      sleep: {
        score: sleepHours
          ? Math.min(100, Math.round((sleepHours / (profile.target_sleep_hours || 8)) * 100))
          : null,
        hours: sleepHours,
        deep_sleep_pct: null,
        status: sleepHours ? 'ok' : 'connect_wearable',
      },
      hrv: {
        value: hrvValue,
        status: hrvValue ? 'ok' : 'connect_wearable',
      },
      steps: {
        count: stepCount,
        goal: profile.target_steps || 10000,
        status: stepCount ? 'ok' : 'connect_wearable',
      },
      calories: {
        consumed: parseInt(food.total_calories) || 0,
        entries: parseInt(food.entries) || 0,
        protein: parseFloat(food.total_protein) || 0,
        carbs: parseFloat(food.total_carbs) || 0,
        fat: parseFloat(food.total_fat) || 0,
      },
      targets: {
        calories: profile.target_calories || null,
        protein: profile.target_protein || null,
        carbs: profile.target_carbs || null,
        fat: profile.target_fat || null,
        fiber: profile.target_fiber || null,
        water: profile.target_water || 8,
        steps: profile.target_steps || 10000,
        sleep_hours: profile.target_sleep_hours || 8,
        active_minutes: profile.target_active_minutes || 30,
      },
      profile_set: !!profile.weight_kg,
      wearables_connected: Object.keys(appleData).length > 0,
    };

    res.json({ snapshot });
  } catch (err) {
    console.error('Health summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch health summary' });
  }
});

// POST /api/health/food-log — log a food entry
router.post('/food-log', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { description, calories, protein, carbs, fat, fiber, source } = req.body;

    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }

    const result = await query(
      `INSERT INTO food_logs (user_id, description, calories, protein, carbs, fat, fiber, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, description, calories || null, protein || null, carbs || null, fat || null, fiber || null, source || 'manual']
    );

    res.status(201).json({ entry: result.rows[0] });
  } catch (err) {
    console.error('Food log error:', err.message);
    res.status(500).json({ error: 'Failed to save food entry' });
  }
});

// GET /api/health/food-log — today's food log
router.get('/food-log', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const result = await query(
      `SELECT * FROM food_logs
       WHERE user_id = $1 AND logged_at >= $2
       ORDER BY logged_at DESC`,
      [userId, todayStart.toISOString()]
    );

    res.json({ entries: result.rows });
  } catch (err) {
    console.error('Food log fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch food log' });
  }
});

module.exports = router;
