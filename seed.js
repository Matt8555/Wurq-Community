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

// Demo logins that each get a full personal month backfilled, in the same box so
// you can compare them side by side. Override emails per deploy with DEMO_EMAILS
// (comma-separated, by position) or DEMO_EMAIL (just the first).
const DEFAULT_DEMO = [
  { email: 'matt@pegacorngroup.com', name: 'Matt P',      exp: 'intermediate', ability: 0.55, prob: 0.50, streak: 7 },
  { email: 'alex@pegacorngroup.com', name: 'Alex Rivera', exp: 'RX',           ability: 0.79, prob: 0.66, streak: 12 },
];
const DEMO_ATHLETES = (() => {
  const overrides = (process.env.DEMO_EMAILS || process.env.DEMO_EMAIL || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return DEFAULT_DEMO.map((p, i) => (overrides[i] ? { ...p, email: overrides[i] } : p));
})();

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
  DEMO_ATHLETES.forEach((p, i) => athletes.push(buildDemoAthlete(p, i)));
  return athletes;
}

// A demo athlete (persona) at the home box: trains to their `prob`/`streak`,
// ability sets their scores, slight improvement over the month. Distinct RNG
// per index so the two demo logins have different histories.
function buildDemoAthlete(p, idx = 0) {
  const rng = mulberry32(SEED + 424242 + idx * 9973);
  const results = [];
  let firstK = -1, franBestK = -1;
  for (let k = DAYS - 1; k >= 0; k--) {
    const prog = (DAYS - 1 - k) / (DAYS - 1);
    const train = k <= p.streak ? true : rng() < p.prob;
    if (!train) continue;
    const eff = clamp(p.ability + 0.08 * prog + (rng() * 2 - 1) * 0.06, 0.3, 0.95);
    const r = genResult(k, eff, rng);
    results.push(r);
    if (firstK < 0 || k > firstK) firstK = k;
    if (FRAN_DAYS.has(k) && r.time < 240 && (franBestK < 0 || k > franBestK)) franBestK = k;
  }
  return { email: p.email, name: p.name, exp: p.exp, boxName: HOME_BOX, results, firstK, franBestK };
}

// Helpers to turn a day-offset k into a date string / timestamp anchored to today.
function dateHelpers(anchor) {
  const [Y, M, D] = anchor.split('-').map(Number);
  const dayStr = (k) => new Date(Date.UTC(Y, M - 1, D - k, 12)).toISOString().slice(0, 10);
  return { dayStr, ts: (k) => `${dayStr(k)} 12:00:00` };
}

const RESULT_COLS = ['user_id', 'workout_id', 'time_seconds', 'rom_pct', 'unbroken_sets', 'holistic_score',
  'avg_hr', 'peak_hr', 'calories', 'power_output', 'work_volume', 'movements', 'created_at'];
const RESULT_CONFLICT = `ON CONFLICT (user_id, workout_id) DO UPDATE SET time_seconds = EXCLUDED.time_seconds,
  rom_pct = EXCLUDED.rom_pct, unbroken_sets = EXCLUDED.unbroken_sets, holistic_score = EXCLUDED.holistic_score,
  avg_hr = EXCLUDED.avg_hr, peak_hr = EXCLUDED.peak_hr, calories = EXCLUDED.calories,
  power_output = EXCLUDED.power_output, work_volume = EXCLUDED.work_volume,
  movements = EXCLUDED.movements, created_at = EXCLUDED.created_at`;
const resultRow = (uid, wid, r, tsStr) => [uid, wid, r.time, r.rom, r.sets, r.holistic,
  r.metrics.avg_hr, r.metrics.peak_hr, r.metrics.calories, r.metrics.power_output, r.metrics.work_volume,
  JSON.stringify(r.metrics.movements), tsStr];

// Backfill (or refresh) just the demo athlete's month into the existing seeded
// world — idempotent and NON-destructive (touches only this account). Lets a
// deploy give the demo login a full personal history without rebuilding the world.
async function ensureDemoAthletes() {
  for (let i = 0; i < DEMO_ATHLETES.length; i++) await ensureDemoAthlete(DEMO_ATHLETES[i], i);
}

