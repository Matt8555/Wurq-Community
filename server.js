'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const { pool, migrate } = require('./db');
const { computeHolisticScore, computeBreakdown } = require('./holisticScore');
const { evaluateBadges } = require('./badges');
const { deriveMetrics } = require('./metrics');
const { runSeed, ensureDemoAthletes } = require('./seed');

const BENCHMARKS = ['Fran', 'Helen', 'Grace', 'Cindy', 'Diane', 'Annie', 'Karen', 'Jackie', 'Isabel', 'Amanda', 'Elizabeth', 'Randy', 'Nancy'];
const SEED_SENTINEL_BOX = 'CrossFit Borderland'; // presence = seeded world exists

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
let seeding = false; // true while the background seed is running

// Avatars are stored as base64 data URIs in profiles.avatar_url (Postgres),
// NOT on the local filesystem. This was chosen over a Railway volume because it
// needs zero infra config and survives redeploys (the container disk is
// ephemeral). Images are capped small (2 MB) to keep rows reasonable; a future
// scale step can move these to object storage / a CDN.
app.use(express.json({ limit: '4mb' }));

// ---- Avatar upload (multipart, kept in memory -> base64) --------------------
const ALLOWED_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image uploads are allowed (png, jpg, gif, webp).'));
  },
});

// ---- Validation helpers -----------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'RX', 'competitor'];
const UNITS = ['lb', 'kg'];

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const wrap = (h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next);

// Profile joined to the user's canonical box (most recent membership).
async function getProfileRow(userId) {
  const { rows } = await pool.query(
    `SELECT u.user_id, u.email,
            p.display_name, p.gym_name, p.avatar_url, p.bio,
            p.experience_level, p.primary_goals,
            COALESCE(p.units, 'lb')             AS units,
            COALESCE(p.profile_complete, false) AS profile_complete,
            COALESCE(p.referral_points, 0) AS referral_points,
            p.updated_at,
            b.box_id, b.name AS box_name,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = u.user_id AND br.box_id = b.box_id AND br.role IN ('coach','owner')) AS is_coach,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = u.user_id AND br.box_id = b.box_id AND br.role = 'owner') AS is_owner,
            ((SELECT COUNT(*) FROM squad_members sm WHERE sm.user_id = u.user_id)
              + (SELECT COUNT(*) FROM follows f WHERE f.follower_user_id = u.user_id))::int AS connection_count
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.user_id
       LEFT JOIN LATERAL (
         SELECT bx.box_id, bx.name
           FROM box_memberships m
           JOIN boxes bx ON bx.box_id = m.box_id
          WHERE m.user_id = u.user_id
          ORDER BY m.joined_at DESC
          LIMIT 1
       ) b ON true
      WHERE u.user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ---- Role helpers / gating --------------------------------------------------
async function rolesFor(userId, boxId) {
  if (!isUuid(userId) || !isUuid(boxId)) return [];
  const { rows } = await pool.query('SELECT role FROM box_roles WHERE user_id = $1 AND box_id = $2', [userId, boxId]);
  return rows.map((r) => r.role);
}
const hasCoach = (roles) => roles.includes('coach') || roles.includes('owner');

// ---- API: users -------------------------------------------------------------
app.post('/api/users', wrap(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });

  const inserted = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO NOTHING
       RETURNING user_id, email, status, created_at`,
    [email]
  );

  let user, created;
  if (inserted.rows[0]) {
    user = inserted.rows[0];
    created = true;
    await pool.query(
      `INSERT INTO identities (user_id, provider, provider_user_id, email)
         VALUES ($1, 'email', $2, $2)
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [user.user_id, email]
    );
    await pool.query(
      `INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [user.user_id]
    );
  } else {
    const found = await pool.query(
      `SELECT user_id, email, status, created_at FROM users WHERE email = $1`, [email]);
    user = found.rows[0];
    created = false;
  }

  // Fulfill any pending referral for this email when the friend first joins.
  let referral = null;
  if (created) {
    const pend = await pool.query(
      `SELECT id, referrer_user_id, box_id FROM referrals
        WHERE lower(referred_email) = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1`, [email]);
    if (pend.rows[0]) {
      const ref = pend.rows[0];
      await pool.query(
        `UPDATE referrals SET status = 'joined', referred_user_id = $2, points_awarded = $3 WHERE id = $1`,
        [ref.id, user.user_id, REFERRER_POINTS]);
      // Award both (one level only): referrer + a thank-you to the referred.
      await pool.query('UPDATE profiles SET referral_points = referral_points + $2 WHERE user_id = $1', [ref.referrer_user_id, REFERRER_POINTS]);
      await pool.query('UPDATE profiles SET referral_points = referral_points + $2 WHERE user_id = $1', [user.user_id, REFERRED_POINTS]);
      // Land the new athlete in the referrer's box.
      if (ref.box_id) {
        const bx = await pool.query('SELECT name FROM boxes WHERE box_id = $1', [ref.box_id]);
        await pool.query(
          `INSERT INTO box_memberships (user_id, box_id) VALUES ($1, $2) ON CONFLICT (user_id, box_id) DO NOTHING`,
          [user.user_id, ref.box_id]);
        if (bx.rows[0]) await pool.query(
          `UPDATE profiles SET gym_name = COALESCE(NULLIF(gym_name,''), $2) WHERE user_id = $1`, [user.user_id, bx.rows[0].name]);
      }
      const refName = (await pool.query(
        `SELECT COALESCE(NULLIF(p.display_name,''),'A teammate') AS n FROM profiles p WHERE p.user_id = $1`,
        [ref.referrer_user_id])).rows[0];
      await pool.query(
        `INSERT INTO feed_events (user_id, type, payload) VALUES ($1, 'referral_joined', $2)`,
        [ref.referrer_user_id, JSON.stringify({ referred_email: email, points: REFERRER_POINTS })]);
      referral = { referred_by: refName ? refName.n : 'A teammate', points: REFERRED_POINTS };
    }
  }

  res.status(created ? 201 : 200).json({ user_id: user.user_id, email: user.email, created, referral });
}));

// ---- API: get profile -------------------------------------------------------
app.get('/api/profile/:userId', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const row = await getProfileRow(userId);
  if (!row) return res.status(404).json({ error: 'User not found.' });
  res.json(row);
}));

// ---- API: create/update profile (syncs the canonical box) -------------------
app.put('/api/profile/:userId', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });

  const userExists = await pool.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
  if (!userExists.rows[0]) return res.status(404).json({ error: 'User not found.' });

  const body = req.body || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? null : String(v));

  const display_name = str(body.display_name);
  const gym_name = str(body.gym_name);
  const avatar_url = str(body.avatar_url);
  const bio = str(body.bio);
  const primary_goals = str(body.primary_goals);
  const experience_level = str(body.experience_level);
  let units = str(body.units);

  if (experience_level && !EXPERIENCE_LEVELS.includes(experience_level)) {
    return res.status(400).json({ error: `experience_level must be one of: ${EXPERIENCE_LEVELS.join(', ')}.` });
  }
  if (!units) units = 'lb';
  if (!UNITS.includes(units)) {
    return res.status(400).json({ error: `units must be one of: ${UNITS.join(', ')}.` });
  }
  if (bio && bio.length > 1000) {
    return res.status(400).json({ error: 'bio must be 1000 characters or fewer.' });
  }

  const profile_complete = Boolean(display_name && gym_name);

  await pool.query(
    `INSERT INTO profiles
        (user_id, display_name, gym_name, avatar_url, bio,
         experience_level, primary_goals, units, profile_complete, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (user_id) DO UPDATE SET
         display_name     = EXCLUDED.display_name,
         gym_name         = EXCLUDED.gym_name,
         avatar_url       = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
         bio              = EXCLUDED.bio,
         experience_level = EXCLUDED.experience_level,
         primary_goals    = EXCLUDED.primary_goals,
         units            = EXCLUDED.units,
         profile_complete = EXCLUDED.profile_complete,
         updated_at       = now()`,
    [userId, display_name, gym_name, avatar_url, bio,
     experience_level || null, primary_goals, units, profile_complete]
  );

  // Keep the canonical box in sync with the gym/box text. boxes is the source of
  // truth going forward; gym_name remains as the display field.
  if (gym_name) {
    const box = await pool.query(
      `INSERT INTO boxes (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING box_id`,
      [gym_name]
    );
    const boxId = box.rows[0].box_id;
    await pool.query(
      `INSERT INTO box_memberships (user_id, box_id) VALUES ($1, $2)
         ON CONFLICT (user_id, box_id) DO NOTHING`,
      [userId, boxId]
    );
    // One canonical box per athlete: drop memberships to any other box.
    await pool.query(
      `DELETE FROM box_memberships WHERE user_id = $1 AND box_id <> $2`, [userId, boxId]);
  }

  res.json(await getProfileRow(userId));
}));

