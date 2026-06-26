'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const { pool, migrate } = require('./db');
const { computeHolisticScore, computeBreakdown } = require('./holisticScore');
const { evaluateBadges } = require('./badges');
const { deriveMetrics } = require('./metrics');

const BENCHMARKS = ['Fran', 'Helen', 'Grace', 'Cindy', 'Diane', 'Annie', 'Karen', 'Jackie', 'Isabel', 'Amanda', 'Elizabeth', 'Randy', 'Nancy'];

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');

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
            p.updated_at,
            b.box_id, b.name AS box_name
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

  res.status(created ? 201 : 200).json({ user_id: user.user_id, email: user.email, created });
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
    `SELECT workout_id, name, type, description, wod_date
       FROM workouts
      ORDER BY (wod_date = CURRENT_DATE) DESC, wod_date DESC
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

    const newBadges = await evaluateBadges(client, { userId, result, workout });

    await client.query('COMMIT');
    res.status(201).json({ result, newBadges, prs });
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
            r.time_seconds, r.rom_pct, r.unbroken_sets, r.holistic_score, r.created_at
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
            p.avatar_url
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
        WHERE m.box_id = $1
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
    user: { display_name: prof.display_name, gym_name: prof.gym_name, experience_level: prof.experience_level, avatar_url: prof.avatar_url, box_id: prof.box_id },
    summary: { sessions_total: R.length, current_streak, trained_today, longest_streak: longest, this_week_avg, last_week_avg },
    prs: { best_holistic: bestH, fastest, highest_power: bestP, longest_streak: longest },
    heatmap, trend, workload, comparison, benchmarks,
  });
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

migrate()
  .then(() => app.listen(PORT, () => console.log(`Wurq Community demo listening on port ${PORT}`)))
  .catch((err) => {
    console.error('[startup] migration failed:', err);
    process.exit(1);
  });
