// backend/src/services/earlyWarning.service.js
"use strict";

const Student             = require("../db/models/Student");
const Class               = require("../db/models/Class");
const Homework            = require("../db/models/Homework");
const ResultSummary       = require("../db/models/ResultSummary");
const { StudentAttendance } = require("../db/models/Attendance");
const { balancesFor }     = require("./fees.service");
const { displayName, byName } = require("../utils/studentName");

/**
 * The watch list: students whose recorded data says something is going wrong.
 *
 * Every signal here is read from records the school ALREADY keeps — attendance
 * registers, published results, homework submissions, the fee ledger. Nothing
 * asks a teacher for a single extra tap, which is the difference between a
 * panel that stays current and a module that dies in a month.
 *
 * The scoring is deliberately a points table, not a model. A head teacher who
 * asks "why is this child on the list?" gets the actual reasons — "absent 6 of
 * 20 days, failed the last exam, owes two thirds of the fees" — and can argue
 * with any of them. A score nobody can argue with is a score nobody trusts.
 *
 * Signals carry machine codes plus the numbers behind them; the clients own
 * the wording, in the reader's language.
 */

const DEFAULT_WINDOW_DAYS = 30;

/** YYYY-MM-DD in local time — the same day arithmetic attendance rows use. */
const dayKey = (d) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/**
 * The thresholds, in one visible place.
 *
 * These are starting values chosen for a Cameroonian day school, not laws of
 * nature: 8% absence over a month is about two days, which is where "was ill
 * once" ends and a pattern begins.
 */
const THRESHOLDS = {
  minAttendanceMarks: 5,     // fewer marked days than this says nothing yet
  absenceRate:  [[0.30, 3], [0.15, 2], [0.08, 1]],
  lateCount:    5,
  gradeDropPct: 10,          // percentage points between the last two exams
  subjectsFailed: 3,
  minHomework:  2,
  homeworkMissRate: [[0.5, 2], [0.25, 1]],
  feeRatio:     0.5,         // owing half or more of what was billed
};

const TIER = (score) => (score >= 5 ? "high" : score >= 3 ? "medium" : "low");

/**
 * @returns {Promise<{generatedAt, windowDays, counts, students}>}
 * students: [{ studentId, name, enrollmentNo, classId, className, score, tier,
 *              signals: [{ code, points, data }] }]
 */
