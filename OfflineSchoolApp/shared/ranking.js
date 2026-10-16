// OfflineSchoolApp/shared/ranking.js
"use strict";

/**
 * The one ranker (docs/39 §13, Phase 4).
 *
 * Every ranking in the system is the same competition rule — highest first,
 * equal values share a place, the next place skips (1, 1, 3) — and it was
 * written out separately for terms and years (termGrading) and again for the
 * weighted sequence route. One copy now, so the places a sequence, a term and
 * a year print cannot drift apart.
 *
 * Pure.
 */

/**
 * Competition places for a list of values, in the list's order.
 * A missing or non-numeric value ranks as 0, as the term ranker always has.
 *
 * @param {Array<number|null|undefined>} values
 * @returns {number[]} places, aligned with `values`
 */
function competitionPlaces(values) {
  const nums = values.map((a) => Number(a) || 0);
  const distinct = [...new Set(nums)].sort((a, b) => b - a);
  const count = new Map();
  for (const v of nums) count.set(v, (count.get(v) ?? 0) + 1);
  const place = new Map();
  let ahead = 0;
  for (const v of distinct) { place.set(v, ahead + 1); ahead += count.get(v); }
  return nums.map((v) => place.get(v));
}

module.exports = { competitionPlaces };
