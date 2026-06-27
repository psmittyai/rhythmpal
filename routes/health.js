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

    // Stub wearable data (replace with real wearable integrations)
    const snapshot = {
      date: new Date().toISOString().split('T')[0],
      sleep: {
        score: null,
        hours: null,
        deep_sleep_pct: null,
        status: 'connect_wearable',
      },
      hrv: {
        value: null,
        status: 'connect_wearable',
      },
      steps: {
        count: null,
        goal: 10000,
        status: 'connect_wearable',
      },
      calories: {
        consumed: parseInt(food.total_calories) || 0,
        entries: parseInt(food.entries) || 0,
        protein: parseFloat(food.total_protein) || 0,
        carbs: parseFloat(food.total_carbs) || 0,
        fat: parseFloat(food.total_fat) || 0,
      },
      wearables_connected: false,
    };

    res.json({ snapshot });
  } catch (err) {
    console.error('Health summary error:', err);
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
    console.error('Food log error:', err);
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
    console.error('Food log fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch food log' });
  }
});

module.exports = router;
