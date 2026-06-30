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
`box_roles`, `workouts`, `results`, `badges`, `user_badges`, `feed_events`,
`squads`, `squad_members`, `follows`, `referrals`, `challenges`, `competitions`,
`training_partners`, `head_to_heads`, `box_finances`, `commitments`
(plus `profiles.wurq_connected` / `results.source` for the WurQ integration, and
`buddies` + `profiles.welcome_buddy` for the welcome ritual). The `identities`
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
| POST | `/api/results` | Manual log: submit raw inputs (`userId`, `workoutId`, `time_seconds`, `rom_pct`, `unbroken_sets`); server computes the Holistic Score + metrics, then runs the shared `recordResult` path (upsert, `result_logged` feed event, PR + comeback, badges, commitment check). |
| POST | `/api/integrations/wurq/workout` | **WurQ app sync (mock).** Token-gated (`x-wurq-token`). Accepts a WurQ-shaped payload, matches the athlete by email, resolves the workout, and runs the SAME `recordResult` effects as a manual log — with WurQ's auto-captured sensor metrics. All WurQ field mapping is isolated in `wurqAdapter.js`. |
| POST | `/api/integrations/wurq/connect` | Mock OAuth handshake — sets/clears `profiles.wurq_connected` (`userId`, `action`). |
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
| POST | `/api/referrals` · GET `/api/users/:id/referrals` · GET `/api/box/:id/referral-leaderboard` | Create a referral; a user's referrals; per-box top referrers. |
| GET | `/api/global/feed` · `/api/global/comebacks` | Cross-box activity feed; recent comebacks. |
| GET | `/api/global/leaderboard/today/:workoutId` · `/api/global/leaderboard/overall` | WurQ-wide leaderboards (with box). |
| POST | `/api/follows` · GET `/api/users/:id/following` · `/api/users/:id/following-feed` | Follow/unfollow; who you follow; cross-box following feed. |
| GET | `/api/box/:boxId/affiliate` | Owner affiliate tier, referral points, perks. |
| GET | `/api/boxes` | List boxes (id, name, location, member count). |
| GET | `/api/workouts` | List workouts (for the challenge WOD picker). |
| GET | `/api/owner/box/:boxId/dashboard` | Owner dashboard: participation, box-vs-box rank + rival gap, churn-risk members (quiet 10+ days), hot streaks. |
| POST | `/api/challenges` | Create a throwdown (`challengerBoxId`, `opponentBoxId`, `workoutId`, `startsAt`, `endsAt`). |
| GET | `/api/challenges/box/:boxId` | List a box's challenges (as challenger or opponent). |
| GET | `/api/challenges/:id/standing` | Head-to-head: each box's avg score × participation for the challenge WOD, within the window. |
| GET | `/api/box/:boxId/manage-coaches` | Box members with `is_coach` / `is_owner` flags (owner's "Manage coaches" screen). |
| POST | `/api/box/:boxId/coaches` | Owner-gated: promote/demote a member to/from coach (`actingUserId`, `targetUserId`, `action`). |
| POST | `/api/box/:boxId/wod` | Coach-gated: program today's WOD (`name`, `type`, `description`, `scaling`); tags `programmed_by`. |
| GET | `/api/box/:boxId/roster?userId=` | Coach-gated roster: sessions, last logged, week-vs-prev score trend, connection count, quiet & under-connected flags, plus today/total/quiet summary. |
| POST | `/api/box/:boxId/announce` | Coach-gated: post a box announcement (`announcement` feed event everyone sees). |
| GET | `/api/users/:userId/onboarding` | Ensures the user's "[Box] — New Crew" cohort squad, returns box, cohort, coaches to meet, 5 suggested boxmates, and kicks off the welcome ritual (public welcome event + buddy pairing). |
| GET | `/api/users/:userId/welcome` | The new member's welcome experience: welcomes received, coach greeting + pending first-week commitment, buddy pairing, first-week milestone path (live), 30-day milestone, starter-badge state. |
| POST | `/api/feed/:eventId/welcome` | One-tap public welcome (a greeting) on a `member_welcome` event — welcomes pile up. |
| POST | `/api/users/:userId/buddy-optin` | Veteran opts in/out as a welcome buddy (`optIn`). |
| POST | `/api/coach/welcome` | Coach-gated: send a new member a personal welcome note (`coach_welcome` feed event). |
| POST | `/api/coach/checkin` | Coach-gated: record a 30-day check-in (clears the nudge). |
| GET | `/api/box/:boxId/welcome-queue?userId=` | Coach-gated: new members + their integration status (welcomes, buddy, greeting, milestones, connections), early at-risk flags, and 30-day check-ins due. |
| GET | `/api/competitions?userId=&scope=&cadence=` | Active competitions visible to a user (community + their box), each with the user's rank/value, the leader, and time remaining; plus recently completed comps with winners. |
| GET | `/api/competitions/:id/leaderboard?userId=` | A competition's live leaderboard (top 25 + the user's own row), computed from results in the window by the comp's metric. |
| GET | `/api/users/:userId/competitions` | The user's standing in every active comp they're placing in, best rank first (powers "you're #2 in Most Improved this week"). |
| GET | `/api/users/:userId/matches` | Performance-based matches (box-first, then community) across three bases — similar performance, shared struggle, similar journey — each with a reason + relevance. |
| GET | `/api/users/:userId/training-partners` | A user's training partners (with each partner's box + last-trained time). |
| POST | `/api/training-partners` | Create/remove a mutual training-partner link (`aUserId`, `bUserId`, `basis`, `action`); writes a `training_partner` feed event. |
| POST | `/api/highfive` | One-tap high-five (`fromUserId`, `toUserId`); writes a `highfive` feed event. |
| GET | `/api/users/:userId/head-to-heads` | A user's 1-on-1 matchups with live scores (your value vs theirs) and days remaining. |
| POST | `/api/head-to-heads` | Start a head-to-head (`aUserId`, `bUserId`, `metric`, `startsAt`, `endsAt`); writes an `h2h_start` feed event. |
| GET | `/api/owner/box/:boxId/business` | Owner business dashboard: auto-pulled members + new members + churn/retention + referral funnel, combined with the owner's cost/price inputs to compute overhead, revenue, break-even, margin, and CAC. |
| PUT | `/api/owner/box/:boxId/business` | Save the box's cost + price + marketing-spend inputs; returns the recomputed dashboard. |
| POST | `/api/commitments` | Member self-commit (`userId`, `type`, `target`, `goalCount`, `period`); writes a public `commit_made` feed event. |
| POST | `/api/commitments/coach-request` | Coach-gated: ask a member to commit (`coachId`, `userId`, …); creates a `pending` commitment the member responds to. |
| POST | `/api/commitments/:id/respond` | Member accepts (`active` + `commit_made`) or declines a coach request. |
| GET | `/api/users/:userId/commitments` | A member's commitments with live progress, follow-through rate, and pending coach requests. |
| GET | `/api/box/:boxId/commitments?userId=` | Coach-gated: the box's commitments split into active / kept / missed (at-risk) / pending. |
| GET | `/api/box/:boxId/commitment-stats` | Box rally stat — "X members committed this week", kept this week. |

