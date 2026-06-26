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
    referral_points  INTEGER NOT NULL DEFAULT 0,
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
    workout_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    type          TEXT,
    description   TEXT,
    scaling       TEXT,
    programmed_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    wod_date      DATE NOT NULL DEFAULT CURRENT_DATE
  );

  CREATE TABLE IF NOT EXISTS results (
    result_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    workout_id     UUID NOT NULL REFERENCES workouts(workout_id) ON DELETE CASCADE,
    time_seconds   INTEGER,
    rom_pct        NUMERIC(5,2),
    unbroken_sets  INTEGER,
    holistic_score NUMERIC(6,2),
    -- Extra session metrics WurQ tracks (backfilled for seeded results).
    avg_hr         INTEGER,
    peak_hr        INTEGER,
    calories       INTEGER,
    power_output   NUMERIC(7,1),
    work_volume    NUMERIC(9,1),
    movements      JSONB NOT NULL DEFAULT '[]'::jsonb,
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

  -- Engagement layer: squads (small groups in a box) + collective team goals.
  CREATE TABLE IF NOT EXISTS squads (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    box_id     UUID NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_squads_box ON squads(box_id);

  CREATE TABLE IF NOT EXISTS squad_members (
    squad_id  UUID NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (squad_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_squad_members_squad ON squad_members(squad_id);
  CREATE INDEX IF NOT EXISTS idx_squad_members_user  ON squad_members(user_id);

  CREATE TABLE IF NOT EXISTS team_goals (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    box_id    UUID NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
    type      TEXT NOT NULL,                 -- total_workouts | total_holistic_points | participation_days
    target    NUMERIC NOT NULL,
    current   NUMERIC NOT NULL DEFAULT 0,    -- seed snapshot; live value is computed
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at   TIMESTAMPTZ NOT NULL,
    status    TEXT NOT NULL DEFAULT 'active'
  );
  CREATE INDEX IF NOT EXISTS idx_team_goals_box ON team_goals(box_id);

  -- Referrals: one level only (referrer + referred), community-framed growth.
  CREATE TABLE IF NOT EXISTS referrals (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    referred_email   TEXT NOT NULL,
    referred_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    status           TEXT NOT NULL DEFAULT 'pending',   -- pending | joined
    box_id           UUID REFERENCES boxes(box_id) ON DELETE SET NULL,
    points_awarded   INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_box      ON referrals(box_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_email    ON referrals(lower(referred_email));

  -- Cross-box follows ("belonging with no walls").
  CREATE TABLE IF NOT EXISTS follows (
    follower_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    followee_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (follower_user_id, followee_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_user_id);
  CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_user_id);

  -- Per-box roles. A user can hold more than one role in a box (owner AND coach).
  CREATE TABLE IF NOT EXISTS box_roles (
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    box_id     UUID NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
    role       TEXT NOT NULL,                 -- member | coach | owner
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, box_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_box_roles_box  ON box_roles(box_id);
  CREATE INDEX IF NOT EXISTS idx_box_roles_user ON box_roles(user_id);
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

  ALTER TABLE results ADD COLUMN IF NOT EXISTS avg_hr       INTEGER;
  ALTER TABLE results ADD COLUMN IF NOT EXISTS peak_hr      INTEGER;
  ALTER TABLE results ADD COLUMN IF NOT EXISTS calories     INTEGER;
  ALTER TABLE results ADD COLUMN IF NOT EXISTS power_output NUMERIC(7,1);
  ALTER TABLE results ADD COLUMN IF NOT EXISTS work_volume  NUMERIC(9,1);
  ALTER TABLE results ADD COLUMN IF NOT EXISTS movements    JSONB NOT NULL DEFAULT '[]'::jsonb;

  ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_points INTEGER NOT NULL DEFAULT 0;

  ALTER TABLE workouts ADD COLUMN IF NOT EXISTS scaling       TEXT;
  ALTER TABLE workouts ADD COLUMN IF NOT EXISTS programmed_by UUID REFERENCES users(user_id) ON DELETE SET NULL;
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
  // NOTE: box memberships are managed by the seed and by PUT /api/profile (which
  // syncs a user's box when they set their gym). We intentionally do NOT re-run a
  // boot-time gym_name->membership migration here, as it would resurrect stale
  // memberships the seed cleared. MIGRATE_GYMS_SQL is retained for one-off use.
  console.log('[db] migration complete (schema ready; Fran + badges seeded)');
}

module.exports = { pool, migrate };
