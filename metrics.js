'use strict';

// Derives the extra session metrics WurQ tracks (avg/peak HR, calories, power,
// work volume, per-movement breakdown) from a logged result. Used by BOTH the
// seed (backfilling June history, passing each athlete's deterministic RNG and
// ability) and the live POST /api/results endpoint (so live logs are just as
// rich). Values are plausible and consistent with effort/ability + workout type.

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r1 = (n) => Math.round(n * 10) / 10;

// Movement breakdown per workout: { m: name, base: rep target, cat: category }.
// cat ∈ push | pull | legs | core | cardio  (drives the workload chart).
const MOVEMENTS = {
  'Fran': [{ m: 'Thrusters', base: 45, cat: 'legs' }, { m: 'Pull-ups', base: 45, cat: 'pull' }],
  'Helen': [{ m: 'Run (400m)', base: 3, cat: 'cardio' }, { m: 'KB Swings', base: 63, cat: 'pull' }, { m: 'Pull-ups', base: 36, cat: 'pull' }],
  'Grace': [{ m: 'Clean & Jerk', base: 30, cat: 'legs' }],
  'Cindy': [{ m: 'Pull-ups', base: 90, cat: 'pull' }, { m: 'Push-ups', base: 180, cat: 'push' }, { m: 'Air Squats', base: 270, cat: 'legs' }],
  'Diane': [{ m: 'Deadlifts', base: 45, cat: 'legs' }, { m: 'Handstand Push-ups', base: 45, cat: 'push' }],
  'Annie': [{ m: 'Double-Unders', base: 150, cat: 'cardio' }, { m: 'Sit-ups', base: 150, cat: 'core' }],
  'Karen': [{ m: 'Wall Balls', base: 150, cat: 'legs' }],
  'Jackie': [{ m: 'Row (1000m)', base: 1, cat: 'cardio' }, { m: 'Thrusters', base: 50, cat: 'legs' }, { m: 'Pull-ups', base: 30, cat: 'pull' }],
  'Nancy': [{ m: 'Run (400m)', base: 5, cat: 'cardio' }, { m: 'Overhead Squats', base: 75, cat: 'legs' }],
  'Angie': [{ m: 'Pull-ups', base: 100, cat: 'pull' }, { m: 'Push-ups', base: 100, cat: 'push' }, { m: 'Sit-ups', base: 100, cat: 'core' }, { m: 'Air Squats', base: 100, cat: 'legs' }],
  'Chelsea': [{ m: 'Pull-ups', base: 120, cat: 'pull' }, { m: 'Push-ups', base: 240, cat: 'push' }, { m: 'Air Squats', base: 360, cat: 'legs' }],
  'DT': [{ m: 'Deadlifts', base: 60, cat: 'legs' }, { m: 'Hang Power Cleans', base: 45, cat: 'legs' }, { m: 'Push Jerks', base: 30, cat: 'push' }],
  'Kelly': [{ m: 'Run (400m)', base: 5, cat: 'cardio' }, { m: 'Box Jumps', base: 150, cat: 'legs' }, { m: 'Wall Balls', base: 150, cat: 'legs' }],
  'Back Squat 5x5': [{ m: 'Back Squat', base: 25, cat: 'legs' }],
  'Deadlift Build': [{ m: 'Deadlift', base: 18, cat: 'legs' }],
  'Snatch EMOM 12': [{ m: 'Power Snatch', base: 24, cat: 'legs' }],
  'Strict Press 5x3': [{ m: 'Strict Press', base: 15, cat: 'push' }],
  'Row 2k': [{ m: 'Row (2000m)', base: 1, cat: 'cardio' }],
  'Wall Ball AMRAP': [{ m: 'Wall Balls', base: 120, cat: 'legs' }],
  'Box Jump RFT': [{ m: 'Box Jumps', base: 80, cat: 'legs' }, { m: 'Burpees', base: 40, cat: 'push' }],
  'Fight Gone Bad': [{ m: 'Wall Balls', base: 60, cat: 'legs' }, { m: 'SDHP', base: 60, cat: 'pull' }, { m: 'Box Jumps', base: 60, cat: 'legs' }, { m: 'Push Press', base: 60, cat: 'push' }, { m: 'Row (cal)', base: 60, cat: 'cardio' }],
  'Filthy Fifty': [{ m: 'Box Jumps', base: 50, cat: 'legs' }, { m: 'Pull-ups', base: 50, cat: 'pull' }, { m: 'KB Swings', base: 50, cat: 'pull' }, { m: 'Walking Lunges', base: 50, cat: 'legs' }, { m: 'Knees-to-Elbows', base: 50, cat: 'core' }],
  'Isabel': [{ m: 'Snatch', base: 30, cat: 'legs' }],
  'Randy': [{ m: 'Power Snatch', base: 75, cat: 'legs' }],
  'Elizabeth': [{ m: 'Cleans', base: 45, cat: 'legs' }, { m: 'Ring Dips', base: 45, cat: 'push' }],
  'Amanda': [{ m: 'Muscle-ups', base: 27, cat: 'pull' }, { m: 'Snatch', base: 27, cat: 'legs' }],
};
const DEFAULT_MOVEMENTS = [{ m: 'Barbell Cycling', base: 40, cat: 'legs' }, { m: 'Conditioning', base: 40, cat: 'cardio' }];

function deriveMetrics({ workoutName, time_seconds, rom_pct, unbroken_sets, ability, rng }) {
  const rnd = rng || Math.random;
  // ability hint: use provided (seed) else proxy from ROM quality (live logs).
  const ab = clamp(ability != null ? ability : (rom_pct / 100) * 0.9, 0.1, 0.99);
  const intensity = clamp(1 - (Number(time_seconds) - 180) / 700, 0.45, 1);

  const avg_hr = Math.round(clamp(150 + (1 - ab) * 14 + intensity * 8 + (rnd() * 2 - 1) * 5, 128, 186));
  const peak_hr = Math.round(clamp(avg_hr + 8 + rnd() * 14, avg_hr + 6, 205));
  const calories = Math.round((Number(time_seconds) / 60) * (9 + ab * 6) + rnd() * 10);
  const power_output = r1(clamp(160 + ab * 240 + (rnd() * 2 - 1) * 25, 90, 520));
  const work_volume = r1(clamp(1800 + ab * 5200 + (rnd() * 2 - 1) * 400, 800, 8200));

  const defs = MOVEMENTS[workoutName] || DEFAULT_MOVEMENTS;
  const movements = defs.map((d) => ({
    movement: d.m,
    reps: Math.max(1, Math.round(d.base * (0.85 + ab * 0.3))),
    rom_pct: Math.round(clamp(Number(rom_pct) + (rnd() * 2 - 1) * 5, 50, 100)),
    cat: d.cat,
  }));

  return { avg_hr, peak_hr, calories, power_output, work_volume, movements };
}

module.exports = { deriveMetrics, MOVEMENTS };
