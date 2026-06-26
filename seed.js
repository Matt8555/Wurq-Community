'use strict';

// ============================================================================
// Demo world seed — a living month of 10 CrossFit boxes competing through the
// 4 weeks ending today (framed as June 2026). ~1,000 athletes, tens of
// thousands of logged results, box-vs-box standings that match each gym's
// personality, head-to-head challenges, streaks, badges, and feeds.
//
//   npm run seed        (or: node seed.js)
//
// IDEMPOTENT + RE-RUNNABLE: rebuilds the world deterministically each run. It
// resets the world tables (boxes/memberships/workouts/results/challenges/
// feed/user_badges) and regenerates from a fixed PRNG seed, so counts are
// stable and there are no leftovers. A deterministic athlete keeps a consistent
// ability across workouts (with day-to-day variance and slight monthly
// improvement), so leaderboards are stable-but-not-identical.
//
// BULK INSERTS: results (15k–20k rows) go in via batched multi-row INSERTs, not
// one at a time. Holistic Scores reuse the server-side scoring module.
//
// The Community/Circle tab posts are a front-end mock (public/app.js) and always
// render, so they are not part of this DB seed.
// ============================================================================

const { pool, migrate } = require('./db');
const { computeHolisticScore } = require('./holisticScore');
const { deriveMetrics } = require('./metrics');

const HERO_EMAIL = 'matt@pegacorngroup.com'; // the demo user — gets a rich month

const SEED = 20260601;            // fixed base seed -> reproducible world
const DAYS = 28;                  // days of activity ending today (k=0 = today)
const FRAN_DAYS = new Set([0, 13, 24]); // days whose WOD is Fran (k=0 = today's WOD)
const HOME_BOX = 'CrossFit Borderland'; // demo athlete home box AND owner box

// ---- deterministic PRNG -----------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const lerp = (a, b, t) => a + (b - a) * t;

// ---- box personalities (10) -------------------------------------------------
// persona drives ability (avg score) + engagement (participation) + improve
// (monthly ramp). Score = avg holistic × participation, so personalities sort
// the standings: powerhouses top, large-but-disengaged low, mid-pack clustered.
const BOX_DEFS = [
  { name: 'Apex CrossFit',          loc: 'Austin, TX',         persona: 'power',   size: 105, ability: 0.78, eng: 1.25, improve: 0.20 },
  { name: 'Iron Valley CrossFit',   loc: 'Phoenix, AZ',        persona: 'power',   size: 100, ability: 0.75, eng: 1.22, improve: 0.20 },
  { name: 'Rising Tide CrossFit',   loc: 'Tampa, FL',          persona: 'upcomer', size: 98,  ability: 0.60, eng: 1.00, improve: 1.00 },
  { name: 'Forge & Anvil CrossFit', loc: 'Denver, CO',         persona: 'upcomer', size: 96,  ability: 0.58, eng: 1.00, improve: 1.00 },
  { name: 'Metroplex CrossFit',     loc: 'Dallas, TX',         persona: 'large',   size: 150, ability: 0.61, eng: 0.55, improve: 0.20 },
  { name: HOME_BOX,                 loc: 'Brownsville, TX',    persona: 'mid',     size: 100, ability: 0.585, eng: 1.00, improve: 0.30 },
  { name: 'Summit CrossFit',        loc: 'Salt Lake City, UT', persona: 'mid',     size: 100, ability: 0.585, eng: 1.00, improve: 0.30 },
  { name: 'CF South Texas',         loc: 'San Antonio, TX',    persona: 'mid',     size: 100, ability: 0.59,  eng: 0.99, improve: 0.30 },
  { name: 'Granite City CrossFit',  loc: 'Boston, MA',         persona: 'mid',     size: 100, ability: 0.55, eng: 0.92, improve: 0.25 },
  { name: 'Coastal CrossFit',       loc: 'San Diego, CA',      persona: 'mid',     size: 100, ability: 0.56, eng: 0.90, improve: 0.25 },
];

