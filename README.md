# Wurq Community Demo

A phone-sized demo app for the Wurq community, served by a small Express server.
It includes **real, database-backed user profiles** (not faked) persisted to
Postgres.

- Static frontend in `public/` (dark / chalk / acid-green, phone-sized layout).
- Express API in `server.js` for users, profiles, and avatar uploads.
- Postgres schema created automatically on startup (`db.js`).

## Data model

`user_id` (UUID) is the real, immutable key; `email` is the human match key.
Tables: `users`, `profiles`, `identities`, `workouts`, and `results`. The
`identities` table lets you link other identity sources later (Shopify, Circle,
watch, …) **without restructuring** — each source just adds a row keyed by
`user_id`. A "Fran" workout is seeded for the current day on startup.

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
| GET | `/api/workouts/today` | Today's WOD (falls back to most recent). |
| GET | `/api/workouts` | List all workouts. |
| POST | `/api/results` | Submit a result; server computes the Holistic Score and upserts (one row per athlete per workout). |
| GET | `/api/leaderboard/:workoutId` | Results joined to `display_name` + `gym_name`, ranked by Holistic Score. |

Avatars are saved to a local `uploads/` folder and served statically. **For
production, move avatar storage to object storage (S3) or a mounted Railway
volume** — the container filesystem is ephemeral and uploads won't survive a
redeploy.

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
