require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

// Run schema on startup
async function initSchema() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        tier VARCHAR(20) DEFAULT 'free',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS food_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        description TEXT,
        calories INTEGER,
        protein NUMERIC,
        carbs NUMERIC,
        fat NUMERIC,
        fiber NUMERIC,
        source VARCHAR(20) DEFAULT 'manual',
        logged_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS health_insights (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        insight_text TEXT,
        insight_type VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(10),
        content TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wearable_connections (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        provider VARCHAR(50),
        access_token TEXT,
        refresh_token TEXT,
        connected_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Schema ready');
  } catch (e) {
    console.error('⚠️ Schema init error:', e.message);
  } finally {
    await pool.end();
  }
}
initSchema();

const app = express();
const PORT = process.env.PORT || 3020;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'rhythmpal' });
});

// Run skills schema migration on startup
const { query: dbQuery } = require('./lib/db');
dbQuery(`
CREATE TABLE IF NOT EXISTS user_skills (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  skill_key VARCHAR(50) NOT NULL,
  enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, skill_key)
);
CREATE TABLE IF NOT EXISTS skill_triggers_fired (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  skill_key VARCHAR(50) NOT NULL,
  trigger_key VARCHAR(100) NOT NULL,
  fired_at TIMESTAMP DEFAULT NOW(),
  fired_date DATE DEFAULT CURRENT_DATE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_triggers_daily 
  ON skill_triggers_fired(user_id, skill_key, trigger_key, fired_date);
CREATE TABLE IF NOT EXISTS proactive_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  skill_key VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  shown BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proactive_unshown 
  ON proactive_messages(user_id, shown) WHERE shown = false;
`).catch(err => console.error('Skills migration error (non-fatal):', err.message));

// Routes
app.use('/api/auth', require('./routes/auth'));
const appleHealthRoutes = require('./routes/apple-health');
app.use('/api/health/apple-health', appleHealthRoutes);
const googleHealthRoutes = require('./routes/google-health');
app.use('/api/health/google', googleHealthRoutes);
app.use('/api/health', require('./routes/health'));
app.use('/api/food', require('./routes/food-photo'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/proactive', require('./routes/proactive'));

// Legal pages
app.get('/tos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tos.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// SPA fallback — all unmatched routes serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`RhythmPal running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});

module.exports = app;
