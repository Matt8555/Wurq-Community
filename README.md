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
`workouts`, `results`, `badges`, `user_badges`, `feed_events`, `challenges`. The `identities`
table lets you link other identity sources later (Shopify, Circle, watch, …)
**without restructuring** — each source just adds a row keyed by `user_id`.

**Boxes are the canonical gym entity.** `profiles.gym_name` is kept as a display
field, but on startup any `gym_name` without a matching box gets a `boxes` row +
`box_memberships` row created automatically, and saving a profile keeps the box
in sync. A "Fran" workout is seeded for the current day on startup (and lazily
by `GET /api/wod/today`).

Badges are seeded (`first_log`, `sub_4_fran`, `century`) with their rules in the
`badges.criteria` JSONB column and evaluated after every result.

Each `results` row also carries the session metrics WurQ tracks — `avg_hr`,
`peak_hr`, `calories`, `power_output`, `work_volume`, and a per-movement
breakdown (`movements` JSONB: name, reps, ROM %, category). These are computed
by `metrics.js` (shared by the seed backfill and the live log endpoint).

## Athlete profile

The **Profile** tab is a full training history with stickiness hooks, all from
real queries over the seeded month:

- **Training history** — reverse-chron session list; tap a session for the full
  WurQ-style log (score + breakdown, time, avg/peak HR, calories, power, volume,
  per-movement reps + ROM).
- **Personal Records** — best Holistic Score, fastest benchmarks, top power,
  longest streak. Logging a result that beats a PR fires a **celebration** and a
  `pr` feed event ("you beat your Fran time by 17s!").
- **Progress** — Holistic Score trend chart, workload by muscle group, and a
  "this week vs last" getting-fitter stat.
- **Streak & consistency** — current streak + a month calendar heatmap (intensity
  by score), with a loss-aversion nudge to train today.
- **Comparison** — real percentiles vs your box and your experience level
  ("top 1% in your box", "your Fran beats 97% of RX athletes").
- **Benchmark tracking** — per repeated benchmark (Fran, Helen, …), the history
  over time with a sparkline.

Two demo logins are backfilled with a full personal month in CrossFit Borderland
so you can compare athletes side by side:

- **matt@pegacorngroup.com** — *Matt P*, an average intermediate athlete (mid-pack
  scores, ~top 55% in box).
- **alex@pegacorngroup.com** — *Alex Rivera*, a strong RX athlete (top-of-box,
  beats ~95% of peers).

Log in as either (Profile → "Not you? Start over"). These accounts are refreshed
on every deploy without rebuilding the world. Override the emails with the
`DEMO_EMAILS` env var (comma-separated, by position) or `DEMO_EMAIL` (first only).

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
| GET | `/api/athlete/:userId/history` | Reverse-chron session list. |
| GET | `/api/athlete/:userId/session/:resultId` | Full session detail + score breakdown + movements. |
| GET | `/api/athlete/:userId/profile` | Profile bundle: summary, PRs, trend, heatmap, workload, comparison percentiles, benchmark histories. |
| GET | `/api/box/:boxId/team-goal` | Active collective goal with live progress, contributors, top contributors. |
| GET | `/api/box/:boxId/squads?userId=` | Squads in a box (member counts + whether the user is in each). |
| GET | `/api/users/:userId/squads` | Squads a user belongs to. |
| POST | `/api/squads` · `/api/squads/:id/join` · `/api/squads/:id/leave` | Create / join / leave a squad. |
| GET | `/api/squads/:id/leaderboard/:workoutId` · `/api/squads/:id/feed` · `/api/squads/:id/quiet` | Squad mini-leaderboard, feed, and quiet members. |
| POST | `/api/shoutout` | Post a shout-out crediting a teammate (writes a `shoutout` feed event). |
| GET | `/api/box/:boxId/newcomers` · `/api/box/:boxId/members` | New-this-week members; box member list. |
| GET | `/api/boxes` | List boxes (id, name, location, member count). |
| GET | `/api/workouts` | List workouts (for the challenge WOD picker). |
| GET | `/api/owner/box/:boxId/dashboard` | Owner dashboard: participation, box-vs-box rank + rival gap, churn-risk members (quiet 10+ days), hot streaks. |
| POST | `/api/challenges` | Create a throwdown (`challengerBoxId`, `opponentBoxId`, `workoutId`, `startsAt`, `endsAt`). |
| GET | `/api/challenges/box/:boxId` | List a box's challenges (as challenger or opponent). |
| GET | `/api/challenges/:id/standing` | Head-to-head: each box's avg score × participation for the challenge WOD, within the window. |