// ---- API: avatar upload -----------------------------------------------------
app.post('/api/profile/:userId/avatar', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const userExists = await pool.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
  if (!userExists.rows[0]) return res.status(404).json({ error: 'User not found.' });

  await new Promise((resolve, reject) => {
    upload.single('avatar')(req, res, (err) => (err ? reject(err) : resolve()));
  });
  if (!req.file) return res.status(400).json({ error: 'No image file received (field name: "avatar").' });

  // Store the image inline as a base64 data URI so it persists in Postgres.
  const avatar_url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  await pool.query(
    `INSERT INTO profiles (user_id, avatar_url, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
    [userId, avatar_url]
  );
  res.status(201).json({ avatar_url });
}));

// ---- API: today's WOD (seeds Fran if missing) -------------------------------
app.get('/api/wod/today', wrap(async (req, res) => {
  await pool.query(
    `INSERT INTO workouts (name, type, description, wod_date)
       SELECT 'Fran', 'For Time',
              '21-15-9 reps for time: Thrusters (95/65 lb) and Pull-ups.', CURRENT_DATE
       WHERE NOT EXISTS (SELECT 1 FROM workouts WHERE name = 'Fran' AND wod_date = CURRENT_DATE)`
  );
  const { rows } = await pool.query(
    `SELECT w.workout_id, w.name, w.type, w.description, w.scaling, w.wod_date,
            w.programmed_by, COALESCE(NULLIF(p.display_name,''), NULL) AS programmed_by_name
       FROM workouts w
       LEFT JOIN profiles p ON p.user_id = w.programmed_by
      ORDER BY (w.wod_date = CURRENT_DATE) DESC, w.wod_date DESC
      LIMIT 1`
  );
  res.json(rows[0]);
}));

// ---- API: submit a result ---------------------------------------------------
// Computes the Holistic Score server-side, saves the result, writes a feed
// event, and evaluates badges — all in one transaction.
app.post('/api/results', wrap(async (req, res) => {
  const body = req.body || {};
  const userId = body.userId || body.user_id;
  const workoutId = body.workoutId || body.workout_id;

  if (!isUuid(userId)) return res.status(400).json({ error: 'A valid userId is required.' });
  if (!isUuid(workoutId)) return res.status(400).json({ error: 'A valid workoutId is required.' });

  const time_seconds = Number(body.time_seconds);
  const rom_pct = Number(body.rom_pct);
  const unbroken_sets = Number(body.unbroken_sets);

  if (!Number.isFinite(time_seconds) || time_seconds <= 0 || time_seconds > 86400) {
    return res.status(400).json({ error: 'time_seconds must be a number between 1 and 86400.' });
  }
  if (!Number.isFinite(rom_pct) || rom_pct < 0 || rom_pct > 100) {
    return res.status(400).json({ error: 'rom_pct must be between 0 and 100.' });
  }
  if (!Number.isInteger(unbroken_sets) || unbroken_sets < 0 || unbroken_sets > 1000) {
    return res.status(400).json({ error: 'unbroken_sets must be a whole number between 0 and 1000.' });
  }

  const userExists = await pool.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
  if (!userExists.rows[0]) return res.status(404).json({ error: 'User not found.' });
  const workoutRow = await pool.query(
    'SELECT workout_id, name FROM workouts WHERE workout_id = $1', [workoutId]);
  if (!workoutRow.rows[0]) return res.status(404).json({ error: 'Workout not found.' });
  const workout = workoutRow.rows[0];

  const holistic_score = computeHolisticScore({ time_seconds, rom_pct, unbroken_sets });
  const metrics = deriveMetrics({ workoutName: workout.name, time_seconds, rom_pct, unbroken_sets });

  // PR detection — compare against the athlete's PRIOR history (other workouts).
  const prevBest = await pool.query(
    `SELECT MAX(holistic_score)::float AS best_holistic,
            MIN(r.time_seconds) FILTER (WHERE w.name = $3 AND r.workout_id <> $2)::int AS best_same
       FROM results r JOIN workouts w ON w.workout_id = r.workout_id
      WHERE r.user_id = $1 AND r.workout_id <> $2`,
    [userId, workoutId, workout.name]);
  const prevHolistic = prevBest.rows[0].best_holistic;
  const prevSame = prevBest.rows[0].best_same;
  const prs = [];
  if (prevHolistic != null && holistic_score > prevHolistic) {
    prs.push({ type: 'holistic', label: 'Best Holistic Score',
      message: `New best Holistic Score: ${holistic_score} (+${Math.round((holistic_score - prevHolistic) * 10) / 10})`,
      improvement: Math.round((holistic_score - prevHolistic) * 10) / 10 });
  }
  if (prevSame != null && time_seconds < prevSame && BENCHMARKS.includes(workout.name)) {
    prs.push({ type: 'benchmark_time', label: `Fastest ${workout.name}`,
      message: `You beat your ${workout.name} time by ${prevSame - time_seconds}s!`,
      improvement: prevSame - time_seconds });
  }

  // Comeback detection — returning after a 7+ day gap.
  const lastSeen = await pool.query(
    `SELECT MAX(created_at) AS last FROM results WHERE user_id = $1 AND workout_id <> $2`, [userId, workoutId]);
  let comeback = null;
  if (lastSeen.rows[0].last) {
    const gapDays = Math.floor((Date.now() - new Date(lastSeen.rows[0].last)) / 86400000);
    if (gapDays >= 7) comeback = { gap_days: gapDays, message: `You're back after ${gapDays} days! 🔥` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const saved = await client.query(
      `INSERT INTO results (user_id, workout_id, time_seconds, rom_pct, unbroken_sets, holistic_score,
                            avg_hr, peak_hr, calories, power_output, work_volume, movements)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (user_id, workout_id) DO UPDATE SET
           time_seconds   = EXCLUDED.time_seconds,
           rom_pct        = EXCLUDED.rom_pct,
           unbroken_sets  = EXCLUDED.unbroken_sets,
           holistic_score = EXCLUDED.holistic_score,
           avg_hr = EXCLUDED.avg_hr, peak_hr = EXCLUDED.peak_hr, calories = EXCLUDED.calories,
           power_output = EXCLUDED.power_output, work_volume = EXCLUDED.work_volume,
           movements = EXCLUDED.movements, created_at = now()
         RETURNING result_id, user_id, workout_id, time_seconds, rom_pct, unbroken_sets, holistic_score, created_at`,
      [userId, workoutId, time_seconds, rom_pct, unbroken_sets, holistic_score,
       metrics.avg_hr, metrics.peak_hr, metrics.calories, metrics.power_output, metrics.work_volume,
       JSON.stringify(metrics.movements)]
    );
    const result = saved.rows[0];

    await client.query(
      `INSERT INTO feed_events (user_id, type, ref_id, payload)
         VALUES ($1, 'result_logged', $2, $3)`,
      [userId, result.result_id,
       JSON.stringify({
         workout_id: workout.workout_id,
         workout_name: workout.name,
         holistic_score: result.holistic_score,
         time_seconds: result.time_seconds,
       })]
    );

    // A PR is its own celebratory feed event.
    for (const pr of prs) {
      await client.query(
        `INSERT INTO feed_events (user_id, type, ref_id, payload)
           VALUES ($1, 'pr', $2, $3)`,
        [userId, result.result_id,
         JSON.stringify({ workout_name: workout.name, label: pr.label, message: pr.message })]);
    }

    if (comeback) {
      await client.query(
        `INSERT INTO feed_events (user_id, type, ref_id, payload) VALUES ($1, 'comeback', $2, $3)`,
        [userId, result.result_id, JSON.stringify({ gap_days: comeback.gap_days, workout_name: workout.name })]);
    }

    const newBadges = await evaluateBadges(client, { userId, result, workout });

    await client.query('COMMIT');
    res.status(201).json({ result, newBadges, prs, comeback });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ---- API: in-box leaderboard ------------------------------------------------
app.get('/api/leaderboard/box/:boxId/:workoutId', wrap(async (req, res) => {
  const { boxId, workoutId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  if (!isUuid(workoutId)) return res.status(400).json({ error: 'Invalid workout id.' });

  const box = await pool.query('SELECT box_id, name FROM boxes WHERE box_id = $1', [boxId]);
  if (!box.rows[0]) return res.status(404).json({ error: 'Box not found.' });

  const { rows } = await pool.query(
    `SELECT r.user_id,
            COALESCE(NULLIF(p.display_name, ''), 'Athlete') AS display_name,
            p.avatar_url,
            r.time_seconds, r.rom_pct, r.unbroken_sets, r.holistic_score, r.created_at,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = r.user_id AND br.box_id = $1 AND br.role IN ('coach','owner')) AS is_coach
       FROM box_memberships m
       JOIN results r ON r.user_id = m.user_id AND r.workout_id = $2
       LEFT JOIN profiles p ON p.user_id = r.user_id
      WHERE m.box_id = $1
      ORDER BY r.holistic_score DESC NULLS LAST, r.time_seconds ASC`,
    [boxId, workoutId]
  );
  res.json({ box: box.rows[0], results: rows });
}));

// ---- API: box-vs-box --------------------------------------------------------
// score = (avg holistic_score of members who logged) × (participation rate).
// Shared by the athlete board, the owner competition screen, and the dashboard.
async function computeBoxStandings(workoutId) {
  const { rows } = await pool.query(
    `SELECT b.box_id, b.name,
            COUNT(DISTINCT m.user_id)::int AS total_members,
            COUNT(DISTINCT r.user_id)::int AS logged_members,
            AVG(r.holistic_score)          AS avg_score
       FROM boxes b
       JOIN box_memberships m ON m.box_id = b.box_id
       LEFT JOIN results r ON r.user_id = m.user_id AND r.workout_id = $1
      GROUP BY b.box_id, b.name`,
    [workoutId]
  );
  return rows.map((b) => {
    const avg = b.avg_score == null ? 0 : Number(b.avg_score);
    const participation = b.total_members > 0 ? b.logged_members / b.total_members : 0;
    return {
      box_id: b.box_id,
      name: b.name,
      total_members: b.total_members,
      logged_members: b.logged_members,
      avg_score: Math.round(avg * 10) / 10,
      participation: Math.round(participation * 100) / 100,
      score: Math.round(avg * participation * 10) / 10,
    };
  }).sort((a, b) => b.score - a.score);
}

app.get('/api/leaderboard/boxes/:workoutId', wrap(async (req, res) => {
  const { workoutId } = req.params;
  if (!isUuid(workoutId)) return res.status(400).json({ error: 'Invalid workout id.' });
  res.json({ boxes: await computeBoxStandings(workoutId) });
}));

// ---- API: list workouts + boxes (pickers) -----------------------------------
app.get('/api/workouts', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT workout_id, name, type, description, wod_date
       FROM workouts ORDER BY wod_date DESC, name LIMIT 50`);
  res.json({ workouts: rows });
}));

app.get('/api/boxes', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.box_id, b.name, b.location,
            COUNT(m.user_id)::int AS member_count
       FROM boxes b
       LEFT JOIN box_memberships m ON m.box_id = b.box_id
      GROUP BY b.box_id, b.name, b.location
      ORDER BY b.name`);
  res.json({ boxes: rows });
}));

