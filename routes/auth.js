const express = require('express');
const router = express.Router();
const { query } = require('../lib/db');
const { signToken, hashPassword, comparePassword, requireAuth } = require('../lib/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if user already exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await hashPassword(password);
    const result = await query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, tier, created_at',
      [email.toLowerCase(), passwordHash, name || null]
    );

    const user = result.rows[0];
    const token = signToken({ id: user.id, email: user.email, tier: user.tier });

    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed — please try again' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await query(
      'SELECT id, email, name, password_hash, tier FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ id: user.id, email: user.email, tier: user.tier });

    res.json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed — please try again' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, name, tier, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/auth/profile — get user profile + targets
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM user_profiles WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ profile: result.rows[0] || null });
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /api/auth/profile — save/update profile + auto-calculate targets
router.post('/profile', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { sex, age, height_cm, weight_kg, activity_level, goal,
            target_calories, target_protein, target_carbs, target_fat,
            target_fiber, target_water, target_steps, target_sleep_hours, target_active_minutes } = req.body;

    // Auto-calculate targets if not manually set (Mifflin-St Jeor + ISSN macros)
    let calcCalories = target_calories;
    let calcProtein = target_protein;
    let calcCarbs = target_carbs;
    let calcFat = target_fat;

    if (!calcCalories && weight_kg && height_cm && age && sex) {
      let bmr;
      if (sex === 'male') {
        bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + 5;
      } else {
        bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age - 161;
      }
      const activityMultipliers = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
      const tdee = bmr * (activityMultipliers[activity_level] || 1.55);
      if (goal === 'lose') calcCalories = Math.round(tdee - 500);
      else if (goal === 'gain') calcCalories = Math.round(tdee + 300);
      else calcCalories = Math.round(tdee);
      calcProtein = calcProtein || Math.round(weight_kg * 1.8);
      calcFat = calcFat || Math.round(calcCalories * 0.25 / 9);
      calcCarbs = calcCarbs || Math.round((calcCalories - calcProtein * 4 - calcFat * 9) / 4);
    }

    const result = await query(
      `INSERT INTO user_profiles (user_id, sex, age, height_cm, weight_kg, activity_level, goal,
        target_calories, target_protein, target_carbs, target_fat, target_fiber,
        target_water, target_steps, target_sleep_hours, target_active_minutes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
        sex=EXCLUDED.sex, age=EXCLUDED.age, height_cm=EXCLUDED.height_cm, weight_kg=EXCLUDED.weight_kg,
        activity_level=EXCLUDED.activity_level, goal=EXCLUDED.goal,
        target_calories=EXCLUDED.target_calories, target_protein=EXCLUDED.target_protein,
        target_carbs=EXCLUDED.target_carbs, target_fat=EXCLUDED.target_fat,
        target_fiber=EXCLUDED.target_fiber, target_water=EXCLUDED.target_water,
        target_steps=EXCLUDED.target_steps, target_sleep_hours=EXCLUDED.target_sleep_hours,
        target_active_minutes=EXCLUDED.target_active_minutes, updated_at=NOW()
       RETURNING *`,
      [userId, sex||null, age||null, height_cm||null, weight_kg||null,
       activity_level||'moderate', goal||'maintain',
       calcCalories||null, calcProtein||null, calcCarbs||null, calcFat||null,
       target_fiber||25, target_water||8, target_steps||10000,
       target_sleep_hours||8, target_active_minutes||30]
    );

    res.json({ profile: result.rows[0] });
  } catch (err) {
    console.error('Profile save error:', err);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

// DELETE /api/auth/account
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    // Delete all user data in dependency order
    await query('DELETE FROM food_logs WHERE user_id = $1', [userId]);
    await query('DELETE FROM health_insights WHERE user_id = $1', [userId]).catch(() => {});
    await query('DELETE FROM chat_messages WHERE user_id = $1', [userId]).catch(() => {});
    await query('DELETE FROM wearable_connections WHERE user_id = $1', [userId]).catch(() => {});
    await query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account — please try again' });
  }
});

module.exports = router;