## WurQ app integration (mock, swap-ready)

Demonstrates how workout data flows from the **WurQ iOS app** into this community
platform. WurQ's real API isn't available yet, so this is a realistic **mock** —
but structured so swapping in the real API is a small change, not a rewrite.

- **Ingestion API** — `POST /api/integrations/wurq/workout` accepts a payload in
  the shape the WurQ app would plausibly send (external id/email, workout
  name/type, and the rich auto-captured metrics WurQ produces: time, holistic
  score, ROM, power, work volume, HR avg/peak, calories, per-movement breakdown,
  timestamp). It matches the athlete to a platform user by email, resolves the
  workout, and fires the **exact same downstream effects as a manual log** —
  because both paths call one shared `recordResult` function (leaderboard,
  feed event, PR/badge check, team-goal progress, commitment check).
- **One place to change** — all WurQ-specific field mapping lives in
  **`wurqAdapter.js`**, with a `TODO(wurq-integration)` marking the single spot
  that changes when the real schema arrives. The endpoint is **token-gated**
  (`x-wurq-token`) so it's structured like a real authenticated integration.
- **"Synced from WurQ" experience** — the athlete WOD screen leads with a
  **Connected to WurQ** state; manual logging stays available but secondary. A
  clearly-labeled **"Simulate WurQ sync"** demo control POSTs a realistic
  workout to the ingestion endpoint so you can watch a workout flow in from "the
  app" and land on the leaderboard live (a code comment notes this is the WurQ
  app's job in production). Synced results show their **auto-captured sensor
  metrics** (ROM, power, HR, work volume) distinctly, and carry a `source='wurq'`
  flag — surfaced as a **⌚ WurQ** badge in the feed, profile, and session detail.
- **Connect step** — onboarding and the profile include a **Connect your WurQ
  app** step (mock OAuth-style handshake that persists `wurq_connected`); a code
  comment notes this becomes real WurQ SSO/OAuth once we have access.
- **Seeded** — several athletes (incl. the demo logins) are seeded as
  WurQ-connected with synced-looking recent workouts.

## Owner business tools, recruiting & commitments

Three reinforcing systems aimed at the owner-as-coach (not a financier),
member-driven growth, and accountability:

