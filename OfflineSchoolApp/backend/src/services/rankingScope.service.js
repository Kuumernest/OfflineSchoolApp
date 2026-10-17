// backend/src/services/rankingScope.service.js
"use strict";

/**
 * Who a class ranking counts: the one rule the sequence, term and annual
 * layers share.
 *
 * A pupil's place and the class size beside it are stored when results are
 * processed. Rows left behind for pupils who have since left the class — made
 * inactive, deleted, moved — were ranked and counted with the rest, so a class
 * of two printed "5th of 8".
 *
 * ── Why the roster only counts for the current year ──────────────────────
 *
 * The roster is Student.classId with isActive and deletedAt, the population
 * the term and annual layers already compute for. It says where a pupil is
 * NOW. Promotion overwrites it (promotion.service.js), and nothing stops a
 * past period being re-processed, so judged against the roster every pupil of
 * a promoted class looks departed and their results would be removed.
 * Enrollment cannot stand in: only promotion writes it, so it knows nothing of
 * a move or a withdrawal during the year.
 *
 * So a departure is acted on only while the period is the school's current
 * year AND no promotion has closed that year for the class. Both signals are
 * needed: settings.academicYear is set when the school is created and nothing
 * updates it, so on its own it can still name last year after a rollover. When
 * either says no, the rows that exist are ranked as they are and nothing is
 * removed.
 */

const School     = require("../db/models/School");
const Enrollment = require("../db/models/Enrollment");
const { looksLikeSchoolId, invalidateSchool } = require("../utils/schoolContext");

/** What School.settings.academicYear accepts (models/School.js). */
const YEAR_FORMAT = /^\d{4}[/-]\d{4}$/;

/** "2026-2027" and "2026/2027" are the same year (School settings accepts both). */
const yearKey = (y) => String(y ?? "").trim().replace("-", "/");
const yearForms = (y) => {
  const k = yearKey(y);
  return [...new Set([k, k.replace("/", "-")])];
};

/**
 * Whether the current roster decides who a ranking of this class counts.
 *
 * @param {object} p
 * @param {string} p.schoolId
 * @param {string|null} p.academicYear  the period's year
 * @param {string} p.classId
 * @returns {Promise<boolean>}  false whenever it cannot be shown safe
 */
async function rosterDecides({ schoolId, academicYear, classId }) {
  // An id no School can have (School._id is an ObjectId) names no current year.
  if (!academicYear || !classId || !looksLikeSchoolId(schoolId)) return false;

  const school = await School.findById(schoolId).select("settings.academicYear").lean();
  const current = yearKey(school?.settings?.academicYear);
  if (!current || current !== yearKey(academicYear)) return false;

  // The outgoing row a promotion writes carries its outcome; while the year
  // is still running it is null.
  const closed = await Enrollment.exists({
    schoolId,
    academicYear: { $in: yearForms(academicYear) },
    classId,
    outcome:      { $ne: null },
    deletedAt:    null,
  });
  return !closed;
}

/**
 * Move the school's current year from `from` to `to`, and only from `from`.
 *
 * Nothing kept settings.academicYear current: it was set when the school was
 * created, if at all, and named that year forever after — so rosterDecides
 * could never say "this year" once a school had moved on. A promotion is the
 * school moving from one year to the next, so committing one moves the year on
 * and reversing it moves it back.
 *
 * A promotion committed for an older year, or reversed after the school has
 * moved on again, leaves the year where it is. `orUnset` also sets a year on a
 * school that has none.
 *
 * @returns {Promise<boolean>} whether the year was changed
 */
async function moveCurrentYear({ schoolId, from, to, orUnset = false }) {
  const next = String(to ?? "").trim();
  if (!looksLikeSchoolId(schoolId) || !YEAR_FORMAT.test(next)) return false;

  const match = [{ "settings.academicYear": { $in: yearForms(from) } }];
  if (orUnset) match.push({ "settings.academicYear": { $in: [null, ""] } });

  const r = await School.updateOne(
    { _id: schoolId, $or: match },
    { $set: { "settings.academicYear": next } }
  );
  if (r.modifiedCount) invalidateSchool(schoolId);
  return r.modifiedCount > 0;
}

module.exports = { rosterDecides, moveCurrentYear, yearKey, YEAR_FORMAT };
