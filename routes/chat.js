const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are RhythmPal, a health intelligence assistant. You have access to the user's health data and help them understand patterns, answer health questions, and provide actionable insights.

Your style:
- Be specific, evidence-based, and proactive
- Give concrete, actionable advice — not generic platitudes
- Reference patterns you notice across their data when available
- Be warm but direct — health matters, don't sugarcoat
- Keep responses concise — 2-4 sentences unless a complex explanation is needed
- Use plain language — no jargon unless you explain it

When users log food, celebrate small wins and note nutritional patterns.
When they ask about sleep or HRV, connect it to energy, recovery, and performance.
When data is missing (wearable not connected), acknowledge it and suggest they connect.`;

// POST /api/chat
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get recent context: last 10 food entries + health summary
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [foodResult, userResult] = await Promise.all([
      query(
        `SELECT description, calories, protein, carbs, fat, logged_at
         FROM food_logs WHERE user_id = $1 AND logged_at >= $2
         ORDER BY logged_at DESC LIMIT 10`,
        [userId, todayStart.toISOString()]
      ),
      query('SELECT name, tier, created_at FROM users WHERE id = $1', [userId]),
    ]);

    const user = userResult.rows[0];
    const foodEntries = foodResult.rows;

    let contextBlock = '';
    if (user) {
      contextBlock += `User: ${user.name || 'Unknown'} (${user.tier} tier)\n`;
    }
    if (foodEntries.length > 0) {
      const totalCals = foodEntries.reduce((sum, e) => sum + (e.calories || 0), 0);
      contextBlock += `Today's food (${foodEntries.length} entries, ~${totalCals} kcal):\n`;
      foodEntries.forEach(e => {
        contextBlock += `- ${e.description}${e.calories ? ` (${e.calories} kcal)` : ''}\n`;
      });
    } else {
      contextBlock += 'No food logged today.\n';
    }

    const userMessageWithContext = contextBlock
      ? `[Health Context]\n${contextBlock}\n[User Message]\n${message}`
      : message;

    // Get recent chat history for continuity
    const historyResult = await query(
      `SELECT role, content FROM chat_messages
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    const history = historyResult.rows.reverse();

    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessageWithContext },
    ];

    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content[0].text;

    // Save both messages to history
    await Promise.all([
      query(
        'INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)',
        [userId, 'user', message]
      ),
      query(
        'INSERT INTO chat_messages (user_id, role, content) VALUES ($1, $2, $3)',
        [userId, 'assistant', reply]
      ),
    ]);

    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Chat failed — please try again' });
  }
});

module.exports = router;
