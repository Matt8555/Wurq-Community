'use strict';

// ============================================================================
// Demo seed — populates a realistic, "alive" world so the demo user drops into
// a populated portal. Safe to re-run: it is IDEMPOTENT (deterministic emails +
// ON CONFLICT upserts; seeded feed events are tagged and replaced, never
// duplicated). Real user-generated data is left untouched.
//
//   npm run seed        (or: node seed.js)
//
// The Community/Circle tab's posts are a front-end mock (see public/app.js), so
// they are not seeded here — they always render.
// ============================================================================

const { pool, migrate } = require('./db');
const { computeHolisticScore } = require('./holisticScore');

const HOME_BOX = 'CrossFit Pegacorn'; // the box the demo user should join

const BOXES = [
  { name: 'CrossFit Pegacorn',              location: 'Norfolk, VA' },
  { name: 'Iron Forge CrossFit',            location: 'Richmond, VA' },
  { name: 'Summit Strength & Conditioning', location: 'Denver, CO' },
  { name: 'Tidewater CrossFit',             location: 'Virginia Beach, VA' },
];

// Per box: athletes who LOGGED today's Fran (time s / ROM % / unbroken sets),
// plus a count of extra members who are signed up but didn't log — so turnout
// (participation) varies and box-vs-box looks genuine.
const ROSTER = {
  'CrossFit Pegacorn': {
    loggers: [
      { name: 'Coach Riley',     exp: 'competitor',   t: 174, rom: 100, sets: 6 },
      { name: 'Marcus Lee',      exp: 'competitor',   t: 165, rom: 95,  sets: 7 },
      { name: 'Ava Thompson',    exp: 'RX',           t: 188, rom: 98,  sets: 5 },
      { name: 'Jordan Diaz',     exp: 'RX',           t: 205, rom: 100, sets: 6 },
      { name: 'Priya Nair',      exp: 'intermediate', t: 242, rom: 92,  sets: 9 },
      { name: 'Chloe Bennett',   exp: 'intermediate', t: 271, rom: 88,  sets: 11 },
    ],
    extra: 2,
  },
  'Iron Forge CrossFit': {
    loggers: [
      { name: 'Tyrone Walker',   exp: 'competitor',   t: 158, rom: 96,  sets: 6 },
      { name: 'Elena Petrova',   exp: 'RX',           t: 197, rom: 99,  sets: 5 },
      { name: 'Diego Morales',   exp: 'RX',           t: 219, rom: 94,  sets: 8 },
      { name: 'Hannah Schmidt',  exp: 'intermediate', t: 258, rom: 90,  sets: 10 },
      { name: 'Wei Chen',        exp: 'beginner',     t: 322, rom: 82,  sets: 12 },
    ],
    extra: 4,
  },
  'Summit Strength & Conditioning': {
    loggers: [
      { name: 'Brooke Sullivan', exp: 'RX',           t: 192, rom: 97,  sets: 6 },
      { name: 'Andre Johnson',   exp: 'competitor',   t: 171, rom: 93,  sets: 7 },
      { name: 'Mei Tanaka',      exp: 'intermediate', t: 248, rom: 91,  sets: 9 },
      { name: 'Liam O\'Connor',  exp: 'intermediate', t: 264, rom: 89,  sets: 10 },
      { name: 'Fatima Hassan',   exp: 'beginner',     t: 305, rom: 84,  sets: 11 },
    ],
    extra: 1,
  },
  'Tidewater CrossFit': {
    loggers: [
      { name: 'Noah Williams',   exp: 'RX',           t: 184, rom: 96,  sets: 6 },
      { name: 'Sofia Rossi',     exp: 'RX',           t: 211, rom: 98,  sets: 5 },
      { name: 'Jamal Carter',    exp: 'intermediate', t: 255, rom: 90,  sets: 9 },
      { name: 'Grace Kim',       exp: 'beginner',     t: 298, rom: 85,  sets: 12 },
    ],
    extra: 3,
  },
};

// ---- Owner-side demo world --------------------------------------------------
const OWNER_BOX = 'CrossFit Borderland'; // the box the demo owner owns