## Community & engagement

The **Community** tab has two sub-tabs: **Community** (the engagement hub) and
**Circle** (the embedded Circle.so mock). The hub is group-identity focused:

- **Team goal** (centerpiece) — a collective box goal (e.g. "1700 / 1710
  workouts") with a live progress bar, days remaining, contributor count, and
  top contributors. Every logged workout ticks it up (shown on the log screen
  and the owner dashboard).
- **Squads** — small groups inside a box (e.g. "5am Crew", "Masters Athletes").
  Join/leave, and open a squad for its own mini-leaderboard + mini-feed.
- **Peer nudges** — on quiet squad-mates, a "Send a push" (encouraging, mocked).
- **Shout-outs** — public gratitude crediting a teammate; stored as a `shoutout`
  feed event and shown prominently in the feed.
- **Welcome** — "new this week" members with a one-tap welcome (mocked).

Engagement data is seeded from the existing population (squads per box, an active
team goal per box, shout-outs, and a couple of new members) so no surface is
empty.

## Owner view

A header toggle switches between **Athlete view** (unchanged) and **Owner
view** (persisted in `localStorage`). The owner view has its own bottom nav and
screens: a **Dashboard** (today/this-week participation as the hero, box-vs-box
rank with the rival gap, a prominent "members going quiet" churn list, and hot
streaks), a **Compete** screen (live box-vs-box with an actionable "log N more
to pass X" prompt), **Throwdown** (create a challenge and watch live head-to-head
scoring), and **Engage** (post-WOD / rally — mocked sends). For the demo the
owner owns **CrossFit Borderland** (resolved by name from `/api/boxes`).

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

**The app auto-seeds an empty database on startup.** On boot, if there are no
boxes yet, it builds the full demo world automatically — so a fresh Railway
deploy populates itself with no manual step. It will **not** reseed once data
exists (so live activity is preserved across restarts).

- `SEED_ON_BOOT=force` — rebuild the world on the next boot (resets demo data).
- `SEED_ON_BOOT=never` — disable auto-seeding.

You can also seed manually:

```bash
DATABASE_URL="postgres://…" npm run seed
```

What it generates (a 4-week window ending today, framed as June 2026):

- **10 boxes** with distinct personalities so the standings tell a story: 2
  powerhouses (high avg + turnout), 2 up-and-comers (improving over the month),
  1 large gym with low participation, and 5 mid-pack — including the demo box.
- **~1,000 athletes** (~100 per box) with names, experience levels (mostly
  intermediate/RX), and a home box.
- **~16,500 logged results** across ~28 daily WODs (Fran, Cindy, Helen, Grace,
  etc.). Participation varies per athlete (near-daily / regular / sporadic /
  lapsed), each athlete has a consistent ability with day-to-day variance and
  slight monthly improvement, and every Holistic Score is computed by the
  server-side scoring module. This realistic spread powers the churn and streak
  features.
- **Box-vs-box standings** that rank by personality, with a tight rivalry around
  the demo box; **3 completed + 1 active** head-to-head challenge; streaks,
  badge unlocks spread across the month, and a populated per-box feed.

**Performance & idempotency:** results load via batched multi-row INSERTs (not
one at a time); the whole run takes ~1–2s. The script **rebuilds the world
deterministically** each run (it resets the world tables, then regenerates from
a fixed PRNG seed), so counts are stable and there are no leftovers. Any
live-created demo data is reset on re-seed.

The demo box **CrossFit Borderland** is both the athlete home box and the owner
box: set your athlete gym to it, or switch to **Owner view** with the header
toggle. The Community/Circle tab's posts are a front-end mock and always render,
so they aren't part of the seed.

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
