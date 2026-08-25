// backend/src/controllers/results.controller.js
"use strict";

const { v4: uuidv4 }  = require("uuid");
const ExamResult      = require("../db/models/ExamResult");
const ExamScore       = require("../db/models/ExamScore");
const StudentScore    = require("../db/models/StudentScore");
const ResultSummary   = require("../db/models/ResultSummary");
const Exam            = require("../db/models/Exam");
const ExamSubject     = require("../db/models/ExamSubject");
const GradingConfig   = require("../db/models/GradingConfig");
const School          = require("../db/models/School");
const ReportTemplate  = require("../db/models/ReportTemplate");
const GeneratedReport = require("../db/models/GeneratedReport");
const ResultChangeLog = require("../db/models/ResultChangeLog");
const {
  guardResultWrite,
  logResultChange,
  diffField,
} = require("../services/resultAudit.service");
const { renderReportCardHtml, renderReportCard } =
  require("../services/reportHtml.service");
const docVerify = require("../services/documentVerify.service");

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

  // Lookup by both ref styles: StudentScore.examSubjectId → ExamSubject._id,
  // while rows entered before subjects were set up may only carry subjectId.
  const subjectMap = new Map();
  for (const es of examSubjects) {
    subjectMap.set(String(es._id), es);
    if (es.subjectId != null) subjectMap.set(String(es.subjectId), es);
  }

  // Canonical weight semantics: ExamSubject.weight is percentage-style
  // (schema default 100). ÷100 → multiplier coefficient, so the default
  // leaves every subject equally weighted (×1). This replaces the old
  // `es.weight ?? 1`, which silently turned every subject into ×100.
  const resolveCoeff = (es) => {
    if (!es || es.weight == null) return 1;
    const c = Math.round((Number(es.weight) / 100) * 100) / 100;
    return c > 0 ? c : 1;
  };

  const subjectRows = scores.map((score) => {
    const es       = subjectMap.get(String(score.examSubjectId)) ||
                     subjectMap.get(String(score.subjectId)) || {};
    const maxScore = score.maxScore || es.maxScore || 100;
    const coeff    = resolveCoeff(es);

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
      gradePoint:    score.gpaPoints     ?? null,
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

  const data = {
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
            totalMaxScore:   summary.maxTotalScore,
            percentage:      summary.percentage,
            average:         summary.average,
            overallGrade:    summary.overallGrade,
            overallRemark:   summary.overallRemark,
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
            promotionStatus: summary.promotionStatus,
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
const loadReportTemplate = async (schoolId, templateId) => {
  if (!schoolId || templateId === "builtin") return null;
  try {
    const query = { schoolId: String(schoolId), deletedAt: null };
    if (templateId) query._id = String(templateId);
    else            query.isDefault = true;

    const tpl = await ReportTemplate.findOne(query)
      .select("_id name html css version")
      .lean();

    return tpl?.html ? tpl : null;
  } catch (err) {
    console.error("[reportcard] template lookup failed:", err.message);
    return null;
  }
};

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

  let schoolName = req.user?.schoolName || null;
  if (!schoolName && req.user?.schoolId) {
    const school = await School.findOne({ _id: req.user.schoolId })
      .select("name")
      .lean();
    schoolName = school?.name || null;
  }

  /**
   * The verification strip: QR + code resolving to a public page that shows
   * what the school's records say, so a registrar elsewhere can check a paper
   * bulletin against them. Values are bilingual where they are words — the
   * verifier's language is unknown, and the page shows both anyway.
   *
   * Mirrors the renderer's average arithmetic (weightedAverage is already
   * /20; summary.average is GPA points ×5) so the page and the paper carry
   * the same number.
   */
  const d = built.data;
  const avg20 = d.computed?.weightedAverage != null
    ? Number(d.computed.weightedAverage)
    : d.summary?.average != null
      ? Math.round(Number(d.summary.average) * 5 * 100) / 100
      : null;
  const isPassing = d.summary?.isPassing ?? (avg20 != null ? avg20 >= 10 : null);

  const verify = req.user?.schoolId
    ? await docVerify.printableBlock({
        schoolId: String(req.user.schoolId),
        kind: "report_card",
        studentId: String(studentId),
        examId: String(examId),
        origin: (() => {
          const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
          const host  = req.headers["x-forwarded-host"]  || req.get("host");
          return host ? `${proto}://${host}` : null;
        })(),
        snapshot: {
          facts: [
            { label: { en: "Student", fr: "Élève" },           value: d.studentName },
            { label: { en: "Admission no.", fr: "Matricule" }, value: d.admissionNo },
            { label: { en: "Class", fr: "Classe" },            value: d.className },
            { label: { en: "Exam", fr: "Examen" },             value: d.examName },
            { label: { en: "Term / year", fr: "Trimestre / année" },
              value: [d.term, d.academicYear].filter(Boolean).join(" · ") || "—" },
            { label: { en: "Average /20", fr: "Moyenne /20" },
              value: avg20 != null ? avg20.toFixed(2) : "—" },
            { label: { en: "Overall grade", fr: "Mention" },
              value: d.summary?.overallGrade ?? "—" },
            { label: { en: "Class position", fr: "Rang" },
              value: d.summary?.classPosition != null
                ? `${d.summary.classPosition}${d.summary.totalInClass != null ? ` / ${d.summary.totalInClass}` : ""}`
                : "—" },
            { label: { en: "Decision", fr: "Décision" },
              value: isPassing == null ? "—" : isPassing ? "Passed / Admis(e)" : "Failed / Ajourné(e)" },
          ],
        },
      })
    : null;

  // Per-school template drives the layout when the school has one; the
  // built-in layout is the fallback, including when a template fails to render.
  const template = await loadReportTemplate(
    req.user?.schoolId,
    req.query.templateId
  );

  const rendered = renderReportCard(built.data, {
    lang,
    schoolName: schoolName || "School",
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
      { new: true }
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