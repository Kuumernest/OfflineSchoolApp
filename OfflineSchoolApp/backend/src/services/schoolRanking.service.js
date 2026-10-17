// backend/src/services/schoolRanking.service.js
"use strict";

/**
 * School places for a term or a year: every pupil in the school with a result
 * for the period, ranked on the period's average by the same competition rule
 * as the class place (shared/ranking).
 *
 * A class is computed on its own, but its school places depend on every other
 * class, so they are read off every row the period has once the class's rows
 * are written and its leftovers removed. A published row counts in the
 * population — its pupil was in the school that period — but is never
 * rewritten (D3): it keeps the place it was issued with. Only rows whose
 * place or school size moved are written, so a re-run does not make every
 * row look changed to the devices that sync it.
 *
 * The sequence layer does the same in examProcess.service (rankAcrossClasses),
 * with grades as well.
 */

const { competitionPlaces } = require("../../../shared/ranking");

/**
 * @param {import("mongoose").Model} Model  TermResult or AnnualResult
 * @param {object} period  { schoolId, academicYear[, term] }
 * @param {string} averageField  "termAverage" or "annualAverage"
 */
async function rankSchool(Model, period, averageField) {
  const rows = await Model.find({ ...period, deletedAt: null })
    .select(`_id isPublished schoolPosition totalInSchool ${averageField}`)
    .lean();
  if (!rows.length) return;

  const totalInSchool = rows.length;
  const places = competitionPlaces(rows.map((r) => r[averageField]));
  const ops = [];
  rows.forEach((r, i) => {
    if (r.isPublished) return;
    if (r.schoolPosition === places[i] && r.totalInSchool === totalInSchool) return;
    ops.push({
      updateOne: {
        filter: { _id: r._id, isPublished: { $ne: true } },
        update: { $set: { schoolPosition: places[i], totalInSchool } },
      },
    });
  });
  if (ops.length) await Model.bulkWrite(ops, { ordered: false });
}

module.exports = { rankSchool };
