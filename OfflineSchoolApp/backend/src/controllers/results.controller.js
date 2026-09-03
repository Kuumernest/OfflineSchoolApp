// backend/src/controllers/results.controller.js
"use strict";

const { v4: uuidv4 }  = require("uuid");
const StudentScore    = require("../db/models/StudentScore");
const ResultSummary   = require("../db/models/ResultSummary");
const Exam            = require("../db/models/Exam");
const ExamSubject     = require("../db/models/ExamSubject");
const GradingConfig   = require("../db/models/GradingConfig");
const School          = require("../db/models/School");
const GeneratedReport = require("../db/models/GeneratedReport");
const ResultChangeLog = require("../db/models/ResultChangeLog");
const {
  guardResultWrite,
  logResultChange,
  diffField,
} = require("../services/resultAudit.service");
const Student = require("../db/models/Student");
const AcademicStructure = require("../db/models/AcademicStructure");
const { renderReportCardHtml, renderReportCard } =
  require("../services/reportHtml.service");
const resultsService = require("../services/results.service");
const { getRankings } = resultsService;
const { lookupGrade } = require("../services/grading.service");
// The §5/§7/§8 rules, shared with the term and annual cards and covered by
// scripts/check-report-card.js.
const { reportTypeFor, subjectRanking, periodName } =
  require("../../../shared/reportCard");

// ─────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided)
    return String(provided).trim();
  return req.user?.schoolId;
};

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const isAdmin = (role) =>
  ["super_admin", "school_admin", "admin"].includes(role);

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId
// ─────────────────────────────────────────────────────────

