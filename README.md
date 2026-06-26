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
| POST | `/api/profile/:userId/avatar` | Upload an avatar image (`avatar` field); returns its URL. |
| GET | `/api/wod/today` | Today's WOD (seeds "Fran" if none exists for today). |
| POST | `/api/results` | Submit raw inputs (`userId`, `workoutId`, `time_seconds`, `rom_pct`, `unbroken_sets`); server computes the Holistic Score, upserts, writes a `result_logged` feed event, evaluates badges. Returns the saved result + any newly earned badges. |
| GET | `/api/leaderboard/box/:boxId/:workoutId` | In-box leaderboard, joined to `display_name` + `avatar_url`, ranked by Holistic Score. |
| GET | `/api/leaderboard/boxes/:workoutId` | Box-vs-box: each box scored by **avg Holistic Score × participation rate**, with the component numbers. |
| GET | `/api/feed/box/:boxId` | Recent feed events for a box's members, newest first. |
| POST | `/api/feed/:eventId/kudos` | Increment the kudos count on a feed event. |

Avatars are saved to a local `uploads/` folder and served statically.
**⚠️ Profile photo storage still needs a persistent volume (separate task):**
on Railway the container filesystem is ephemeral, so uploaded avatars won't
survive a redeploy until storage is moved to a mounted Railway volume or object
storage (S3).

**Auth is intentionally out of scope for now** — the app runs open/no-login.
Anyone with a `user_id` (cached in the browser) can act as that athlete. Real
login (and using this as the SSO identity provider) is a later roadmap step.

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

## Deploy to Railway

Configured for [Railway](https://railway.app) with the Nixpacks builder
(`railway.json`).

1. Create a new Railway project and connect this GitHub repository.
2. Add a **Postgres** service — Railway injects `DATABASE_URL` automatically.
3. Railway builds with Nixpacks and starts the app with `npm start`.

No other environment variables are required for the demo.
