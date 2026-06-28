-- RhythmPal Database Schema

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
  user_id INTEGER REFERENCES users(id),
  description TEXT,
  calories INTEGER,
  protein NUMERIC,
  carbs NUMERIC,
  fat NUMERIC,
  fiber NUMERIC,
  source VARCHAR(20) DEFAULT 'manual',
  logged_at TIMESTAMP DEFAULT NOW()
);

-- Migrations: add new columns if they don't exist yet (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='food_logs' AND column_name='fiber') THEN
    ALTER TABLE food_logs ADD COLUMN fiber NUMERIC;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='food_logs' AND column_name='source') THEN
    ALTER TABLE food_logs ADD COLUMN source VARCHAR(20) DEFAULT 'manual';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS health_insights (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  insight_text TEXT,
  insight_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wearable_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  provider VARCHAR(50) NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  connected_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  sex VARCHAR(10),
  age INTEGER,
  height_cm NUMERIC,
  weight_kg NUMERIC,
  activity_level VARCHAR(20) DEFAULT 'moderate',
  goal VARCHAR(30) DEFAULT 'maintain',
  -- Daily targets (auto-calculated or user-set)
  target_calories INTEGER,
  target_protein INTEGER,
  target_carbs INTEGER,
  target_fat INTEGER,
  target_fiber INTEGER,
  target_water INTEGER DEFAULT 8,
  target_steps INTEGER DEFAULT 10000,
  target_sleep_hours NUMERIC DEFAULT 8,
  target_active_minutes INTEGER DEFAULT 30,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Migration: idempotent
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='user_profiles') THEN
    CREATE TABLE user_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      sex VARCHAR(10),
      age INTEGER,
      height_cm NUMERIC,
      weight_kg NUMERIC,
      activity_level VARCHAR(20) DEFAULT 'moderate',
      goal VARCHAR(30) DEFAULT 'maintain',
      target_calories INTEGER,
      target_protein INTEGER,
      target_carbs INTEGER,
      target_fat INTEGER,
      target_fiber INTEGER,
      target_water INTEGER DEFAULT 8,
      target_steps INTEGER DEFAULT 10000,
      target_sleep_hours NUMERIC DEFAULT 8,
      target_active_minutes INTEGER DEFAULT 30,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  END IF;
END $$;
