'use strict';

const SKILLS = {
  nutrition: {
    key: 'nutrition',
    name: 'Nutrition Coach',
    emoji: '🥗',
    description: 'Macro tracking, meal planning, and daily nutrition coaching based on your actual intake.',
    systemPrompt: `You are RhythmPal's Nutrition Coach. You have real data about this user — their profile, daily targets, today's food log, and weekly trends.
Your job: give daily actionable nutrition coaching based on THEIR actual numbers. Never generic advice.
Rules:
- Always reference actual numbers: "You've hit 82g protein — you need 58g more to reach your 140g target"
- Spot patterns: "Your protein has been low 4 of the last 7 days — this is limiting your recovery"
- Give specific food suggestions when short on a macro
- Celebrate wins when targets are hit — make it feel earned
- 3-5 sentences max. Dense with value, zero filler.
- Be direct, warm, and smart — like a coach who actually looked at their data`,
    // AUTO-TRIGGER: fires at 8pm if protein < 60% of target
    async triggerCheck(userId, db) {
      const now = new Date();
      const hour = now.getHours();
      if (hour < 20) return null; // only after 8pm
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const [foodRes, profileRes] = await Promise.all([
        db.query(`SELECT SUM(protein) as total_protein FROM food_logs WHERE user_id=$1 AND logged_at>=$2`, [userId, todayStart.toISOString()]),
        db.query(`SELECT target_protein FROM user_profiles WHERE user_id=$1`, [userId])
      ]);
      const protein = parseFloat(foodRes.rows[0]?.total_protein || 0);
      const target = parseFloat(profileRes.rows[0]?.target_protein || 0);
      if (!target || protein >= target * 0.6) return null;
      const gap = Math.round(target - protein);
      return {
        triggerKey: 'evening_protein_check',
        prompt: `AUTO-TRIGGER: It's evening and the user has only hit ${Math.round(protein)}g protein out of their ${Math.round(target)}g target. They're ${gap}g short. Proactively tell them this and give 3 specific quick food options to close the gap tonight. Be direct and actionable.`
      };
    }
  },

  sleep: {
    key: 'sleep',
    name: 'Sleep Optimizer',
    emoji: '😴',
    description: 'Sleep stage analysis, recovery coaching, and bedtime optimization using your wearable data.',
    systemPrompt: `You are RhythmPal's Sleep Optimizer coach. You have access to this user's sleep data from their wearable.
Your job: turn raw sleep data into actionable recovery intelligence. Help them understand what happened last night and what to do today.
Rules:
- Always lead with last night's actual numbers: duration, deep sleep %, REM %, readiness score
- Explain what the numbers mean in plain English — never just show data
- Connect sleep quality to today's recommended intensity (train hard vs recover)
- Flag patterns: late meals, consistent wake times, sleep debt trends
- 3-5 sentences. No filler. Be the coach they wish they had.`,
    // AUTO-TRIGGER: fires on morning app open (before noon) when new sleep data exists
    async triggerCheck(userId, db) {
      const now = new Date();
      const hour = now.getHours();
      if (hour >= 12) return null; // morning only
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(18, 0, 0, 0);
      const sleepRes = await db.query(
        `SELECT value, unit, start_date FROM apple_health_logs 
         WHERE user_id=$1 AND data_type IN ('SleepAnalysis','sleep_duration','HKCategoryTypeIdentifierSleepAnalysis')
         AND received_at >= $2 ORDER BY start_date DESC LIMIT 5`,
        [userId, yesterday.toISOString()]
      );
      if (!sleepRes.rows.length) return null;
      const totalMinutes = sleepRes.rows.reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
      const hours = (totalMinutes / 60).toFixed(1);
      return {
        triggerKey: 'morning_sleep_brief',
        prompt: `AUTO-TRIGGER: Morning check-in. The user slept approximately ${hours} hours last night based on wearable data. Proactively give them their sleep brief — what the data shows, what it means for their energy and training today, and one specific recommendation. Be direct and personal.`
      };
    }
  },

  workout: {
    key: 'workout',
    name: 'Workout Coach',
    emoji: '🏋️',
    description: 'Training programming, workout logging, and recovery-based session recommendations.',
    systemPrompt: `You are RhythmPal's Workout Coach. You have access to this user's activity data, HRV, and training history.
Your job: program smart training based on what their body is actually ready for — not a generic plan.
Rules:
- Always check recovery status (HRV, resting HR, sleep quality) before recommending intensity
- Log workouts when detected from wearable data — ask for details if unclear
- Track progressive overload — reference past sessions
- Green light = push hard. Yellow = moderate. Red = active recovery only.
- 3-5 sentences. Specific and data-driven. Never generic "listen to your body" advice.`,
    // AUTO-TRIGGER: fires when active calories spike OR HRV drop detected (post-workout)
    async triggerCheck(userId, db) {
      const since = new Date(); since.setHours(0, 0, 0, 0);
      const activityRes = await db.query(
        `SELECT SUM(value) as total FROM apple_health_logs 
         WHERE user_id=$1 AND data_type IN ('ActiveEnergyBurned','active_calories')
         AND start_date >= $2`,
        [userId, since.toISOString()]
      );
      const activeCals = parseFloat(activityRes.rows[0]?.total || 0);
      if (activeCals < 200) return null; // no significant activity
      return {
        triggerKey: 'post_workout_detection',
        prompt: `AUTO-TRIGGER: The user has burned ${Math.round(activeCals)} active calories today — looks like they trained. Proactively acknowledge the workout, ask them to log the details if not already done, and give a quick recovery recommendation based on the intensity. Be direct and coach-like.`
      };
    }
  },

  hydration: {
    key: 'hydration',
    name: 'Hydration Coach',
    emoji: '💧',
    description: 'Daily water intake tracking with proactive reminders based on activity and targets.',
    systemPrompt: `You are RhythmPal's Hydration Coach. You track this user's daily water intake vs their target.
Your job: keep them on track with hydration and explain why it matters for their specific goals.
Rules:
- Always reference today's actual intake vs target in ounces or glasses
- Connect hydration to their current goal (muscle building, fat loss, performance, recovery)
- If they're behind, give a concrete catch-up plan for the rest of the day
- Flag patterns: consistently low mid-afternoon, post-workout gaps
- 3-4 sentences. Specific and practical.`,
    // AUTO-TRIGGER: fires at 2pm if water logs < 50% of daily target
    async triggerCheck(userId, db) {
      const now = new Date();
      const hour = now.getHours();
      if (hour < 14 || hour > 15) return null; // 2-3pm window
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const [waterRes, profileRes] = await Promise.all([
        db.query(
          `SELECT SUM(value) as total FROM apple_health_logs 
           WHERE user_id=$1 AND data_type IN ('DietaryWater','water_intake') AND start_date >= $2`,
          [userId, todayStart.toISOString()]
        ),
        db.query(`SELECT target_water FROM user_profiles WHERE user_id=$1`, [userId])
      ]);
      const water = parseFloat(waterRes.rows[0]?.total || 0);
      const target = parseFloat(profileRes.rows[0]?.target_water || 8); // glasses
      if (water >= target * 0.5) return null;
      return {
        triggerKey: 'afternoon_hydration_check',
        prompt: `AUTO-TRIGGER: It's 2pm and the user has only logged ${water.toFixed(1)} glasses of water out of their ${target} glass target. Proactively tell them they're behind on hydration and give a specific plan to catch up by end of day. Connect it to their energy and performance.`
      };
    }
  },

  recovery: {
    key: 'recovery',
    name: 'Stress & Recovery',
    emoji: '🧠',
    description: 'HRV-based stress monitoring and recovery coaching to help you know when to push and when to rest.',
    systemPrompt: `You are RhythmPal's Stress & Recovery coach. You read HRV data and physiological stress markers to help the user make smart decisions about training and recovery.
Your job: translate HRV numbers into a clear daily directive — push, maintain, or recover.
Rules:
- Always reference their actual HRV vs their personal baseline (7-day rolling avg)
- Green (>100% baseline) = push hard. Yellow (85-100%) = maintain. Red (<85%) = prioritize recovery.
- Connect the HRV signal to likely causes: poor sleep, training load, stress, illness
- Give one specific action: "Take the easy session today" or "This is a great day for intensity"
- 3-5 sentences. Data-driven. No wishy-washy language.`,
    // AUTO-TRIGGER: fires when HRV is 10%+ below 7-day rolling average
    async triggerCheck(userId, db) {
      const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const [baselineRes, todayRes] = await Promise.all([
        db.query(
          `SELECT AVG(value) as avg_hrv FROM apple_health_logs 
           WHERE user_id=$1 AND data_type IN ('HeartRateVariabilitySDNN','hrv') AND start_date >= $2 AND start_date < $3`,
          [userId, weekAgo.toISOString(), todayStart.toISOString()]
        ),
        db.query(
          `SELECT AVG(value) as today_hrv FROM apple_health_logs 
           WHERE user_id=$1 AND data_type IN ('HeartRateVariabilitySDNN','hrv') AND start_date >= $2`,
          [userId, todayStart.toISOString()]
        )
      ]);
      const baseline = parseFloat(baselineRes.rows[0]?.avg_hrv || 0);
      const today = parseFloat(todayRes.rows[0]?.today_hrv || 0);
      if (!baseline || !today) return null;
      const pct = today / baseline;
      if (pct >= 0.9) return null; // within 10% of baseline, no alert
      const dropPct = Math.round((1 - pct) * 100);
      const signal = pct < 0.85 ? 'RED — prioritize recovery' : 'YELLOW — maintain only';
      return {
        triggerKey: 'hrv_suppression_alert',
        prompt: `AUTO-TRIGGER: HRV alert. The user's HRV today is ${Math.round(today)}ms — ${dropPct}% below their 7-day baseline of ${Math.round(baseline)}ms. Signal: ${signal}. Proactively tell them what this means, what's likely causing it, and give them one specific directive for today's training/recovery. Be direct.`
      };
    }
  },

  fasting: {
    key: 'fasting',
    name: 'Intermittent Fasting',
    emoji: '⏱️',
    description: 'Eating window tracking, fast quality coaching, and time-restricted feeding optimization.',
    systemPrompt: `You are RhythmPal's Intermittent Fasting coach. You track the user's eating windows and help them optimize time-restricted feeding.
Your job: keep them on their fasting protocol and coach around fast quality.
Rules:
- Always reference actual eating window: first meal time → last meal time
- Calculate fast duration and compare to their target (default 16:8)
- Flag late eating: "Your last meal was at 10:30pm — that pushed your fast window to only 13 hours"
- Acknowledge clean fasts and explain the benefit gained
- 3-4 sentences. Specific times and durations. Never vague.`,
    // AUTO-TRIGGER: fires when first food log of the day is detected
    async triggerCheck(userId, db) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const firstMealRes = await db.query(
        `SELECT logged_at FROM food_logs WHERE user_id=$1 AND logged_at >= $2 ORDER BY logged_at ASC LIMIT 1`,
        [userId, todayStart.toISOString()]
      );
      if (!firstMealRes.rows.length) return null;
      const firstMeal = new Date(firstMealRes.rows[0].logged_at);
      // Get yesterday's last meal to calculate fast duration
      const yesterdayStart = new Date(); yesterdayStart.setDate(yesterdayStart.getDate() - 1); yesterdayStart.setHours(0, 0, 0, 0);
      const lastMealRes = await db.query(
        `SELECT logged_at FROM food_logs WHERE user_id=$1 AND logged_at >= $2 AND logged_at < $3 ORDER BY logged_at DESC LIMIT 1`,
        [userId, yesterdayStart.toISOString(), todayStart.toISOString()]
      );
      const firstMealTime = firstMeal.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      let fastMsg = `first meal today at ${firstMealTime}`;
      if (lastMealRes.rows.length) {
        const lastMeal = new Date(lastMealRes.rows[0].logged_at);
        const fastHours = ((firstMeal - lastMeal) / 3600000).toFixed(1);
        const lastMealTime = lastMeal.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        fastMsg = `fasted ${fastHours} hours (last meal yesterday at ${lastMealTime}, first meal today at ${firstMealTime})`;
      }
      return {
        triggerKey: 'first_meal_fast_break',
        prompt: `AUTO-TRIGGER: The user just broke their fast — they ${fastMsg}. Proactively tell them how their fast window looks, whether it hits their 16:8 target, and one tip for their eating window for the rest of today. Be specific with the times and duration.`
      };
    }
  },

  supplements: {
    key: 'supplements',
    name: 'Supplement Stack',
    emoji: '💊',
    description: 'Supplement timing reminders, stack optimization, and goal-aligned recommendations.',
    systemPrompt: `You are RhythmPal's Supplement Stack coach. You help the user optimize their supplement timing and stack based on their health goals.
Your job: make sure they're taking the right things at the right times for maximum effect.
Rules:
- Reference their specific stack and goals (muscle building, fat loss, sleep, performance)
- Timing matters: pre-workout, post-workout, with food, before bed — always specify
- Flag interactions or redundancies when spotted
- Connect each supplement to a specific outcome they care about
- 3-4 sentences. Specific supplement names and timing. Never generic.`,
    // AUTO-TRIGGER: fires at 7-9am as morning stack reminder
    async triggerCheck(userId, db) {
      const now = new Date();
      const hour = now.getHours();
      if (hour < 7 || hour > 9) return null;
      // Check if they have a supplement stack defined in settings
      const skillRes = await db.query(
        `SELECT settings FROM user_skills WHERE user_id=$1 AND skill_key='supplements'`,
        [userId]
      );
      const settings = skillRes.rows[0]?.settings || {};
      const stack = settings.stack || [];
      const stackDesc = stack.length ? stack.join(', ') : 'their supplement stack';
      return {
        triggerKey: 'morning_supplement_reminder',
        prompt: `AUTO-TRIGGER: Morning supplement reminder. The user's morning stack includes: ${stackDesc}. Proactively remind them to take their morning supplements, explain the optimal timing (with or without food, before/after coffee), and give one tip for maximizing absorption. Be specific and practical.`
      };
    }
  }
};

module.exports = { SKILLS };
