'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const { pool, migrate } = require('./db');
const { computeHolisticScore } = require('./holisticScore');
const { evaluateBadges } = require('./badges');

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const saved = await client.query(
      `INSERT INTO results (user_id, workout_id, time_seconds, rom_pct, unbroken_sets, holistic_score)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, workout_id) DO UPDATE SET
           time_seconds   = EXCLUDED.time_seconds,
           rom_pct        = EXCLUDED.rom_pct,
           unbroken_sets  = EXCLUDED.unbroken_sets,
           holistic_score = EXCLUDED.holistic_score,
           created_at     = now()
         RETURNING result_id, user_id, workout_id, time_seconds, rom_pct, unbroken_sets, holistic_score, created_at`,
      [userId, workoutId, time_seconds, rom_pct, unbroken_sets, holistic_score]
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

    const newBadges = await evaluateBadges(client, { userId, result, workout });

    await client.query('COMMIT');
    res.status(201).json({ result, newBadges });
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
app.get('/api/leaderboard/boxes/:workoutId', wrap(async (req, res) => {
  const { workoutId } = req.params;
  if (!isUuid(workoutId)) return res.status(400).json({ error: 'Invalid workout id.' });

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

  const boxes = rows.map((b) => {
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

  res.json({ boxes });
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
