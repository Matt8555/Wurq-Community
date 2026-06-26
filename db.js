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

// Schema is designed so additional linked identity sources (Shopify, Circle,
// watch, ...) can be added later WITHOUT restructuring: `email` is the human
// match key, but `user_id` (an immutable UUID) is the real key everything else
// references. New providers just add rows to the `identities` table.
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

  -- Linked identity sources. user_id is the real key; (provider, provider_user_id)
  -- is unique so the same external account can't be linked twice. email is stored
  -- per-identity as the cross-source match key.
  CREATE TABLE IF NOT EXISTS identities (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    provider         TEXT NOT NULL,            -- 'email','shopify','circle','watch',...
    provider_user_id TEXT,                     -- id within that provider
    email            TEXT,                     -- email known to that provider
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_identities_user_id ON identities(user_id);
  CREATE INDEX IF NOT EXISTS idx_identities_email   ON identities(email);
`;

async function migrate() {
  if (!connectionString) {
    console.warn(
      '[db] DATABASE_URL is not set. Add a Postgres service (Railway provides ' +
      'DATABASE_URL automatically) or export it locally before starting.'
    );
  }
  await pool.query(SCHEMA_SQL);
  console.log('[db] migration complete (users, profiles, identities ready)');
}

module.exports = { pool, migrate };