// ---- API: box feed ----------------------------------------------------------
app.get('/api/feed/box/:boxId', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });

  const box = await pool.query('SELECT box_id, name FROM boxes WHERE box_id = $1', [boxId]);
  if (!box.rows[0]) return res.status(404).json({ error: 'Box not found.' });

  const { rows } = await pool.query(
    `SELECT f.event_id, f.user_id, f.type, f.ref_id, f.payload, f.kudos, f.created_at,
            COALESCE(NULLIF(p.display_name, ''), 'Athlete') AS display_name,
            p.avatar_url,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = f.user_id AND br.box_id = $1 AND br.role IN ('coach','owner')) AS is_coach
       FROM feed_events f
       JOIN box_memberships m ON m.user_id = f.user_id
       LEFT JOIN profiles p ON p.user_id = f.user_id
      WHERE m.box_id = $1
      ORDER BY f.created_at DESC
      LIMIT 50`,
    [boxId]
  );
  res.json({ box: box.rows[0], events: rows });
}));

// ---- API: kudos -------------------------------------------------------------
app.post('/api/feed/:eventId/kudos', wrap(async (req, res) => {
  const { eventId } = req.params;
  if (!isUuid(eventId)) return res.status(400).json({ error: 'Invalid event id.' });
  const { rows } = await pool.query(
    'UPDATE feed_events SET kudos = kudos + 1 WHERE event_id = $1 RETURNING event_id, kudos',
    [eventId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Event not found.' });
  res.json(rows[0]);
}));

// ---- API: owner dashboard ---------------------------------------------------
// Everything an owner needs at a glance for one box: participation, box-vs-box
// rank + rival gap, churn-risk (quiet 10+ days), and hot streaks this week.
app.get('/api/owner/box/:boxId/dashboard', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });

  const box = await pool.query('SELECT box_id, name, location FROM boxes WHERE box_id = $1', [boxId]);
  if (!box.rows[0]) return res.status(404).json({ error: 'Box not found.' });

  // Today's WOD (the active box-vs-box competition).
  await pool.query(
    `INSERT INTO workouts (name, type, description, wod_date)
       SELECT 'Fran', 'For Time', '21-15-9 reps for time: Thrusters (95/65 lb) and Pull-ups.', CURRENT_DATE
       WHERE NOT EXISTS (SELECT 1 FROM workouts WHERE name = 'Fran' AND wod_date = CURRENT_DATE)`);
  const wodRow = await pool.query(
    `SELECT workout_id, name FROM workouts ORDER BY (wod_date = CURRENT_DATE) DESC, wod_date DESC LIMIT 1`);
  const wod = wodRow.rows[0];

  const [participation, churn, streaks] = await Promise.all([
    pool.query(
      `SELECT (SELECT COUNT(*)::int FROM box_memberships WHERE box_id = $1) AS total_members,
              COUNT(DISTINCT r.user_id) FILTER (WHERE r.created_at::date = CURRENT_DATE)::int AS trained_today,
              COUNT(DISTINCT r.user_id) FILTER (WHERE r.created_at >= now() - interval '7 days')::int AS trained_week
         FROM box_memberships m
         LEFT JOIN results r ON r.user_id = m.user_id
        WHERE m.box_id = $1`, [boxId]),
    pool.query(
      `SELECT m.user_id,
              COALESCE(NULLIF(p.display_name, ''), 'Athlete') AS display_name,
              (CURRENT_DATE - MAX(r.created_at)::date) AS days_since
         FROM box_memberships m
         LEFT JOIN profiles p ON p.user_id = m.user_id
         LEFT JOIN results r ON r.user_id = m.user_id
        WHERE m.box_id = $1 AND m.joined_at < now() - interval '10 days'
        GROUP BY m.user_id, p.display_name
       HAVING MAX(r.created_at) IS NULL OR MAX(r.created_at) < now() - interval '10 days'
        ORDER BY days_since DESC NULLS FIRST
        LIMIT 8`, [boxId]),
    pool.query(
      `SELECT m.user_id,
              COALESCE(NULLIF(p.display_name, ''), 'Athlete') AS display_name,
              COUNT(DISTINCT r.created_at::date)::int AS days_this_week
         FROM box_memberships m
         LEFT JOIN profiles p ON p.user_id = m.user_id
         JOIN results r ON r.user_id = m.user_id AND r.created_at >= now() - interval '7 days'
        WHERE m.box_id = $1
        GROUP BY m.user_id, p.display_name
       HAVING COUNT(DISTINCT r.created_at::date) >= 2
        ORDER BY days_this_week DESC, display_name
        LIMIT 6`, [boxId]),
  ]);

  // Box-vs-box rank + gap to the box directly ahead.
  const standings = await computeBoxStandings(wod.workout_id);
  const pos = standings.findIndex((b) => b.box_id === boxId);
  const me = pos >= 0 ? standings[pos] : null;
  const ahead = pos > 0 ? standings[pos - 1] : null;
  const rank = me ? {
    position: pos + 1,
    total_boxes: standings.length,
    score: me.score,
    workout_name: wod.name,
    ahead: ahead ? { name: ahead.name, score: ahead.score, gap: Math.round((ahead.score - me.score) * 10) / 10 } : null,
  } : null;

  res.json({
    box: box.rows[0],
    participation: participation.rows[0],
    rank,
    churn: churn.rows.map((c) => ({ ...c, days_since: c.days_since == null ? null : Number(c.days_since) })),
    streaks: streaks.rows,
  });
}));

// ---- API: challenges --------------------------------------------------------
app.post('/api/challenges', wrap(async (req, res) => {
  const b = req.body || {};
  const challenger = b.challengerBoxId || b.challenger_box_id;
  const opponent = b.opponentBoxId || b.opponent_box_id;
  const workoutId = b.workoutId || b.workout_id;
  if (!isUuid(challenger)) return res.status(400).json({ error: 'A valid challengerBoxId is required.' });
  if (!isUuid(opponent)) return res.status(400).json({ error: 'A valid opponentBoxId is required.' });
  if (challenger === opponent) return res.status(400).json({ error: 'A box cannot challenge itself.' });
  if (!isUuid(workoutId)) return res.status(400).json({ error: 'A valid workoutId is required.' });

  const startsAt = b.startsAt || b.starts_at;
  const endsAt = b.endsAt || b.ends_at;
  const start = startsAt ? new Date(startsAt) : new Date();
  const end = endsAt ? new Date(endsAt) : new Date(Date.now() + 7 * 86400000);
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ error: 'Invalid start/end date.' });
  if (end <= start) return res.status(400).json({ error: 'ends_at must be after starts_at.' });

  const check = await pool.query(
    `SELECT
       (SELECT 1 FROM boxes WHERE box_id = $1) AS c,
       (SELECT 1 FROM boxes WHERE box_id = $2) AS o,
       (SELECT 1 FROM workouts WHERE workout_id = $3) AS w`,
    [challenger, opponent, workoutId]);
  if (!check.rows[0].c || !check.rows[0].o) return res.status(404).json({ error: 'Box not found.' });
  if (!check.rows[0].w) return res.status(404).json({ error: 'Workout not found.' });

  const { rows } = await pool.query(
    `INSERT INTO challenges (challenger_box_id, opponent_box_id, workout_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING id, challenger_box_id, opponent_box_id, workout_id, starts_at, ends_at, status, created_at`,
    [challenger, opponent, workoutId, start.toISOString(), end.toISOString()]);
  res.status(201).json(rows[0]);
}));

