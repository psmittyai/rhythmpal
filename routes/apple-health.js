const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

// GET /api/health/apple-health/setup — get or generate webhook token for current user
// NOTE: This must be defined BEFORE the /:token route to avoid "setup" being treated as a token
router.get('/setup', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get existing token
    const result = await query(
      'SELECT apple_health_token FROM user_profiles WHERE user_id = $1',
      [userId]
    );

    let token = result.rows[0]?.apple_health_token;
    const wasConnected = !!token;

    // Generate if missing
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      await query(
        `INSERT INTO user_profiles (user_id, apple_health_token)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET apple_health_token = $2`,
        [userId, token]
      );
    }

    const baseUrl = process.env.BASE_URL || 'https://rhythmpal.com';
    const webhookUrl = `${baseUrl}/api/health/apple-health/${token}`;

    // Check if any data has been received
    const dataCheck = await query(
      'SELECT COUNT(*) as cnt FROM apple_health_logs WHERE user_id = $1',
      [userId]
    );
    const hasData = parseInt(dataCheck.rows[0]?.cnt) > 0;

    res.json({ token, webhookUrl, connected: wasConnected, hasData });
  } catch (err) {
    console.error('Apple Health setup error:', err);
    res.status(500).json({ error: 'Failed to get setup info' });
  }
});

// POST /api/health/apple-health/:token — receive Health Auto Export webhook
// No auth middleware — token in URL IS the auth
router.post('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Find user by token
    const userResult = await query(
      'SELECT user_id FROM user_profiles WHERE apple_health_token = $1',
      [token]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'Invalid token' });
    }

    const userId = userResult.rows[0].user_id;
    const payload = req.body;

    // Health Auto Export sends data as array of metrics
    // Format: { data: [ { name, units, data: [ { date, qty } ] } ] }
    // Also supports: { metrics: [...] } format
    const metrics = payload.data || payload.metrics || [];

    let inserted = 0;

    for (const metric of metrics) {
      const dataType = metric.name || metric.identifier;
      const unit = metric.units || metric.unit;
      const entries = metric.data || metric.dataPoints || [];

      for (const entry of entries) {
        const value = entry.qty !== undefined ? entry.qty : entry.value;
        const startDate = entry.date || entry.startDate;
        const endDate = entry.endDate || startDate;
        const source = entry.source || metric.source || 'apple_health';

        if (value === undefined || value === null) continue;

        // Upsert — avoid duplicate entries for same user/type/date
        await query(
          `INSERT INTO apple_health_logs (user_id, data_type, value, unit, source, start_date, end_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [userId, dataType, value, unit, source, startDate, endDate]
        );
        inserted++;
      }
    }

    res.json({ ok: true, inserted });
  } catch (err) {
    console.error('Apple Health webhook error:', err);
    res.status(500).json({ error: 'Failed to process health data' });
  }
});

module.exports = router;
