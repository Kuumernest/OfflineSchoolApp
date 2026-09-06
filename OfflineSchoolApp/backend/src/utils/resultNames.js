// backend/src/utils/resultNames.js
"use strict";

const mongoose = require("mongoose");

/**
 * Fill in the denormalised pupil and class names on result rows as they go out.
 *
 * Term and annual results copy studentName, admissionNo and className onto
 * themselves when they are computed, so a report card is a single read. The
 * copy is only as good as what was there at the time: className came from
 * `student.className`, a string a pupil can be enrolled without, and three on
 * this school's roster were. Their exam results carried "Form 1" — that path
 * had a backfill — and their term results carried nothing, so the class column
 * was empty on the exams and results screens for those three pupils and
 * correct everywhere else.
 *
 * The compute now resolves the name from the classId it is already scoped by.
 * This is the other half: rows computed before that fix are still in the
 * database, and a school should not have to recompute a term to see a class
 * name. Resolving on read costs two queries for a page of results and only
 * when something is actually missing.
 *
 * Deliberately NOT persisted, unlike the equivalents in exam.routes and
 * results.controller. Those write what they resolve back to the row, which is
 * a write on a GET — it turns a read-only replica into an error and makes a
 * report card request that raced with a class rename win or lose depending on
 * ordering. The join is cheap; the write is the part that bites.
 *
 * @param {object[]} rows     lean result documents, patched in place
 * @param {string}   schoolId
 */
async function fillResultNames(rows, schoolId) {
  const list = Array.isArray(rows) ? rows : [rows];

  const missing = list.filter(
    (r) => r && r.studentId && (!r.studentName || !r.admissionNo || !r.className)
  );
  if (!missing.length) return rows;

  const Student = mongoose.model("Student");
  const Class   = mongoose.model("Class");

  const studentIds = [...new Set(missing.map((r) => String(r.studentId)))];
  const classIds   = [...new Set(
    missing.map((r) => r.classId).filter(Boolean).map(String)
  )];

  const [students, classes] = await Promise.all([
    Student.find({ _id: { $in: studentIds }, schoolId })
      .select("_id studentName firstName lastName enrollmentNo admissionNo classId className")
      .lean()
      .catch(() => []),
    classIds.length
      ? Class.find({ _id: { $in: classIds }, schoolId }).select("_id name").lean().catch(() => [])
      : [],
  ]);

  const byStudent = new Map(students.map((s) => [String(s._id), s]));
  const nameOf    = new Map(classes.map((c) => [String(c._id), c.name]));

  for (const r of missing) {
    const s = byStudent.get(String(r.studentId));

    if (!r.studentName) {
      r.studentName = s
        ? (s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" ") || null)
        : null;
    }
    if (!r.admissionNo) {
      r.admissionNo = s ? (s.enrollmentNo || s.admissionNo || null) : null;
    }
    if (!r.className) {
      // The row's own classId first — it records the class the term was sat
      // in, which is the right answer for a pupil who has since moved.
      r.className =
        (r.classId && nameOf.get(String(r.classId))) ||
        s?.className ||
        (s?.classId && nameOf.get(String(s.classId))) ||
        null;
    }
  }

  return rows;
}

module.exports = { fillResultNames };