const watchlist = async ({ schoolId, days = DEFAULT_WINDOW_DAYS }) => {
  const sinceKey = dayKey(new Date(Date.now() - days * 86_400_000));
  const todayKey = dayKey(new Date());

  const [students, classes] = await Promise.all([
    Student.find({ schoolId, status: "approved", deletedAt: null })
      .select("studentName name firstName lastName enrollmentNo classId")
      .lean(),
    Class.find({ schoolId, deletedAt: null }).select("name").lean(),
  ]);
  const ids = students.map((s) => String(s._id));
  const classNames = new Map(classes.map((c) => [String(c._id), c.name]));

  const [attendanceAgg, summaries, homework, balances] = await Promise.all([
    // One row per (student, status) in the window.
    StudentAttendance.aggregate([
      { $match: { schoolId, studentId: { $in: ids }, date: { $gte: sinceKey } } },
      { $group: { _id: { student: "$studentId", status: "$status" }, n: { $sum: 1 } } },
    ]),
    // Published only: an unpublished summary is a draft nobody has signed off,
    // and flagging a child over it would leak marks the school has not issued.
    ResultSummary.find({ schoolId, isPublished: true, deletedAt: null })
      .select("studentId percentage isPassing subjectsFailed term academicYear createdAt")
      .sort({ createdAt: 1 })
      .lean(),
    // Homework due inside the window. dueDate is a day string, so string
    // comparison is date comparison.
    Homework.find({
      schoolId, isPublished: true, deletedAt: null,
      dueDate: { $gte: sinceKey, $lte: todayKey },
    }).select("classId dueDate submissions.studentId").lean(),
    // All-time balance, deliberately not scoped to a year: a family two terms
    // behind is more of a warning sign, not less.
    balancesFor({ schoolId, studentIds: ids }),
  ]);

  // ── Fold the raw rows into per-student shapes ───────────────────────────────

  const attendance = new Map(); // studentId → {present, absent, late, excused, marked}
  for (const row of attendanceAgg) {
    const id = String(row._id.student);
    const a = attendance.get(id) ?? { present: 0, absent: 0, late: 0, excused: 0, marked: 0 };
    a[row._id.status] = (a[row._id.status] ?? 0) + row.n;
    a.marked += row.n;
    attendance.set(id, a);
  }

  const lastTwoResults = new Map(); // studentId → [previous?, latest]
  for (const s of summaries) {
    const id = String(s.studentId);
    const list = lastTwoResults.get(id) ?? [];
    list.push(s);
    if (list.length > 2) list.shift();
    lastTwoResults.set(id, list);
  }

  const homeworkByClass = new Map(); // classId → [{submitted:Set}]
  for (const hw of homework) {
    const key = String(hw.classId);
    const list = homeworkByClass.get(key) ?? [];
    list.push(new Set((hw.submissions ?? []).map((sub) => String(sub.studentId))));
    homeworkByClass.set(key, list);
  }

  // ── Score every student ─────────────────────────────────────────────────────

  const rows = [];
  for (const student of students) {
    const id = String(student._id);
    const signals = [];

    const att = attendance.get(id);
    if (att && att.marked >= THRESHOLDS.minAttendanceMarks) {
      const rate = att.absent / att.marked;
      const band = THRESHOLDS.absenceRate.find(([min]) => rate >= min);
      if (band) {
        signals.push({
          code: "absence", points: band[1],
          data: { absent: att.absent, marked: att.marked, days },
        });
      }
      if (att.late >= THRESHOLDS.lateCount) {
        signals.push({ code: "late", points: 1, data: { late: att.late, days } });
      }
    }

    const results = lastTwoResults.get(id) ?? [];
    const latest = results[results.length - 1];
    if (latest) {
      if (latest.isPassing === false) {
        signals.push({
          code: "failed_exam", points: 2,
          data: {
            term: latest.term ?? null, academicYear: latest.academicYear ?? null,
            percentage: latest.percentage ?? null,
          },
        });
      }
      const previous = results.length === 2 ? results[0] : null;
      if (
        previous &&
        typeof previous.percentage === "number" &&
        typeof latest.percentage === "number" &&
        previous.percentage - latest.percentage >= THRESHOLDS.gradeDropPct
      ) {
        signals.push({
          code: "grade_drop", points: 2,
          data: {
            from: Math.round(previous.percentage * 10) / 10,
            to:   Math.round(latest.percentage * 10) / 10,
          },
        });
      }
      if ((latest.subjectsFailed ?? 0) >= THRESHOLDS.subjectsFailed) {
        signals.push({
          code: "subjects_failed", points: 1,
          data: { count: latest.subjectsFailed },
        });
      }
    }

    const assigned = student.classId
      ? homeworkByClass.get(String(student.classId)) ?? []
      : [];
    if (assigned.length >= THRESHOLDS.minHomework) {
      const missing = assigned.filter((submitted) => !submitted.has(id)).length;
      const missRate = missing / assigned.length;
      const band = THRESHOLDS.homeworkMissRate.find(([min]) => missRate >= min);
      if (band) {
        signals.push({
          code: "missing_homework", points: band[1],
          data: { missing, assigned: assigned.length, days },
        });
      }
    }

    const money = balances.get(id);
    if (money && money.balance > 0) {
      const billed = money.charged - money.waived;
      const heavy = billed > 0 && money.balance / billed >= THRESHOLDS.feeRatio;
      signals.push({
        code: "fees_outstanding", points: heavy ? 2 : 1,
        data: { balance: money.balance, billed },
      });
    }

    if (!signals.length) continue;
    const score = signals.reduce((sum, sig) => sum + sig.points, 0);
    rows.push({
      studentId:    id,
      name:         displayName(student) || null,
      enrollmentNo: student.enrollmentNo ?? null,
      classId:      student.classId ? String(student.classId) : null,
      className:    student.classId ? (classNames.get(String(student.classId)) ?? null) : null,
      score,
      tier: TIER(score),
      signals,
    });
  }

  // Worst first; ties in register order so the list is stable between loads.
  rows.sort((a, b) => b.score - a.score || byName(a, b));

  return {
    generatedAt: new Date(),
    windowDays:  days,
    counts: {
      high:   rows.filter((r) => r.tier === "high").length,
      medium: rows.filter((r) => r.tier === "medium").length,
      low:    rows.filter((r) => r.tier === "low").length,
      students: students.length,
    },
    students: rows,
  };
};

module.exports = { watchlist, THRESHOLDS, DEFAULT_WINDOW_DAYS };
