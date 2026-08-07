-- Migration 006: oura_sync_support
-- Adds sync_cursor (if missing from Sprint 1) and a compound index
-- for fast provider+status lookups by cron batch jobs.

-- sync_cursor may already exist from migration 001 — ADD COLUMN IF NOT EXISTS is safe
ALTER TABLE wearable_connections ADD COLUMN IF NOT EXISTS sync_cursor TEXT;

-- Compound index for cron jobs that scan by provider + status
CREATE INDEX IF NOT EXISTS idx_wc_provider_status ON wearable_connections(provider, status);
