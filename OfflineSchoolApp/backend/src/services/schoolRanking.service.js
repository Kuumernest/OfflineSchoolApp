// backend/src/services/schoolRanking.service.js
"use strict";

/**
 * Grade and school places for one period — a sequence, a term or a year —
 * read off every row the period has once a class's rows are written and its
 * leftovers removed. A class is computed on its own, but these places depend
 * on every other class.
 *
 * - School: every pupil in the school with a result for the period.
 * - Grade: the pupils of classes sharing one Class.level ("Form 1A" and
 *   "Form 1B" both at level "Form 1"; case and surrounding spaces ignored).
 *   A class with no level is in no grade, and its pupils get no grade place
 *   rather than one guessed from the class name.
 *
 * Same competition rule as the class place (shared/ranking). A published row
 * counts in the population — its pupil sat the period — but is never
 * rewritten (D3): it keeps the places it was issued with. So a school that
 * publishes one class before computing the rest will see the published
 * cards' sizes disagree with the later ones. Only rows whose places moved are
 * written, so a re-run does not make every row look changed to the devices
 * that sync it.
 */

const mongoose = require("mongoose");
const { competitionPlaces } = require("../../../shared/ranking");

const PLACE_FIELDS = ["gradePosition", "totalInGrade", "schoolPosition", "totalInSchool"];

/**
 * @param {import("mongoose").Model} Model  ResultSummary, TermResult or AnnualResult
 * @param {object} period  the period's rows: { schoolId, examId } or
 *                         { schoolId, academicYear[, term] }
 * @param {string} averageField  "average", "termAverage" or "annualAverage"
 */
async function rankAcrossClasses(Model, period, averageField) {
  // A row with no average was never ranked by its class either.
  const rows = (await Model.find({ ...period, deletedAt: null })
    .select(["_id", "classId", "isPublished", averageField, ...PLACE_FIELDS].join(" "))
    .lean())
    .filter((r) => r[averageField] != null);
  if (!rows.length) return;

  const classIds = [...new Set(rows.map((r) => r.classId).filter(Boolean).map(String))];
  const classes = classIds.length
    ? await mongoose.model("Class").find({ _id: { $in: classIds }, schoolId: period.schoolId })
        .select("_id level").lean()
    : [];
  const gradeOf = new Map(classes.map((c) => [String(c._id), (c.level || "").trim().toLowerCase()]));

  const places = new Map(rows.map((r) => [String(r._id), {
    gradePosition: null, totalInGrade: null, schoolPosition: null, totalInSchool: rows.length,
  }]));
  competitionPlaces(rows.map((r) => r[averageField])).forEach((p, i) => {
    places.get(String(rows[i]._id)).schoolPosition = p;
  });

  const byGrade = new Map();
  for (const r of rows) {
    const grade = gradeOf.get(String(r.classId));
    if (!grade) continue;
    if (!byGrade.has(grade)) byGrade.set(grade, []);
    byGrade.get(grade).push(r);
  }
  for (const members of byGrade.values()) {
    competitionPlaces(members.map((r) => r[averageField])).forEach((p, i) => {
      Object.assign(places.get(String(members[i]._id)), { gradePosition: p, totalInGrade: members.length });
    });
  }

  const moved = (r) => PLACE_FIELDS.some((k) => (r[k] ?? null) !== places.get(String(r._id))[k]);
  const ops = rows.filter((r) => !r.isPublished && moved(r)).map((r) => ({
    updateOne: {
      filter: { _id: r._id, isPublished: { $ne: true } },
      update: { $set: places.get(String(r._id)) },
    },
  }));
  if (ops.length) await Model.bulkWrite(ops, { ordered: false });
}

module.exports = { rankAcrossClasses };