app.get('/api/challenges/box/:boxId', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const { rows } = await pool.query(
    `SELECT c.id, c.challenger_box_id, c.opponent_box_id, c.workout_id,
            c.starts_at, c.ends_at, c.status, c.created_at,
            cb.name AS challenger_name, ob.name AS opponent_name, w.name AS workout_name
       FROM challenges c
       JOIN boxes cb ON cb.box_id = c.challenger_box_id
       JOIN boxes ob ON ob.box_id = c.opponent_box_id
       JOIN workouts w ON w.workout_id = c.workout_id
      WHERE c.challenger_box_id = $1 OR c.opponent_box_id = $1
      ORDER BY c.created_at DESC`, [boxId]);
  res.json({ challenges: rows });
}));

// Head-to-head: each box's avg score × participation for the challenge WOD,
// restricted to results logged within the challenge window.
app.get('/api/challenges/:id/standing', wrap(async (req, res) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ error: 'Invalid challenge id.' });

  const c = await pool.query(
    `SELECT c.*, cb.name AS challenger_name, ob.name AS opponent_name, w.name AS workout_name
       FROM challenges c
       JOIN boxes cb ON cb.box_id = c.challenger_box_id
       JOIN boxes ob ON ob.box_id = c.opponent_box_id
       JOIN workouts w ON w.workout_id = c.workout_id
      WHERE c.id = $1`, [id]);
  if (!c.rows[0]) return res.status(404).json({ error: 'Challenge not found.' });
  const ch = c.rows[0];

  async function sideStanding(boxId) {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM box_memberships WHERE box_id = $1) AS total_members,
              COUNT(DISTINCT r.user_id)::int AS logged_members,
              AVG(r.holistic_score) AS avg_score
         FROM box_memberships m
         LEFT JOIN results r ON r.user_id = m.user_id
              AND r.workout_id = $2
              AND r.created_at BETWEEN $3 AND $4
        WHERE m.box_id = $1`,
      [boxId, ch.workout_id, ch.starts_at, ch.ends_at]);
    const row = rows[0];
    const avg = row.avg_score == null ? 0 : Number(row.avg_score);
    const participation = row.total_members > 0 ? row.logged_members / row.total_members : 0;
    return {
      total_members: row.total_members,
      logged_members: row.logged_members,
      avg_score: Math.round(avg * 10) / 10,
      participation: Math.round(participation * 100) / 100,
      score: Math.round(avg * participation * 10) / 10,
    };
  }

  const [challenger, opponent] = await Promise.all([
    sideStanding(ch.challenger_box_id), sideStanding(ch.opponent_box_id)]);

  res.json({
    challenge: {
      id: ch.id, status: ch.status, starts_at: ch.starts_at, ends_at: ch.ends_at,
      workout_name: ch.workout_name,
      challenger_box_id: ch.challenger_box_id, challenger_name: ch.challenger_name,
      opponent_box_id: ch.opponent_box_id, opponent_name: ch.opponent_name,
    },
    challenger: { box_id: ch.challenger_box_id, name: ch.challenger_name, ...challenger },
    opponent: { box_id: ch.opponent_box_id, name: ch.opponent_name, ...opponent },
  });
}));

// ---- API: athlete training history + detail ---------------------------------
const dminus = (str, n) => { const [y, m, d] = str.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10); };
const toDate = (v) => new Date(v).toISOString().slice(0, 10);

app.get('/api/athlete/:userId/history', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const { rows } = await pool.query(
    `SELECT r.result_id, w.name, w.type, w.wod_date, r.holistic_score, r.time_seconds
       FROM results r JOIN workouts w ON w.workout_id = r.workout_id
      WHERE r.user_id = $1
      ORDER BY w.wod_date DESC, r.created_at DESC`, [userId]);
  res.json({ sessions: rows.map((r) => ({ ...r, wod_date: toDate(r.wod_date), holistic_score: Number(r.holistic_score) })) });
}));

app.get('/api/athlete/:userId/session/:resultId', wrap(async (req, res) => {
  const { userId, resultId } = req.params;
  if (!isUuid(userId) || !isUuid(resultId)) return res.status(400).json({ error: 'Invalid id.' });
  const { rows } = await pool.query(
    `SELECT r.result_id, r.time_seconds, r.rom_pct, r.unbroken_sets, r.holistic_score,
            r.avg_hr, r.peak_hr, r.calories, r.power_output, r.work_volume, r.movements, r.created_at,
            w.name, w.type, w.description, w.wod_date
       FROM results r JOIN workouts w ON w.workout_id = r.workout_id
      WHERE r.user_id = $1 AND r.result_id = $2`, [userId, resultId]);
  if (!rows[0]) return res.status(404).json({ error: 'Session not found.' });
  const s = rows[0];
  res.json({
    session: {
      result_id: s.result_id, name: s.name, type: s.type, description: s.description,
      wod_date: toDate(s.wod_date),
      time_seconds: s.time_seconds, rom_pct: Number(s.rom_pct), unbroken_sets: s.unbroken_sets,
      holistic_score: Number(s.holistic_score),
      avg_hr: s.avg_hr, peak_hr: s.peak_hr, calories: s.calories,
      power_output: s.power_output == null ? null : Number(s.power_output),
      work_volume: s.work_volume == null ? null : Number(s.work_volume),
      movements: s.movements || [],
      breakdown: computeBreakdown({ time_seconds: s.time_seconds, rom_pct: Number(s.rom_pct), unbroken_sets: s.unbroken_sets }),
    },
  });
}));

// ---- API: athlete profile bundle (PRs, trends, streak, comparison, ...) ------
app.get('/api/athlete/:userId/profile', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });

  const prof = await getProfileRow(userId);
  if (!prof) return res.status(404).json({ error: 'User not found.' });

  const todayStr = (await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d;

  const rowsRes = await pool.query(
    `SELECT r.result_id, w.name, w.type, w.wod_date, r.holistic_score, r.time_seconds,
            r.power_output, r.movements
       FROM results r JOIN workouts w ON w.workout_id = r.workout_id
      WHERE r.user_id = $1
      ORDER BY w.wod_date ASC`, [userId]);
  const R = rowsRes.rows.map((r) => ({
    result_id: r.result_id, name: r.name, type: r.type, date: toDate(r.wod_date),
    score: Number(r.holistic_score), time: r.time_seconds,
    power: r.power_output == null ? 0 : Number(r.power_output), movements: r.movements || [],
  }));

  const dateSet = new Set(R.map((r) => r.date));
  // current streak (counts from today, or yesterday if not trained today yet)
  const trained_today = dateSet.has(todayStr);
  let anchor = trained_today ? 0 : (dateSet.has(dminus(todayStr, 1)) ? 1 : null);
  let current_streak = 0;
  if (anchor !== null) { let i = anchor; while (dateSet.has(dminus(todayStr, i))) { current_streak++; i++; } }
  // longest streak overall
  const sortedDates = [...dateSet].sort();
  let longest = 0, run = 0, prev = null;
  for (const d of sortedDates) {
    run = (prev && dminus(d, 1) === prev) ? run + 1 : 1;
    longest = Math.max(longest, run); prev = d;
  }

  // heatmap: last 35 days, best score per day
  const bestByDate = {};
  for (const r of R) bestByDate[r.date] = Math.max(bestByDate[r.date] || 0, r.score);
  const heatmap = [];
  for (let i = 34; i >= 0; i--) { const d = dminus(todayStr, i); heatmap.push({ date: d, score: bestByDate[d] || 0 }); }

  // trend (chronological session scores)
  const trend = R.map((r) => ({ date: r.date, score: r.score }));

  // weekly delta
  const inRange = (d, a, b) => { for (let i = a; i < b; i++) if (dminus(todayStr, i) === d) return true; return false; };
  const avgOf = (a, b) => { const xs = R.filter((r) => inRange(r.date, a, b)); return xs.length ? Math.round(xs.reduce((s, r) => s + r.score, 0) / xs.length * 10) / 10 : null; };
  const this_week_avg = avgOf(0, 7), last_week_avg = avgOf(7, 14);

  // workload by movement category
  const cat = {};
  for (const r of R) for (const m of r.movements) cat[m.cat] = (cat[m.cat] || 0) + (m.reps || 0);
  const totalReps = Object.values(cat).reduce((s, n) => s + n, 0) || 1;
  const workload = Object.entries(cat).map(([category, reps]) => ({ category, reps, pct: Math.round(100 * reps / totalReps) }))
    .sort((a, b) => b.reps - a.reps);

  // PRs
  let bestH = null, bestP = null;
  for (const r of R) {
    if (!bestH || r.score > bestH.score) bestH = { score: r.score, name: r.name, date: r.date };
    if (!bestP || r.power > bestP.power) bestP = { power: r.power, name: r.name, date: r.date };
  }
  const fastest = [];
  const benchHistory = {};
  for (const r of R) {
    if (!BENCHMARKS.includes(r.name)) continue;
    (benchHistory[r.name] = benchHistory[r.name] || { name: r.name, type: r.type, history: [] })
      .history.push({ date: r.date, time: r.time, score: r.score });
  }
  for (const name of Object.keys(benchHistory)) {
    const h = benchHistory[name].history;
    const best = h.reduce((m, x) => (x.time < m.time ? x : m), h[0]);
    fastest.push({ name, time: best.time, date: best.date });
  }
  fastest.sort((a, b) => a.name.localeCompare(b.name));
  const benchmarks = Object.values(benchHistory).filter((b) => b.history.length >= 2);

  // Comparison percentiles (box, experience level, Fran-vs-level)
  async function pctl(sql, params) { const { rows } = await pool.query(sql, params); return rows[0]; };
  let comparison = { box: null, exp: null, fran: null };
  if (R.length && prof.box_id) {
    const box = await pctl(
      `WITH a AS (SELECT m.user_id, AVG(r.holistic_score) v FROM box_memberships m
         JOIN results r ON r.user_id = m.user_id WHERE m.box_id = $1 GROUP BY m.user_id)
       SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE v < (SELECT v FROM a WHERE user_id = $2))::int below FROM a`,
      [prof.box_id, userId]);
    comparison.box = { total: box.total, top_pct: box.total > 1 ? Math.max(1, Math.round(100 * (box.total - 1 - box.below) / (box.total - 1))) : 1 };

    const lvl = prof.experience_level || 'RX';
    const exp = await pctl(
      `WITH a AS (SELECT r.user_id, AVG(r.holistic_score) v FROM results r
         JOIN profiles p ON p.user_id = r.user_id WHERE p.experience_level = $1 GROUP BY r.user_id)
       SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE v < (SELECT v FROM a WHERE user_id = $2))::int below FROM a`,
      [lvl, userId]);
    comparison.exp = { level: lvl, total: exp.total, beats_pct: exp.total > 1 ? Math.round(100 * exp.below / (exp.total - 1)) : 100 };

    const fran = await pctl(
      `WITH a AS (SELECT r.user_id, MIN(r.time_seconds) t FROM results r
         JOIN workouts w ON w.workout_id = r.workout_id JOIN profiles p ON p.user_id = r.user_id
         WHERE w.name = 'Fran' AND p.experience_level = $1 GROUP BY r.user_id)
       SELECT (SELECT t FROM a WHERE user_id = $2) AS me, COUNT(*)::int total,
              COUNT(*) FILTER (WHERE t > (SELECT t FROM a WHERE user_id = $2))::int slower FROM a`,
      [lvl, userId]);
    if (fran.me != null) comparison.fran = { level: lvl, total: fran.total, beats_pct: fran.total > 1 ? Math.round(100 * fran.slower / (fran.total - 1)) : 100 };
  }

  res.json({
    user: { display_name: prof.display_name, gym_name: prof.gym_name, experience_level: prof.experience_level, avatar_url: prof.avatar_url, box_id: prof.box_id, is_coach: prof.is_coach, connection_count: prof.connection_count },
    summary: { sessions_total: R.length, current_streak, trained_today, longest_streak: longest, this_week_avg, last_week_avg },
    prs: { best_holistic: bestH, fastest, highest_power: bestP, longest_streak: longest },
    heatmap, trend, workload, comparison, benchmarks,
  });
}));

// ---- API: team goal (collective box goal, live progress) --------------------
const GOAL_LABEL = { total_workouts: 'workouts', total_holistic_points: 'points', participation_days: 'training days' };
app.get('/api/box/:boxId/team-goal', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const g = (await pool.query(
    `SELECT * FROM team_goals WHERE box_id = $1 AND status = 'active' ORDER BY ends_at DESC LIMIT 1`, [boxId])).rows[0];
  if (!g) return res.json({ goal: null });

  const win = [boxId, g.starts_at, g.ends_at];
  const base = `FROM results r JOIN box_memberships m ON m.user_id = r.user_id
                WHERE m.box_id = $1 AND r.created_at BETWEEN $2 AND $3`;
  const metric = g.type === 'total_holistic_points' ? 'COALESCE(SUM(r.holistic_score),0)'
    : g.type === 'participation_days' ? 'COUNT(DISTINCT (r.user_id, r.created_at::date))' : 'COUNT(*)';
  const contribExpr = g.type === 'total_holistic_points' ? 'ROUND(SUM(r.holistic_score))'
    : g.type === 'participation_days' ? 'COUNT(DISTINCT r.created_at::date)' : 'COUNT(*)';

  const current = Math.round(Number((await pool.query(`SELECT ${metric} AS n ${base}`, win)).rows[0].n));
  const contributors = (await pool.query(`SELECT COUNT(DISTINCT r.user_id)::int AS n ${base}`, win)).rows[0].n;
  const top = (await pool.query(
    `SELECT r.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name, ${contribExpr}::int AS contribution
       FROM results r JOIN box_memberships m ON m.user_id = r.user_id
       LEFT JOIN profiles p ON p.user_id = r.user_id
      WHERE m.box_id = $1 AND r.created_at BETWEEN $2 AND $3
      GROUP BY r.user_id, p.display_name ORDER BY contribution DESC LIMIT 5`, win)).rows;

  const target = Number(g.target);
  res.json({
    goal: {
      id: g.id, type: g.type, label: GOAL_LABEL[g.type] || 'workouts',
      target, current, pct: Math.min(100, Math.round((100 * current) / Math.max(target, 1))),
      remaining: Math.max(0, target - current), contributors, top,
      days_remaining: Math.max(0, Math.ceil((new Date(g.ends_at) - Date.now()) / 86400000)),
      starts_at: g.starts_at, ends_at: g.ends_at,
    },
  });
}));

// ---- API: box members + newcomers -------------------------------------------
app.get('/api/box/:boxId/members', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const { rows } = await pool.query(
    `SELECT m.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name
       FROM box_memberships m LEFT JOIN profiles p ON p.user_id = m.user_id
      WHERE m.box_id = $1 ORDER BY display_name LIMIT 300`, [boxId]);
  res.json({ members: rows });
}));

app.get('/api/box/:boxId/newcomers', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const { rows } = await pool.query(
    `SELECT m.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name, m.joined_at
       FROM box_memberships m LEFT JOIN profiles p ON p.user_id = m.user_id
      WHERE m.box_id = $1 AND m.joined_at >= now() - interval '7 days'
      ORDER BY m.joined_at DESC LIMIT 12`, [boxId]);
  res.json({ newcomers: rows });
}));

// ---- API: squads ------------------------------------------------------------
app.get('/api/box/:boxId/squads', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const userId = isUuid(req.query.userId) ? req.query.userId : null;
  const { rows } = await pool.query(
    `SELECT s.id, s.name, COUNT(sm.user_id)::int AS member_count,
            COALESCE(BOOL_OR(sm.user_id = $2), false) AS is_member
       FROM squads s LEFT JOIN squad_members sm ON sm.squad_id = s.id
      WHERE s.box_id = $1 GROUP BY s.id, s.name ORDER BY member_count DESC, s.name`,
    [boxId, userId]);
  res.json({ squads: rows });
}));

app.get('/api/users/:userId/squads', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.box_id, b.name AS box_name
       FROM squad_members sm JOIN squads s ON s.id = sm.squad_id JOIN boxes b ON b.box_id = s.box_id
      WHERE sm.user_id = $1 ORDER BY s.name`, [userId]);
  res.json({ squads: rows });
}));