// Borderland members. `today` = logged today's Fran (counts for participation +
// box-vs-box). `hist` = additional days-ago they logged (drives streaks, this-
// week participation, and churn recency). Some never log (churn risk).
const BORDERLAND = [
  { name: 'Mateo Salas',   exp: 'competitor',   today: { t: 158, rom: 96,  sets: 6 },  hist: [1, 2, 3, 5] },
  { name: 'Rosa Mendez',   exp: 'RX',           today: { t: 165, rom: 98,  sets: 7 },  hist: [1, 2, 3] },
  { name: 'Tomas Guerra',  exp: 'RX',           today: { t: 188, rom: 95,  sets: 6 },  hist: [1, 2] },
  { name: 'Hector Vega',   exp: 'intermediate', today: { t: 241, rom: 90,  sets: 9 },  hist: [1, 4] },
  { name: 'Bianca Ruiz',   exp: 'RX',           today: { t: 205, rom: 100, sets: 6 },  hist: [2] },
  { name: 'Lucia Flores',  exp: 'intermediate', today: { t: 271, rom: 88,  sets: 11 }, hist: [3] },
  { name: 'Andres Pena',   exp: 'beginner',     today: { t: 310, rom: 82,  sets: 12 }, hist: [] },
  { name: 'Sofia Lara',    exp: 'intermediate', today: null,                            hist: [2] },
  { name: 'Javier Castro', exp: 'beginner',     today: null,                            hist: [3] },
  { name: 'Marisol Tovar', exp: 'intermediate', today: null,                            hist: [12] },
  { name: 'Diego Navarro', exp: 'RX',           today: null,                            hist: [15] },
  { name: 'Pablo Reyes',   exp: 'beginner',     today: null,                            hist: [18] },
  { name: 'Elena Vargas',  exp: 'intermediate', today: null,                            hist: [11] },
  { name: 'Camila Ortiz',  exp: 'beginner',     today: null,                            hist: [] },
];

// Rival boxes (logged today's Fran) so box-vs-box + the throwdown look live.
const RIVALS = {
  'CF South Texas': {
    location: 'San Antonio, TX',
    loggers: [
      { name: 'Carlos Reyna',   t: 162, rom: 97, sets: 6 },
      { name: 'Daniela Cruz',   t: 179, rom: 99, sets: 5 },
      { name: 'Omar Salinas',   t: 214, rom: 93, sets: 8 },
      { name: 'Nayeli Ramos',   t: 248, rom: 91, sets: 9 },
      { name: 'Beto Aguilar',   t: 295, rom: 85, sets: 11 },
    ],
    extra: 2,
  },
  'Iron Valley': {
    location: 'El Paso, TX',
    loggers: [
      { name: 'Sterling Pace',  t: 156, rom: 98, sets: 6 },
      { name: 'Maya Brooks',    t: 183, rom: 96, sets: 6 },
      { name: 'Caleb Stone',    t: 201, rom: 94, sets: 7 },
      { name: 'Ivy Larsen',     t: 236, rom: 92, sets: 9 },
    ],
    extra: 1,
  },
};

const BENCH = ['Cindy', 'Grace', 'Helen', 'Diane', 'Annie', 'Karen', 'Jackie', 'Nancy', 'Angie', 'Barbara'];

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function emailFor(name, box) { return `${slug(name)}.${slug(box)}@wurqdemo.io`; }

async function getOrCreateBox(client, name, location) {
  const { rows } = await client.query(
    `INSERT INTO boxes (name, location) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET location = EXCLUDED.location
       RETURNING box_id`, [name, location]);
  return rows[0].box_id;
}

// Get-or-create a workout dated `daysAgo` days back (same day -> same row).
async function getOrCreateWorkout(client, name, daysAgo) {
  const { rows } = await client.query(
    `WITH ins AS (
       INSERT INTO workouts (name, type, description, wod_date)
       SELECT $1, 'For Time', 'Benchmark WOD.', CURRENT_DATE - ($2)::int
       WHERE NOT EXISTS (SELECT 1 FROM workouts WHERE name = $1 AND wod_date = CURRENT_DATE - ($2)::int)
       RETURNING workout_id)
     SELECT workout_id FROM ins
     UNION ALL
     SELECT workout_id FROM workouts WHERE name = $1 AND wod_date = CURRENT_DATE - ($2)::int
     LIMIT 1`, [name, daysAgo]);
  return rows[0].workout_id;
}

async function upsertResultAt(client, userId, workoutId, a, daysAgo) {
  const holistic = computeHolisticScore({ time_seconds: a.t, rom_pct: a.rom, unbroken_sets: a.sets });
  await client.query(
    `INSERT INTO results (user_id, workout_id, time_seconds, rom_pct, unbroken_sets, holistic_score, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval)
       ON CONFLICT (user_id, workout_id) DO UPDATE SET
         time_seconds = EXCLUDED.time_seconds, rom_pct = EXCLUDED.rom_pct,
         unbroken_sets = EXCLUDED.unbroken_sets, holistic_score = EXCLUDED.holistic_score,
         created_at = now() - ($7 || ' days')::interval`,
    [userId, workoutId, a.t, a.rom, a.sets, holistic, String(daysAgo)]);
}

