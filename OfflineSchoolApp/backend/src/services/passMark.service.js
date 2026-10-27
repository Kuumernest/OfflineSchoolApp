// backend/src/services/passMark.service.js
"use strict";

/**
 * A school's pass mark on /20: GradingConfig.passMark, the figure every
 * isPassing on a term, a year and a card is judged against, 10 when unset.
 * The Exam/ExamSubject passMark fields (raw marks, default 50) are not it.
 */

const GradingConfig = require("../db/models/GradingConfig");
const { DEFAULT_PASS_MARK } = require("../../../shared/passRate");

async function passMarkOf(schoolId) {
  if (!schoolId) return DEFAULT_PASS_MARK;
  const cfg = await GradingConfig.findOne({ schoolId: String(schoolId) }).select("passMark").lean().catch(() => null);
  return cfg?.passMark ?? DEFAULT_PASS_MARK;
}

/** schoolId → pass mark, for many schools in one read. */
async function passMarksOf(schoolIds) {
  const ids = [...new Set((schoolIds || []).map(String))];
  const rows = ids.length
    ? await GradingConfig.find({ schoolId: { $in: ids } }).select("schoolId passMark").lean()
    : [];
  const out = new Map(ids.map((id) => [id, DEFAULT_PASS_MARK]));
  for (const r of rows) if (r.passMark != null) out.set(String(r.schoolId), r.passMark);
  return out;
}

module.exports = { passMarkOf, passMarksOf };
