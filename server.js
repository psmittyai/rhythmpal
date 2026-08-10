require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

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
app.use('/api/wearables/oura', require('./routes/wearables/oura'));

// Legal pages
app.get('/tos', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tos.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// SEO/AEO static files — serve before SPA fallback
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});
app.get('/llms.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'llms.txt'));
});
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});
app.get('/agents', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agents.html'));
});

// SPA fallback — all unmatched routes serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Run migrations then skills/proactive schema, then start the server
const { runMigrations } = require('./lib/migrate');
const { query: dbQuery } = require('./lib/db');

runMigrations()
  .then(() => {
    // Skills and proactive tables — run after migrations complete
    return dbQuery(`
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
    `);
  })
  .then(() => {
    console.log('✅ Schema ready');
  })
  .catch(err => {
    console.error('⚠️ Startup schema error (non-fatal):', err.message);
  });

// Start server
app.listen(PORT, () => {
  console.log(`RhythmPal running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});

module.exports = app;