app.post('/api/squads', wrap(async (req, res) => {
  const b = req.body || {};
  const boxId = b.box_id || b.boxId;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!isUuid(boxId)) return res.status(400).json({ error: 'A valid box_id is required.' });
  if (!name || name.length > 60) return res.status(400).json({ error: 'A squad name (1–60 chars) is required.' });
  const box = await pool.query('SELECT 1 FROM boxes WHERE box_id = $1', [boxId]);
  if (!box.rows[0]) return res.status(404).json({ error: 'Box not found.' });
  const { rows } = await pool.query(
    `INSERT INTO squads (box_id, name) VALUES ($1, $2) RETURNING id, box_id, name`, [boxId, name]);
  res.status(201).json(rows[0]);
}));

app.post('/api/squads/:squadId/join', wrap(async (req, res) => {
  const { squadId } = req.params;
  const userId = (req.body || {}).userId || (req.body || {}).user_id;
  if (!isUuid(squadId) || !isUuid(userId)) return res.status(400).json({ error: 'Invalid id.' });
  const sq = await pool.query('SELECT 1 FROM squads WHERE id = $1', [squadId]);
  if (!sq.rows[0]) return res.status(404).json({ error: 'Squad not found.' });
  await pool.query(
    `INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2) ON CONFLICT (squad_id, user_id) DO NOTHING`,
    [squadId, userId]);
  res.json({ ok: true, joined: true });
}));

app.post('/api/squads/:squadId/leave', wrap(async (req, res) => {
  const { squadId } = req.params;
  const userId = (req.body || {}).userId || (req.body || {}).user_id;
  if (!isUuid(squadId) || !isUuid(userId)) return res.status(400).json({ error: 'Invalid id.' });
  await pool.query('DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2', [squadId, userId]);
  res.json({ ok: true, joined: false });
}));

