// backend/src/services/attendanceSummary.service.js
"use strict";

/**
 * How much school a pupil missed over a stretch of days.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The counting lived inside GET /api/attendance/report/student, which is the
 * only caller today. It is here rather than there so that a second reader —
 * a report, an export, a screen — counts a pupil's absences the same way
 * instead of writing the reduce again, and so a whole class can be counted
 * in one query rather than one per pupil.
 *
 * ── Records and days are different numbers ────────────────────────────────
 *
 * A register is marked per period, so one pupil has several rows a day and
 * the endpoint's totals are row counts: "absent: 6" can mean six periods of
 * one day. That is the right answer for an attendance report and the wrong
 * one under a label that says DAYS, so both are returned. The card prints
 * days; the endpoint keeps its rows, unchanged.
 *
 * ── The statuses are the application's, not new ones ──────────────────────
 *
 * StudentAttendance stores present | absent | late | excused (see
 * shared/attendance.js). "excused" is an excused absence and "absent" an
 * unexcused one; both are days away, and a day the pupil was late is not.
 */

const { StudentAttendance } = require("../db/models/Attendance");

/** The statuses a register can carry, in the order a card reads them. */
const AWAY_STATUSES = ["absent", "excused"];

/**
 * Attendance for one or more pupils between two days, inclusive.
 *
 * One query for the whole list: a class of fifty printed one card at a time
 * would otherwise be fifty round trips for the same fifty rows.
 *
 * @param {object} args
 * @param {string} args.schoolId          always required — this is tenant data
 * @param {string[]} args.studentIds
 * @param {string} args.from              "YYYY-MM-DD"
 * @param {string} args.to                "YYYY-MM-DD"
 * @returns {Promise<Map<string, object>>} studentId → counts
 */
async function summariseStudentAttendance({ schoolId, studentIds, from, to }) {
  const ids = [...new Set((studentIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (!schoolId || !ids.length || !from || !to) return out;

  const rows = await StudentAttendance.find({
    schoolId:  String(schoolId),
    studentId: { $in: ids },
    date:      { $gte: String(from), $lte: String(to) },
  }).select("studentId date status").lean();

  const blank = () => ({
    records: { present: 0, absent: 0, late: 0, excused: 0, total: 0 },
    // The set of calendar days each status was recorded on, collapsed to
    // counts below: one pupil marked absent in four periods missed one day.
    dates:   { present: new Set(), absent: new Set(), late: new Set(), excused: new Set(), away: new Set() },
  });

  for (const id of ids) out.set(id, blank());

  for (const r of rows) {
    const entry = out.get(String(r.studentId));
    if (!entry) continue;
    entry.records.total += 1;
    if (r.status in entry.records) entry.records[r.status] += 1;
    if (entry.dates[r.status]) entry.dates[r.status].add(r.date);
    if (AWAY_STATUSES.includes(r.status)) entry.dates.away.add(r.date);
  }

  for (const [id, entry] of out) {
    out.set(id, {
      records: entry.records,
      days: {
        present:  entry.dates.present.size,
        absent:   entry.dates.absent.size,
        late:     entry.dates.late.size,
        excused:  entry.dates.excused.size,
        // Days the pupil was not in school for any reason. A union, not a
        // sum: a day with an excused morning and an unexcused afternoon is
        // one day missed, not two.
        away:     entry.dates.away.size,
      },
    });
  }
  return out;
}

module.exports = {
  AWAY_STATUSES,
  summariseStudentAttendance,
};
