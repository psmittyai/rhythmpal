const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are RhythmPal, a personal health intelligence assistant. You have real data about this user — their profile, daily targets, today's food log, and weekly trends.

Your job is to give them daily actionable coaching based on THEIR actual numbers — not generic advice. Reference their specific data every time.

Rules:
- Always reference their actual numbers: "You've hit 82g protein — you need 58g more to reach your 140g target"
- Point out patterns: "Your protein has been low 4 of the last 7 days — this is limiting your recovery"
- Give specific food suggestions when they're short on a macro: "Add a chicken breast or Greek yogurt to close that protein gap"
- If they're on track, acknowledge it specifically and suggest what to focus on next
- Keep replies to 3-5 sentences max — dense with value, zero filler
- Never give canned advice like "drink more water" without connecting it to their actual data
- Celebrate wins when they hit targets: make it feel earned
- Be direct, warm, and smart — like a coach who actually looked at their data`;

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

    // Get profile + goals
    const profileResult = await query(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [userId]
    );
    const profile = profileResult.rows[0] || {};

    // Get 7-day food history for trend context
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    const weekFoodResult = await query(
      `SELECT DATE(logged_at) as day,
              SUM(calories) as calories, SUM(protein) as protein,
              SUM(carbs) as carbs, SUM(fat) as fat
       FROM food_logs WHERE user_id = $1 AND logged_at >= $2
       GROUP BY DATE(logged_at) ORDER BY day DESC`,
      [userId, weekStart.toISOString()]
    );

    let contextBlock = '';
    if (user) contextBlock += `User: ${user.name || 'Unknown'} (${user.tier} tier)\n`;

    if (profile.weight_kg) {
      contextBlock += `Profile: ${profile.sex || '?'}, age ${profile.age || '?'}, `;
      contextBlock += `${profile.weight_kg}kg, goal: ${profile.goal || 'maintain'}\n`;
      contextBlock += `Daily targets: ${profile.target_calories || '?'} kcal, `;
      contextBlock += `${profile.target_protein || '?'}g protein, ${profile.target_carbs || '?'}g carbs, `;
      contextBlock += `${profile.target_fat || '?'}g fat\n`;
    }

    if (foodEntries.length > 0) {
      const totalCals = foodEntries.reduce((sum, e) => sum + (e.calories || 0), 0);
      const totalProtein = foodEntries.reduce((sum, e) => sum + (parseFloat(e.protein) || 0), 0);
      const totalCarbs = foodEntries.reduce((sum, e) => sum + (parseFloat(e.carbs) || 0), 0);
      const totalFat = foodEntries.reduce((sum, e) => sum + (parseFloat(e.fat) || 0), 0);

      contextBlock += `Today's intake: ${totalCals} kcal, ${totalProtein.toFixed(0)}g protein, `;
      contextBlock += `${totalCarbs.toFixed(0)}g carbs, ${totalFat.toFixed(0)}g fat\n`;

      if (profile.target_calories) {
        const remaining = profile.target_calories - totalCals;
        contextBlock += `Remaining today: ${remaining > 0 ? remaining + ' kcal to goal' : Math.abs(remaining) + ' kcal over goal'}\n`;
      }
      if (profile.target_protein) {
        const proteinLeft = profile.target_protein - totalProtein;
        contextBlock += `Protein: ${proteinLeft > 0 ? proteinLeft.toFixed(0) + 'g to target' : 'target hit'}\n`;
      }

      contextBlock += `Food today (${foodEntries.length} entries):\n`;
      foodEntries.forEach(e => {
        contextBlock += `- ${e.description}${e.calories ? ` (${e.calories} kcal)` : ''}\n`;
      });
    } else {
      contextBlock += 'No food logged today.\n';
    }

    if (weekFoodResult.rows.length > 1) {
      contextBlock += `7-day food trend:\n`;
      weekFoodResult.rows.forEach(d => {
        contextBlock += `- ${d.day}: ${d.calories || 0} kcal, ${parseFloat(d.protein||0).toFixed(0)}g protein\n`;
      });
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