const ARCHETYPES = {
  power:   { streak: 0.15, regular: 0.65, sporadic: 0.12, lapsed: 0.08 },
  upcomer: { streak: 0.10, regular: 0.62, sporadic: 0.18, lapsed: 0.10 },
  large:   { streak: 0.05, regular: 0.45, sporadic: 0.30, lapsed: 0.20 },
  mid:     { streak: 0.09, regular: 0.58, sporadic: 0.20, lapsed: 0.13 },
};
const BASE_PROB = { streak: 0.92, regular: 0.72, sporadic: 0.38, lapsed: 0.48 };

const FIRST = ['Alex', 'Maria', 'James', 'Sofia', 'Liam', 'Emma', 'Noah', 'Olivia', 'Mateo', 'Ava',
  'Diego', 'Isabella', 'Lucas', 'Mia', 'Ethan', 'Camila', 'Mason', 'Luna', 'Logan', 'Harper',
  'Andre', 'Priya', 'Marcus', 'Nina', 'Tariq', 'Wei', 'Yuki', 'Omar', 'Elena', 'Jamal',
  'Sara', 'Kofi', 'Ingrid', 'Pablo', 'Aisha', 'Rohan', 'Bianca', 'Hector', 'Lucia', 'Tomas'];
const LAST = ['Smith', 'Garcia', 'Johnson', 'Lee', 'Brown', 'Martinez', 'Davis', 'Lopez', 'Nguyen', 'Wilson',
  'Walker', 'Reyes', 'Cruz', 'Patel', 'Kim', 'Rossi', 'Hassan', 'Petrova', 'Okafor', 'Chen',
  'Morales', 'Schmidt', 'Tanaka', 'Larsen', 'Carter', 'Vega', 'Flores', 'Mendez', 'Navarro', 'Stone',
  'Brooks', 'Pace', 'Salas', 'Guerra', 'Ruiz', 'Tovar', 'Vargas', 'Castro', 'Aguilar', 'Salinas'];