app.get('/api/squads/:squadId/leaderboard/:workoutId', wrap(async (req, res) => {
  const { squadId, workoutId } = req.params;
  if (!isUuid(squadId) || !isUuid(workoutId)) return res.status(400).json({ error: 'Invalid id.' });
  const sq = await pool.query('SELECT id, name, box_id FROM squads WHERE id = $1', [squadId]);
  if (!sq.rows[0]) return res.status(404).json({ error: 'Squad not found.' });
  const { rows } = await pool.query(
    `SELECT r.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name, p.avatar_url,
            r.time_seconds, r.rom_pct, r.unbroken_sets, r.holistic_score
       FROM squad_members sm
       JOIN results r ON r.user_id = sm.user_id AND r.workout_id = $2
       LEFT JOIN profiles p ON p.user_id = r.user_id
      WHERE sm.squad_id = $1 ORDER BY r.holistic_score DESC NULLS LAST, r.time_seconds ASC`,
    [squadId, workoutId]);
  res.json({ squad: sq.rows[0], results: rows });
}));

app.get('/api/squads/:squadId/feed', wrap(async (req, res) => {
  const { squadId } = req.params;
  if (!isUuid(squadId)) return res.status(400).json({ error: 'Invalid id.' });
  const sq = await pool.query('SELECT id, name FROM squads WHERE id = $1', [squadId]);
  if (!sq.rows[0]) return res.status(404).json({ error: 'Squad not found.' });
  const { rows } = await pool.query(
    `SELECT f.event_id, f.user_id, f.type, f.ref_id, f.payload, f.kudos, f.created_at,
            COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name, p.avatar_url,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = f.user_id AND br.role IN ('coach','owner')) AS is_coach
       FROM feed_events f JOIN squad_members sm ON sm.user_id = f.user_id
       LEFT JOIN profiles p ON p.user_id = f.user_id
      WHERE sm.squad_id = $1 ORDER BY f.created_at DESC LIMIT 50`, [squadId]);
  res.json({ squad: sq.rows[0], events: rows });
}));

app.get('/api/squads/:squadId/quiet', wrap(async (req, res) => {
  const { squadId } = req.params;
  if (!isUuid(squadId)) return res.status(400).json({ error: 'Invalid id.' });
  const { rows } = await pool.query(
    `SELECT sm.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name,
            (CURRENT_DATE - MAX(r.created_at)::date) AS days_since
       FROM squad_members sm LEFT JOIN profiles p ON p.user_id = sm.user_id
       LEFT JOIN results r ON r.user_id = sm.user_id
      WHERE sm.squad_id = $1
      GROUP BY sm.user_id, p.display_name
     HAVING MAX(r.created_at) IS NULL OR MAX(r.created_at) < now() - interval '7 days'
      ORDER BY days_since DESC NULLS FIRST LIMIT 8`, [squadId]);
  res.json({ members: rows.map((m) => ({ ...m, days_since: m.days_since == null ? null : Number(m.days_since) })) });
}));

// ---- API: shout-out (public gratitude -> feed event) ------------------------
app.post('/api/shoutout', wrap(async (req, res) => {
  const b = req.body || {};
  const fromUserId = b.fromUserId || b.from_user_id;
  const toUserId = b.toUserId || b.to_user_id;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!isUuid(fromUserId) || !isUuid(toUserId)) return res.status(400).json({ error: 'Valid user ids are required.' });
  if (fromUserId === toUserId) return res.status(400).json({ error: 'You can\'t shout out yourself 😅' });
  if (!text || text.length > 280) return res.status(400).json({ error: 'Shout-out text (1–280 chars) is required.' });
  const to = await pool.query(
    `SELECT COALESCE(NULLIF(p.display_name,''),'Athlete') AS name FROM users u
       LEFT JOIN profiles p ON p.user_id = u.user_id WHERE u.user_id = $1`, [toUserId]);
  if (!to.rows[0]) return res.status(404).json({ error: 'Recipient not found.' });
  const { rows } = await pool.query(
    `INSERT INTO feed_events (user_id, type, ref_id, payload) VALUES ($1, 'shoutout', $2, $3)
       RETURNING event_id, created_at`,
    [fromUserId, toUserId, JSON.stringify({ to_user_id: toUserId, to_name: to.rows[0].name, text })]);
  res.status(201).json({ ok: true, event_id: rows[0].event_id, to_name: to.rows[0].name });
}));

// ---- API: referrals ---------------------------------------------------------
const REFERRER_POINTS = 50, REFERRED_POINTS = 25;

async function boxIdForUser(userId) {
  const r = await pool.query(
    `SELECT box_id FROM box_memberships WHERE user_id = $1 ORDER BY joined_at DESC LIMIT 1`, [userId]);
  return r.rows[0] ? r.rows[0].box_id : null;
}

app.post('/api/referrals', wrap(async (req, res) => {
  const b = req.body || {};
  const referrerUserId = b.referrerUserId || b.referrer_user_id;
  const email = typeof b.referredEmail === 'string' ? b.referredEmail.trim().toLowerCase() : '';
  if (!isUuid(referrerUserId)) return res.status(400).json({ error: 'A valid referrerUserId is required.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid friend email is required.' });
  const u = await pool.query('SELECT 1 FROM users WHERE user_id = $1', [referrerUserId]);
  if (!u.rows[0]) return res.status(404).json({ error: 'User not found.' });
  const boxId = await boxIdForUser(referrerUserId);
  const { rows } = await pool.query(
    `INSERT INTO referrals (referrer_user_id, referred_email, status, box_id)
       VALUES ($1, $2, 'pending', $3) RETURNING id, created_at`,
    [referrerUserId, email, boxId]);
  res.status(201).json({
    id: rows[0].id, referred_email: email, status: 'pending',
    invite_url: `https://wurq.io/join?ref=${rows[0].id}`,
  });
}));

app.get('/api/users/:userId/referrals', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const list = (await pool.query(
    `SELECT r.id, r.referred_email, r.status, r.points_awarded, r.created_at,
            COALESCE(NULLIF(p.display_name,''), NULL) AS referred_name
       FROM referrals r LEFT JOIN profiles p ON p.user_id = r.referred_user_id
      WHERE r.referrer_user_id = $1 ORDER BY r.created_at DESC`, [userId])).rows;
  const points = (await pool.query(
    `SELECT COALESCE(referral_points, 0) AS pts FROM profiles WHERE user_id = $1`, [userId])).rows[0];
  res.json({
    referrals: list,
    points: points ? points.pts : 0,
    joined_count: list.filter((r) => r.status === 'joined').length,
    pending_count: list.filter((r) => r.status === 'pending').length,
  });
}));

app.get('/api/box/:boxId/referral-leaderboard', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const { rows } = await pool.query(
    `SELECT r.referrer_user_id AS user_id,
            COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name,
            COUNT(*) FILTER (WHERE r.status = 'joined')::int AS joined,
            COALESCE(MAX(p.referral_points), 0)::int AS points
       FROM referrals r LEFT JOIN profiles p ON p.user_id = r.referrer_user_id
      WHERE r.box_id = $1
      GROUP BY r.referrer_user_id, p.display_name
      ORDER BY joined DESC, points DESC LIMIT 20`, [boxId]);
  res.json({ leaders: rows });
}));

// ---- API: global community (cross-box) --------------------------------------
app.get('/api/global/feed', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.event_id, f.user_id, f.type, f.payload, f.kudos, f.created_at,
            COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name, b.name AS box_name,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = f.user_id AND br.role IN ('coach','owner')) AS is_coach
       FROM feed_events f
       LEFT JOIN profiles p ON p.user_id = f.user_id
       LEFT JOIN box_memberships m ON m.user_id = f.user_id
       LEFT JOIN boxes b ON b.box_id = m.box_id
      ORDER BY f.created_at DESC LIMIT 60`);
  res.json({ events: rows });
}));

app.get('/api/global/comebacks', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.event_id, f.user_id, f.payload, f.kudos, f.created_at,
            COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name, b.name AS box_name
       FROM feed_events f
       LEFT JOIN profiles p ON p.user_id = f.user_id
       LEFT JOIN box_memberships m ON m.user_id = f.user_id
       LEFT JOIN boxes b ON b.box_id = m.box_id
      WHERE f.type = 'comeback' AND f.created_at >= now() - interval '7 days'
      ORDER BY f.created_at DESC LIMIT 12`);
  res.json({ comebacks: rows });
}));

app.get('/api/global/leaderboard/today/:workoutId', wrap(async (req, res) => {
  const { workoutId } = req.params;
  if (!isUuid(workoutId)) return res.status(400).json({ error: 'Invalid workout id.' });
  const { rows } = await pool.query(
    `SELECT r.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name,
            b.name AS box_name, r.holistic_score, r.time_seconds
       FROM results r
       LEFT JOIN profiles p ON p.user_id = r.user_id
       LEFT JOIN box_memberships m ON m.user_id = r.user_id
       LEFT JOIN boxes b ON b.box_id = m.box_id
      WHERE r.workout_id = $1
      ORDER BY r.holistic_score DESC NULLS LAST, r.time_seconds ASC LIMIT 50`, [workoutId]);
  res.json({ results: rows });
}));