const getExamResults = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const {
    schoolId: qSchoolId,
    classId,
    isPublished,
    page  = 1,
    limit = 50,
  } = req.query;

  const schoolId = resolveSchoolId(req, qSchoolId);
  const filter   = { examId, deletedAt: null };

  if (schoolId) filter.schoolId = schoolId;
  if (classId)  filter.classId  = classId;

  if (!isAdmin(req.user?.role)) {
    filter.isPublished = true;
  } else if (isPublished !== undefined) {
    filter.isPublished = isPublished === "true";
  }

  const skip    = (Number(page) - 1) * Number(limit);
  const total   = await ResultSummary.countDocuments(filter);
  const results = await ResultSummary.find(filter)
    .sort({ classPosition: 1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  // Backfill studentName / admissionNo / className for old results that were
  // processed before the fields were denormalised. enrollmentNo is the single
  // source of truth; admissionNo only survives as a legacy fallback.
  const missing = results.filter((r) => (!r.studentName || !r.className) && r.studentId);
  if (missing.length > 0 && schoolId) {
    const Student = require("../db/models/Student");
    const ids = [...new Set(missing.map((r) => r.studentId))];
    const [students, classes] = await Promise.all([
      Student.find({ _id: { $in: ids }, schoolId })
        .select("_id studentName firstName lastName enrollmentNo admissionNo classId")
        .lean(),
      require("../db/models/Class").find({ schoolId }).select("_id name").lean(),
    ]);
    const sMap = new Map(students.map((s) => [String(s._id), s]));
    const cMap = new Map(classes.map((c) => [String(c._id), c.name]));
    const bulkOps = [];
    for (const r of missing) {
      const s = sMap.get(String(r.studentId));
      if (!s) continue;
      const name    = s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" ") || null;
      const admNo   = s.enrollmentNo || s.admissionNo || null;
      const clsName = cMap.get(String(s.classId)) || null;
      if (!r.studentName) r.studentName = name;
      if (!r.admissionNo) r.admissionNo = admNo;
      if (!r.className)   r.className   = clsName;
      const $set = {};
      if (name)    $set.studentName = name;
      if (admNo)   $set.admissionNo = admNo;
      if (clsName) $set.className   = clsName;
      bulkOps.push({ updateOne: { filter: { _id: r._id }, update: { $set } } });
    }
    if (bulkOps.length > 0) {
      await ResultSummary.bulkWrite(bulkOps).catch(() => {});
    }
  }

  return res.json({
    success: true,
    count:   results.length,
    total,
    page:    Number(page),
    pages:   Math.ceil(total / Number(limit)),
    data:    results,
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/stats
// ─────────────────────────────────────────────────────────

const getExamStats = asyncHandler(async (req, res) => {
  const { examId }  = req.params;
  const { classId, schoolId: qSchoolId } = req.query;

  const schoolId = resolveSchoolId(req, qSchoolId);

  const filter = { examId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;
  if (classId)  filter.classId  = classId;

  const results = await ResultSummary.find(filter).lean();

  const totalStudents = results.length;
  const passed = results.filter((r) => r.isPassing).length;
  const failed = totalStudents - passed;

  // Average / highest / lowest use each student's overall percentage (0-100),
  // not the /20 average stored on the summary. r.average mixes scales when
  // subjects have different maxScore, so a 12/20 average must not render as 12%.
  const percentages = results
    .map((r) => r.percentage)
    .filter((p) => p != null && Number.isFinite(Number(p)))
    .map(Number);
  const average = percentages.length
    ? Math.round((percentages.reduce((s, v) => s + v, 0) / percentages.length) * 100) / 100
    : 0;
  const highest = percentages.length ? Math.max(...percentages) : 0;
  const lowest  = percentages.length ? Math.min(...percentages) : 0;
  const passRate = totalStudents > 0
    ? Math.round((passed / totalStudents) * 10000) / 100
    : 0;

  const gpas = results
    .map((r) => r.gpa)
    .filter((g) => g != null && Number.isFinite(Number(g)))
    .map(Number);
  const averageGpa = gpas.length
    ? Math.round((gpas.reduce((s, v) => s + v, 0) / gpas.length) * 100) / 100
    : 0;

  const gradeDistribution = {};
  for (const r of results) {
    const g = r.overallGrade || "N/A";
    gradeDistribution[g] = (gradeDistribution[g] || 0) + 1;
  }

  // Subject analysis — aggregate per-subject numbers from every student's
  // subjectBreakdown. Averages / highs / lows are percentages so the UI can
  // render them alongside the pass rate without mixing scales.
  const subjectAgg = new Map();
  for (const r of results) {
    for (const s of r.subjectBreakdown || []) {
      if (s.isAbsent || s.isExempt || s.score == null) continue;
      const key = String(s.subjectId || s.subjectName || "");
      if (!key) continue;
      if (!subjectAgg.has(key)) {
        subjectAgg.set(key, {
          subjectId:   s.subjectId || key,
          subjectName: s.subjectName || key,
          total:       0,
          sum:         0,
          highest:     -Infinity,
          lowest:      Infinity,
          passed:      0,
        });
      }
      const agg = subjectAgg.get(key);
      agg.total += 1;
      const pct = s.percentage != null && Number.isFinite(Number(s.percentage))
        ? Number(s.percentage)
        : s.maxScore > 0
          ? Math.round((Number(s.score) / Number(s.maxScore)) * 10000) / 100
          : 0;
      agg.sum += pct;
      if (pct > agg.highest) agg.highest = pct;
      if (pct < agg.lowest)  agg.lowest  = pct;
      if (s.isPassing) agg.passed += 1;
    }
  }
  const subjectStats = [...subjectAgg.values()].map((a) => ({
    subjectId:   a.subjectId,
    subjectName: a.subjectName,
    average:     a.total > 0 ? Math.round((a.sum / a.total) * 100) / 100 : 0,
    highest:     a.total > 0 ? a.highest : 0,
    lowest:      a.total > 0 ? a.lowest  : 0,
    passRate:    a.total > 0 ? Math.round((a.passed / a.total) * 10000) / 100 : 0,
    total:       a.total,
  }));

  return res.json({
    success: true,
    data: {
      totalStudents,
      passed,
      failed,
      average,
      highest,
      lowest,
      passRate,
      averageGpa,
      gradeDistribution,
      subjectStats,
    },
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/rankings
// ─────────────────────────────────────────────────────────

const getExamRankings = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const {
    rankBy = "class",
    classId,
    limit  = 100,
  } = req.query;

  const scope = ["class", "grade", "school"].includes(rankBy)
    ? rankBy : "class";

  let rankings = await getRankings(examId, scope, classId || null);
  rankings     = rankings.slice(0, Number(limit));

  return res.json({
    success: true,
    rankBy:  scope,
    count:   rankings.length,
    data:    rankings,
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId
// ─────────────────────────────────────────────────────────

const getStudentResult = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;

  // ✅ Phase 0 repoint: this route used to read ExamResult/ExamScore — models
  //    the processing pipeline no longer writes (processResults lands data in
  //    ResultSummary / StudentScore). Consumers got an empty summary and the
  //    web batch print silently fell back to blank marks. Response shape is
  //    unchanged: { summary, scores }.
  const [summary, scores] = await Promise.all([
    ResultSummary.findOne({ examId, studentId, deletedAt: null }).lean(),
    StudentScore.find({ examId, studentId, deletedAt: null }).lean(),
  ]);

  if (!summary && !scores.length) {
    return res.status(404).json({
      success: false,
      error:   "No result found for this student in this exam",
    });
  }

  // Backfill studentName if missing
  if (summary && !summary.studentName && summary.studentId) {
    const Student = require("../db/models/Student");
    const stu = await Student.findOne({ _id: summary.studentId, schoolId: summary.schoolId })
      .select("_id studentName firstName lastName admissionNo")
      .lean();
    if (stu) {
      const name = stu.studentName || [stu.firstName, stu.lastName].filter(Boolean).join(" ") || null;
      summary.studentName = name;
      summary.admissionNo = stu.admissionNo || null;
      await ResultSummary.updateOne(
        { _id: summary._id },
        { $set: { studentName: name, admissionNo: stu.admissionNo || null } }
      ).catch(() => {});
    }
  }

  return res.json({
    success: true,
    data:    { summary: summary ?? null, scores },
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId/reportcard
// ─────────────────────────────────────────────────────────

// Shared payload builder — used by the JSON endpoint and the HTML renderer
// endpoint (Phase 2 single-engine consolidation). Returns
// { ok: true, data } or { ok: false }.
const buildStudentReportCardData = async (examId, studentId) => {
  // ✅ Phase 0 repoint: reads the LIVE pipeline collections (StudentScore +
  //    ResultSummary, written by processResults) instead of ExamResult/ExamScore.
  //    Payload shape is unchanged — the mobile ReportCard (admin + student
  //    views), the web batch print and the shared HTML renderer consume it.
  const [scores, examSubjects, summary, exam] = await Promise.all([
    StudentScore.find({ examId, studentId, deletedAt: null }).lean(),
    ExamSubject.find({ examId, deletedAt: null }).lean(),
    ResultSummary.findOne({ examId, studentId, deletedAt: null }).lean(),
    Exam.findById(examId).lean(),
  ]);

  if (!summary && !scores.length) return { ok: false };

  // ── Student info + school grading settings (requirements §1, §3) ──────────
  const [student, gradingConfig, allExamScores] = await Promise.all([
    // gender / dateOfBirth live on the Student document, not the summary
    Student.findOne({ _id: studentId })
      .select("gender dateOfBirth studentName enrollmentNo admissionNo photoUrl")
      .lean()
      .catch(() => null),
    // showGrades + the school's configurable grade bands (§3). Falls back to
    // the model's DEFAULT_GRADE_SCALE when the school has no config.
    exam?.schoolId
      ? GradingConfig.findOne({ schoolId: String(exam.schoolId) }).lean()
          .catch(() => null)
      : Promise.resolve(null),
    // Every score for this exam — needed to rank the student per subject (§5)
    StudentScore.find({ examId, deletedAt: null })
      .select("studentId examSubjectId subjectId score maxScore isAbsent isExempt")
      .lean(),
  ]);

  const showGrades = gradingConfig?.showGrades ?? true;

  // ── Per-subject positions (§5) ─────────────────────────────────────────────
  // The rule itself is in shared/reportCard.js, where the term and annual cards
  // reach it too and where scripts/check-report-card.js can test it: pupils who
  // did not sit a subject are out of both the ranking and the denominator, and
  // equal marks share a place.
  const ranking = subjectRanking(allExamScores);
  const computeSubjectPosition = (score) => ranking.positionOf(score);

  // ── Grade + remark per the school's configured bands (§3, §4) ──────────────
  // The school's GradingConfig.grades bands are on the /20 Cameroon scale
  // (see DEFAULT_GRADE_SCALE in the model). When the school has no config or
  // no band matches, fall back to the built-in Cameroon scale so a real mark
  // never renders without its grade/remark.
  const bands = Array.isArray(gradingConfig?.grades)
    ? gradingConfig.grades.filter((b) => b && b.grade != null)
    : [];
  // One lookup, from shared/, rather than a fourth hand-written band search.
  // Both remarks come back: a report card renders in the reader's language and
  // the renderer picks, so the payload cannot decide that for it.
  const gradeInfo = (normalizedMark) => {
    if (normalizedMark == null) {
      return { grade: null, points: null, remark: null, remarkFr: null };
    }
    const band = GradingConfig.findGradeBand(normalizedMark, bands);
    if (band) {
      return {
        grade:    band.grade,
        points:   band.gpaPoints ?? null,
        remark:   band.remark    || null,
        remarkFr: band.remarkFr  || band.remark || null,
      };
    }
    const fb = lookupGrade(normalizedMark);
    return {
      grade:    fb.grade,
      points:   fb.points ?? null,
      remark:   fb.remark,
      remarkFr: fb.remarkFr || fb.remark,
    };
  };

  /** The /20 average this card headlines, for the overall band lookup. */
  const resolveAvg20 = () =>
    summary?.average != null ? Number(summary.average) : null;

  // Lookup by both ref styles: StudentScore.examSubjectId → ExamSubject._id,
  // while rows entered before subjects were set up may only carry subjectId.
  const subjectMap = new Map();
  for (const es of examSubjects) {
    subjectMap.set(String(es._id), es);
    if (es.subjectId != null) subjectMap.set(String(es.subjectId), es);
  }

  // Canonical weight semantics: ExamSubject.weight is percentage-style
  // (schema default 100). ÷100 → multiplier coefficient, so the default
  // leaves every subject equally weighted (×1).
  //
  // Shared, because the term and annual cards need the identical answer and
  // their own copy of this read a field ExamSubject does not have — so the
  // same pupil's sequence card said ×4 and their term card said ×1.
  const resolveCoeff = (es) => coefficientFromWeight(es?.weight);

  const subjectRows = scores.map((score) => {
    const es       = subjectMap.get(String(score.examSubjectId)) ||
                     subjectMap.get(String(score.subjectId)) || {};
    // The exam's own total before a literal 100. A subject row written before
    // ExamSubject inherited the exam's totals says 100 even in a school that
    // marks out of 20, and normalising an 18 against 100 gives 3.6 — an F on
    // every subject of every card.
    const maxScore = score.maxScore || es.maxScore || exam?.totalMarks || 100;
    const coeff    = resolveCoeff(es);

    const normalizedMark =
      score.score != null && !score.isAbsent && !score.isExempt
        ? Math.round((score.score / maxScore) * 20 * 100) / 100
        : null;

    const weightedScore =
      normalizedMark != null
        ? Math.round(normalizedMark * coeff * 100) / 100
        : null;

    const posInfo = computeSubjectPosition(score);
    const gi      = gradeInfo(normalizedMark);

    return {
      scoreId:       String(score._id),
      subjectId:     String(score.subjectId),
      examSubjectId: score.examSubjectId || es._id || null,
      subjectName:   es.subjectName  || String(score.subjectId),
      teacherName:   es.teacherName  || null,
      score:         score.score,
      maxScore,
      isAbsent:      score.isAbsent      ?? false,
      isExempt:      score.isExempt      ?? false,
      teacherRemark: score.teacherRemark || null,
      // Remark shown on the card: the teacher's own remark wins, then the
      // school's configured band remark (§4).
      remark:        score.teacherRemark || gi.remark || null,
      // The band remark in French. A teacher's own remark is their words and
      // is not translated — it stands in whichever language it was written.
      remarkFr:      score.teacherRemark || gi.remarkFr || null,
      coefficient:   coeff,
      percentage:    score.percentage    ?? null,
      // Derived first, stored second — the other way round until now, and the
      // stored value is a snapshot. Every grade in this database was computed
      // under the previous /100 table keyed on percentage, so an 11/20 came
      // back as "D" where the school's own table says "C+ / Above Average".
      // The remark beside it was already derived, so the card was showing a
      // grade and a remark from two different scales. The stored value remains
      // the fallback for a score with no mark to look up.
      grade:         gi.grade            ?? score.grade,
      gradePoint:    gi.points           ?? score.gpaPoints ?? null,
      isPassing:     score.isPassing     ?? null,
      normalizedMark,
      weightedScore,
      // Per-subject rank over the students who actually sat this subject (§5)
      subjectPosition: posInfo.position,
      subjectTotal:    posInfo.total,
    };
  });

  const activeRows    = subjectRows.filter(
    (r) => !r.isAbsent && !r.isExempt && r.score != null
  );
  const totalCoeff    = activeRows.reduce((s, r) => s + r.coefficient, 0);
  const totalWeighted = activeRows.reduce(
    (s, r) => s + (r.weightedScore ?? 0), 0
  );
  const weightedAverage = totalCoeff > 0
    ? Math.round((totalWeighted / totalCoeff) * 100) / 100
    : 0;

  // ── Report type (§7) ────────────────────────────────────────────────────────
  // sequence → a bound sequence (1–6); annual → the promotion exam, the only
  // card allowed to carry a promotion decision (§8); everything else → term.
  const reportType = reportTypeFor(exam);

  // The period this card is FOR, spelled the way a parent reads it. A
  // sequence card names its sequence, a term card names its term, and the
  // annual card names neither because it covers the whole year.
  let ownName = null;
  if (reportType === "sequence") {
    const structure = exam?.schoolId
      ? await AcademicStructure.findOne({
          schoolId: String(exam.schoolId), academicYear: exam.academicYear,
        }).lean().catch(() => null)
      : null;
    ownName = structure?.terms
      ?.flatMap((t) => t.sequences || [])
      ?.find((sq) => sq.number === exam.sequenceNumber)?.name || null;
  }

  // The facts about the period, not a sentence about it. The header names the
  // period in the reader's language ("Première Séquence"), so a string built
  // here would be the one line of English left on a French card — the same
  // fault the remarks had. periodLabel stays for {{term}}, which templates
  // already reference.
  const period = {
    reportType,
    sequenceNumber: exam?.sequenceNumber ?? null,
    term:           exam?.term ?? null,
    name:           ownName,
  };
  const periodLabel = periodName(period, "en");

  const data = {
      examId,
      studentId,
      studentName:  summary?.studentName || null,
      admissionNo:  summary?.admissionNo || null,
      className:    summary?.className   || null,
      examName:     exam?.name           || null,
      academicYear: exam?.academicYear   || null,
      // §7 wants the sequence NAMED on a sequence card. Exam.term is a number
      // now, so printing it raw put "1" in the subtitle where "First Sequence"
      // belongs. The school's own name for the sequence wins; "Sequence 3" is
      // the fallback for a school that has not named them.
      term:         periodLabel,
      period,
      totalMarks:   exam?.totalMarks     || null,
      passMark:     exam?.passMark       || null,
      // §1 student identity + §3 grade toggle, consumed by the renderer
      gender:       student?.gender      || null,
      dateOfBirth:  student?.dateOfBirth || null,
      // Absolute, for the same reason the logo is: the card is printed by
      // writing the HTML into a new window whose document is about:blank, so
      // a served path like /uploads/photos/x.jpg has no origin to resolve
      // against and the image silently 404s.
      photoUrl:     absoluteLogoUrl(student?.photoUrl, req),
      showGrades,
      reportType,
      subjects:     subjectRows,
      summary: summary
        ? {
            totalScore:      summary.totalScore,
            totalMaxScore:   summary.maxTotalScore,
            percentage:      summary.percentage,
            average:         summary.average,
            // From the average, for the reason above: the stored overall grade
            // was computed under the old table too, so the headline letter
            // disagreed with the subject letters underneath it.
            overallGrade:    gradeInfo(resolveAvg20()).grade ?? summary.overallGrade,
            overallRemark:   summary.overallRemark,
            // Derived from the band the average falls in, so the overall
            // remark translates like the per-subject ones rather than being
            // the one line of English left on a French card.
            overallRemarkFr: gradeInfo(resolveAvg20()).remarkFr,
            gpa:             summary.gpa,
            isPassing:       summary.isPassing,
            // Exposed so the archive can freeze only what has actually been
            // issued to parents, not a draft an admin previewed.
            isPublished:     summary.isPublished ?? false,
            classPosition:   summary.classPosition,
            gradePosition:   summary.gradePosition,
            schoolPosition:  summary.schoolPosition,
            totalInClass:    summary.totalInClass,
            totalInGrade:    summary.totalInGrade,
            totalInSchool:   summary.totalInSchool,
            subjectsPassed:  summary.subjectsPassed,
            subjectsFailed:  summary.subjectsFailed,
            // §8: promotion only exists on the final annual report card —
            // sequence and intermediate term cards never carry it.
            promotionStatus: reportType === "annual"
              ? summary.promotionStatus
              : null,
            subjectScores:   summary.subjectBreakdown,
          }
        : null,
      computed: {
        totalCoefficients: totalCoeff,
        weightedAverage,
        outOf: 20,
      },
};

  return { ok: true, data };
};

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId/reportcard
// ─────────────────────────────────────────────────────────

const getStudentReportCard = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;

  const built = await buildStudentReportCardData(examId, studentId);
  if (!built?.ok) {
    return res.status(404).json({
      success: false,
      error:   "No scores found for this student in this exam",
      detail:  "Enter marks first before generating a report card",
    });
  }

  return res.json({ success: true, data: built.data });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId/reportcard/html
//
// ✅ Phase 2: single rendering engine. Returns the canonical printable HTML
//    produced server-side; the web batch print and the mobile PDF export
//    fetch this instead of keeping their own local builders.
//    ?lang=fr switches label language (default en).
// ─────────────────────────────────────────────────────────

/**
 * The template that should drive this school's report cards.
 *
 * Resolution order: an explicit ?templateId=, then the school's default
 * (isDefault), then none — in which case the renderer uses its built-in
 * layout. ?templateId=builtin forces the built-in layout, which is the
 * escape hatch when a school's template is misbehaving.
 *
 * Never throws: a template lookup failure must not cost the school its
 * report cards, so it degrades to the built-in layout.
 */
// The template lookup moved to reportCardData.service.js, where the term and
// annual cards reach the same one — see the note there.
const { coefficientFromWeight } = require("../services/subjectCoefficient.service");
const { cardVerification } = require("../services/reportCardData.service");
const { loadReportTemplate, loadSchoolForCard, absoluteLogoUrl } =
  require("../services/reportCardData.service");

/**
 * Freeze what was just issued.
 *
 * GeneratedReport is the legal record: a parent reprinting in two years must
 * get the card the school issued, not one re-derived from data and a template
 * that have both moved on since. Upserted on examId + studentId, so
 * re-issuing replaces rather than accumulates.
 *
 * variablePayload stores the report card payload — the canonical input both
 * render paths consume — rather than the engine's nested view of it, which is
 * derived from this and reproducible.
 *
 * Deliberately fire-and-forget: a failure to archive must never cost the user
 * the report card they asked for.
 */
const archiveGeneratedReport = ({
  schoolId, examId, studentId, data, html, template, source, userId,
}) => {
  if (!schoolId) return;

  // Only freeze what has actually been issued. Before results are published
  // the card is a draft, and an admin previewing one must not create a record
  // that later reads as "what the parent received".
  if (!data.summary?.isPublished) return;

  GeneratedReport.findOneAndUpdate(
    { examId, studentId },
    {
      // Every frozen field is $setOnInsert, never $set: the FIRST issue wins.
      // Re-reading a card months later must not silently rewrite what a parent
      // already holds — by then the template may have been edited or a mark
      // corrected. Reissuing after a genuine correction is a deliberate act;
      // see POST /:examId/student/:studentId/reportcard/reissue.
      $setOnInsert: {
        _id:             uuidv4(),
        schoolId,
        examId,
        studentId,
        templateId:      source === "template" ? String(template._id) : null,
        templateVersion: source === "template" ? template.version ?? 1 : 1,
        renderedHtml:    html,
        variablePayload: data,
        term:            data.term         || null,
        academicYear:    data.academicYear || null,
        generatedBy:     userId || null,
        isPublished:     false,
        deletedAt:       null,
      },
    },
    { upsert: true }
  )
    .lean()
    .catch((err) =>
      console.error("[reportcard] archive failed:", err.message)
    );
};

const getStudentReportCardHtml = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;
  const lang =
    String(req.query.lang || "en").toLowerCase() === "fr" ? "fr" : "en";

  const built = await buildStudentReportCardData(examId, studentId);
  if (!built?.ok) {
    return res.status(404).json({
      success: false,
      error:   "No scores found for this student in this exam",
      detail:  "Enter marks first before generating a report card",
    });
  }

  // Logo, motto and the official header's delegations come from the school's
  // settings (§2) — never hard-coded, and loaded by the one function all three
  // card routes share so they cannot select different fields from each other.
  const letterhead = await loadSchoolForCard(req.user?.schoolId, req);
  const schoolName = req.user?.schoolName || letterhead.doc?.name || null;

  /**
   * The verification strip: QR + code resolving to a public page that shows
   * what the school's records say, so a registrar elsewhere can check a paper
   * bulletin against them.
   *
   * Shared with the term and annual cards, which had no strip at all until it
   * moved out of this controller — they rendered {{qr_code}} with nothing
   * behind it and printed the inert placeholder box.
   */
  const verify = await cardVerification({
    data:        built.data,
    schoolId:    req.user?.schoolId,
    studentId,
    documentKey: examId,
    req,
  });

  // Per-school template drives the layout when the school has one; the
  // built-in layout is the fallback, including when a template fails to render.
  const template = await loadReportTemplate(
    req.user?.schoolId,
    req.query.templateId
  );

  const rendered = renderReportCard(built.data, {
    lang,
    schoolName: schoolName || "School",
    // §2: logo, motto and delegations from the school's settings document
    school: { ...letterhead.school, name: schoolName || "" },
    verify,
    template,
  });

  archiveGeneratedReport({
    schoolId:  req.user?.schoolId,
    examId,
    studentId,
    data:      built.data,
    html:      rendered.html,
    template,
    source:    rendered.source,
    userId:    req.user?._id,
  });

  return res.json({
    success: true,
    data: {
      html:     rendered.html,
      filename: `report-${built.data.admissionNo || studentId}-${examId}.html`,
      // Which layout produced this, so a caller can tell the school their
      // template was skipped, and so an archived copy is traceable.
      source:          rendered.source,
      templateId:      rendered.source === "template" ? String(template._id) : null,
      templateVersion: rendered.source === "template" ? template.version ?? 1 : null,
      ...(rendered.error ? { templateError: rendered.error } : {}),
      // Tokens in the school's template that the engine does not know. The
      // card still printed; this lets the UI tell the admin to fix the typo.
      ...(rendered.unknownTokens ? { unknownTokens: rendered.unknownTokens } : {}),
    },
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/:examId/student/:studentId/reportcard/calculate
// ─────────────────────────────────────────────────────────

/**
 * POST /api/results/:examId/student/:studentId/reportcard/reissue
 *
 * Replace the frozen copy of an already-issued report card.
 *
 * The normal render path never overwrites an archived card, so a mark
 * corrected after issue would leave the parent's copy stale forever. This is
 * the deliberate act that supersedes it — admin-only, and it records who did
 * it, because replacing a document a parent already holds is exactly the kind
 * of change that needs a name against it.
 */
const reissueStudentReportCard = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;
  const schoolId = req.user?.schoolId;

  if (!schoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }

  // Deliberately NOT filtered on deletedAt. The automatic archive matches on
  // examId + studentId alone and only $setOnInsert, so once a card is soft
  // deleted a reprint quietly no-ops against the dead row and the unique index
  // blocks a fresh insert — leaving the card unrecoverable. Reissue is the
  // explicit admin action, so it is the thing that may revive one.
  const existing = await GeneratedReport.findOne({
    examId, studentId,
  }).select("_id templateVersion deletedAt").lean();

  if (!existing) {
    return res.status(404).json({
      success: false,
      error:   "No issued report card to reissue",
      detail:  "A card is archived the first time it is printed after results are published.",
    });
  }

  const built = await buildStudentReportCardData(examId, studentId);
  if (!built?.ok) {
    return res.status(404).json({
      success: false,
      error:   "No scores found for this student in this exam",
    });
  }

  const lang =
    String(req.body.lang || "en").toLowerCase() === "fr" ? "fr" : "en";

  let schoolName = req.user?.schoolName || null;
  if (!schoolName) {
    const school = await School.findOne({ _id: schoolId }).select("name").lean();
    schoolName = school?.name || null;
  }

  const template = await loadReportTemplate(schoolId, req.body.templateId);

  const rendered = renderReportCard(built.data, {
    lang,
    schoolName: schoolName || "School",
    template,
  });

  await GeneratedReport.updateOne(
    { _id: existing._id },
    {
      $set: {
        templateId:      rendered.source === "template" ? String(template._id) : null,
        templateVersion: rendered.source === "template" ? template.version ?? 1 : 1,
        renderedHtml:    rendered.html,
        variablePayload: built.data,
        term:            built.data.term         || null,
        academicYear:    built.data.academicYear || null,
        generatedBy:     req.user?._id || null,
        // Revive a soft-deleted card: reissuing is how an admin undoes a
        // delete, and leaving it set would keep the portal at NOT_ISSUED.
        deletedAt:       null,
      },
    }
  );

  console.log(
    `♻️  Report card reissued: exam=${examId} student=${studentId} ` +
    `by=${req.user?._id || "?"}` +
    (existing.deletedAt ? " (revived a deleted card)" : "")
  );

  return res.json({
    success: true,
    data: {
      html:            rendered.html,
      source:          rendered.source,
      revived:         Boolean(existing.deletedAt),
      templateId:      rendered.source === "template" ? String(template._id) : null,
      templateVersion: rendered.source === "template" ? template.version ?? 1 : null,
      ...(rendered.unknownTokens ? { unknownTokens: rendered.unknownTokens } : {}),
    },
  });
});

const calculateStudentReportCard = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;
  const {
    subjects: inputSubjects,
    outOf    = 20,
    passMark = 10,
  } = req.body;

  if (!Array.isArray(inputSubjects) || inputSubjects.length === 0) {
    return res.status(400).json({
      success: false,
      error:   "subjects[] array is required",
    });
  }

  const schoolId = req.user?.schoolId;
  const out      = Number(outOf)    || 20;
  const pass     = Number(passMark) || 10;

  const [exam, gradingConfig] = await Promise.all([
    Exam.findById(examId).lean(),
    GradingConfig.findOne({ schoolId }).lean(),
  ]);

  let totalWeightedScore = 0;
  let totalCoefficients  = 0;
  let subjectsPassed     = 0;
  let subjectsFailed     = 0;
  const subjectBreakdown = [];

  for (const input of inputSubjects) {
    const {
      subjectId,
      subjectName,
      score,
      maxScore    = 100,
      coefficient = 1,
      isAbsent    = false,
      isExempt    = false,
    } = input;

    if (isAbsent || isExempt || score == null) {
      subjectBreakdown.push({
        subjectId:      String(subjectId),
        subjectName:    subjectName || String(subjectId),
        score:          null,
        maxScore:       Number(maxScore),
        coefficient:    Number(coefficient),
        normalizedMark: null,
        weightedScore:  null,
        percentage:     null,
        grade:          null,
        points:         null,
        isPassing:      false,
        isAbsent:       Boolean(isAbsent),
        isExempt:       Boolean(isExempt),
        remark:         isAbsent ? "Absent" : isExempt ? "Exempt" : null,
      });
      continue;
    }

    const numScore = Number(score);
    const numMax   = Number(maxScore)    || 100;
    const numCoeff = Number(coefficient) || 1;

    const normalizedMark = Math.round((numScore / numMax) * out * 100) / 100;
    const weightedScore  = Math.round(normalizedMark * numCoeff * 100) / 100;

    totalWeightedScore += weightedScore;
    totalCoefficients  += numCoeff;

    const pct        = Math.round((numScore / numMax) * 100);
    const grades     = gradingConfig?.grades || [];
    // Grade bands are stored on the /20 scale (same as GradingConfig defaults
    // and grading.service's GRADE_SCALE), so look the mark up out of 20 — not
    // the 0-100 percentage. Falling back to the built-in scale keeps a student
    // from dropping to a wrong letter when a school has no custom config.
    let gradeMatch = grades.find(
      (g) => normalizedMark >= g.minMark && normalizedMark <= g.maxMark
    );
    if (!gradeMatch) {
      const fb = lookupGrade(normalizedMark);
      gradeMatch = fb
        ? { grade: fb.grade, gpaPoints: fb.points, remark: fb.remark }
        : null;
    }
    const isPassing  = normalizedMark >= pass;

    if (isPassing) subjectsPassed++;
    else           subjectsFailed++;

    subjectBreakdown.push({
      subjectId:      String(subjectId),
      subjectName:    subjectName || String(subjectId),
      score:          numScore,
      maxScore:       numMax,
      coefficient:    numCoeff,
      normalizedMark,
      weightedScore,
      percentage:     pct,
      grade:          gradeMatch?.grade     || null,
      points:         gradeMatch?.gpaPoints ?? null,
      isPassing,
      isAbsent:       false,
      isExempt:       false,
      remark:         gradeMatch?.remark    || null,
    });
  }

  const average       = totalCoefficients > 0
    ? Math.round((totalWeightedScore / totalCoefficients) * 100) / 100
    : 0;
  const avgPercentage = Math.round((average / out) * 100);
  const grades        = gradingConfig?.grades || [];
  // Same scale fix as per-subject: `average` is already out of `out` (default
  // 20), so it is matched against the /20 bands directly.
  let overallMatch = grades.find(
    (g) => average >= g.minMark && average <= g.maxMark
  );
  if (!overallMatch) {
    const fb = lookupGrade(average);
    overallMatch = fb
      ? { grade: fb.grade, remark: fb.remark, gpaPoints: fb.points }
      : null;
  }
  const isPassing     = average >= pass;

  // ✅ Phase 0 repoint: persist to ResultSummary (the live pipeline model)
  //    instead of ExamResult. GET /reportcard reads ResultSummary now, so
  //    "Calculate & save" must write where the read happens or the saved
  //    values would never show up on reload.
  const computedFields = {
    average,
    percentage:    avgPercentage,
    overallGrade:  overallMatch?.grade     || null,
    overallRemark: overallMatch?.remark    || null,
    gpa:           overallMatch?.gpaPoints ?? null,
    subjectsPassed,
    subjectsFailed,
    subjectsTotal: subjectBreakdown.length,
    isPassing,
    subjectBreakdown,
    syncStatus:    "synced",
    lastSyncedAt:  new Date(),
  };

  const existing = await ResultSummary.findOne({
    examId, studentId, deletedAt: null,
  });

  let summary;
  if (existing) {
    summary = await ResultSummary.findByIdAndUpdate(
      existing._id,
      { $set: computedFields },
      { returnDocument: 'after' }
    ).lean();
  } else {
    // No processed summary yet — create a minimal one. classId and schoolId
    // are schema-required; take them from the student's score rows, falling
    // back to the exam.
    const firstScore = await StudentScore.findOne({
      examId, studentId, deletedAt: null,
    })
      .select("classId schoolId studentName admissionNo className academicYear term")
      .lean();

    const classId = firstScore?.classId || exam?.classId || null;
    if (!classId || !schoolId) {
      return res.status(409).json({
        success: false,
        error:   "No result summary for this student in this exam",
        detail:  "Run Results → Compute for this exam first, then retry.",
      });
    }

    const created = await ResultSummary.create({
      _id:          uuidv4(),
      examId,
      studentId,
      schoolId,
      classId,
      studentName:  firstScore?.studentName || null,
      admissionNo:  firstScore?.admissionNo || null,
      className:    firstScore?.className   || null,
      academicYear: firstScore?.academicYear || exam?.academicYear || null,
      term:         firstScore?.term        || exam?.term        || null,
      ...computedFields,
    });
    summary = created.toObject ? created.toObject() : created;
  }

  console.log(
    `✅ Report card: student=${studentId}`,
    `avg=${average}/${out}`,
    `pass=${isPassing}`,
    `subjects=${subjectBreakdown.length}`
  );

  return res.json({
    success: true,
    data: {
      summaryId:          summary._id,
      average,
      outOf:              out,
      passMark:           pass,
      percentage:         avgPercentage,
      overallGrade:       overallMatch?.grade     || null,
      overallRemark:      overallMatch?.remark    || null,
      gpa:                overallMatch?.gpaPoints ?? null,
      isPassing,
      subjectsPassed,
      subjectsFailed,
      subjectsTotal:      subjectBreakdown.length,
      totalCoefficients,
      totalWeightedScore: Math.round(totalWeightedScore * 100) / 100,
      subjectBreakdown,
      classPosition:      summary.classPosition,
      gradePosition:      summary.gradePosition,
      schoolPosition:     summary.schoolPosition,
      totalInClass:       summary.totalInClass,
      totalInGrade:       summary.totalInGrade,
      totalInSchool:      summary.totalInSchool,
      promotionStatus:    summary.promotionStatus,
    },
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/:examId/compute
// ─────────────────────────────────────────────────────────

const computeResults = asyncHandler(async (req, res) => {
  const { examId }                          = req.params;
  const { schoolId: bodySchoolId, classId } = req.body;
  const schoolId = resolveSchoolId(req, bodySchoolId);

  if (!schoolId) {
    return res.status(400).json({ message: "schoolId is required" });
  }

  // Use the new results.service.js pipeline (Phase 0)
  const resultsService = require("../services/results.service");
  const result = await resultsService.processResults({ examId, classId, schoolId });

  return res.json({
    success:   true,
    message:   `Results computed for ${result.computed || 0} student(s)`,
    computed:  result.computed || 0,
    warnings:  result.warnings || [],
    isPartial: result.isPartial || false,
    stats:     result.stats || null,
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/:examId/publish
// ─────────────────────────────────────────────────────────

const publishResults = asyncHandler(async (req, res) => {
  const { examId }  = req.params;
  const { classId } = req.body;

  // Publish all ResultSummary records for this exam
  const filter = { examId, deletedAt: null };
  if (classId) filter.classId = classId;

  const result = await ResultSummary.updateMany(filter, {
    $set: {
      isPublished: true,
      publishedAt: new Date(),
    },
  });

  // Also update the Exam status
  await Exam.findByIdAndUpdate(examId, {
    $set: {
      status: "published",
      resultsPublished: true,
      resultsPublishedAt: new Date(),
      publishedBy: req.user?._id || null,
    },
  });

  return res.json({
    success:   true,
    message:   "Results published successfully",
    published: result.modifiedCount,
  });
});

// ─────────────────────────────────────────────────────────
// PUT /api/results/summary/:summaryId/publish
// ─────────────────────────────────────────────────────────

const publishResult = asyncHandler(async (req, res) => {
  const { summaryId }      = req.params;
  const { publish = true } = req.body;

  const summary = await ResultSummary.findById(summaryId);

  if (!summary) {
    return res.status(404).json({
      success: false,
      error:   "Result summary not found",
    });
  }

  // 423 Locked, not 400: the request is well formed, the resource's own state
  // forbids it. And the check now covers unpublishing too — pulling a result
  // back from parents who have seen it is a change, not an exemption.
  if (summary.isLocked) {
    const reason = (req.body?.changeReason || req.body?.reason || "").trim();
    if (!reason) {
      return res.status(423).json({
        success: false,
        code:    "RESULTS_LOCKED",
        message: "This result is locked. Send a `changeReason` to record why you are overriding the lock.",
      });
    }
  }

  const wasPublished = Boolean(summary.isPublished);
  const reason       = (req.body?.changeReason || req.body?.reason || "").trim() || null;

  summary.isPublished = Boolean(publish);
  summary.publishedAt = publish ? new Date() : null;
  await summary.save();

  if (wasPublished !== Boolean(publish)) {
    await logResultChange(
      {
        examId:     String(summary.examId),
        schoolId:   String(summary.schoolId),
        studentId:  summary.studentId ? String(summary.studentId) : null,
        reason,
        isOverride: Boolean(summary.isLocked),
        actor: {
          id:   req.user?._id ? String(req.user._id) : null,
          name: req.user?.name || null,
          role: req.user?.role || null,
        },
      },
      {
        entity:   "summary",
        entityId: String(summary._id),
        action:   publish ? "published" : "unpublished",
        field:    "isPublished",
        oldValue: wasPublished,
        newValue: Boolean(publish),
      }
    );
  }

  return res.json({
    success: true,
    message: publish ? "Result published" : "Result unpublished",
    data:    summary,
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/score
// ─────────────────────────────────────────────────────────

const upsertScore = asyncHandler(async (req, res) => {
  const {
    examId, examSubjectId, studentId,
    subjectId, classId, schoolId,
    score, maxScore, isAbsent, isExempt, teacherRemark,
  } = req.body;

  const audit = await guardResultWrite(req, res, {
    examId,
    schoolId: schoolId || req.user?.schoolId,
    studentId,
    subjectId,
  });
  if (!audit) return;

  const existing = await StudentScore.findOne({ examId, studentId, subjectId });

  if (existing) {
    // Snapshot before Object.assign mutates the document in place.
    const before = {
      score:         existing.score         ?? null,
      isAbsent:      existing.isAbsent      ?? false,
      isExempt:      existing.isExempt      ?? false,
      teacherRemark: existing.teacherRemark ?? null,
    };

    const corrections = existing.corrections ?? [];
    if (existing.score !== null && existing.score !== score) {
      corrections.push({
        originalScore: existing.score,
        newScore:      score,
        reason:        req.body.correctionReason ?? "Score updated",
        correctedBy:   req.user?._id,
        correctedAt:   new Date(),
      });
    }
    Object.assign(existing, {
      score,
      maxScore:      maxScore      ?? existing.maxScore,
      isAbsent:      isAbsent      ?? existing.isAbsent,
      isExempt:      isExempt      ?? existing.isExempt,
      teacherRemark: teacherRemark ?? existing.teacherRemark,
      updatedBy:     req.user?._id,
      corrections,
      syncStatus:    "pending",
    });
    await existing.save();

    await logResultChange(
      audit,
      [
        diffField("score",         before.score,         score         ?? null),
        diffField("isAbsent",      before.isAbsent,      isAbsent      ?? before.isAbsent),
        diffField("isExempt",      before.isExempt,      isExempt      ?? before.isExempt),
        diffField("teacherRemark", before.teacherRemark, teacherRemark ?? before.teacherRemark),
      ]
        .filter(Boolean)
        .map((f) => ({
          entity:   "score",
          entityId: String(existing._id),
          action:   "updated",
          ...f,
        }))
    );

    return res.json({ success: true, action: "updated", data: existing });
  }

  const newScore = await StudentScore.create({
    examId, examSubjectId, studentId,
    subjectId, classId, schoolId,
    score,
    maxScore:      maxScore      ?? 100,
    isAbsent:      isAbsent      ?? false,
    isExempt:      isExempt      ?? false,
    teacherRemark: teacherRemark ?? null,
    enteredBy:     req.user?._id,
    enteredAt:     new Date(),
    syncStatus:    "pending",
  });

  await logResultChange(audit, {
    entity:   "score",
    entityId: String(newScore._id),
    action:   "created",
    field:    "score",
    oldValue: null,
    newValue: score ?? null,
  });

  return res.status(201).json({
    success: true,
    action:  "created",
    data:    newScore,
  });
});

// ─────────────────────────────────────────────────────────
// DELETE /api/results/score/:scoreId
// ─────────────────────────────────────────────────────────

const deleteScore = asyncHandler(async (req, res) => {
  const score = await StudentScore.findById(req.params.scoreId);

  if (!score) {
    return res.status(404).json({
      success: false,
      error:   "Score not found",
    });
  }

  const audit = await guardResultWrite(req, res, {
    examId:    String(score.examId),
    schoolId:  String(score.schoolId),
    studentId: score.studentId ? String(score.studentId) : null,
    subjectId: score.subjectId ? String(score.subjectId) : null,
  });
  if (!audit) return;

  score.deletedAt  = new Date();
  score.syncStatus = "pending";
  await score.save();

  await logResultChange(audit, {
    entity:   "score",
    entityId: String(score._id),
    action:   "deleted",
    field:    "score",
    oldValue: score.score ?? null,
    newValue: null,
  });

  return res.json({
    success: true,
    message: "Score deleted successfully",
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/history
//
// The change history for an exam, or for one student within it.
// ?studentId=  narrow to a single student
// ?overridesOnly=1  only edits made past a lock — what an auditor asks for
// ─────────────────────────────────────────────────────────

const getResultHistory = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId } = req.params;
  const { studentId, subjectId, overridesOnly } = req.query;

  const filter = { schoolId, examId };
  if (studentId) filter.studentId = String(studentId);
  if (subjectId) filter.subjectId = String(subjectId);
  if (overridesOnly === "1" || overridesOnly === "true") filter.isOverride = true;

  const limit = Math.min(Number(req.query.limit) || 200, 1000);

  const rows = await ResultChangeLog.find(filter)
    .sort({ changedAt: -1 })
    .limit(limit)
    .lean();

  return res.json({
    success: true,
    count:   rows.length,
    data:    rows,
  });
});

// ─────────────────────────────────────────────────────────
// ✅ SINGLE CLEAN EXPORT — const declarations above,
//    module.exports here. No mixing of exports.x = and
//    module.exports = {} styles.
// ─────────────────────────────────────────────────────────

module.exports = {
  getExamResults,
  getExamStats,
  getExamRankings,
  getStudentResult,
  getStudentReportCard,
  getStudentReportCardHtml,
  reissueStudentReportCard,
  calculateStudentReportCard,
  computeResults,
  publishResults,
  publishResult,
  upsertScore,
  deleteScore,
  getResultHistory,
};