async function upsertUser(client, email) {
  const { rows } = await client.query(
    `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING user_id`, [email]);
  return rows[0].user_id;
}

async function upsertProfile(client, userId, { display_name, gym_name, exp }) {
  await client.query(
    `INSERT INTO profiles (user_id, display_name, gym_name, experience_level, profile_complete, updated_at)
       VALUES ($1, $2, $3, $4, true, now())
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         gym_name = EXCLUDED.gym_name,
         experience_level = EXCLUDED.experience_level,
         profile_complete = true,
         updated_at = now()`,
    [userId, display_name, gym_name, exp]);
}

async function joinBox(client, userId, boxId) {
  await client.query(
    `INSERT INTO box_memberships (user_id, box_id) VALUES ($1, $2)
       ON CONFLICT (user_id, box_id) DO NOTHING`, [userId, boxId]);
  await client.query(
    `DELETE FROM box_memberships WHERE user_id = $1 AND box_id <> $2`, [userId, boxId]);
}

async function upsertResult(client, userId, workoutId, a) {
  const holistic = computeHolisticScore({ time_seconds: a.t, rom_pct: a.rom, unbroken_sets: a.sets });
  await client.query(
    `INSERT INTO results (user_id, workout_id, time_seconds, rom_pct, unbroken_sets, holistic_score)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, workout_id) DO UPDATE SET
         time_seconds = EXCLUDED.time_seconds, rom_pct = EXCLUDED.rom_pct,
         unbroken_sets = EXCLUDED.unbroken_sets, holistic_score = EXCLUDED.holistic_score,
         created_at = now()`,
    [userId, workoutId, a.t, a.rom, a.sets, holistic]);
  return holistic;
}

async function awardBadge(client, userId, code) {
  await client.query(
    `INSERT INTO user_badges (user_id, badge_id)
       SELECT $1, badge_id FROM badges WHERE code = $2
       ON CONFLICT (user_id, badge_id) DO NOTHING`, [userId, code]);
}

