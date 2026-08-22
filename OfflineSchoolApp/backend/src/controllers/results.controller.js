// backend/src/controllers/results.controller.js
"use strict";

const { v4: uuidv4 }  = require("uuid");
const ExamResult      = require("../db/models/ExamResult");
const ExamScore       = require("../db/models/ExamScore");
const Exam            = require("../db/models/Exam");
const ExamSubject     = require("../db/models/ExamSubject");
const GradingConfig   = require("../db/models/GradingConfig");
const ResultChangeLog = require("../db/models/ResultChangeLog");
const {
  guardResultWrite,
  logResultChange,
  diffField,
} = require("../services/resultAudit.service");

const {
  computeResults:  computeResultsService,
  publishResults:  publishResultsService,
  getRankings,
  getExamStats:    getExamStatsService,
} = require("../services/examResult.service");

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
  const total   = await ExamResult.countDocuments(filter);
  const results = await ExamResult.find(filter)
    .sort({ classPosition: 1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

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
  const { classId } = req.query;

  const stats = await getExamStatsService(examId, classId || null);

  return res.json({ success: true, data: stats });
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

  const [summary, scores] = await Promise.all([
    ExamResult.findOne({ examId, studentId, deletedAt: null }).lean(),
    ExamScore.find({ examId, studentId, deletedAt: null }).lean(),
  ]);

  if (!summary && !scores.length) {
    return res.status(404).json({
      success: false,
      error:   "No result found for this student in this exam",
    });
  }

  return res.json({
    success: true,
    data:    { summary: summary ?? null, scores },
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId/reportcard
// ─────────────────────────────────────────────────────────

const getStudentReportCard = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;

  const [scores, examSubjects, summary, exam] = await Promise.all([
    ExamScore.find({ examId, studentId, deletedAt: null }).lean(),
    ExamSubject.find({ examId, deletedAt: null }).lean(),
    ExamResult.findOne({ examId, studentId }).lean(),
    Exam.findById(examId).lean(),
  ]);

  if (!scores.length) {
    return res.status(404).json({
      success: false,
      error:   "No scores found for this student in this exam",
      detail:  "Enter marks first before generating a report card",
    });
  }

  const subjectMap = new Map(
    examSubjects.map((es) => [String(es.subjectId), es])
  );

  const subjectRows = scores.map((score) => {
    const es       = subjectMap.get(String(score.subjectId)) || {};
    const maxScore = score.maxScore || es.maxScore || 100;
    const coeff    = es.weight ?? 1;

    const normalizedMark =
      score.score != null && !score.isAbsent && !score.isExempt
        ? Math.round((score.score / maxScore) * 20 * 100) / 100
        : null;

    const weightedScore =
      normalizedMark != null
        ? Math.round(normalizedMark * coeff * 100) / 100
        : null;

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
      coefficient:   coeff,
      percentage:    score.percentage    ?? null,
      grade:         score.grade         ?? null,
      gradePoint:    score.gradePoint    ?? null,
      isPassing:     score.isPassing     ?? null,
      normalizedMark,
      weightedScore,
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

  return res.json({
    success: true,
    data: {
      examId,
      studentId,
      studentName:  summary?.studentName || null,
      admissionNo:  summary?.admissionNo || null,
      className:    summary?.className   || null,
      examName:     exam?.name           || null,
      academicYear: exam?.academicYear   || null,
      term:         exam?.term           || null,
      totalMarks:   exam?.totalMarks     || null,
      passMark:     exam?.passMark       || null,
      subjects:     subjectRows,
      summary: summary
        ? {
            totalScore:      summary.totalScore,
            totalMaxScore:   summary.totalMaxScore,
            percentage:      summary.percentage,
            average:         summary.average,
            overallGrade:    summary.overallGrade,
            overallRemark:   summary.overallRemark,
            gpa:             summary.gpa,
            isPassing:       summary.isPassing,
            classPosition:   summary.classPosition,
            gradePosition:   summary.gradePosition,
            schoolPosition:  summary.schoolPosition,
            totalInClass:    summary.totalInClass,
            totalInGrade:    summary.totalInGrade,
            totalInSchool:   summary.totalInSchool,
            subjectsPassed:  summary.subjectsPassed,
            subjectsFailed:  summary.subjectsFailed,
            promotionStatus: summary.promotionStatus,
            subjectScores:   summary.subjectScores,
          }
        : null,
      computed: {
        totalCoefficients: totalCoeff,
        weightedAverage,
        outOf: 20,
      },
    },
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/:examId/student/:studentId/reportcard/calculate
// ─────────────────────────────────────────────────────────

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
    const gradeMatch = grades.find(
      (g) => pct >= g.minMark && pct <= g.maxMark
    );
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
  const overallMatch  = grades.find(
    (g) => avgPercentage >= g.minMark && avgPercentage <= g.maxMark
  );
  const isPassing     = average >= pass;

  const existing = await ExamResult.findOne({ examId, studentId, schoolId });

  let summary;
  if (existing) {
    summary = await ExamResult.findByIdAndUpdate(
      existing._id,
      {
        $set: {
          classId:       exam?.classId         || existing.classId || null,
          average,
          percentage:    avgPercentage,
          overallGrade:  overallMatch?.grade    || null,
          overallRemark: overallMatch?.remark   || null,
          gpa:           overallMatch?.gpaPoints ?? null,
          subjectsPassed,
          subjectsFailed,
          subjectsTotal: subjectBreakdown.length,
          isPassing,
          subjectBreakdown,
          syncStatus:    "synced",
          lastSyncedAt:  new Date(),
        },
      },
      { new: true }
    ).lean();
  } else {
    const created = await ExamResult.create({
      _id:           uuidv4(),
      examId,
      studentId,
      schoolId,
      classId:       exam?.classId         || null,
      average,
      percentage:    avgPercentage,
      overallGrade:  overallMatch?.grade    || null,
      overallRemark: overallMatch?.remark   || null,
      gpa:           overallMatch?.gpaPoints ?? null,
      subjectsPassed,
      subjectsFailed,
      subjectsTotal: subjectBreakdown.length,
      isPassing,
      subjectBreakdown,
      syncStatus:    "synced",
      lastSyncedAt:  new Date(),
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

  const result = await computeResultsService({ examId, classId, schoolId });

  return res.json({
    success:   true,
    message:   `Results computed for ${result.computed} student(s)`,
    computed:  result.computed,
    warnings:  result.warnings,
    isPartial: result.isPartial,
    stats:     result.stats,
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/:examId/publish
// ─────────────────────────────────────────────────────────

const publishResults = asyncHandler(async (req, res) => {
  const { examId }  = req.params;
  const { classId } = req.body;

  const result = await publishResultsService({
    examId,
    classId,
    publishedBy: req.user?._id || null,
  });

  return res.json({
    success:   true,
    message:   "Results published successfully",
    published: result.published,
  });
});

// ─────────────────────────────────────────────────────────
// PUT /api/results/summary/:summaryId/publish
// ─────────────────────────────────────────────────────────

const publishResult = asyncHandler(async (req, res) => {
  const { summaryId }      = req.params;
  const { publish = true } = req.body;

  const summary = await ExamResult.findById(summaryId);

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

  const existing = await ExamScore.findOne({ examId, studentId, subjectId });

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

  const newScore = await ExamScore.create({
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
  const score = await ExamScore.findById(req.params.scoreId);

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
  calculateStudentReportCard,
  computeResults,
  publishResults,
  publishResult,
  upsertScore,
  deleteScore,
  getResultHistory,
};