**Business dashboard** (`box_finances` table, **Owner → Business**) gives
plain-language financial clarity. It auto-pulls what the data knows — current
members, new members this month, churn/retention from activity, the referral
funnel — and asks the owner only for what it can't (rent + the other fixed
costs, average membership price, marketing spend). It then shows, in encouraging
non-jargon: **break-even** ("you need 90 members to cover costs; you have 104 —
14 above break-even"), monthly **revenue / overhead / margin**, **churn vs the
industry benchmark** (~7.6% average, <5% target) with the framing that *keeping*
a member costs 5–25× less than getting one, and **CAC** contrasted with the
near-free referral channel. All visual cards, not a spreadsheet.

**Member-driven recruiting** turns members into the growth engine (reusing the
`referrals` system): any member can **invite a friend** by email/shareable link
(native contact-list access is noted as an app-phase follow-up), invites→joins
award referral points and fire celebratory feed events, and the owner sees a
**recruiting leaderboard** (top recruiters) and the **referral funnel** (invites
sent → pending → joined) right on the Business tab — making the cheapest, best
growth channel legible.

**Commitment mechanics** (`commitments` table) are the accountability engine, in
both flavors. **Self-commit:** a member publicly commits ("I'll be at 5am
tomorrow", "2× this week", "30-day streak") — visible to the box, which drives
follow-through. **Coach-requested:** a coach asks a member to commit (e.g.
2×/week); the member accepts or declines, creating a relationship-driven
commitment the coach tracks. Kept/missed is **auto-detected** from logged
activity (resolved on read and right after a workout is logged): a **kept**
commitment fires a celebratory feed event, a **missed** one becomes an at-risk
signal the coach sees and acts on. There's a member surface (make/see
commitments + follow-through rate, accept coach asks), a coach surface (ask
members, see who's keeping/missing), and a box rally stat. This ties the loop
together — commitments feed retention, recruiting feeds growth, and the business
dashboard makes the owner's numbers legible.

## Recurring competitions & performance-based matchmaking

Two reinforcing systems make the world feel alive and pull people into
connections (the retention anchor from onboarding):

**Recurring competitions** (`competitions` table — `scope` box/community,
`cadence` weekly/monthly, `type`, `[starts_at, ends_at]`, `status`, `winner`).
Leaderboards are **computed live** from results in each comp's window by metric,
so standings are always real and self-updating; only the slate + completed
winners are stored. Five metric types let *different* athletes win different
things — **most_improved** (biggest Holistic gain), **highest_avg**,
**most_workouts**, **movement_specific** (e.g. Pull-up volume), and
**most_consistent** (participation days). The seed lays out a live slate
(several weeklies + a bigger monthly, at both box and community level) plus
completed past comps with real winners. The **Compete → Competitions** screen
leads with *"You're winning something"* — surfacing the user's best placement so
even non-elite athletes see themselves on top of *some* board.

**Performance-based matchmaking** (`training_partners`, `head_to_heads`). The
match engine (`GET /api/users/:id/matches`) pairs a user across three bases —
**similar performance** ("you both ran Fran in 3:14"), **shared struggle** ("you're
both working on Thrusters", from each athlete's weakest movement), and **similar
journey** (both on hot streaks / comebacks / new) — **box-first, then
community** so cross-box ties form. Each match offers a clear arc: **surface →
connect** (high-five, follow, or **become training partners** — a persisted
mutual link; partners see each other's logs and are "notified when the other
trains") **→ compete** (challenge head-to-head next week, a two-athlete
competition scored over a window). The seed lays in training-partner pairs
(within-box + cross-box) and active + completed head-to-heads. New partnerships,
competition wins, and head-to-head results all emit **feed events**, so wins and
connections get celebrated. Training partners also count toward a user's
connection count (the churn-risk signal).

## Coaches & connection-driven onboarding

Coaches are a real, per-box role (`box_roles` table — a user can be both
`owner` and `coach`), gated server-side and surfaced everywhere:

- **Roles & permissions** (`box_roles (user_id, box_id, role)`): owners
  designate/remove coaches from a **Manage coaches** screen on the owner
  dashboard. Coach-only endpoints (program WOD, roster, announce) are gated by
  `rolesFor()` / `hasCoach()`; owner-only coach management is gated separately.
  The seed gives every box 2–3 coaches (the owner is owner+coach).
- **Coach tools** (Profile → "Coach tools" when you're a coach): **program the
  WOD** (edits today's shared workout, shown to athletes as "🧢 Programmed by
  Coach [Name]" with scaling on the log screen); **My athletes** roster with
  recent activity, score trend, connection count, who trained today and who's
  going quiet; tap an athlete for their full (read-only) profile; **message the
  box** (persisted announcement everyone sees in the feed).
- **Coaches as community figures**: a green **Coach** badge on the feed,
  leaderboard, roster and profiles; coach posts and announcements get
  **elevated styling** in the feed.
- **Connection-driven onboarding**: every box has an auto-cohort
  **"[Box] — New Crew"** squad. When a new member finishes their profile, a
  wizard walks them through confirming their box, joining the cohort, following
  3–5 suggested boxmates, and meeting their coaches — so nobody leaves with zero
  connections. Connection count (`squad_members` + `follows`) is queryable as a
  churn-risk signal and shown on the coach roster.

## New-member welcome ritual

A deep first-week welcome that builds ON the cohort/onboarding/coach systems —
the anti-single-connection-fragility mechanic, so every new member forms multiple
ties in week one.

- **Public welcome** — joining fires a `member_welcome` feed event ("Welcome
  [name] to [box]!"); existing members give a one-tap **👋 Welcome** (welcomes
  pile up). The new member's welcome screen leads with *"12 people welcomed you"*
  — a warm first experience.
- **Coach personal greeting** — the coach sends a personal welcome note
  (`coach_welcome`) and asks a first-week commitment ("come twice this week",
  via the existing commitment system); both surface to the member as a note from
  their coach they can accept/decline.
- **Buddy / mentor pairing** (`buddies` table; veterans opt in via
  `profiles.welcome_buddy`) — a new member is paired with an opted-in veteran at
  their box (similar level if possible) for their first month; shown prominently
  with one-tap follow. Both are notified.
- **First-week milestone path** — a live checklist (log first workout, give a
  fist-bump, join your New Crew squad, follow 3, meet your coach, say hi to your
  buddy), computed honestly from existing data. Completing it fires a
  *"Welcome complete!"* moment + a **First Week** starter badge.
- **First-workout celebration** — a new member's first logged workout (via manual
  log OR WurQ sync — both run `recordResult`) gets extra fanfare
  ("Welcome to the board, [name]!") + a **Day One** starter badge.
- **30-day check-in** — at ~30 days the coach is nudged to check in, the member's
  milestone is celebrated publicly (`milestone_30day`), and new members who
  aren't integrating (low connections/activity) are flagged **early at-risk** in
  the coach's welcome queue so they can intervene.

The seed shows it alive: opted-in buddies, recent new members mid-ritual (some
welcomes in, a buddy paired, milestone path partway, a coach greeting + pending
first-week commitment), an isolated **at-risk** newcomer, and a member at their
**30-day** mark with a check-in due.

## Referrals, global community & affiliate status

The platform tells the full story — individual → squad → box → box-vs-box →
whole community — with growth and emotional support woven through:

- **Referrals** (`referrals` table, `profiles.referral_points`): a "Bring a
  friend" screen (in Community → Box) generates an invite; when the friend signs
  up with that email, both earn points, the friend lands in the referrer's box,
  and a `referral_joined` feed event fires. One level only. There's a per-box
  top-referrers board.
- **Global community** (Community → **Global**): a cross-box activity feed,
  global leaderboards (today's WOD + overall, with each athlete's box), and the
  ability to **follow** and send **kudos** to athletes at *other* boxes
  (`follows` table). A "Following" tab shows people you follow across boxes.
- **Comebacks** (`comeback` feed events): returning after a 7+ day gap fires a
  celebratory comeback (shown in a "Comebacks this week" strip and the log
  screen), with a one-tap "Lift up" community encouragement.
- **Owner affiliate status**: the owner dashboard shows a Bronze/Silver/Gold
  **WurQ affiliate** tier (from weekly turnout + referrals), owner referral
  points, progress to the next tier, and perks.

Supporting data (referrals, follows, comebacks) is seeded across the population.

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
  the demo box; **3 completed + 1 active** box throwdown; streaks,
  badge unlocks spread across the month, and a populated per-box feed.
- **~48 recurring competitions** — a live weekly + monthly slate at community
  and per-box level (the five metric types), plus completed past comps with real
  computed winners; **~75 training-partner pairs** (within-box + cross-box) and
  active + completed **head-to-head** matchups, with feed events celebrating new
  partnerships, competition wins, and head-to-head results.
- **Box finances for every box** (the demo box tuned so the break-even story
  lands ~14 above), a **referral funnel** (invites sent / pending / joined per
  box), and **~25 commitments** for the demo box — active, kept and missed,
  self-made and coach-requested (including a pending coach ask the demo login can
  accept), with `commit_made` / `commit_kept` feed celebrations.
- **~8 WurQ-connected athletes** (incl. the demo logins) with recent results
  flagged as **synced from WurQ** (`source='wurq'`) and ⌚-tagged in the feed.
- **Welcome ritual alive**: ~120 opted-in welcome buddies and ~20 buddy
  pairings; recent new members mid-ritual (welcomes piling up, buddy paired,
  partial milestone path, a coach greeting + pending first-week commitment); an
  isolated **at-risk** newcomer; and a member at their **30-day** mark with a
  coach check-in due.

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
