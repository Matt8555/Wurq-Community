# Wurq Community Demo

A phone-sized demo app for the Wurq community, served by a small Express server.
It includes **real, database-backed user profiles** (not faked) persisted to
Postgres.

- Static frontend in `public/` (dark / chalk / acid-green, phone-sized layout).
- Express API in `server.js` for users, profiles, and avatar uploads.
- Postgres schema created automatically on startup (`db.js`).

## Data model

`user_id` (UUID) is the real, immutable key; `email` is the human match key.
Tables: `users`, `profiles`, `identities`, `boxes`, `box_memberships`,
`workouts`, `results`, `badges`, `user_badges`, `feed_events`. The `identities`
table lets you link other identity sources later (Shopify, Circle, watch, …)
**without restructuring** — each source just adds a row keyed by `user_id`.

**Boxes are the canonical gym entity.** `profiles.gym_name` is kept as a display
field, but on startup any `gym_name` without a matching box gets a `boxes` row +
`box_memberships` row created automatically, and saving a profile keeps the box
in sync. A "Fran" workout is seeded for the current day on startup (and lazily
by `GET /api/wod/today`).

Badges are seeded (`first_log`, `sub_4_fran`, `century`) with their rules in the
`badges.criteria` JSONB column and evaluated after every result.

## Holistic Score

Scores are computed **server-side only** (`holisticScore.js`) — the single
source of truth. The browser submits raw inputs (time, ROM %, unbroken sets)
and the server returns/persists the score (0–100). Time sets the ceiling; ROM
and pacing are quality multipliers. Weights and the reference time live in that
one file so they are easy to tune.

## API

| Method | Route | Purpose |
| ------ | ----- | ------- |
| POST | `/api/users` | Create or match a user by `email`; returns `user_id`. |
| GET | `/api/profile/:userId` | Fetch a profile. |
| PUT | `/api/profile/:userId` | Create/update profile fields. |
| POST | `/api/profile/:userId/avatar` | Upload an avatar image (`avatar` field); stored as a base64 data URI in Postgres and returned. |
| GET | `/api/wod/today` | Today's WOD (seeds "Fran" if none exists for today). |
| POST | `/api/results` | Submit raw inputs (`userId`, `workoutId`, `time_seconds`, `rom_pct`, `unbroken_sets`); server computes the Holistic Score, upserts, writes a `result_logged` feed event, evaluates badges. Returns the saved result + any newly earned badges. |
| GET | `/api/leaderboard/box/:boxId/:workoutId` | In-box leaderboard, joined to `display_name` + `avatar_url`, ranked by Holistic Score. |
| GET | `/api/leaderboard/boxes/:workoutId` | Box-vs-box: each box scored by **avg Holistic Score × participation rate**, with the component numbers. |
| GET | `/api/feed/box/:boxId` | Recent feed events for a box's members, newest first. |
| POST | `/api/feed/:eventId/kudos` | Increment the kudos count on a feed event. |

**Profile photos persist in Postgres.** Uploaded avatars are stored as base64
data URIs in `profiles.avatar_url` (capped at 2 MB), not on the local
filesystem. This was chosen over a Railway volume because it needs zero infra
config and survives redeploys (the container disk is ephemeral). A future scale
step can move these to object storage / a CDN.

**Auth is intentionally out of scope for now** — the app runs open/no-login.
Anyone with a `user_id` (cached in the browser) can act as that athlete. Real
login (and using this as the SSO identity provider) is a later roadmap step.

**The Community tab is a demo mock of the Circle.so integration** (see the
comment block in `public/app.js`). It renders a Circle-style space with seeded
posts inside the portal chrome to show "Circle, seamlessly inside WurQ." There
is no real Circle auth/API yet — the live version will embed Circle via an
`<iframe>` to `community.wurq.io` (same TLD) with headless SSO once the Circle
plan is provisioned.

## Local development

Requires a Postgres database. Point `DATABASE_URL` at it; the server runs the
migration on startup.

```bash
npm install
export DATABASE_URL="postgres://user:pass@localhost:5432/wurq_community"
npm start
```

The server binds to `process.env.PORT || 3000`. Open
[http://localhost:3000](http://localhost:3000), enter an email, fill in your
profile, save, and reload — it persists.

## Demo seed data

To make every screen look alive, run the idempotent seed script. It creates 4
boxes, ~30 members (20 with logged Fran results), varied box-vs-box standings,
and a populated feed. Re-running it does **not** duplicate anything.

```bash
DATABASE_URL="postgres://…" npm run seed
```

Then set your profile's gym/box to **CrossFit Pegacorn** (the demo home box) to
drop into the already-populated box. The Community/Circle tab's posts are a
front-end mock and always render, so they aren't part of the seed.

## Branding

The header uses the **WurQ** wordmark (capital W and Q, the Q in acid-green) on
the existing dark / chalk / acid-green athletic palette. Note: wurq.io was not
reachable from the build environment to extract exact logo assets / hex values —
share the brand palette or logo SVG to make the match pixel-perfect.

## Deploy to Railway

Configured for [Railway](https://railway.app) with the Nixpacks builder
(`railway.json`).

1. Create a new Railway project and connect this GitHub repository.
2. Add a **Postgres** service — Railway injects `DATABASE_URL` automatically.
3. Railway builds with Nixpacks and starts the app with `npm start`.

No other environment variables are required for the demo.
