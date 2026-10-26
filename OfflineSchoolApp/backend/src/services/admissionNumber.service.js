// backend/src/services/admissionNumber.service.js
"use strict";

/**
 * The one place a student's admission number is made.
 *
 * ── The fault this exists to fix ──────────────────────────────────────────
 *
 * Five generators had grown up beside each other, and they disagreed:
 *
 *   approving an applicant        PUT  /admin/students/:id/approve   GVA00/2026/001
 *   the console's "give a number" POST /admin/students/:id/enrollment-number   GVA00/2026/001
 *   adding a student directly     POST /students (provisionStudentAccount)   GVA00-2026-0001
 *   provisioning a login          POST /api/students/:id/enrollment-number   GVA00-2026-0001
 *   approving through the sync    POST /sync/push (pushStudentDecisions)     GVA00-2026-0001
 *
 * So two pupils admitted the same morning got numbers in different shapes,
 * and each generator counted only its own shape — the slash ones read
 * `admissionNo` alone, the dash ones `User.enrollmentNo` alone — so neither saw
 * the other's numbers and the sequences ran independently.
 *
 * ── What it does now ──────────────────────────────────────────────────────
 *
 * One format, FORMAT below: CODE-YEAR-NNN, at least three digits.
 *
 * One sequence per school code and year. The next number is one past the
 * highest already issued in ANY of the shapes above, on any of the fields a
 * number has been kept in, so a new number never repeats one already printed
 * on somebody's paperwork — GVA00/2026/007 existing means the next is
 * GVA00-2026-008.
 *
 * Race-safe by a counter rather than by read-the-highest-and-add-one: the
 * counter is first raised to the highest issued ($max, which never lowers it),
 * then incremented atomically, so two admissions at the same moment take two
 * different numbers. Callers keep their unique-index retry as the second line.
 *
 * Existing numbers are never rewritten. Renumbering a real student would
 * invalidate whatever already carries the old number; the legacy shapes stay
 * as they are and are simply counted.
 */

const Counter = require("../db/models/Counter");

/** Change the shape here, and only here. */
const FORMAT = { separator: "-", minDigits: 3 };

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The school's short code, as every generator resolved it: School.code, else
 * the first three alphanumerics of the id, else "SCH".
 */
async function schoolCodeFor(schoolId) {
  try {
    const School = require("../db/models/School");
    const school = schoolId
      ? await School.findById(schoolId).select("code").lean()
      : null;
    if (school?.code?.trim()) return school.code.trim().toUpperCase().slice(0, 5);
  } catch { /* fall through to the id */ }
  return String(schoolId || "").replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase() || "SCH";
}

function formatAdmissionNo(code, year, seq) {
  const { separator: s, minDigits } = FORMAT;
  return `${code}${s}${year}${s}${String(seq).padStart(minDigits, "0")}`;
}

/** Any shape this app has issued: CODE-YEAR-0001, CODE/YEAR/001, mixed. */
const anyShape = (code, year) =>
  new RegExp(`^${escapeRegex(code)}[-/]${escapeRegex(year)}[-/](\\d+)$`);

/** The sequence in a number of this code and year, or null. */
function sequenceOf(value, code, year) {
  const m = anyShape(code, year).exec(String(value ?? "").trim());
  return m ? parseInt(m[1], 10) : null;
}

/**
 * The highest sequence already issued for this code and year, in every
 * collection and field a number has lived in.
 *
 * Not narrowed to one school: User.enrollmentNo is unique across the whole
 * database, so a number another school with the same code already holds is
 * just as unusable.
 */
async function highestIssued(code, year) {
  const mongoose = require("mongoose");
  const rx = new RegExp(`^${escapeRegex(code)}[-/]${escapeRegex(year)}[-/]\\d+$`);
  const sources = [
    ["Student",            ["admissionNo", "enrollmentNo", "admissionNumber"]],
    ["StudentApplication", ["admissionNo", "enrollmentNo", "admissionNumber"]],
    ["User",               ["enrollmentNo"]],
  ];
  let max = 0;
  for (const [model, fields] of sources) {
    if (!mongoose.models[model]) {
      try { require(`../db/models/${model}`); } catch { continue; }
    }
    const M = mongoose.models[model];
    const rows = await M.find({ $or: fields.map((f) => ({ [f]: rx })) })
      .select(fields.join(" ")).lean().catch(() => []);
    for (const row of rows) {
      for (const f of fields) {
        const seq = sequenceOf(row[f], code, year);
        if (seq != null && seq > max) max = seq;
      }
    }
  }
  return max;
}

/**
 * Issue the next admission number for a school.
 *
 * @param {string} schoolId
 * @param {object} [opts]
 * @param {number} [opts.year]  defaults to this calendar year, as every
 *   generator before it did
 * @returns {Promise<string>}
 */
async function nextAdmissionNo(schoolId, { year = new Date().getFullYear() } = {}) {
  const code = await schoolCodeFor(schoolId);
  const _id  = `admissionNo:${code}:${year}`;
  const issued = await highestIssued(code, year);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await Counter.updateOne(
        { _id },
        { $max: { seq: issued }, $setOnInsert: { schoolId: schoolId ? String(schoolId) : null } },
        { upsert: true }
      );
      break;
    } catch (err) {
      // Two first-ever admissions racing on the upsert: one inserts, the other
      // gets E11000 and simply runs again as an update.
      if (err?.code !== 11000 || attempt >= 2) throw err;
    }
  }

  const counter = await Counter.findOneAndUpdate(
    { _id }, { $inc: { seq: 1 } }, { returnDocument: "after" }
  ).lean();
  return formatAdmissionNo(code, year, counter.seq);
}

module.exports = {
  nextAdmissionNo, formatAdmissionNo, sequenceOf, highestIssued, schoolCodeFor, FORMAT,
};
