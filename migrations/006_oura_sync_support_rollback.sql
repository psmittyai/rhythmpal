-- Migration 006 ROLLBACK: oura_sync_support
-- Removes compound provider+status index.
-- Does NOT drop sync_cursor column — it was potentially added in Sprint 1.

DROP INDEX IF EXISTS idx_wc_provider_status;