const WOD_LIB = [
  { name: 'Cindy', type: 'AMRAP 20', base: 250 }, { name: 'Helen', type: '3 RFT', base: 270 },
  { name: 'Grace', type: 'For Time', base: 180 }, { name: 'Diane', type: 'For Time', base: 240 },
  { name: 'Annie', type: 'For Time', base: 210 }, { name: 'Karen', type: 'For Time', base: 300 },
  { name: 'Jackie', type: 'For Time', base: 230 }, { name: 'Nancy', type: '5 RFT', base: 320 },
  { name: 'Angie', type: 'For Time', base: 340 }, { name: 'Chelsea', type: 'EMOM 30', base: 300 },
  { name: 'DT', type: '5 RFT', base: 280 }, { name: 'Kelly', type: '5 RFT', base: 360 },
  { name: 'Back Squat 5x5', type: 'Strength', base: 300 }, { name: 'Deadlift Build', type: 'Strength', base: 300 },
  { name: 'Snatch EMOM 12', type: 'EMOM', base: 240 }, { name: 'Strict Press 5x3', type: 'Strength', base: 270 },
  { name: 'Row 2k', type: 'For Time', base: 260 }, { name: 'Wall Ball AMRAP', type: 'AMRAP 15', base: 230 },
  { name: 'Box Jump RFT', type: '4 RFT', base: 250 }, { name: 'Fight Gone Bad', type: '3 Rounds', base: 320 },
  { name: 'Filthy Fifty', type: 'For Time', base: 380 }, { name: 'Isabel', type: 'For Time', base: 170 },
  { name: 'Randy', type: 'For Time', base: 200 }, { name: 'Elizabeth', type: 'For Time', base: 230 },
  { name: 'Amanda', type: 'For Time', base: 190 },
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const expFor = (a) => (a >= 0.88 ? 'competitor' : a >= 0.62 ? 'RX' : a >= 0.42 ? 'intermediate' : 'beginner');

// One result for day-offset k at effective ability eff, incl. WurQ metrics.
function genResult(k, eff, rng) {
  const isFran = FRAN_DAYS.has(k);
  const wod = isFran ? { name: 'Fran', base: 200 } : WOD_LIB[k % WOD_LIB.length];
  const rom = clamp(Math.round(72 + eff * 28 + (rng() * 2 - 1) * 4), 60, 100);
  const sets = clamp(Math.round(3 + eff * 9 + (rng() * 2 - 1) * 1.5), 1, 14);
  const time = clamp(Math.round(wod.base * (1.45 - eff * 0.7) + (rng() * 2 - 1) * 22), 90, 900);
  const holistic = computeHolisticScore({ time_seconds: time, rom_pct: rom, unbroken_sets: sets });
  const metrics = deriveMetrics({ workoutName: wod.name, time_seconds: time, rom_pct: rom, unbroken_sets: sets, ability: eff, rng });
  return { k, time, rom, sets, holistic, metrics };
}

function pickArchetype(rng, persona) {
  const mix = ARCHETYPES[persona];
  const r = rng();
  if (r < mix.streak) return 'streak';
  if (r < mix.streak + mix.regular) return 'regular';
  if (r < mix.streak + mix.regular + mix.sporadic) return 'sporadic';
  return 'lapsed';
}

// Build the whole world in memory (deterministic), then bulk-load it.
function generateWorld() {
  const athletes = []; // { email, name, exp, boxName, results:[{k,time,rom,sets,holistic}] , firstK, franBestK }
  let bIndex = 0;
  for (const box of BOX_DEFS) {
    for (let i = 0; i < box.size; i++) {
      const rng = mulberry32(SEED + bIndex * 100003 + i * 17);
      const ability = clamp(box.ability + (rng() * 2 - 1) * 0.17, 0.18, 0.97);
      const arche = pickArchetype(rng, box.persona);
      const name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
      const email = `a${i}.${slug(box.name)}@wurqdemo.io`;

      // Lapsed athletes quit ~11–20 days ago; a few never log at all.
      const quitK = arche === 'lapsed' ? Math.floor(11 + rng() * 10) : -1;
      const neverLogs = arche === 'lapsed' && rng() < 0.15;
      const streakLen = arche === 'streak' ? Math.floor(10 + rng() * 11) : 0; // 10–20 day current streak

      const results = [];
      let firstK = -1, franBestK = -1;
      if (!neverLogs) {
        for (let k = DAYS - 1; k >= 0; k--) { // oldest -> today
          const prog = (DAYS - 1 - k) / (DAYS - 1); // 0 oldest .. 1 today
          if (arche === 'lapsed' && k < quitK) continue; // quit: nothing recent
          let train;
          if (arche === 'streak' && k < streakLen) {
            train = true; // forced current streak
          } else {
            let engMult = box.eng;
            if (box.persona === 'upcomer') engMult = lerp(0.62, 1.2, prog); // ramps up over month
            const prob = clamp(BASE_PROB[arche] * engMult, 0.05, 0.97);
            train = rng() < prob;
          }
          if (!train) continue;

          const eff = clamp(ability + box.improve * 0.15 * prog + (rng() * 2 - 1) * 0.06, 0.05, 0.99);
          const r = genResult(k, eff, rng);
          results.push(r);
          if (firstK < 0 || k > firstK) firstK = k; // earliest day = largest k
          if (FRAN_DAYS.has(k) && r.time < 240 && (franBestK < 0 || k > franBestK)) franBestK = k;
        }
      }
      athletes.push({ email, name, exp: expFor(ability), boxName: box.name, results, firstK, franBestK });
      // keep firstK as the *earliest* (largest k) training day
    }
    bIndex++;
  }
  athletes.push(buildHero());
  return athletes;
}

// The demo user: a rich, strong month at the home box. Trains every day k=1..27
// (a long current streak ending yesterday) but NOT today (k=0), so logging
// today's Fran live can set a personal record and fire the celebration.
function buildHero() {
  const rng = mulberry32(SEED + 424242);
  const ability = 0.80; // strong, top-of-box, but not literally #1
  const results = [];
  let firstK = -1, franBestK = -1;
  for (let k = DAYS - 1; k >= 1; k--) {
    const prog = (DAYS - 1 - k) / (DAYS - 1);
    const eff = clamp(ability + 0.06 * prog + (rng() * 2 - 1) * 0.05, 0.5, 0.97);
    const r = genResult(k, eff, rng);
    results.push(r);
    if (firstK < 0 || k > firstK) firstK = k;
    if (FRAN_DAYS.has(k) && r.time < 240 && (franBestK < 0 || k > franBestK)) franBestK = k;
  }
  return { email: HERO_EMAIL, name: 'Matt P', exp: 'RX', boxName: HOME_BOX, results, firstK, franBestK };
}

// ---- bulk helpers -----------------------------------------------------------
async function bulkInsert(client, table, columns, rows, conflict = '') {
  if (!rows.length) return;
  const perRow = columns.length;
  const maxRows = Math.max(1, Math.floor(55000 / perRow));
  for (let i = 0; i < rows.length; i += maxRows) {
    const chunk = rows.slice(i, i + maxRows);
    const params = [];
    const values = chunk.map((r) => {
      const ph = r.map((_, ci) => `$${params.length + ci + 1}`);
      params.push(...r);
      return `(${ph.join(',')})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')} ${conflict}`, params);
  }
}

async function upsertUsersReturning(client, emails) {
  const map = new Map();
  const maxRows = 20000;
  for (let i = 0; i < emails.length; i += maxRows) {
    const chunk = emails.slice(i, i + maxRows);
    const values = chunk.map((_, ci) => `($${ci + 1})`).join(',');
    const { rows } = await client.query(
      `INSERT INTO users (email) VALUES ${values}
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id, email`, chunk);
    rows.forEach((r) => map.set(r.email, r.user_id));
  }
  return map;
}

// ---- main -------------------------------------------------------------------
async function main() {
  await migrate(); // ensure schema + base badges exist

  const anchorRow = await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`);
  const [Y, M, D] = anchorRow.rows[0].d.split('-').map(Number);
  const dayStr = (k) => new Date(Date.UTC(Y, M - 1, D - k, 12)).toISOString().slice(0, 10);
  const ts = (k) => `${dayStr(k)} 12:00:00`;

  const athletes = generateWorld();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reset the world (deterministic rebuild). FK-safe order.
    await client.query('DELETE FROM feed_events');
    await client.query('DELETE FROM user_badges');
    await client.query('DELETE FROM challenges');
    await client.query('DELETE FROM results');
    await client.query('DELETE FROM box_memberships');
    await client.query('DELETE FROM workouts');
    await client.query('DELETE FROM boxes');

    // Boxes
    const boxIds = {};
    for (const b of BOX_DEFS) {
      const { rows } = await client.query(
        `INSERT INTO boxes (name, location) VALUES ($1, $2) RETURNING box_id`, [b.name, b.loc]);
      boxIds[b.name] = rows[0].box_id;
    }

    // Workouts (one per day; FRAN_DAYS use 'Fran' so today's WOD is Fran)
    const workoutIds = {};
    for (let k = 0; k < DAYS; k++) {
      const w = FRAN_DAYS.has(k)
        ? { name: 'Fran', type: 'For Time', base: 200 }
        : WOD_LIB[k % WOD_LIB.length];
      const desc = w.name === 'Fran'
        ? '21-15-9 reps for time: Thrusters (95/65 lb) and Pull-ups.'
        : `${w.name} — ${w.type}.`;
      const { rows } = await client.query(
        `INSERT INTO workouts (name, type, description, wod_date) VALUES ($1, $2, $3, $4::date)
           RETURNING workout_id`, [w.name, w.type, desc, dayStr(k)]);
      workoutIds[k] = rows[0].workout_id;
    }
    const franTodayId = workoutIds[0];

    // Users (bulk) -> id map
    const emailToId = await upsertUsersReturning(client, athletes.map((a) => a.email));
    athletes.forEach((a) => { a.userId = emailToId.get(a.email); });

    // Profiles + memberships (bulk)
    await bulkInsert(client, 'profiles',
      ['user_id', 'display_name', 'gym_name', 'experience_level', 'profile_complete', 'updated_at'],
      athletes.map((a) => [a.userId, a.name, a.boxName, a.exp, true, ts(0)]),
      `ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name,
         gym_name = EXCLUDED.gym_name, experience_level = EXCLUDED.experience_level,
         profile_complete = true, updated_at = EXCLUDED.updated_at`);
    await bulkInsert(client, 'box_memberships', ['user_id', 'box_id', 'joined_at'],
      athletes.map((a) => [a.userId, boxIds[a.boxName], ts(DAYS - 1)]),
      'ON CONFLICT (user_id, box_id) DO NOTHING');

    // Results (bulk — the big one)
    const resultRows = [];
    for (const a of athletes) {
      for (const r of a.results) {
        const m = r.metrics;
        resultRows.push([a.userId, workoutIds[r.k], r.time, r.rom, r.sets, r.holistic,
          m.avg_hr, m.peak_hr, m.calories, m.power_output, m.work_volume, JSON.stringify(m.movements), ts(r.k)]);
      }
    }
    await bulkInsert(client, 'results',
      ['user_id', 'workout_id', 'time_seconds', 'rom_pct', 'unbroken_sets', 'holistic_score',
        'avg_hr', 'peak_hr', 'calories', 'power_output', 'work_volume', 'movements', 'created_at'],
      resultRows,
      `ON CONFLICT (user_id, workout_id) DO UPDATE SET time_seconds = EXCLUDED.time_seconds,
         rom_pct = EXCLUDED.rom_pct, unbroken_sets = EXCLUDED.unbroken_sets,
         holistic_score = EXCLUDED.holistic_score, avg_hr = EXCLUDED.avg_hr, peak_hr = EXCLUDED.peak_hr,
         calories = EXCLUDED.calories, power_output = EXCLUDED.power_output,
         work_volume = EXCLUDED.work_volume, movements = EXCLUDED.movements, created_at = EXCLUDED.created_at`);

    // Badges: first_log (earliest training day) + sub_4_fran (earliest sub-240 Fran)
    const badgeRow = await client.query(`SELECT code, badge_id FROM badges`);
    const badgeId = Object.fromEntries(badgeRow.rows.map((r) => [r.code, r.badge_id]));
    const ubRows = [];
    for (const a of athletes) {
      if (a.firstK >= 0 && badgeId.first_log) ubRows.push([a.userId, badgeId.first_log, ts(a.firstK)]);
      if (a.franBestK >= 0 && badgeId.sub_4_fran) ubRows.push([a.userId, badgeId.sub_4_fran, ts(a.franBestK)]);
    }
    await bulkInsert(client, 'user_badges', ['user_id', 'badge_id', 'earned_at'], ubRows,
      'ON CONFLICT (user_id, badge_id) DO NOTHING');

    // Feed events: badge unlocks (spread), recent results, coach posts.
    const feedRows = []; // [user_id, type, payload, kudos, created_at]
    const frng = mulberry32(SEED + 999);
    for (const a of athletes) {
      // badge_earned for sub_4_fran unlocks (spread across the Fran days)
      if (a.franBestK >= 0) {
        feedRows.push([a.userId, 'badge_earned',
          JSON.stringify({ name: 'Sub-4 Fran', description: 'Completed Fran in under 4 minutes.', seed: 'true' }),
          Math.floor(frng() * 20), ts(a.franBestK)]);
      }
      // result_logged for recent results (last 3 days) -> fills every box feed
      for (const r of a.results) {
        if (r.k <= 2) {
          feedRows.push([a.userId, 'result_logged',
            JSON.stringify({ workout_name: FRAN_DAYS.has(r.k) ? 'Fran' : WOD_LIB[r.k % WOD_LIB.length].name,
              holistic_score: r.holistic, time_seconds: r.time, seed: 'true' }),
            Math.floor(frng() * 18), ts(r.k)]);
        }
      }
    }
    // Coach posts: 3 per box from a random member, varied timestamps.
    const COACH = [
      'Great work this week, team 💪 Mobility session Friday 6pm.',
      'Sign-ups open for the next throwdown — grab a partner!',
      'Reminder: scale to keep intensity. Form first, then load.',
      'New PR board is up — go chase a number this week.',
      'Welcome our new members 👋 say hi at the next class.',
    ];
    for (const b of BOX_DEFS) {
      const members = athletes.filter((a) => a.boxName === b.name);
      for (let c = 0; c < 3; c++) {
        const m = members[Math.floor(frng() * members.length)];
        if (!m) continue;
        // Recent (last 3 days) so coach posts surface alongside PRs in the feed.
        feedRows.push([m.userId, 'coach_post',
          JSON.stringify({ text: COACH[(c + BOX_DEFS.indexOf(b)) % COACH.length], seed: 'true' }),
          12 + Math.floor(frng() * 30), ts(Math.floor(frng() * 3))]);
      }
    }
    await bulkInsert(client, 'feed_events', ['user_id', 'type', 'payload', 'kudos', 'created_at'], feedRows);

    // Challenges: 2 completed (earlier June) + 1 active involving the home box.
    const chRows = [
      // completed powerhouse clash
      [boxIds['Apex CrossFit'], boxIds['Iron Valley CrossFit'], workoutIds[13],
        ts(15), ts(11), 'completed'],
      // completed: home box vs a close rival
      [boxIds[HOME_BOX], boxIds['CF South Texas'], workoutIds[24],
        ts(26), ts(20), 'completed'],
      // completed up-and-comer derby
      [boxIds['Rising Tide CrossFit'], boxIds['Forge & Anvil CrossFit'], workoutIds[13],
        ts(16), ts(10), 'completed'],
      // ACTIVE: home box vs close rival on today's Fran
      [boxIds[HOME_BOX], boxIds['Summit CrossFit'], franTodayId,
        ts(3), `${dayStr(-4)} 12:00:00`, 'active'],
    ];
    await bulkInsert(client, 'challenges',
      ['challenger_box_id', 'opponent_box_id', 'workout_id', 'starts_at', 'ends_at', 'status'], chRows);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const t = await pool.query(`
    SELECT (SELECT COUNT(*) FROM boxes)::int AS boxes,
           (SELECT COUNT(*) FROM box_memberships)::int AS athletes,
           (SELECT COUNT(*) FROM results)::int AS results,
           (SELECT COUNT(*) FROM workouts)::int AS workouts,
           (SELECT COUNT(*) FROM challenges)::int AS challenges,
           (SELECT COUNT(*) FROM feed_events)::int AS feed,
           (SELECT COUNT(*) FROM user_badges)::int AS badges`);
  const c = t.rows[0];
  console.log(`[seed] world rebuilt — ${c.boxes} boxes, ${c.athletes} athletes, ${c.results} results, ` +
    `${c.workouts} workouts, ${c.challenges} challenges, ${c.feed} feed events, ${c.badges} badge awards.`);
  console.log(`[seed] Demo box (athlete home + owner): "${HOME_BOX}". Set your athlete gym to it, or switch to Owner view.`);
}

// Exported so the server can auto-seed an empty database on startup. (main()
// shares the ./db pool and does NOT close it.) Run directly to seed manually.
module.exports = { runSeed: main };

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch((err) => { console.error('[seed] failed:', err); pool.end(); process.exit(1); });
}
