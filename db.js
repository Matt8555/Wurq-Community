'use strict';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

// Railway's internal hostname (*.railway.internal) and local Postgres don't need
// SSL; externally-proxied Postgres connections generally do. rejectUnauthorized
// false covers Railway's self-signed proxy certificate.
function sslConfig(url) {
  if (!url) return false;
  if (/localhost|127\.0\.0\.1|::1|\.railway\.internal/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString,
  ssl: sslConfig(connectionString),
});

// ---- Schema -----------------------------------------------------------------
// Designed so additional linked identity sources (Shopify, Circle, watch, ...)
// can be added later WITHOUT restructuring: `email` is the human match key, but
// `user_id` (an immutable UUID) is the real key everything else references.
// boxes are the canonical gym entity; profiles.gym_name is kept as a display
// field and migrated into boxes/box_memberships on startup.
const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS users (
    user_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT UNIQUE NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id          UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    display_name     TEXT,
    gym_name         TEXT,
    avatar_url       TEXT,
    bio              TEXT,
    experience_level TEXT,
    primary_goals    TEXT,
    units            TEXT NOT NULL DEFAULT 'lb',
    profile_complete BOOLEAN NOT NULL DEFAULT false,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS identities (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider         TEXT NOT NULL,            -- 'email','shopify','circle','watch',...
    provider_user_id TEXT,
    email            TEXT,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities(user_id);
  CREATE INDEX IF NOT EXISTS idx_identities_email   ON identities(email);

  -- Boxes (gyms) are the canonical entity.
  CREATE TABLE IF NOT EXISTS boxes (
    box_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT UNIQUE NOT NULL,
    location   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS box_memberships (
    user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    box_id    UUID NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, box_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_box  ON box_memberships(box_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON box_memberships(user_id);

  CREATE TABLE IF NOT EXISTS workouts (
    workout_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    type        TEXT,
    description TEXT,
    wod_date    DATE NOT NULL DEFAULT CURRENT_DATE
  );

  CREATE TABLE IF NOT EXISTS results (
    result_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    workout_id     UUID NOT NULL REFERENCES workouts(workout_id) ON DELETE CASCADE,
    time_seconds   INTEGER,
    rom_pct        NUMERIC(5,2),
    unbroken_sets  INTEGER,
    holistic_score NUMERIC(6,2),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One result per athlete per workout; re-logging updates the existing row.
    UNIQUE (user_id, workout_id)
  );
  CREATE INDEX IF NOT EXISTS idx_results_workout ON results(workout_id);
  CREATE INDEX IF NOT EXISTS idx_results_user    ON results(user_id);

  CREATE TABLE IF NOT EXISTS badges (
    badge_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    criteria    JSONB NOT NULL DEFAULT '{}'::jsonb
  );

  CREATE TABLE IF NOT EXISTS user_badges (
    user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    badge_id  UUID NOT NULL REFERENCES badges(badge_id) ON DELETE CASCADE,
    earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, badge_id)
  );

  CREATE TABLE IF NOT EXISTS feed_events (
    event_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    type       TEXT NOT NULL,                 -- 'result_logged','badge_earned',...
    ref_id     UUID,
    payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
    kudos      INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_feed_user    ON feed_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_feed_created ON feed_events(created_at DESC);

  -- Box-vs-box throwdown challenges.
  CREATE TABLE IF NOT EXISTS challenges (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenger_box_id UUID NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
    opponent_box_id   UUID NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
    workout_id        UUID NOT NULL REFERENCES workouts(workout_id) ON DELETE CASCADE,
    starts_at         TIMESTAMPTZ NOT NULL,
    ends_at           TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_challenges_challenger ON challenges(challenger_box_id);
  CREATE INDEX IF NOT EXISTS idx_challenges_opponent   ON challenges(opponent_box_id);
`;

// Idempotent fixups for databases created by earlier versions of this app:
// rename the old `id` PKs to the canonical names, and ensure feed kudos exists.
const FIXUP_SQL = `
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workouts' AND column_name='id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workouts' AND column_name='workout_id') THEN
      ALTER TABLE workouts RENAME COLUMN id TO workout_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='results' AND column_name='id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='results' AND column_name='result_id') THEN
      ALTER TABLE results RENAME COLUMN id TO result_id;
    END IF;
  END $$;

  ALTER TABLE feed_events ADD COLUMN IF NOT EXISTS kudos INTEGER NOT NULL DEFAULT 0;
`;

// Ensure there is a "Fran" workout for today (idempotent).
const SEED_WOD_SQL = `
  INSERT INTO workouts (name, type, description, wod_date)
  SELECT 'Fran', 'For Time',
         '21-15-9 reps for time: Thrusters (95/65 lb) and Pull-ups.',
         CURRENT_DATE
  WHERE NOT EXISTS (
    SELECT 1 FROM workouts WHERE name = 'Fran' AND wod_date = CURRENT_DATE
  );
`;

// Starter badge set (idempotent on code).
const SEED_BADGES_SQL = `
  INSERT INTO badges (code, name, description, criteria) VALUES
    ('first_log',  'First Log',   'Logged your first workout result.',
       '{"type":"first_result"}'),
    ('sub_4_fran', 'Sub-4 Fran',  'Completed Fran in under 4 minutes.',
       '{"type":"time_under","workout_name":"Fran","seconds":240}'),
    ('century',    'Century',     'Logged your 100th result.',
       '{"type":"nth_result","n":100}')
  ON CONFLICT (code) DO NOTHING;
`;

// Migrate existing free-text gym_name values into real boxes + memberships.
const MIGRATE_GYMS_SQL = `
  INSERT INTO boxes (name)
  SELECT DISTINCT TRIM(gym_name) FROM profiles
   WHERE gym_name IS NOT NULL AND TRIM(gym_name) <> ''
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO box_memberships (user_id, box_id)
  SELECT p.user_id, b.box_id
    FROM profiles p
    JOIN boxes b ON b.name = TRIM(p.gym_name)
   WHERE p.gym_name IS NOT NULL AND TRIM(p.gym_name) <> ''
  ON CONFLICT (user_id, box_id) DO NOTHING;
`;

async function migrate() {
  if (!connectionString) {
    console.warn(
      '[db] DATABASE_URL is not set. Add a Postgres service (Railway provides ' +
      'DATABASE_URL automatically) or export it locally before starting.'
    );
  }
  await pool.query(SCHEMA_SQL);
  await pool.query(FIXUP_SQL);
  await pool.query(SEED_WOD_SQL);
  await pool.query(SEED_BADGES_SQL);
  await pool.query(MIGRATE_GYMS_SQL);
  console.log('[db] migration complete (users, profiles, identities, boxes, memberships, ' +
    'workouts, results, badges, user_badges, feed_events ready; Fran + badges seeded; gyms migrated)');
}

module.exports = { pool, migrate };
