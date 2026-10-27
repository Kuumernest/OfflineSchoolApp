// backend/src/services/studentOverview.service.js
"use strict";

/**
 * One pupil at a glance, for the student profile (C10): published results,
 * attendance, the fee balance and who to call.
 *
 * Nothing here is a new rule. Each figure comes from the function that owns it
 * everywhere else, so the profile cannot disagree with the screen it summarises:
 *
 *   results     published summaries only (academicHistory), on /20
 *               (sequenceFigureOn20), judged against the school's pass mark
 *               (summaryPasses); position out of the pupils in that class who
 *               have results for that exam (A1)
 *   attendance  the registers of the last `days` days; a rate only when the
 *               pupil was marked at all (C3: "–", never a false 0%)
 *   fees        the balance for the school's current academic year, the one
 *               Fees > Outstanding counts (A3)
 */

const ResultSummary         = require("../db/models/ResultSummary");
const Exam                  = require("../db/models/Exam");
const School                = require("../db/models/School");
const { StudentAttendance } = require("../db/models/Attendance");
const academicHistory       = require("./intelligence/academicHistory.service");
const { balanceFor }        = require("./fees.service");
const { passMarkOf }        = require("./passMark.service");
const { sequenceFigureOn20 } = require("../../../shared/academicRules");
const { summaryPasses }     = require("../../../shared/passRate");
const { currentAcademicYearOf } = require("../../../shared/academicYear");

const ATTENDANCE_DAYS = 30;
const RESULTS_SHOWN   = 6;

const dayKey = (d) => d.toISOString().slice(0, 10);

/**
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {object}  p.student       the pupil's record (already tenancy-checked)
 * @param {boolean} [p.withFees]    false for a caller without fees.view
 * @param {Date}    [p.asOf]
 */
const overviewFor = async ({ schoolId, student, withFees = true, asOf = new Date() }) => {
  const studentId = String(student._id);
  const since = dayKey(new Date(asOf.getTime() - ATTENDANCE_DAYS * 86_400_000));

  const [history, passMark, school, attendanceAgg] = await Promise.all([
    academicHistory.publishedHistory({ schoolId, studentIds: [studentId] }),
    passMarkOf(schoolId),
    School.findById(schoolId).select("settings.academicYear academicYearStart academicYearEnd").lean(),
    StudentAttendance.aggregate([
      { $match: { schoolId, studentId, date: { $gte: since, $lte: dayKey(asOf) } } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
  ]);

  // ── Results: the latest few, newest first ────────────────────────────────
  const summaries = (history.get(studentId) ?? []).slice(-RESULTS_SHOWN).reverse();
  const examIds   = [...new Set(summaries.map((s) => String(s.examId)))];
  const [exams, extra, classSizes] = await Promise.all([
    Exam.find({ _id: { $in: examIds } }).select("name").lean(),
    ResultSummary.find({ _id: { $in: summaries.map((s) => s._id) } })
      .select("classPosition overallRemark").lean(),
    ResultSummary.aggregate([
      { $match: { schoolId, examId: { $in: examIds }, isPublished: true, deletedAt: null } },
      { $group: { _id: { examId: "$examId", classId: "$classId" }, n: { $sum: 1 } } },
    ]),
  ]);
  const examName = new Map(exams.map((e) => [String(e._id), e.name]));
  const extraOf  = new Map(extra.map((r) => [String(r._id), r]));
  const sizeOf   = new Map(classSizes.map((r) => [`${r._id.examId}|${r._id.classId}`, r.n]));

  const results = summaries.map((s) => {
    const more = extraOf.get(String(s._id)) ?? {};
    return {
      examId:       String(s.examId),
      examName:     examName.get(String(s.examId)) ?? null,
      term:         s.term ?? null,
      academicYear: s.academicYear ?? null,
      average:      sequenceFigureOn20(s),
      passed:       summaryPasses(s, passMark),
      position:     more.classPosition ?? null,
      outOf:        sizeOf.get(`${s.examId}|${s.classId}`) ?? null,
      remark:       more.overallRemark ?? null,
    };
  });

  // ── Attendance ───────────────────────────────────────────────────────────
  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  for (const row of attendanceAgg) if (row._id in counts) counts[row._id] = row.n;
  const marked = counts.present + counts.absent + counts.late + counts.excused;
  const attendance = {
    days: ATTENDANCE_DAYS,
    ...counts,
    marked,
    // Late is attended. null, not 0, when no register marked the pupil.
    rate: marked ? Math.round(((counts.present + counts.late) / marked) * 1000) / 10 : null,
  };

  // ── Fees ─────────────────────────────────────────────────────────────────
  let fees = null;
  if (withFees) {
    const academicYear = currentAcademicYearOf(school ?? {});
    const t = await balanceFor({ schoolId, studentId, academicYear });
    fees = { academicYear, charged: t.charged - t.waived, paid: t.paid, balance: t.balance };
  }

  return {
    results,
    passMark,
    attendance,
    fees,
    guardian: {
      name:  student.guardianName  ?? null,
      phone: student.guardianPhone ?? null,
      email: student.guardianEmail ?? null,
    },
  };
};

module.exports = { overviewFor, ATTENDANCE_DAYS, RESULTS_SHOWN };
