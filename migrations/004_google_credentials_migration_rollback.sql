-- Rollback 004: google_credentials_migration
-- Remove migrated Google rows — safe because legacy columns still exist in user_profiles

DELETE FROM wearable_connections WHERE provider = 'google_fit';
