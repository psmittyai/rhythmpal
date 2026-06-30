'use strict';
const { query } = require('./db');
const { SKILLS } = require('./skills');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function checkAndQueueTriggers(userId) {
  try {
    // Get user's enabled skills (default all enabled)
    const skillsRes = await query(
      `SELECT skill_key, enabled, settings FROM user_skills WHERE user_id=$1`,
      [userId]
    );
    const userSkillMap = {};
    skillsRes.rows.forEach(r => { userSkillMap[r.skill_key] = r; });

    const results = [];

    for (const [key, skill] of Object.entries(SKILLS)) {
      // Skip if explicitly disabled
      if (userSkillMap[key] && !userSkillMap[key].enabled) continue;
      if (!skill.triggerCheck) continue;

      try {
        const trigger = await skill.triggerCheck(userId, { query });
        if (!trigger) continue;

        // Check if already fired today
        const today = new Date().toISOString().split('T')[0];
        const firedRes = await query(
          `SELECT id FROM skill_triggers_fired WHERE user_id=$1 AND skill_key=$2 AND trigger_key=$3 AND fired_date=$4`,
          [userId, key, trigger.triggerKey, today]
        );
        if (firedRes.rows.length) continue; // already fired today

        // Generate the proactive message
        const response = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 300,
          system: skill.systemPrompt,
          messages: [{ role: 'user', content: trigger.prompt }]
        });
        const content = response.content[0]?.text || '';
        if (!content) continue;

        // Store in proactive_messages queue
        await query(
          `INSERT INTO proactive_messages (user_id, skill_key, content) VALUES ($1, $2, $3)`,
          [userId, key, content]
        );

        // Mark trigger as fired
        await query(
          `INSERT INTO skill_triggers_fired (user_id, skill_key, trigger_key, fired_date) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, skill_key, trigger_key, fired_date) DO NOTHING`,
          [userId, key, trigger.triggerKey, today]
        );

        results.push({ skill: key, triggered: true });
      } catch (err) {
        console.error(`Trigger check failed for skill ${key}, user ${userId}:`, err.message);
      }
    }
    return results;
  } catch (err) {
    console.error('checkAndQueueTriggers error:', err.message);
    return [];
  }
}

async function getPendingMessages(userId) {
  const res = await query(
    `SELECT id, skill_key, content, created_at FROM proactive_messages 
     WHERE user_id=$1 AND shown=false ORDER BY created_at ASC`,
    [userId]
  );
  return res.rows;
}

async function markShown(messageIds) {
  if (!messageIds.length) return;
  await query(
    `UPDATE proactive_messages SET shown=true WHERE id = ANY($1)`,
    [messageIds]
  );
}

module.exports = { checkAndQueueTriggers, getPendingMessages, markShown };
