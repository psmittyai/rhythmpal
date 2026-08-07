#!/usr/bin/env node
'use strict';

/**
 * Oura Daily Sync — batch cron script
 *
 * Runs as: node scripts/oura-daily-sync.js
 * Cron: 6 AM daily via OpenClaw cron job
 *
 * SECURITY RULES:
 * - Never log access tokens, refresh tokens, or credentials
 * - Errors per user are logged but do NOT stop other users
 * - Exit 0 always (scheduler should not back off on partial user failures)
 */

require('dotenv').config();

const { query } = require('../lib/db');
const { syncOuraData } = require('../lib/oura-sync');

async function main() {
  console.log(`[oura-daily-sync] Starting at ${new Date().toISOString()}`);

  let connections;
  try {
    const result = await query(
      `SELECT user_id
       FROM wearable_connections
       WHERE provider = 'oura' AND status = 'active'
       ORDER BY user_id`,
      []
    );
    connections = result.rows;
  } catch (err) {
    console.error('[oura-daily-sync] Failed to load connections:', err.message);
    process.exit(0);
  }

  console.log(`[oura-daily-sync] Found ${connections.length} active Oura connection(s)`);

  let successCount = 0;
  let errorCount = 0;

  for (const { user_id } of connections) {
    try {
      const result = await syncOuraData(user_id, { historical: false });
      console.log(
        `[oura-daily-sync] Synced user ${user_id}: ${result.sessions_imported} sessions, ${result.measurements_imported} measurements`
      );
      successCount++;
    } catch (err) {
      // Log error per user, continue with the rest
      console.error(`[oura-daily-sync] Error syncing user ${user_id}: ${err.message}`);
      errorCount++;
    }
  }

  console.log(
    `[oura-daily-sync] Done at ${new Date().toISOString()} — ${successCount} succeeded, ${errorCount} failed`
  );

  // Always exit 0 — partial failures are expected and logged above
  process.exit(0);
}

main().catch(err => {
  console.error('[oura-daily-sync] Fatal error:', err.message);
  process.exit(0); // Still exit 0 to prevent cron backoff
});