async function ensureDemoAthlete(p, idx = 0) {
  const anchor = (await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d;
  const { dayStr, ts } = dateHelpers(anchor);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const boxRow = await client.query('SELECT box_id FROM boxes WHERE name = $1', [HOME_BOX]);
    if (!boxRow.rows[0]) { await client.query('ROLLBACK'); return false; } // world not seeded yet
    const boxId = boxRow.rows[0].box_id;

    const wRows = (await client.query(
      `SELECT workout_id, to_char(wod_date,'YYYY-MM-DD') AS d FROM workouts
        WHERE wod_date >= CURRENT_DATE - ${DAYS}`)).rows;
    const widByDate = {};
    wRows.forEach((w) => { widByDate[w.d] = w.workout_id; });

    const a = buildDemoAthlete(p, idx);
    const email = p.email;
    const uid = await upsertUser(client, email);
    await upsertProfile(client, uid, { display_name: a.name, gym_name: HOME_BOX, exp: a.exp });
    await joinBox(client, uid, boxId);
    // Ensure the demo login is in a squad so the Squads section is populated.
    const sq = await client.query('SELECT id FROM squads WHERE box_id = $1 ORDER BY created_at LIMIT 1', [boxId]);
    if (sq.rows[0]) await client.query(
      'INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sq.rows[0].id, uid]);

    // Demo referral data so "Bring a friend" is populated.
    await client.query('DELETE FROM referrals WHERE referrer_user_id = $1', [uid]);
    const mates = (await client.query(
      `SELECT m.user_id, u.email FROM box_memberships m JOIN users u ON u.user_id = m.user_id
        WHERE m.box_id = $1 AND m.user_id <> $2 LIMIT 2`, [boxId, uid])).rows;
    let demoPts = 0;
    for (const mate of mates) {
      await client.query(
        `INSERT INTO referrals (referrer_user_id, referred_email, referred_user_id, status, box_id, points_awarded, created_at)
           VALUES ($1, $2, $3, 'joined', $4, 50, now() - interval '6 days')`,
        [uid, mate.email, mate.user_id, boxId]);
      demoPts += 50;
    }
    await client.query(
      `INSERT INTO referrals (referrer_user_id, referred_email, status, box_id, created_at)
         VALUES ($1, $2, 'pending', $3, now() - interval '1 days')`,
      [uid, 'newfriend@example.com', boxId]);
    await client.query('UPDATE profiles SET referral_points = $2 WHERE user_id = $1', [uid, demoPts]);

    const rows = [];
    for (const r of a.results) {
      const wid = widByDate[dayStr(r.k)];
      if (wid) rows.push(resultRow(uid, wid, r, ts(r.k)));
    }
    await bulkInsert(client, 'results', RESULT_COLS, rows, RESULT_CONFLICT);

    if (a.firstK >= 0) await client.query(
      `INSERT INTO user_badges (user_id, badge_id, earned_at) SELECT $1, badge_id, $2 FROM badges
         WHERE code = 'first_log' ON CONFLICT (user_id, badge_id) DO NOTHING`, [uid, ts(a.firstK)]);
    if (a.franBestK >= 0) await client.query(
      `INSERT INTO user_badges (user_id, badge_id, earned_at) SELECT $1, badge_id, $2 FROM badges
         WHERE code = 'sub_4_fran' ON CONFLICT (user_id, badge_id) DO NOTHING`, [uid, ts(a.franBestK)]);

    // refresh this account's seeded feed (don't touch their live-logged events)
    await client.query(`DELETE FROM feed_events WHERE user_id = $1 AND payload->>'seed' = 'true'`, [uid]);
    for (const r of a.results.filter((x) => x.k <= 3)) {
      await client.query(
        `INSERT INTO feed_events (user_id, type, payload, kudos, created_at) VALUES ($1, 'result_logged', $2, $3, $4)`,
        [uid, JSON.stringify({ workout_name: FRAN_DAYS.has(r.k) ? 'Fran' : WOD_LIB[r.k % WOD_LIB.length].name,
          holistic_score: r.holistic, time_seconds: r.time, seed: 'true' }), 2 + (r.k % 4), ts(r.k)]);
    }

    await client.query('COMMIT');
    console.log(`[demo] backfilled ${email}: ${rows.length} sessions into ${HOME_BOX}`);
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[demo] backfill failed:', e.message);
    return false;
  } finally {
    client.release();
  }
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

// Single-row upserts used by the demo-athlete backfill.
async function upsertUser(client, email) {
  const { rows } = await client.query(
    `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING user_id`, [email]);
  return rows[0].user_id;
}
async function upsertProfile(client, userId, { display_name, gym_name, exp }) {
  await client.query(
    `INSERT INTO profiles (user_id, display_name, gym_name, experience_level, profile_complete, updated_at)
       VALUES ($1, $2, $3, $4, true, now())
       ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name,
         gym_name = EXCLUDED.gym_name, experience_level = EXCLUDED.experience_level,
         profile_complete = true, updated_at = now()`,
    [userId, display_name, gym_name, exp]);
}
async function joinBox(client, userId, boxId) {
  await client.query(
    `INSERT INTO box_memberships (user_id, box_id) VALUES ($1, $2) ON CONFLICT (user_id, box_id) DO NOTHING`,
    [userId, boxId]);
  await client.query(`DELETE FROM box_memberships WHERE user_id = $1 AND box_id <> $2`, [userId, boxId]);
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

// ---- competitions / matchmaking seed helpers --------------------------------
// SQL date ranges for the slate (Postgres-side so they track "now").
const COMP_RANGES = {
  this_week:  ["date_trunc('week', now())", "date_trunc('week', now()) + interval '7 days' - interval '1 second'"],
  this_month: ["date_trunc('month', now())", "date_trunc('month', now()) + interval '1 month' - interval '1 second'"],
  last_week:  ["date_trunc('week', now()) - interval '7 days'", "date_trunc('week', now()) - interval '1 second'"],
};

async function insertComp(client, { scope, boxId = null, cadence, type, title, movement = null, window, status = 'active' }) {
  const [s, e] = COMP_RANGES[window];
  const { rows } = await client.query(
    `INSERT INTO competitions (scope, box_id, cadence, type, title, movement, starts_at, ends_at, status)
       VALUES ($1,$2,$3,$4,$5,$6, ${s}, ${e}, $7)
       RETURNING id, scope, box_id, type, movement, starts_at, ends_at`,
    [scope, boxId, cadence, type, title, movement, status]);
  return rows[0];
}

// Pick the winner (top user + value) of a competition window, mirroring the
// server metric. Returns { user_id, value } or null.
async function compWinner(client, c) {
  const boxJoin = c.scope === 'box' ? 'JOIN box_memberships m ON m.user_id = r.user_id AND m.box_id = $3' : '';
  const p = [c.starts_at, c.ends_at];
  if (c.scope === 'box') p.push(c.box_id);
  let sql;
  if (c.type === 'highest_avg') {
    sql = `SELECT r.user_id, ROUND(AVG(r.holistic_score),1)::float8 AS value FROM results r ${boxJoin}
            WHERE r.created_at BETWEEN $1 AND $2 AND r.holistic_score IS NOT NULL
            GROUP BY r.user_id HAVING COUNT(*) >= 1 ORDER BY value DESC LIMIT 1`;
  } else if (c.type === 'most_workouts') {
    sql = `SELECT r.user_id, COUNT(*)::float8 AS value FROM results r ${boxJoin}
            WHERE r.created_at BETWEEN $1 AND $2 GROUP BY r.user_id ORDER BY value DESC LIMIT 1`;
  } else if (c.type === 'most_consistent') {
    sql = `SELECT r.user_id, COUNT(DISTINCT r.created_at::date)::float8 AS value FROM results r ${boxJoin}
            WHERE r.created_at BETWEEN $1 AND $2 GROUP BY r.user_id ORDER BY value DESC LIMIT 1`;
  } else { // most_improved
    sql = `WITH x AS (SELECT r.user_id, r.holistic_score AS hs,
                ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.created_at ASC, r.result_id) AS rn_a,
                ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.created_at DESC, r.result_id) AS rn_d,
                COUNT(*) OVER (PARTITION BY r.user_id) AS cnt
              FROM results r ${boxJoin} WHERE r.created_at BETWEEN $1 AND $2 AND r.holistic_score IS NOT NULL)
            SELECT user_id, ROUND((MAX(hs) FILTER (WHERE rn_d=1) - MAX(hs) FILTER (WHERE rn_a=1))::numeric,1)::float8 AS value
              FROM x WHERE cnt >= 2 GROUP BY user_id ORDER BY value DESC LIMIT 1`;
  }
  return (await client.query(sql, p)).rows[0] || null;
}

const canonPair = (a, b) => (a < b ? [a, b] : [b, a]);

// ---- main -------------------------------------------------------------------
async function main() {
  await migrate(); // ensure schema + base badges exist

  const anchorRow = await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`);
  const { dayStr, ts } = dateHelpers(anchorRow.rows[0].d);

  const athletes = generateWorld();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reset the world (deterministic rebuild). FK-safe order.
    await client.query('DELETE FROM head_to_heads');
    await client.query('DELETE FROM training_partners');
    await client.query('DELETE FROM competitions');
    await client.query('DELETE FROM box_roles');
    await client.query('DELETE FROM follows');
    await client.query('DELETE FROM referrals');
    await client.query('DELETE FROM feed_events');
    await client.query('DELETE FROM user_badges');
    await client.query('DELETE FROM squad_members');
    await client.query('DELETE FROM team_goals');
    await client.query('DELETE FROM squads');
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
      for (const r of a.results) resultRows.push(resultRow(a.userId, workoutIds[r.k], r, ts(r.k)));
    }
    await bulkInsert(client, 'results', RESULT_COLS, resultRows, RESULT_CONFLICT);

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

    // ---- Engagement layer: squads, team goals, shout-outs, newcomers --------
    const SQUAD_NAMES = ['5am Crew', 'Masters Athletes', 'Weekend Warriors', 'Barbell Club', 'Engine Room', 'Comp Team'];
    const firstSquadByBox = {};
    for (const box of BOX_DEFS) {
      const boxId = boxIds[box.name];
      const roster = athletes.filter((a) => a.boxName === box.name);
      const nSquads = 3 + (frng() < 0.5 ? 1 : 0);
      for (let s = 0; s < nSquads; s++) {
        const name = SQUAD_NAMES[(s + BOX_DEFS.indexOf(box)) % SQUAD_NAMES.length];
        const sq = await client.query(
          `INSERT INTO squads (box_id, name, created_at) VALUES ($1, $2, $3) RETURNING id`,
          [boxId, name, ts(DAYS - 1)]);
        const squadId = sq.rows[0].id;
        if (s === 0) firstSquadByBox[box.name] = squadId;
        const shuffled = roster.slice().sort(() => frng() - 0.5);
        const members = shuffled.slice(0, 12 + Math.floor(frng() * 8));
        const mRows = members.map((m) => [squadId, m.userId, ts(DAYS - 1 - Math.floor(frng() * 12))]);
        await bulkInsert(client, 'squad_members', ['squad_id', 'user_id', 'joined_at'], mRows,
          'ON CONFLICT (squad_id, user_id) DO NOTHING');
      }
    }
    // Guarantee the demo logins are in a squad so "your squads" is never empty.
    for (const p of DEMO_ATHLETES) {
      const a = athletes.find((x) => x.email === p.email);
      const sid = firstSquadByBox[p.boxName || HOME_BOX] || firstSquadByBox[HOME_BOX];
      if (a && sid) await client.query(
        `INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [sid, a.userId]);
    }

    // ---- Roles: an owner + 2 coaches per box. Demo box: matt owner+coach, alex coach.
    const coachesByBox = {};
    for (const box of BOX_DEFS) {
      const boxId = boxIds[box.name];
      const roster = athletes.filter((a) => a.boxName === box.name);
      const owner = roster[0];
      const roleRows = [];
      if (owner) { roleRows.push([owner.userId, boxId, 'owner'], [owner.userId, boxId, 'coach']); }
      const coachPool = roster.slice(1).sort(() => frng() - 0.5).slice(0, 2);
      for (const c of coachPool) roleRows.push([c.userId, boxId, 'coach']);
      coachesByBox[box.name] = [owner, ...coachPool].filter(Boolean);
      await bulkInsert(client, 'box_roles', ['user_id', 'box_id', 'role'], roleRows,
        'ON CONFLICT (user_id, box_id, role) DO NOTHING');
    }
    const matt = athletes.find((a) => a.email === DEMO_ATHLETES[0].email);
    const alex = athletes.find((a) => a.email === DEMO_ATHLETES[1].email);
    const borderId = boxIds[HOME_BOX];
    for (const [u, roles] of [[matt, ['owner', 'coach']], [alex, ['coach']]]) {
      if (!u) continue;
      for (const r of roles) await client.query(
        'INSERT INTO box_roles (user_id, box_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [u.userId, borderId, r]);
      if (!coachesByBox[HOME_BOX].includes(u)) coachesByBox[HOME_BOX].push(u);
    }

    // Coach-programmed WOD: today's Fran is programmed by Coach Matt P.
    if (matt) await client.query(
      `UPDATE workouts SET programmed_by = $1, type = 'For Time',
         scaling = 'Scale pull-ups to bands or ring rows; 65/45 lb thrusters if needed.'
        WHERE name = 'Fran' AND wod_date = CURRENT_DATE`, [matt.userId]);

    // Team goal per box — mostly complete so it looks exciting. current is
    // computed live by the API; here we set a target just above the real count.
    const GOAL_TYPES = ['total_workouts', 'total_holistic_points', 'participation_days'];
    for (const box of BOX_DEFS) {
      const boxId = boxIds[box.name];
      const type = box.name === HOME_BOX ? 'total_workouts' : GOAL_TYPES[BOX_DEFS.indexOf(box) % 3];
      const metric = type === 'total_holistic_points' ? 'COALESCE(SUM(r.holistic_score),0)'
        : type === 'participation_days' ? 'COUNT(DISTINCT (r.user_id, r.created_at::date))' : 'COUNT(*)';
      const cur = Math.round(Number((await client.query(
        `SELECT ${metric} AS n FROM results r JOIN box_memberships m ON m.user_id = r.user_id WHERE m.box_id = $1`,
        [boxId])).rows[0].n));
      const roundTo = type === 'total_holistic_points' ? 500 : 5;
      const pad = type === 'total_holistic_points' ? 300 + Math.floor(frng() * 600) : 8 + Math.floor(frng() * 16);
      const target = Math.ceil((cur + pad) / roundTo) * roundTo;
      await client.query(
        `INSERT INTO team_goals (box_id, type, target, current, starts_at, ends_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
        [boxId, type, target, cur, ts(DAYS - 1), `${dayStr(-4)} 12:00:00`]);
    }

    // Shout-outs — public gratitude, seeded into box feeds.
    const SHOUT = [
      (t) => `huge thanks to @${t} for pushing me through today 🙌`,
      (t) => `couldn't have hit that PR without @${t}!`,
      (t) => `@${t} set the pace today — chasing you made me better`,
      (t) => `grateful for @${t}'s spot on the heavy sets 💪`,
    ];
    const shoutRows = [];
    for (const box of BOX_DEFS) {
      const roster = athletes.filter((a) => a.boxName === box.name);
      for (let i = 0; i < 2; i++) {
        const from = roster[Math.floor(frng() * roster.length)];
        const to = roster[Math.floor(frng() * roster.length)];
        if (!from || !to || from === to) continue;
        shoutRows.push([from.userId, 'shoutout',
          JSON.stringify({ to_user_id: to.userId, to_name: to.name, text: SHOUT[i % SHOUT.length](to.name.split(' ')[0]), seed: 'true' }),
          3 + Math.floor(frng() * 12), ts(Math.floor(frng() * 4))]);
      }
    }
    await bulkInsert(client, 'feed_events', ['user_id', 'type', 'payload', 'kudos', 'created_at'], shoutRows);

    // Coach announcements — box messages from a coach (elevated in the feed).
    const ANNOUNCE = [
      'Saturday throwdown — bring a partner! 💪',
      'Great week, team. Mobility class Friday at 6pm.',
      'New strength cycle starts Monday — let\'s build that engine.',
    ];
    const annRows = [];
    for (const box of BOX_DEFS) {
      const coach = (coachesByBox[box.name] || [])[0];
      if (!coach) continue;
      annRows.push([coach.userId, 'announcement',
        JSON.stringify({ text: ANNOUNCE[BOX_DEFS.indexOf(box) % ANNOUNCE.length], seed: 'true' }),
        5 + Math.floor(frng() * 20), ts(Math.floor(frng() * 3))]);
    }
    await bulkInsert(client, 'feed_events', ['user_id', 'type', 'payload', 'kudos', 'created_at'], annRows);

    // Newcomers — "new this week" members (recent join, no results yet), placed
    // into an auto-cohort "New Crew" squad so they're never alone.
    for (const box of BOX_DEFS) {
      const boxId = boxIds[box.name];
      const shortName = box.name.replace(/^(CrossFit|CF)\s+/i, '').replace(/\s+CrossFit$/i, '').trim() || box.name;
      const cohort = await client.query(
        `INSERT INTO squads (box_id, name, created_at) VALUES ($1, $2, now()) RETURNING id`,
        [boxId, `${shortName} — New Crew`]);
      const cohortId = cohort.rows[0].id;
      for (let i = 0; i < 2; i++) {
        const name = `${FIRST[(i * 9 + BOX_DEFS.indexOf(box) * 3) % FIRST.length]} ${LAST[(i * 7 + 2) % LAST.length]}`;
        const uid = await upsertUser(client, `new${i}.${slug(box.name)}@wurqdemo.io`);
        await upsertProfile(client, uid, { display_name: name, gym_name: box.name, exp: 'beginner' });
        await client.query(
          `INSERT INTO box_memberships (user_id, box_id, joined_at)
             VALUES ($1, $2, now() - ($3 || ' days')::interval)
             ON CONFLICT (user_id, box_id) DO UPDATE SET joined_at = EXCLUDED.joined_at`,
          [uid, boxId, String(1 + i)]);
        await client.query(
          `INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [cohortId, uid]);
      }
    }

    // ---- Referrals — community growth. Joined referrals link two members and
    // award points; a few pending invites per box keep the funnel visible.
    const refRows = [];
    const refPoints = {}; // user_id -> referral_points
    const add = (uid, pts) => { refPoints[uid] = (refPoints[uid] || 0) + pts; };
    for (const box of BOX_DEFS) {
      const boxId = boxIds[box.name];
      const roster = athletes.filter((a) => a.boxName === box.name);
      const joined = 5 + Math.floor(frng() * 6); // 5–10 joined referrals
      for (let i = 0; i < joined; i++) {
        const referrer = roster[Math.floor(frng() * roster.length)];
        const referred = roster[Math.floor(frng() * roster.length)];
        if (!referrer || !referred || referrer === referred) continue;
        refRows.push([referrer.userId, referred.email, referred.userId, 'joined', boxId, 50, ts(Math.floor(frng() * DAYS))]);
        add(referrer.userId, 50); add(referred.userId, 25);
      }
      for (let i = 0; i < 2; i++) {
        const referrer = roster[Math.floor(frng() * roster.length)];
        if (!referrer) continue;
        refRows.push([referrer.userId, `friend${i}.${slug(box.name)}@example.com`, null, 'pending', boxId, 0, ts(Math.floor(frng() * 6))]);
      }
    }
    await bulkInsert(client, 'referrals',
      ['referrer_user_id', 'referred_email', 'referred_user_id', 'status', 'box_id', 'points_awarded', 'created_at'], refRows);
    const rpRows = Object.entries(refPoints).map(([uid, pts]) => [uid, pts]);
    // Apply referral_points to profiles (upsert-safe; profiles already exist).
    for (let i = 0; i < rpRows.length; i += 500) {
      const chunk = rpRows.slice(i, i + 500);
      const vals = chunk.map((_, j) => `($${j * 2 + 1}::uuid, $${j * 2 + 2}::int)`).join(',');
      await client.query(
        `UPDATE profiles p SET referral_points = v.pts FROM (VALUES ${vals}) AS v(uid, pts)
           WHERE p.user_id = v.uid`, chunk.flat());
    }

    // ---- Follows — cross-box connections so the global "following" feels alive.
    const followRows = [];
    const seenF = new Set();
    const pushFollow = (a, b) => {
      if (a === b) return; const key = a + '|' + b; if (seenF.has(key)) return;
      seenF.add(key); followRows.push([a, b, ts(Math.floor(frng() * DAYS))]);
    };
    for (const a of athletes) {
      if (frng() > 0.45) continue; // ~45% of athletes follow others
      const others = athletes.filter((x) => x.boxName !== a.boxName);
      const n = 1 + Math.floor(frng() * 3);
      for (let i = 0; i < n; i++) pushFollow(a.userId, others[Math.floor(frng() * others.length)].userId);
    }
    // Ensure demo logins follow a few athletes at OTHER boxes.
    for (const p of DEMO_ATHLETES) {
      const me = athletes.find((x) => x.email === p.email); if (!me) continue;
      const others = athletes.filter((x) => x.boxName !== HOME_BOX);
      for (let i = 0; i < 4; i++) pushFollow(me.userId, others[Math.floor(frng() * others.length)].userId);
    }
    await bulkInsert(client, 'follows', ['follower_user_id', 'followee_user_id', 'created_at'], followRows,
      'ON CONFLICT (follower_user_id, followee_user_id) DO NOTHING');

    // ---- Comeback stories — athletes returning after a gap (emotional layer).
    const comebackRows = [];
    const pool2 = athletes.slice().sort(() => frng() - 0.5);
    for (let i = 0; i < 12; i++) {
      const a = pool2[i]; if (!a) continue;
      const gap = 7 + Math.floor(frng() * 14);
      comebackRows.push([a.userId, 'comeback',
        JSON.stringify({ gap_days: gap, workout_name: 'Fran', seed: 'true' }),
        8 + Math.floor(frng() * 25), ts(Math.floor(frng() * 5))]);
    }
    await bulkInsert(client, 'feed_events', ['user_id', 'type', 'payload', 'kudos', 'created_at'], comebackRows);

    // ---- Recurring competitions — a live slate + completed past with winners.
    const compFeed = []; // comp_win events
    // Community-wide slate.
    await insertComp(client, { scope: 'community', cadence: 'weekly', type: 'highest_avg', title: 'Community Engine ⚡ Highest Avg', window: 'this_week' });
    await insertComp(client, { scope: 'community', cadence: 'weekly', type: 'most_improved', title: 'Most Improved This Week 📈', window: 'this_week' });
    await insertComp(client, { scope: 'community', cadence: 'weekly', type: 'most_workouts', title: 'Grind Leaders 🔁 Most Workouts', window: 'this_week' });
    await insertComp(client, { scope: 'community', cadence: 'weekly', type: 'movement_specific', movement: 'Pull-ups', title: 'Pull-up Push 💪 (Weekly)', window: 'this_week' });
    await insertComp(client, { scope: 'community', cadence: 'monthly', type: 'highest_avg', title: 'WurQ Champion 🏆 (Monthly)', window: 'this_month' });
    await insertComp(client, { scope: 'community', cadence: 'monthly', type: 'most_consistent', title: 'Iron Habit 🔥 Most Consistent (Monthly)', window: 'this_month' });
    // Community completed (last week) + winners.
    for (const def of [
      { type: 'highest_avg', title: 'Community Engine ⚡ (last week)' },
      { type: 'most_improved', title: 'Most Improved 📈 (last week)' },
    ]) {
      const c = await insertComp(client, { scope: 'community', cadence: 'weekly', type: def.type, title: def.title, window: 'last_week', status: 'completed' });
      const w = await compWinner(client, c);
      if (w) {
        await client.query('UPDATE competitions SET winner_user_id = $1 WHERE id = $2', [w.user_id, c.id]);
        compFeed.push([w.user_id, 'comp_win', JSON.stringify({ title: def.title, type_label: 'Community', value: w.value, seed: 'true' }), 8 + Math.floor(frng() * 30), ts(Math.floor(1 + frng() * 3))]);
      }
    }
    // Per-box slate: weekly most_improved + most_workouts, monthly highest_avg,
    // plus a completed weekly most_improved (last week) with a winner.
    for (const box of BOX_DEFS) {
      const boxId = boxIds[box.name];
      const short = box.name.replace(/^(CrossFit|CF)\s+/i, '').replace(/\s+CrossFit$/i, '').trim() || box.name;
      await insertComp(client, { scope: 'box', boxId, cadence: 'weekly', type: 'most_improved', title: `${short} Most Improved 📈`, window: 'this_week' });
      await insertComp(client, { scope: 'box', boxId, cadence: 'weekly', type: 'most_workouts', title: `${short} Grind 🔁`, window: 'this_week' });
      await insertComp(client, { scope: 'box', boxId, cadence: 'monthly', type: 'highest_avg', title: `${short} Champion 🏆`, window: 'this_month' });
      const done = await insertComp(client, { scope: 'box', boxId, cadence: 'weekly', type: 'most_improved', title: `${short} Most Improved (last week)`, window: 'last_week', status: 'completed' });
      const w = await compWinner(client, done);
      if (w) {
        await client.query('UPDATE competitions SET winner_user_id = $1 WHERE id = $2', [w.user_id, done.id]);
        compFeed.push([w.user_id, 'comp_win', JSON.stringify({ title: `${short} Most Improved`, type_label: short, value: w.value, seed: 'true' }), 5 + Math.floor(frng() * 22), ts(Math.floor(1 + frng() * 3))]);
      }
    }
    await bulkInsert(client, 'feed_events', ['user_id', 'type', 'payload', 'kudos', 'created_at'], compFeed);

    // ---- Training partners — performance-based pairs (within-box + cross-box).
    const avgHol = (a) => (a.results.length ? a.results.reduce((s, r) => s + r.holistic, 0) / a.results.length : 0);
    const tpSeen = new Set();
    const tpRows = [];
    const tpFeed = [];
    const addPartner = (a, b, basis, withFeed = false) => {
      if (!a || !b || a === b) return;
      const [lo, hi] = canonPair(a.userId, b.userId);
      const key = lo + '|' + hi; if (tpSeen.has(key)) return; tpSeen.add(key);
      tpRows.push([lo, hi, basis, ts(Math.floor(frng() * DAYS))]);
      if (withFeed) tpFeed.push([a.userId, 'training_partner',
        JSON.stringify({ partner_name: b.name, partner_box: b.boxName, you_name: a.name, seed: 'true' }),
        2 + Math.floor(frng() * 10), ts(Math.floor(frng() * 5))]);
    };
    // Within-box: pair athletes of similar pace (adjacent after sorting by avg).
    for (const box of BOX_DEFS) {
      const roster = athletes.filter((a) => a.boxName === box.name && a.results.length >= 3)
        .sort((x, y) => avgHol(x) - avgHol(y));
      for (let i = 0; i + 1 < roster.length && i < 12; i += 2) addPartner(roster[i], roster[i + 1], 'similar pace', frng() < 0.4);
    }
    // Cross-box: similar pace across gyms (feeds the cross-box community).
    const byAvg = athletes.filter((a) => a.results.length >= 3).slice().sort((x, y) => avgHol(x) - avgHol(y));
    for (let n = 0; n < 14; n++) {
      const i = Math.floor(frng() * (byAvg.length - 1));
      const a = byAvg[i];
      // find a near neighbor in a different box
      let b = null;
      for (let j = i + 1; j < Math.min(byAvg.length, i + 8); j++) { if (byAvg[j].boxName !== a.boxName) { b = byAvg[j]; break; } }
      if (b) addPartner(a, b, 'similar pace · cross-box', frng() < 0.5);
    }
    // Guarantee the demo logins have partners (in-box + cross-box).
    if (matt && alex) addPartner(matt, alex, 'training partners at Borderland', true);
    if (matt) {
      const xb = athletes.find((a) => a.boxName !== HOME_BOX && a.results.length >= 5);
      if (xb) addPartner(matt, xb, 'similar pace · cross-box', true);
    }
    if (alex) {
      const inbox = athletes.find((a) => a.boxName === HOME_BOX && a !== alex && a !== matt && a.results.length >= 3);
      if (inbox) addPartner(alex, inbox, 'similar pace', false);
    }
    await bulkInsert(client, 'training_partners', ['a_user_id', 'b_user_id', 'basis', 'created_at'], tpRows,
      'ON CONFLICT (a_user_id, b_user_id) DO NOTHING');
    await bulkInsert(client, 'feed_events', ['user_id', 'type', 'payload', 'kudos', 'created_at'], tpFeed);

    // ---- Head-to-head matchups — active mid-flight + one completed (with feed).
    const h2hActiveStart = ts(3), h2hActiveEnd = `${dayStr(-4)} 12:00:00`;
    async function makeH2H(a, b, metric, startsAt, endsAt, status) {
      if (!a || !b) return null;
      const { rows } = await client.query(
        `INSERT INTO head_to_heads (a_user_id, b_user_id, metric, starts_at, ends_at, status)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [a.userId, b.userId, metric, startsAt, endsAt, status]);
      return rows[0].id;
    }
    const h2hFeed = [];
    // Active: matt vs a Borderland rival.
    const rival = athletes.find((a) => a.boxName === HOME_BOX && a !== matt && a !== alex && a.results.length >= 5);
    if (matt && rival) {
      const id = await makeH2H(matt, rival, 'highest_avg', h2hActiveStart, h2hActiveEnd, 'active');
      h2hFeed.push([matt.userId, 'h2h_start', JSON.stringify({ opponent_name: rival.name, metric: 'highest_avg', unit: 'avg score', seed: 'true' }), 3 + Math.floor(frng() * 8), ts(2)]);
    }
    // Active: two cross-box athletes.
    const xa = athletes.find((a) => a.boxName === 'Apex CrossFit' && a.results.length >= 5);
    const xb2 = athletes.find((a) => a.boxName === 'Iron Valley CrossFit' && a.results.length >= 5);
    if (xa && xb2) {
      await makeH2H(xa, xb2, 'most_workouts', h2hActiveStart, h2hActiveEnd, 'active');
      h2hFeed.push([xa.userId, 'h2h_start', JSON.stringify({ opponent_name: xb2.name, metric: 'most_workouts', unit: 'workouts', seed: 'true' }), 4 + Math.floor(frng() * 10), ts(3)]);
    }
    // Completed: alex vs a cross-box athlete, last week, with a winner.
    const past = athletes.find((a) => a.boxName === 'Rising Tide CrossFit' && a.results.length >= 5);
    if (alex && past) {
      const startsAt = ts(11), endsAt = ts(7);
      const id = await makeH2H(alex, past, 'highest_avg', startsAt, endsAt, 'completed');
      const st = (await client.query(
        `SELECT user_id, AVG(holistic_score) AS v FROM results WHERE user_id = ANY($1::uuid[]) AND created_at BETWEEN $2 AND $3 GROUP BY user_id`,
        [[alex.userId, past.userId], startsAt, endsAt])).rows;
      const winner = st.sort((p, q) => Number(q.v) - Number(p.v))[0];
      if (winner) {
        await client.query('UPDATE head_to_heads SET winner_user_id = $1 WHERE id = $2', [winner.user_id, id]);
        const wName = winner.user_id === alex.userId ? alex.name : past.name;
        const lName = winner.user_id === alex.userId ? past.name : alex.name;
        h2hFeed.push([winner.user_id, 'h2h_result', JSON.stringify({ opponent_name: lName, won: true, seed: 'true' }), 6 + Math.floor(frng() * 18), ts(6)]);
      }
    }
    await bulkInsert(client, 'feed_events', ['user_id', 'type', 'payload', 'kudos', 'created_at'], h2hFeed);

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
           (SELECT COUNT(*) FROM competitions)::int AS competitions,
           (SELECT COUNT(*) FROM training_partners)::int AS partners,
           (SELECT COUNT(*) FROM head_to_heads)::int AS h2h,
           (SELECT COUNT(*) FROM feed_events)::int AS feed,
           (SELECT COUNT(*) FROM user_badges)::int AS badges`);
  const c = t.rows[0];
  console.log(`[seed] world rebuilt — ${c.boxes} boxes, ${c.athletes} athletes, ${c.results} results, ` +
    `${c.workouts} workouts, ${c.challenges} challenges, ${c.competitions} competitions, ` +
    `${c.partners} training partners, ${c.h2h} head-to-heads, ${c.feed} feed events, ${c.badges} badge awards.`);
  console.log(`[seed] Demo box: "${HOME_BOX}". Demo logins: ${DEMO_ATHLETES.map((p) => `${p.email} (${p.name})`).join(', ')}.`);
}

// Exported so the server can auto-seed an empty database on startup, or backfill
// just the demo athlete on later boots. (main() shares the ./db pool and does NOT
// close it.) Run directly to seed manually.
module.exports = { runSeed: main, ensureDemoAthletes, DEMO_ATHLETES };

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch((err) => { console.error('[seed] failed:', err); pool.end(); process.exit(1); });
}
