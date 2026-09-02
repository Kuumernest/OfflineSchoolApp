// backend/src/services/subjectCoefficient.service.js
"use strict";

/**
 * What happens to the exams when a subject's coefficient changes.
 *
 * ── The two numbers, which look interchangeable and are not ───────────────
 *
 * Subject.coefficient is the Cameroon sense: 1 is normal, 2 counts double.
 * ExamSubject.weight is percentage-style, where 100 means coefficient 1, and
 * attaching a subject to an exam seeds weight = coefficient × 100.
 *
 * ── The fault this exists to fix ──────────────────────────────────────────
 *
 * PUT /admin/subjects/:id wrote Subject.coefficient and stopped there. Every
 * ExamSubject already attached kept the weight it was seeded with, and the
 * grading service and the mark-entry screen both read the weight. So a head
 * would set Mathematics to coefficient 4, open the marks screen, and find it
 * still counting as 1 — with nothing on screen to say why, and no way to tell
 * from the subject page that the change had gone nowhere.
 *
 * ── Why it cascades rather than being read live ───────────────────────────
 *
 * Because a per-exam coefficient is a real thing: PUT /exams/:examId/subjects/:id
 * exists so a head can weight one paper differently, and reading the subject's
 * value at grading time would silently throw that away. So the exam keeps its
 * own copy, and changing the school-wide default updates the copies that were
 * still following it.
 *
 * ── What is deliberately left alone ───────────────────────────────────────
 *
 * A row whose weight does not match the OLD default was set per exam, and is
 * the head's decision to keep. A row on an exam whose results are published,
 * locked or archived is part of a document that has already gone home; a
 * coefficient rescales every average in the class, and rewriting a card a
 * family is holding is not a side effect any edit should have.
 *
 * ── And why nothing is recomputed ─────────────────────────────────────────
 *
 * The same reason PUT /exams/:examId/subjects/:id does not: recomputing would
 * rewrite results an admin may be about to publish. The caller is told that a
 * reprocess is needed and decides when.
 */

const Exam         = require("../db/models/Exam");
const ExamSubject  = require("../db/models/ExamSubject");
const StudentScore = require("../db/models/StudentScore");

/** 100 = coefficient 1. */
const WEIGHT_PER_COEFFICIENT = 100;

/**
 * A subject's coefficient as everything downstream reads it.
 *
 * Subjects created before the field existed hold nothing, and the whole app
 * treats that as 1 — including the read normaliser in admin.routes.js. The
 * cascade has to agree with it, or a first edit would compare against a
 * different "old" value than the screens were showing.
 */
const coefficientOf = (subject) =>
  Number(subject?.coefficient) > 0 ? Number(subject.coefficient) : 1;

const weightFor = (coefficient) => coefficient * WEIGHT_PER_COEFFICIENT;

/**
 * The other direction: an ExamSubject's stored weight as a coefficient.
 *
 * Every card needs this and each one had written it out again. The term and
 * annual cards read `es.coefficient`, a field ExamSubject does not have, so
 * every subject on those cards printed a coefficient of 1 however the school
 * had weighted it — while the sequence card, computing it from `weight`,
 * printed 4. Two cards for the same pupil disagreeing about how much a subject
 * counts is not a rounding difference; it is a different average.
 *
 * A missing or nonsensical weight falls back to 1, which is the schema default
 * expressed as a coefficient.
 */
const coefficientFromWeight = (weight) => {
  if (weight == null) return 1;
  const c = Math.round((Number(weight) / WEIGHT_PER_COEFFICIENT) * 100) / 100;
  return c > 0 ? c : 1;
};

/**
 * Is this exam's marking finished as far as the school is concerned?
 *
 * Any one of these is enough. `status` alone is not: an exam can carry
 * resultsPublished with a status the school never advanced.
 */
const isFinalised = (exam) =>
  Boolean(exam?.resultsPublished) ||
  Boolean(exam?.resultsLockedAt) ||
  ["published", "archived"].includes(String(exam?.status || ""));

/**
 * Push a new coefficient into the exam subjects that were following the old one.
 *
 * @param {object} p
 * @param {string} p.schoolId
 * @param {string} p.subjectId
 * @param {number} p.from  the coefficient before the edit
 * @param {number} p.to    the coefficient after it
 * @param {boolean} [p.force]  align every unfinalised row, whatever its weight.
 *   For the backfill of rows that drifted while the cascade did not exist —
 *   never for an ordinary edit, where a mismatched weight means somebody chose
 *   it on purpose.
 * @returns {Promise<{updated: number, examIds: string[], skippedFinalised: number,
 *                    skippedOverridden: number, reprocessRequired: boolean}>}
 */
async function cascadeCoefficient({ schoolId, subjectId, from, to, force = false }) {
  const empty = {
    updated: 0, examIds: [], skippedFinalised: 0,
    skippedOverridden: 0, reprocessRequired: false,
  };
  if (!subjectId) return empty;
  if (!force && !(Number.isFinite(from) && Number.isFinite(to) && from !== to)) {
    return empty;
  }

  const rows = await ExamSubject.find({
    ...(schoolId ? { schoolId: String(schoolId) } : {}),
    subjectId: String(subjectId),
    deletedAt: null,
  }).select("_id examId weight").lean();
  if (!rows.length) return empty;

  const exams = await Exam.find({
    _id: { $in: [...new Set(rows.map((r) => String(r.examId)))] },
  }).select("_id status resultsPublished resultsLockedAt").lean();

  const finalised = new Set(
    exams.filter(isFinalised).map((e) => String(e._id))
  );

  const target = weightFor(to);
  let skippedFinalised = 0, skippedOverridden = 0;
  const following = [];

  for (const row of rows) {
    if (finalised.has(String(row.examId))) { skippedFinalised += 1; continue; }
    if (Number(row.weight) === target)     continue;   // already right
    if (!force && Number(row.weight) !== weightFor(from)) {
      skippedOverridden += 1;
      continue;
    }
    following.push(row);
  }

  if (!following.length) {
    return { ...empty, skippedFinalised, skippedOverridden };
  }

  await ExamSubject.updateMany(
    { _id: { $in: following.map((r) => r._id) } },
    { $set: { weight: target } }
  );

  const examIds = [...new Set(following.map((r) => String(r.examId)))];

  // Only an exam that has been marked needs reprocessing; one with no scores
  // yet will pick the new coefficient up when it is graded.
  const marked = await StudentScore.exists({
    ...(schoolId ? { schoolId: String(schoolId) } : {}),
    subjectId: String(subjectId),
    examId:    { $in: examIds },
    deletedAt: null,
  });

  return {
    updated: following.length,
    examIds,
    skippedFinalised,
    skippedOverridden,
    reprocessRequired: Boolean(marked),
  };
}

module.exports = {
  cascadeCoefficient, coefficientOf, weightFor, coefficientFromWeight,
  isFinalised, WEIGHT_PER_COEFFICIENT,
};
