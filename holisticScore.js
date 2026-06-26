'use strict';

// ── Holistic Score ──────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for scoring. The browser no longer computes scores;
// it submits only the raw inputs (time, ROM %, unbroken sets) and the server
// returns/persists the score. Keep all scoring math in this file so every
// endpoint stays consistent.
//
// The score (0–100) blends three dimensions:
//   • Time   — how fast the workout was completed, vs a reference "par" time
//   • ROM    — movement quality / range of motion (%), the "did it count" axis
//   • Pacing — strategy & consistency, inferred from unbroken sets
//
// Time sets the ceiling; ROM and pacing are quality multipliers that scale it
// down when reps were shallow or the athlete kept breaking up sets.
//
// NOTE: the weights and reference time live here on purpose so they are trivial
// to tune. If you have an exact formula from the original demo, replace the
// expressions below and every endpoint picks it up automatically.

const REFERENCE_TIME_SECONDS = 300; // ~5:00 — a solid benchmark effort

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// Inputs are validated by the caller; this function defensively coerces too.
function computeHolisticScore({ time_seconds, rom_pct, unbroken_sets }) {
  const t = Number(time_seconds);
  const rom = Number(rom_pct);
  const sets = Number(unbroken_sets);

  // Time: 100 at/under par, decaying as it gets slower (par / time, capped 100).
  const timeScore = clamp((REFERENCE_TIME_SECONDS / Math.max(t, 1)) * 100, 0, 100);

  // ROM quality multiplier: 100% ROM = full credit, scales linearly to 0.
  const romFactor = clamp(rom / 100, 0, 1);

  // Pacing multiplier: more unbroken sets = better pacing. 0 sets → 0.70,
  // diminishing returns, reaching 1.0 around 10 unbroken sets.
  const pacingFactor = clamp(0.7 + 0.03 * sets, 0.7, 1);

  const score = timeScore * romFactor * pacingFactor;
  return Math.round(score * 10) / 10; // one decimal place
}

module.exports = { computeHolisticScore, REFERENCE_TIME_SECONDS };
