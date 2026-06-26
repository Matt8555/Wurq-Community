'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool, migrate } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const uploadsDir = path.join(__dirname, 'uploads');

// Ensure the uploads folder exists. NOTE: local disk is fine for the demo, but on
// Railway the container filesystem is ephemeral — uploaded avatars will not
// survive a redeploy. For production move this to object storage (S3) or a
// mounted Railway volume and store the resulting URL in profiles.avatar_url.
fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.json({ limit: '1mb' }));

// ---- Avatar upload (multipart) ----------------------------------------------
const ALLOWED_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 10);
    const safe = (req.params.userId || 'user').replace(/[^a-z0-9-]/gi, '');
    // Unique-enough name without pulling in extra deps.
    cb(null, `${safe}-${process.hrtime.bigint().toString(36)}${ext || '.img'}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
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

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

// Wrap an async route so rejected promises hit the error handler, never crash.
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ---- API: users -------------------------------------------------------------
// Create-or-match a user by email. email is the human match key; user_id is the
// real, immutable key. Returns the user_id either way.
app.post('/api/users', wrap(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  // Try to insert; if the email already exists, fall back to a lookup.
  const inserted = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO NOTHING
       RETURNING user_id, email, status, created_at`,
    [email]
  );

  let user;
  let created;
  if (inserted.rows[0]) {
    user = inserted.rows[0];
    created = true;
    // Record the email identity and seed an empty profile row for the new user.
    await pool.query(
      `INSERT INTO identities (user_id, provider, provider_user_id, email)
         VALUES ($1, 'email', $2, $2)
         ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [user.user_id, email]
    );
    await pool.query(
      `INSERT INTO profiles (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
      [user.user_id]
    );
  } else {
    const found = await pool.query(
      `SELECT user_id, email, status, created_at FROM users WHERE email = $1`,
      [email]
    );
    user = found.rows[0];
    created = false;
  }

  res.status(created ? 201 : 200).json({ user_id: user.user_id, email: user.email, created });
}));

// ---- API: get profile -------------------------------------------------------
app.get('/api/profile/:userId', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const result = await pool.query(
    `SELECT u.user_id, u.email,
            p.display_name, p.gym_name, p.avatar_url, p.bio,
            p.experience_level, p.primary_goals,
            COALESCE(p.units, 'lb')        AS units,
            COALESCE(p.profile_complete, false) AS profile_complete,
            p.updated_at
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.user_id
      WHERE u.user_id = $1`,
    [userId]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }
  res.json(result.rows[0]);
}));

// ---- API: create/update profile ---------------------------------------------
app.put('/api/profile/:userId', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }

  const userExists = await pool.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
  if (!userExists.rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const body = req.body || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? null : String(v));

  const display_name = str(body.display_name);
  const gym_name = str(body.gym_name);
  const avatar_url = str(body.avatar_url);
  const bio = str(body.bio);
  const primary_goals = str(body.primary_goals);
  let experience_level = str(body.experience_level);
  let units = str(body.units);

  // Validate enums; empty/absent is allowed (treated as null) so partial saves work.
  if (experience_level && !EXPERIENCE_LEVELS.includes(experience_level)) {
    return res.status(400).json({
      error: `experience_level must be one of: ${EXPERIENCE_LEVELS.join(', ')}.`,
    });
  }
  if (!units) units = 'lb';
  if (!UNITS.includes(units)) {
    return res.status(400).json({ error: `units must be one of: ${UNITS.join(', ')}.` });
  }
  if (bio && bio.length > 1000) {
    return res.status(400).json({ error: 'bio must be 1000 characters or fewer.' });
  }

  // gym/box is the most important field — a profile is "complete" once the
  // athlete has a display name and a gym/box.
  const profile_complete = Boolean(display_name && gym_name);

  const result = await pool.query(
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
         updated_at       = now()
       RETURNING user_id, display_name, gym_name, avatar_url, bio,
                 experience_level, primary_goals, units, profile_complete, updated_at`,
    [userId, display_name, gym_name, avatar_url, bio,
     experience_level || null, primary_goals, units, profile_complete]
  );

  res.json(result.rows[0]);
}));

// ---- API: avatar upload -----------------------------------------------------
app.post('/api/profile/:userId/avatar', wrap(async (req, res) => {
  const { userId } = req.params;
  if (!isUuid(userId)) {
    return res.status(400).json({ error: 'Invalid user id.' });
  }
  const userExists = await pool.query('SELECT 1 FROM users WHERE user_id = $1', [userId]);
  if (!userExists.rows[0]) {
    return res.status(404).json({ error: 'User not found.' });
  }

  // Run multer here so we can return JSON errors instead of crashing.
  await new Promise((resolve, reject) => {
    upload.single('avatar')(req, res, (err) => (err ? reject(err) : resolve()));
  });

  if (!req.file) {
    return res.status(400).json({ error: 'No image file received (field name: "avatar").' });
  }

  const avatar_url = `/uploads/${req.file.filename}`;
  // Persist immediately so the URL survives a reload even before the form is saved.
  await pool.query(
    `INSERT INTO profiles (user_id, avatar_url, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url, updated_at = now()`,
    [userId, avatar_url]
  );

  res.status(201).json({ avatar_url });
}));

// ---- Static + SPA -----------------------------------------------------------
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

// Unknown API routes return JSON, not the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Catch-all: serve the app shell for any other route.
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ---- Error handler ----------------------------------------------------------
// Centralized so a bad request never crashes the process.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /image uploads are allowed/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Wurq Community demo listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('[startup] migration failed:', err);
    process.exit(1);
  });
