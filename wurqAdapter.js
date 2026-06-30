'use strict';

// ============================================================================
// WurQ app integration adapter — THE single place WurQ-specific field mapping
// lives. Everything downstream (saving the result, leaderboards, feed, badges,
// commitments) speaks the platform's internal shape, NOT WurQ's. When the real
// integration lands, only this file changes.
//
// TODO(wurq-integration): replace this MOCK field mapping with the real WurQ API
// schema once access is granted. Today we map a *plausible* payload shape (what
// the WurQ iOS app would send); the real schema may rename/nest fields, add auth
// claims, use different units, etc. Keep all that translation HERE so the rest of
// the codebase is untouched when we swap mock → real.
// ============================================================================

// Shape we expect from the WurQ app (mock). Example:
// {
//   "athlete":  { "wurq_user_id": "wq_8f3a", "email": "athlete@example.com" },
//   "workout":  { "name": "Fran", "type": "For Time", "performed_at": "2026-06-27T13:30:00Z" },
//   "metrics":  {
//     "duration_sec": 225, "holistic_score": 78.4,
//     "range_of_motion_pct": 92, "unbroken_sets": 6,
//     "heart_rate": { "avg_bpm": 168, "peak_bpm": 189 },
//     "calories_kcal": 142, "power_output_w": 410.5, "work_volume_kg": 5200,
//     "movements": [ { "name": "Thrusters", "reps": 45, "rom_pct": 92, "category": "legs" } ]
//   }
// }

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

class WurqPayloadError extends Error {}

// Map a WurQ movement entry → our internal movement shape ({movement, reps, rom_pct, cat}).
// TODO(wurq-integration): confirm WurQ's real movement field names + categories.
function mapMovement(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    movement: String(m.name || m.movement || 'Movement'),
    reps: Math.max(0, Math.round(num(m.reps) || 0)),
    rom_pct: Math.round(Math.min(100, Math.max(0, num(m.rom_pct) ?? num(m.range_of_motion_pct) ?? 100))),
    cat: String(m.category || m.cat || 'cardio'),
  };
}

// Parse + validate a WurQ workout payload into the platform's internal shape.
// Throws WurqPayloadError (→ 422) on anything malformed.
function parseWurqWorkout(body) {
  if (!body || typeof body !== 'object') throw new WurqPayloadError('Empty payload.');
  const athlete = body.athlete || {};
  const workout = body.workout || {};
  const metrics = body.metrics || {};
  const hr = metrics.heart_rate || {};

  const email = typeof athlete.email === 'string' ? athlete.email.trim().toLowerCase() : '';
  const wurqUserId = athlete.wurq_user_id != null ? String(athlete.wurq_user_id) : null;
  if (!email && !wurqUserId) throw new WurqPayloadError('Payload must identify the athlete by email or wurq_user_id.');

  const name = typeof workout.name === 'string' ? workout.name.trim() : '';
  if (!name) throw new WurqPayloadError('workout.name is required.');

  const time_seconds = Math.round(num(metrics.duration_sec) ?? 0);
  if (!time_seconds || time_seconds <= 0 || time_seconds > 86400) {
    throw new WurqPayloadError('metrics.duration_sec must be between 1 and 86400.');
  }

  const performedAt = workout.performed_at ? new Date(workout.performed_at) : new Date();

  return {
    external: { email, wurqUserId },
    workout: {
      name,
      type: typeof workout.type === 'string' && workout.type.trim() ? workout.type.trim() : 'For Time',
      performedAt: Number.isNaN(performedAt.getTime()) ? new Date() : performedAt,
    },
    time_seconds,
    // holistic_score is optional — WurQ may compute it; if absent the platform
    // computes it from time/ROM/sets with the same scoring module.
    holistic_score: num(metrics.holistic_score),
    rom_pct: Math.round(Math.min(100, Math.max(0, num(metrics.range_of_motion_pct) ?? 100))),
    unbroken_sets: Math.max(0, Math.round(num(metrics.unbroken_sets) ?? 0)),
    // Rich auto-captured sensor metrics, mapped to our internal columns.
    metrics: {
      avg_hr: num(hr.avg_bpm) == null ? null : Math.round(num(hr.avg_bpm)),
      peak_hr: num(hr.peak_bpm) == null ? null : Math.round(num(hr.peak_bpm)),
      calories: num(metrics.calories_kcal) == null ? null : Math.round(num(metrics.calories_kcal)),
      power_output: num(metrics.power_output_w),
      work_volume: num(metrics.work_volume_kg),
      movements: Array.isArray(metrics.movements) ? metrics.movements.map(mapMovement).filter(Boolean) : [],
    },
  };
}

module.exports = { parseWurqWorkout, WurqPayloadError };