async function main() {
  await migrate(); // ensure schema + today's Fran + base badges exist

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Today's Fran.
    const wod = await client.query(
      `SELECT workout_id, name FROM workouts WHERE wod_date = CURRENT_DATE ORDER BY name LIMIT 1`);
    const workoutId = wod.rows[0].workout_id;

    const boxIds = {};
    const idByName = {}; // display_name -> user_id (home box, for feed)

    for (const box of BOXES) {
      const b = await client.query(
        `INSERT INTO boxes (name, location) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET location = EXCLUDED.location
           RETURNING box_id`, [box.name, box.location]);
      const boxId = b.rows[0].box_id;
      boxIds[box.name] = boxId;

      const roster = ROSTER[box.name];

      for (const a of roster.loggers) {
        const userId = await upsertUser(client, emailFor(a.name, box.name));
        await upsertProfile(client, userId, { display_name: a.name, gym_name: box.name, exp: a.exp });
        await joinBox(client, userId, boxId);
        await upsertResult(client, userId, workoutId, a);
        await awardBadge(client, userId, 'first_log');
        if (a.t < 240) await awardBadge(client, userId, 'sub_4_fran');
        if (box.name === HOME_BOX) idByName[a.name] = userId;
      }

      // Extra members who haven't logged (drives participation < 100%).
      for (let i = 0; i < roster.extra; i++) {
        const name = `${box.name.split(' ')[0]} Member ${i + 1}`;
        const userId = await upsertUser(client, emailFor(name, box.name));
        await upsertProfile(client, userId, { display_name: name, gym_name: box.name, exp: 'beginner' });
        await joinBox(client, userId, boxId);
      }
    }

    // ---- Feed events (home box) — tagged so a re-run replaces, not duplicates.
    await client.query(`DELETE FROM feed_events WHERE payload->>'seed' = 'true'`);

    const score = (name) => {
      const a = ROSTER[HOME_BOX].loggers.find((x) => x.name === name);
      return computeHolisticScore({ time_seconds: a.t, rom_pct: a.rom, unbroken_sets: a.sets });
    };
    const FEED = [
      { who: 'Marcus Lee',   type: 'result_logged', minsAgo: 12,   kudos: 14,
        payload: { workout_name: 'Fran', holistic_score: score('Marcus Lee'), time_seconds: 165 } },
      { who: 'Jordan Diaz',  type: 'badge_earned',  minsAgo: 40,   kudos: 9,
        payload: { name: 'Sub-4 Fran', description: 'Completed Fran in under 4 minutes.' } },
      { who: 'Priya Nair',   type: 'result_logged', minsAgo: 125,  kudos: 6,
        payload: { workout_name: 'Fran', holistic_score: score('Priya Nair'), time_seconds: 242 } },
      { who: 'Coach Riley',  type: 'coach_post',    minsAgo: 190,  kudos: 22,
        payload: { text: 'Huge effort on Fran today, Pegacorn 💪 Mobility session at 6pm — bring a band.' } },
      { who: 'Ava Thompson', type: 'badge_earned',  minsAgo: 360,  kudos: 31,
        payload: { name: 'Century', description: 'Logged your 100th result.' } },
      { who: 'Chloe Bennett',type: 'result_logged', minsAgo: 480,  kudos: 4,
        payload: { workout_name: 'Fran', holistic_score: score('Chloe Bennett'), time_seconds: 271 } },
      { who: 'Coach Riley',  type: 'coach_post',    minsAgo: 1440, kudos: 17,
        payload: { text: 'Sign-ups open for Saturday\'s partner throwdown — grab a partner in the replies!' } },
    ];

    for (const f of FEED) {
      const uid = idByName[f.who];
      if (!uid) continue;
      const payload = { ...f.payload, seed: 'true' };
      await client.query(
        `INSERT INTO feed_events (user_id, type, payload, kudos, created_at)
           VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval)`,
        [uid, f.type, JSON.stringify(payload), f.kudos, String(f.minsAgo)]);
    }

    // ---- Owner world: CrossFit Borderland + rivals + active challenge -------
    const HIST_STATS = { t: 235, rom: 91, sets: 8 };
    const borderlandId = await getOrCreateBox(client, OWNER_BOX, 'Brownsville, TX');

    for (const m of BORDERLAND) {
      const uid = await upsertUser(client, emailFor(m.name, OWNER_BOX));
      await upsertProfile(client, uid, { display_name: m.name, gym_name: OWNER_BOX, exp: m.exp });
      await joinBox(client, uid, borderlandId);
      if (m.today) {
        await upsertResult(client, uid, workoutId, m.today); // today's Fran
        await awardBadge(client, uid, 'first_log');
        if (m.today.t < 240) await awardBadge(client, uid, 'sub_4_fran');
      }
      for (const d of m.hist) {
        const wId = await getOrCreateWorkout(client, BENCH[d % BENCH.length], d);
        await upsertResultAt(client, uid, wId, HIST_STATS, d);
        await awardBadge(client, uid, 'first_log');
      }
    }

    // Rival boxes log today's Fran.
    const rivalIds = {};
    for (const [name, r] of Object.entries(RIVALS)) {
      const rid = await getOrCreateBox(client, name, r.location);
      rivalIds[name] = rid;
      for (const a of r.loggers) {
        const uid = await upsertUser(client, emailFor(a.name, name));
        await upsertProfile(client, uid, { display_name: a.name, gym_name: name, exp: 'RX' });
        await joinBox(client, uid, rid);
        await upsertResult(client, uid, workoutId, a);
      }
      for (let i = 0; i < r.extra; i++) {
        const nm = `${name.split(' ')[0]} Member ${i + 1}`;
        const uid = await upsertUser(client, emailFor(nm, name));
        await upsertProfile(client, uid, { display_name: nm, gym_name: name, exp: 'beginner' });
        await joinBox(client, uid, rid);
      }
    }

    // Active throwdown: Borderland vs CF South Texas on today's Fran.
    const opponentId = rivalIds['CF South Texas'];
    await client.query(
      `DELETE FROM challenges WHERE challenger_box_id = $1 AND opponent_box_id = $2 AND workout_id = $3`,
      [borderlandId, opponentId, workoutId]);
    await client.query(
      `INSERT INTO challenges (challenger_box_id, opponent_box_id, workout_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, now() - interval '2 days', now() + interval '5 days', 'active')`,
      [borderlandId, opponentId, workoutId]);

    await client.query('COMMIT');

    const totals = await pool.query(
      `SELECT (SELECT COUNT(*) FROM boxes)::int AS boxes,
              (SELECT COUNT(*) FROM box_memberships)::int AS members,
              (SELECT COUNT(*) FROM results WHERE workout_id = $1)::int AS results,
              (SELECT COUNT(*) FROM feed_events WHERE payload->>'seed' = 'true')::int AS feed`, [workoutId]);
    const t = totals.rows[0];
    console.log(`[seed] done — ${t.boxes} boxes, ${t.members} members, ${t.results} Fran results, ${t.feed} feed events.`);
    console.log(`[seed] Athlete home box: "${HOME_BOX}". Owner box: "${OWNER_BOX}" (switch to Owner view in the header).`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((err) => { console.error('[seed] failed:', err); pool.end(); process.exit(1); });
