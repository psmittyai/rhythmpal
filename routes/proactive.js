'use strict';
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../lib/auth');
const { checkAndQueueTriggers, getPendingMessages, markShown } = require('../lib/proactive');
const { query } = require('../lib/db');
const { SKILLS } = require('../lib/skills');

// GET /api/proactive/pending — called on app open
// Runs trigger checks + returns any queued messages
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    // Run trigger checks (await so messages are ready when we return)
    await checkAndQueueTriggers(userId);
    const messages = await getPendingMessages(userId);
    // Mark as shown
    if (messages.length) await markShown(messages.map(m => m.id));
    res.json({ messages });
  } catch (err) {
    console.error('GET /api/proactive/pending error:', err);
    res.status(500).json({ error: 'Failed to load proactive messages' });
  }
});

// GET /api/proactive/skills — returns skill list + user's enabled state
router.get('/skills', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const enabledRes = await query(
      `SELECT skill_key, enabled, settings FROM user_skills WHERE user_id=$1`,
      [userId]
    );
    const enabledMap = {};
    enabledRes.rows.forEach(r => { enabledMap[r.skill_key] = r; });
    const skills = Object.values(SKILLS).map(s => ({
      key: s.key,
      name: s.name,
      emoji: s.emoji,
      description: s.description,
      enabled: enabledMap[s.key] ? enabledMap[s.key].enabled : true,
      settings: enabledMap[s.key]?.settings || {}
    }));
    res.json({ skills });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load skills' });
  }
});

// PATCH /api/proactive/skills/:key — toggle or update settings
router.patch('/skills/:key', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { key } = req.params;
    const { enabled, settings } = req.body;
    if (!SKILLS[key]) return res.status(404).json({ error: 'Unknown skill' });
    await query(
      `INSERT INTO user_skills (user_id, skill_key, enabled, settings, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, skill_key) DO UPDATE SET enabled=$3, settings=$4, updated_at=NOW()`,
      [userId, key, enabled !== undefined ? enabled : true, JSON.stringify(settings || {})]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

module.exports = router;
