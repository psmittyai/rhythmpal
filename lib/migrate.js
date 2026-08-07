'use strict';

/**
 * Migration runner — reads numbered UP/DOWN SQL files from migrations/
 * Tracks applied migrations in schema_migrations table.
 *
 * Naming convention:
 *   UP:   NNN_name.sql
 *   DOWN: NNN_name_rollback.sql
 */

const fs = require('fs');
const path = require('path');
const { query, pool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// Ensure schema_migrations tracking table exists
async function ensureTrackingTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Return list of already-applied migration filenames
async function getApplied() {
  const result = await query('SELECT filename FROM schema_migrations ORDER BY filename ASC');
  return new Set(result.rows.map(r => r.filename));
}

// Return sorted list of UP migration files (NNN_name.sql, excluding _rollback.sql)
function getUpMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql') && !f.includes('_rollback'))
    .sort(); // lexicographic sort — NNN prefix keeps them ordered
  return files;
}

// Apply a single UP migration file
async function applyMigration(filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filePath, 'utf8');
  // Run in a transaction so partial failure is rolled back
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [filename]
    );
    await client.query('COMMIT');
    console.log(`✅ Migration applied: ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Migration failed [${filename}]: ${err.message}`);
  } finally {
    client.release();
  }
}

// Roll back the most recently applied migration
async function rollbackLast() {
  await ensureTrackingTable();
  const result = await query(
    'SELECT filename FROM schema_migrations ORDER BY applied_at DESC, filename DESC LIMIT 1'
  );
  if (!result.rows.length) {
    console.log('No migrations to roll back.');
    return null;
  }
  const { filename } = result.rows[0];
  // Derive rollback filename: NNN_name.sql → NNN_name_rollback.sql
  const rollbackFilename = filename.replace(/\.sql$/, '_rollback.sql');
  const rollbackPath = path.join(MIGRATIONS_DIR, rollbackFilename);

  if (!fs.existsSync(rollbackPath)) {
    throw new Error(`Rollback file not found: ${rollbackFilename}`);
  }

  const sql = fs.readFileSync(rollbackPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE filename = $1', [filename]);
    await client.query('COMMIT');
    console.log(`⏪ Rolled back: ${filename}`);
    return filename;
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Rollback failed [${rollbackFilename}]: ${err.message}`);
  } finally {
    client.release();
  }
}

// Apply all pending UP migrations in order
async function runMigrations() {
  try {
    await ensureTrackingTable();
    const applied = await getApplied();
    const upFiles = getUpMigrationFiles();
    const pending = upFiles.filter(f => !applied.has(f));

    if (pending.length === 0) {
      console.log('✅ All migrations up to date.');
      return;
    }

    console.log(`🔄 Running ${pending.length} pending migration(s)...`);
    for (const filename of pending) {
      await applyMigration(filename);
    }
    console.log('✅ Migrations complete.');
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    throw err;
  }
}

module.exports = { runMigrations, rollbackLast, ensureTrackingTable };