app.get('/api/global/leaderboard/overall', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name,
            b.name AS box_name, ROUND(AVG(r.holistic_score), 1) AS avg_score, COUNT(*)::int AS sessions
       FROM results r
       LEFT JOIN profiles p ON p.user_id = r.user_id
       LEFT JOIN box_memberships m ON m.user_id = r.user_id
       LEFT JOIN boxes b ON b.box_id = m.box_id
      GROUP BY r.user_id, p.display_name, b.name
     HAVING COUNT(*) >= 5
      ORDER BY avg_score DESC LIMIT 50`);
  res.json({ results: rows.map((r) => ({ ...r, avg_score: Number(r.avg_score) })) });
}));

// ---- API: follows (cross-box) -----------------------------------------------
app.post('/api/follows', wrap(async (req, res) => {
  const b = req.body || {};
  const follower = b.followerUserId || b.follower_user_id;
  const followee = b.followeeUserId || b.followee_user_id;
  if (!isUuid(follower) || !isUuid(followee)) return res.status(400).json({ error: 'Invalid id.' });
  if (follower === followee) return res.status(400).json({ error: 'You can\'t follow yourself.' });
  const action = b.action === 'unfollow' ? 'unfollow' : 'follow';
  if (action === 'unfollow') {
    await pool.query('DELETE FROM follows WHERE follower_user_id = $1 AND followee_user_id = $2', [follower, followee]);
    return res.json({ ok: true, following: false });
  }
  await pool.query(
    `INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2)
       ON CONFLICT (follower_user_id, followee_user_id) DO NOTHING`, [follower, followee]);
  res.json({ ok: true, following: true });
}));

app.get('/api/users/:userId/following', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const { rows } = await pool.query('SELECT followee_user_id FROM follows WHERE follower_user_id = $1', [userId]);
  res.json({ following: rows.map((r) => r.followee_user_id) });
}));

app.get('/api/users/:userId/following-feed', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const { rows } = await pool.query(
    `SELECT f.event_id, f.user_id, f.type, f.payload, f.kudos, f.created_at,
            COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name, b.name AS box_name
       FROM feed_events f
       JOIN follows fo ON fo.followee_user_id = f.user_id AND fo.follower_user_id = $1
       LEFT JOIN profiles p ON p.user_id = f.user_id
       LEFT JOIN box_memberships m ON m.user_id = f.user_id
       LEFT JOIN boxes b ON b.box_id = m.box_id
      ORDER BY f.created_at DESC LIMIT 50`, [userId]);
  res.json({ events: rows });
}));

// ---- API: roles & coach management ------------------------------------------
app.get('/api/box/:boxId/manage-coaches', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const { rows } = await pool.query(
    `SELECT m.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = m.user_id AND br.box_id = $1 AND br.role = 'coach') AS is_coach,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = m.user_id AND br.box_id = $1 AND br.role = 'owner') AS is_owner
       FROM box_memberships m LEFT JOIN profiles p ON p.user_id = m.user_id
      WHERE m.box_id = $1 ORDER BY is_coach DESC, display_name LIMIT 300`, [boxId]);
  res.json({ members: rows });
}));

app.post('/api/box/:boxId/coaches', wrap(async (req, res) => {
  const { boxId } = req.params;
  const b = req.body || {};
  const actingUserId = b.actingUserId || b.acting_user_id;
  const targetUserId = b.targetUserId || b.target_user_id;
  const action = b.action === 'demote' ? 'demote' : 'promote';
  if (!isUuid(boxId) || !isUuid(targetUserId)) return res.status(400).json({ error: 'Invalid id.' });
  if (!(await rolesFor(actingUserId, boxId)).includes('owner')) return res.status(403).json({ error: 'Only the box owner can manage coaches.' });
  if (action === 'demote') {
    await pool.query(`DELETE FROM box_roles WHERE user_id = $1 AND box_id = $2 AND role = 'coach'`, [targetUserId, boxId]);
    return res.json({ ok: true, is_coach: false });
  }
  await pool.query(
    `INSERT INTO box_roles (user_id, box_id, role) VALUES ($1, $2, 'coach') ON CONFLICT DO NOTHING`, [targetUserId, boxId]);
  res.json({ ok: true, is_coach: true });
}));

// ---- API: coach — program the WOD -------------------------------------------
app.post('/api/box/:boxId/wod', wrap(async (req, res) => {
  const { boxId } = req.params;
  const b = req.body || {};
  const actingUserId = b.actingUserId || b.acting_user_id;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  if (!hasCoach(await rolesFor(actingUserId, boxId))) return res.status(403).json({ error: 'Coaches only.' });
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 60) return res.status(400).json({ error: 'A WOD name (1–60 chars) is required.' });
  const type = (typeof b.type === 'string' ? b.type.trim() : '') || 'For Time';
  const description = (typeof b.description === 'string' ? b.description.trim() : '').slice(0, 1000);
  const scaling = (typeof b.scaling === 'string' ? b.scaling.trim() : '').slice(0, 500);
  // Program today's WOD (the shared today workout), tagged with the coach.
  const existing = await pool.query(`SELECT workout_id FROM workouts WHERE wod_date = CURRENT_DATE ORDER BY workout_id LIMIT 1`);
  let row;
  if (existing.rows[0]) {
    row = (await pool.query(
      `UPDATE workouts SET name = $1, type = $2, description = $3, scaling = $4, programmed_by = $5
         WHERE workout_id = $6 RETURNING workout_id, name, type, description, scaling, wod_date, programmed_by`,
      [name, type, description, scaling, actingUserId, existing.rows[0].workout_id])).rows[0];
  } else {
    row = (await pool.query(
      `INSERT INTO workouts (name, type, description, scaling, programmed_by, wod_date)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE) RETURNING workout_id, name, type, description, scaling, wod_date, programmed_by`,
      [name, type, description, scaling, actingUserId])).rows[0];
  }
  res.status(201).json(row);
}));

// ---- API: coach — athlete roster --------------------------------------------
app.get('/api/box/:boxId/roster', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const actingUserId = isUuid(req.query.userId) ? req.query.userId : null;
  if (!hasCoach(await rolesFor(actingUserId, boxId))) return res.status(403).json({ error: 'Coaches only.' });
  const { rows } = await pool.query(
    `SELECT m.user_id,
            COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name,
            COALESCE(p.experience_level,'') AS experience_level,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = m.user_id AND br.box_id = $1 AND br.role IN ('coach','owner')) AS is_coach,
            COUNT(r.result_id)::int AS sessions,
            MAX(r.created_at) AS last_logged,
            (CURRENT_DATE - MAX(r.created_at)::date) AS days_since,
            BOOL_OR(r.created_at::date = CURRENT_DATE) AS logged_today,
            ROUND(AVG(r.holistic_score) FILTER (WHERE r.created_at >= now() - interval '7 days'), 1) AS week_avg,
            ROUND(AVG(r.holistic_score) FILTER (WHERE r.created_at >= now() - interval '14 days' AND r.created_at < now() - interval '7 days'), 1) AS prev_avg,
            ((SELECT COUNT(*) FROM squad_members sm WHERE sm.user_id = m.user_id)
              + (SELECT COUNT(*) FROM follows f WHERE f.follower_user_id = m.user_id))::int AS connection_count
       FROM box_memberships m
       LEFT JOIN profiles p ON p.user_id = m.user_id
       LEFT JOIN results r ON r.user_id = m.user_id
      WHERE m.box_id = $1
      GROUP BY m.user_id, p.display_name, p.experience_level
      ORDER BY logged_today DESC NULLS LAST, days_since ASC NULLS LAST`, [boxId]);
  const members = rows.map((m) => ({
    user_id: m.user_id, display_name: m.display_name, experience_level: m.experience_level,
    is_coach: m.is_coach, sessions: m.sessions, logged_today: !!m.logged_today,
    days_since: m.days_since == null ? null : Number(m.days_since),
    week_avg: m.week_avg == null ? null : Number(m.week_avg),
    prev_avg: m.prev_avg == null ? null : Number(m.prev_avg),
    connection_count: m.connection_count,
    quiet: m.days_since == null || Number(m.days_since) >= 10,
    under_connected: m.connection_count < 3,
  }));
  res.json({
    members,
    logged_today: members.filter((m) => m.logged_today).length,
    total: members.length,
    quiet_count: members.filter((m) => m.quiet).length,
  });
}));

// ---- API: coach — announce to the box ---------------------------------------
app.post('/api/box/:boxId/announce', wrap(async (req, res) => {
  const { boxId } = req.params;
  const b = req.body || {};
  const actingUserId = b.actingUserId || b.acting_user_id;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  if (!hasCoach(await rolesFor(actingUserId, boxId))) return res.status(403).json({ error: 'Coaches only.' });
  if (!text || text.length > 500) return res.status(400).json({ error: 'Announcement text (1–500 chars) is required.' });
  const { rows } = await pool.query(
    `INSERT INTO feed_events (user_id, type, payload) VALUES ($1, 'announcement', $2) RETURNING event_id, created_at`,
    [actingUserId, JSON.stringify({ text })]);
  res.status(201).json({ ok: true, event_id: rows[0].event_id });
}));

// ---- API: connection-driven onboarding --------------------------------------
app.get('/api/users/:userId/onboarding', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) return res.status(400).json({ error: 'Invalid user id.' });
  const prof = await getProfileRow(userId);
  if (!prof) return res.status(404).json({ error: 'User not found.' });
  if (!prof.box_id) return res.json({ box: null });
  const boxId = prof.box_id;

  // Ensure a "New Crew" cohort squad exists and the user is in it.
  const shortName = prof.box_name.replace(/^(CrossFit|CF)\s+/i, '').replace(/\s+CrossFit$/i, '').trim() || prof.box_name;
  const cohortName = `${shortName} — New Crew`;
  let cohort = (await pool.query('SELECT id, name FROM squads WHERE box_id = $1 AND name = $2 LIMIT 1', [boxId, cohortName])).rows[0];
  if (!cohort) cohort = (await pool.query('INSERT INTO squads (box_id, name) VALUES ($1, $2) RETURNING id, name', [boxId, cohortName])).rows[0];
  await pool.query('INSERT INTO squad_members (squad_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cohort.id, userId]);
  const cohortCount = (await pool.query('SELECT COUNT(*)::int AS n FROM squad_members WHERE squad_id = $1', [cohort.id])).rows[0].n;

  const coaches = (await pool.query(
    `SELECT DISTINCT br.user_id, COALESCE(NULLIF(p.display_name,''),'Coach') AS display_name
       FROM box_roles br LEFT JOIN profiles p ON p.user_id = br.user_id
      WHERE br.box_id = $1 AND br.role = 'coach' AND br.user_id <> $2 LIMIT 4`, [boxId, userId])).rows;
  // Suggested boxmates to follow (active, not already followed, not self).
  const suggestions = (await pool.query(
    `SELECT m.user_id, COALESCE(NULLIF(p.display_name,''),'Athlete') AS display_name,
            EXISTS (SELECT 1 FROM box_roles br WHERE br.user_id = m.user_id AND br.box_id = $1 AND br.role IN ('coach','owner')) AS is_coach
       FROM box_memberships m LEFT JOIN profiles p ON p.user_id = m.user_id
      WHERE m.box_id = $1 AND m.user_id <> $2
        AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_user_id = $2 AND f.followee_user_id = m.user_id)
        AND EXISTS (SELECT 1 FROM results r WHERE r.user_id = m.user_id)
      ORDER BY random() LIMIT 5`, [boxId, userId])).rows;

  res.json({
    box: { box_id: boxId, name: prof.box_name },
    cohort: { squad_id: cohort.id, name: cohort.name, member_count: cohortCount },
    coaches, suggestions,
    connection_count: prof.connection_count,
  });
}));

// ---- API: owner affiliate status --------------------------------------------
const AFFILIATE_PERKS = {
  Bronze: ['Featured in the WurQ app', 'Affiliate dashboard access'],
  Silver: ['Everything in Bronze', 'Co-marketing features', 'Priority support'],
  Gold: ['Everything in Silver', 'Revenue share on referrals', 'Annual WurQ summit invite'],
};
app.get('/api/box/:boxId/affiliate', wrap(async (req, res) => {
  const { boxId } = req.params;
  if (!isUuid(boxId)) return res.status(400).json({ error: 'Invalid box id.' });
  const box = await pool.query('SELECT name FROM boxes WHERE box_id = $1', [boxId]);
  if (!box.rows[0]) return res.status(404).json({ error: 'Box not found.' });

  const m = (await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM box_memberships WHERE box_id = $1) AS members,
            (SELECT COUNT(DISTINCT r.user_id)::int FROM results r JOIN box_memberships bm ON bm.user_id = r.user_id
               WHERE bm.box_id = $1 AND r.created_at >= now() - interval '7 days') AS active_week,
            (SELECT COUNT(DISTINCT (r.user_id, r.created_at::date))::int FROM results r JOIN box_memberships bm ON bm.user_id = r.user_id
               WHERE bm.box_id = $1 AND r.created_at >= now() - interval '7 days') AS member_days_7,
            (SELECT COUNT(*)::int FROM referrals WHERE box_id = $1 AND status = 'joined') AS referrals_joined,
            (SELECT COALESCE(SUM(points_awarded),0)::int FROM referrals WHERE box_id = $1 AND status = 'joined') AS owner_referral_points`,
    [boxId])).rows[0];

  // Average daily turnout over the week — differentiates box engagement.
  const participation = m.members ? m.member_days_7 / (m.members * 7) : 0;
  const score = Math.round(participation * 100) + Math.min(m.referrals_joined, 10);
  const tier = score >= 75 ? 'Gold' : score >= 50 ? 'Silver' : 'Bronze';
  const nextTier = tier === 'Gold' ? null : tier === 'Silver' ? 'Gold' : 'Silver';
  const nextThreshold = tier === 'Bronze' ? 50 : tier === 'Silver' ? 75 : null;
  res.json({
    box: box.rows[0].name, tier, score, participation: Math.round(participation * 100) / 100,
    members: m.members, active_week: m.active_week,
    referrals_joined: m.referrals_joined, owner_referral_points: m.owner_referral_points,
    perks: AFFILIATE_PERKS[tier],
    next_tier: nextTier, to_next: nextThreshold ? Math.max(0, nextThreshold - score) : 0,
  });
}));

