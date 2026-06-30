#!/usr/bin/env node
'use strict';
// Run daily to queue proactive messages for all active users
// Wire via OpenClaw cron (not crontab)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query } = require('../lib/db');
const { checkAndQueueTriggers } = require('../lib/proactive');

async function main() {
  console.log('[trigger-cron] Starting proactive trigger sweep...');
  const usersRes = await query(`SELECT id FROM users ORDER BY id`);
  console.log(`[trigger-cron] Checking ${usersRes.rows.length} users`);
  let triggered = 0;
  for (const { id } of usersRes.rows) {
    const results = await checkAndQueueTriggers(id);
    triggered += results.filter(r => r.triggered).length;
  }
  console.log(`[trigger-cron] Done. ${triggered} triggers fired.`);
  process.exit(0);
}

main().catch(err => { console.error('[trigger-cron] Fatal:', err); process.exit(1); });
