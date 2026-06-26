'use strict';

// Badge evaluation. Runs inside the POST /api/results transaction (receives the
// transaction `client`) after the result has been saved. Awards any newly-met
// badge, writes a 'badge_earned' feed event, and returns the newly earned
// badges so the API can surface the unlock to the UI.
//
// Criteria live in the badges.criteria JSONB column so new badges can be added
// by inserting a row — supported criteria types:
//   { "type": "first_result" }
//   { "type": "time_under", "workout_name": "Fran", "seconds": 240 }
//   { "type": "nth_result", "n": 100 }

async function badgeIsMet(client, criteria, { userId, result, workout }) {
  switch (criteria.type) {
    case 'first_result': {
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM results WHERE user_id = $1', [userId]);
      return rows[0].n === 1;
    }
    case 'nth_result': {
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM results WHERE user_id = $1', [userId]);
      return rows[0].n === Number(criteria.n);
    }
    case 'time_under': {
      return workout.name === criteria.workout_name
        && Number(result.time_seconds) < Number(criteria.seconds);
    }
    default:
      return false;
  }
}

async function evaluateBadges(client, ctx) {
  const { userId } = ctx;
  const { rows: badges } = await client.query(
    'SELECT badge_id, code, name, description, criteria FROM badges');

  const earned = [];
  for (const badge of badges) {
    let met = false;
    try {
      met = await badgeIsMet(client, badge.criteria || {}, ctx);
    } catch (_) {
      met = false; // a malformed criteria never breaks logging
    }
    if (!met) continue;

    // Award if not already held. RETURNING tells us if this is newly earned.
    const ins = await client.query(
      `INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2)
         ON CONFLICT (user_id, badge_id) DO NOTHING
         RETURNING badge_id`,
      [userId, badge.badge_id]
    );
    if (!ins.rows[0]) continue; // already had it

    await client.query(
      `INSERT INTO feed_events (user_id, type, ref_id, payload)
         VALUES ($1, 'badge_earned', $2, $3)`,
      [userId, badge.badge_id,
       JSON.stringify({ code: badge.code, name: badge.name, description: badge.description })]
    );
    earned.push({ code: badge.code, name: badge.name, description: badge.description });
  }
  return earned;
}

module.exports = { evaluateBadges };