// ---- API: health / diagnostics (read-only) ----------------------------------
// Visit /api/health to see whether the demo world is seeded.
app.get('/api/health', wrap(async (req, res) => {
  let counts = {};
  try {
    const r = await pool.query(`
      SELECT (SELECT COUNT(*) FROM boxes)::int AS boxes,
             (SELECT COUNT(*) FROM box_memberships)::int AS athletes,
             (SELECT COUNT(*) FROM results)::int AS results,
             (SELECT COUNT(*) FROM feed_events)::int AS feed_events,
             (SELECT COUNT(*) FROM challenges)::int AS challenges,
             EXISTS (SELECT 1 FROM boxes WHERE name = $1) AS world_seeded`, [SEED_SENTINEL_BOX]);
    counts = r.rows[0];
  } catch (e) { counts = { error: e.message }; }
  res.json({ ok: true, seeding, ...counts });
}));

// ---- API: manual reseed (guarded) -------------------------------------------
// Disabled unless SEED_TOKEN is set; then POST /api/admin/reseed?token=... forces
// a rebuild of the demo world (handy if auto-seed didn't run).
app.post('/api/admin/reseed', wrap(async (req, res) => {
  const token = process.env.SEED_TOKEN;
  if (!token) return res.status(404).json({ error: 'Reseed endpoint disabled (set SEED_TOKEN to enable).' });
  if (req.query.token !== token) return res.status(403).json({ error: 'Invalid token.' });
  if (seeding) return res.status(202).json({ status: 'already seeding' });
  seeding = true;
  runSeed().then(() => { seeding = false; }).catch((e) => { seeding = false; console.error('[reseed] failed:', e); });
  res.status(202).json({ status: 'reseeding started' });
}));

// ---- Static + SPA -----------------------------------------------------------
app.use(express.static(publicDir));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ---- Error handler ----------------------------------------------------------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /image uploads are allowed/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// Auto-seed the demo world. Seeds when the seeded world is ABSENT — detected by
// the presence of the canonical demo box (CrossFit Borderland), not just "no
// boxes", so it still fires on a DB that only has a user-created box. Once the
// world exists it won't reseed (live activity is preserved across restarts).
// SEED_ON_BOOT=force rebuilds; SEED_ON_BOOT=never disables.
async function maybeSeed() {
  const mode = process.env.SEED_ON_BOOT;
  if (mode === 'never') return;
  let worldPresent = false;
  try {
    worldPresent = (await pool.query('SELECT 1 FROM boxes WHERE name = $1 LIMIT 1', [SEED_SENTINEL_BOX])).rowCount > 0;
  } catch (_) { /* tables may not exist yet on a brand-new DB */ }
  if (mode === 'force' || !worldPresent) {
    console.log(`[startup] seeding demo world (${mode === 'force' ? 'forced' : 'seeded world not found'})…`);
    seeding = true;
    try { await runSeed(); console.log('[startup] seed complete'); }
    catch (e) { console.error('[startup] seed failed (continuing):', e.message); }
    finally { seeding = false; }
  } else {
    // World already present — just keep the demo logins' personal history fresh.
    try { await ensureDemoAthletes(); } catch (e) { console.error('[startup] demo backfill failed:', e.message); }
  }
}

migrate()
  .then(() => {
    // Start listening FIRST so the platform health check passes immediately,
    // then seed in the background — a large seed must never delay (or fail) boot.
    app.listen(PORT, () => {
      console.log(`Wurq Community demo listening on port ${PORT}`);
      maybeSeed().catch((e) => console.error('[startup] seed error (continuing):', e));
    });
  })
  .catch((err) => {
    console.error('[startup] migration failed:', err);
    process.exit(1);
  });
