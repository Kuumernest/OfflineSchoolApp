// backend/src/routes/exam.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const Exam          = require("../db/models/Exam");
const ExamSubject   = require("../db/models/ExamSubject");
const StudentScore  = require("../db/models/StudentScore");
const ResultSummary = require("../db/models/ResultSummary");
const GradingConfig = require("../db/models/GradingConfig");
// The CA half of a sequence: created alongside the paper, paired with it, and
// the source of the split the sequence result is computed by.
const sequenceAssessment = require("../services/sequenceAssessment.service");
const Class         = require("../db/models/Class");
const Subject       = require("../db/models/Subject");
const User          = require("../db/models/User");
const TeacherAssignment = require("../db/models/TeacherAssignment");
const StudentRoster = require("../db/models/Student");
const { teacherAssigned } = require("../utils/teacherScope");

const { requirePermission } = require("../../middleware/permissions");
const tenant = require("../utils/tenant");
const { processExam, computeGrade } = require("../services/examProcess.service");
const { coefficientOf, weightFor } = require("../services/subjectCoefficient.service");
const { scopedPassRate, withAverage20 } = require("../services/classStats.service");
const { withAssignedTeachers } = require("../services/classSubjectTeacher.service");
const { currentYearOf } = require("../services/fees.service");
const { calendarAcademicYear } = require("../../../shared/academicYear");

/** The school's current year: its setting, else the calendar's. */
const schoolYearOf = async (schoolId) => (await currentYearOf(schoolId)) || calendarAcademicYear();
const { scopes: feedScopes } = require("../config/syncFeed");
const {
  guardResultWrite,
  logResultChange,
  diffField,
} = require("../services/resultAudit.service");

// This router is mounted behind `authenticate` but carried no authorisation of
// its own, so any signed-in account — including a student — could call
// PATCH /:examId/unlock and clear the lock on every result in the school.
// Enforcing a lock that anybody may remove is not enforcement.
// exams.view defaults to TEACHING_ROLES, not STAFF_ROLES: the bursar has no
// business in the exam module. Setting papers, entering scores and locking
// results are academic acts, and the one thing this separation exists to
// prevent is the person who collects the fees altering the marks.
//
// exams.manage is non-delegable for the same reason — this is not a capability
// a school should be able to hand to the fee desk by ticking a box.
const staffOnly = requirePermission("exams.view");
const adminOnly = requirePermission("exams.manage");

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

// The canonical rule (utils/tenant), so a handler and the guard below can never
// disagree about which school a request is for. `|| undefined` lets an empty
// candidate fall through to the request's other sources, as the guard does.
const resolveSchoolId = (req, provided) => tenant.resolveSchoolId(req, provided || undefined);

// Every exam, paper, mark and result here is one school's. A request that
// resolves to no school — a super_admin who named none, an account with no
// school — is refused before any handler builds a `{ schoolId: undefined }`
// filter (docs/39 §4.6i, §17.2, Phase 2e).
router.use(tenant.requireSchool());

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveClassIdsFromBody = (body) => {
  const { classes, classIds, classId } = body;
  if (Array.isArray(classes) && classes.length > 0) {
    return classes.map((c) =>
      typeof c === "object"
        ? String(c._id || c.id || c.classId || c)
        : String(c)
    ).filter(Boolean);
  }
  if (Array.isArray(classIds) && classIds.length > 0) {
    return classIds.map(String).filter(Boolean);
  }
  if (classId) return [String(classId)];
  return [];
};

const resolveClassData = async (classIdArray, schoolId) => {
  if (!classIdArray || classIdArray.length === 0) {
    return {
      primaryClassId:   null,
      primaryClassName: null,
      classIds:         [],
      classNames:       null,
    };
  }
  // Scoped: an exam bound to another school's class would carry that class's
  // name into this school's records and count its pupils in the other's.
  const classRecords = await Class.find({
    _id: { $in: classIdArray }, ...(schoolId ? { schoolId } : {}),
  }).lean();
  const classNameMap = new Map(classRecords.map((c) => [String(c._id), c.name]));
  const orderedIds   = classIdArray.filter((cid) => classNameMap.has(cid));
  const orderedNames = orderedIds.map((cid) => classNameMap.get(cid));
  return {
    primaryClassId:   orderedIds[0]   || null,
    primaryClassName: orderedNames[0] || null,
    classIds:         orderedIds,
    classNames:       orderedNames.join(", ") || null,
  };
};

// computeGrade lives with the exam processing it serves (examProcess.service).

/**
 * Backfill studentName, admissionNo, and className for old ResultSummary rows
 * that were processed before these fields were denormalized.
 * Patches in-memory AND persists so future reads skip the join.
 */
const backfillResultNames = async (results, schoolId) => {
  const incomplete = results.filter((r) =>
    r.studentId && (!r.studentName || !r.admissionNo || !r.className)
  );
  if (incomplete.length === 0) return;

  const Student = require("../db/models/Student");
  const Class   = require("../db/models/Class");

  const sIds = [...new Set(incomplete.map((r) => r.studentId))];
  const [students, allClasses] = await Promise.all([
    Student.find({ _id: { $in: sIds }, schoolId })
      .select("_id studentName firstName lastName enrollmentNo admissionNo classId className")
      .lean(),
    Class.find({ schoolId }).select("_id name").lean(),
  ]);

  const sMap = new Map(students.map((s) => [String(s._id), s]));
  const cMap = new Map(allClasses.map((c) => [String(c._id), c.name]));
  const bulkOps = [];

  for (const r of incomplete) {
    const s = sMap.get(String(r.studentId));
    if (!s) continue;
    const name    = s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" ") || null;
    const admNo   = s.enrollmentNo || s.admissionNo || null;
    const clsName = s.className || cMap.get(String(s.classId)) || null;
    // In-memory patch
    if (!r.studentName) r.studentName = name;
    if (!r.admissionNo) r.admissionNo = admNo;
    if (!r.className)   r.className   = clsName;
    // Persist only what changed
    const $set = {};
    if (name)    $set.studentName = name;
    if (admNo)   $set.admissionNo = admNo;
    if (clsName) $set.className   = clsName;
    if (Object.keys($set).length > 0) {
      bulkOps.push({ updateOne: { filter: { _id: r._id }, update: { $set } } });
    }
  }
  if (bulkOps.length > 0) {
    await ResultSummary.bulkWrite(bulkOps).catch(() => {});
  }
};

// ═════════════════════════════════════════════════════════
// STATIC ROUTES — ALL BEFORE /:id
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// GET /api/exams
// ─────────────────────────────────────────────────────────

router.get("/", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const {
    status, classId, academicYear, term,
    page = 1, limit = 50,
  } = req.query;

  const query = { schoolId, deletedAt: null };
  if (status)       query.status       = status;
  if (academicYear) query.academicYear = academicYear;
  if (term !== undefined && !(Number.isInteger(Number(term)) && Number(term) >= 1)) return res.status(400).json({ success: false, message: "term must be a positive integer" });
  if (term)         query.term         = Number(term);
  if (classId) {
    query.$or = [
      { classId  },
      { classIds: classId },
    ];
  }

  const skip  = (Number(page) - 1) * Number(limit); if (!(skip >= 0) || !(Number(limit) >= 1)) return res.status(400).json({ success: false, message: "page and limit must be positive integers" });
  const total = await Exam.countDocuments(query);
  const exams = await Exam.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  return res.json({
    success: true,
    exams,
    pagination: {
      total,
      page:       Number(page),
      limit:      Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
    },
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/dashboard
// ─────────────────────────────────────────────────────────

router.get("/dashboard", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const [
    total, draft, scheduled, ongoing,
    completed, published, archived,
    publishedResults, pendingResults,
    studentsWithMissingGrades,
  ] = await Promise.all([
    Exam.countDocuments({ schoolId, deletedAt: null }),
    Exam.countDocuments({ schoolId, status: "draft",     deletedAt: null }),
    Exam.countDocuments({ schoolId, status: "scheduled", deletedAt: null }),
    Exam.countDocuments({ schoolId, status: "ongoing",   deletedAt: null }),
    Exam.countDocuments({ schoolId, status: "completed", deletedAt: null }),
    Exam.countDocuments({ schoolId, status: "published", deletedAt: null }),
    Exam.countDocuments({ schoolId, status: "archived",  deletedAt: null }),
    ResultSummary.countDocuments({ schoolId, isPublished: true  }),
    ResultSummary.countDocuments({ schoolId, isPublished: false }),
    StudentScore.countDocuments({
      schoolId,
      score:    null,
      isAbsent: false,
      isExempt: false,
      deletedAt: null,
    }),
  ]);

  const recentExams = await Exam.find({ schoolId, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  const [dashMissingExams, dashPendingExams] = await Promise.all([
    StudentScore.distinct("examId", {
      schoolId, score: null, isAbsent: false, isExempt: false, deletedAt: null,
    }),
    ResultSummary.distinct("examId", { schoolId, isPublished: false }),
  ]);

  // The one pass rate (shared/passRate.js), over a stated scope: this school
  // year's published sequence results. It was every published summary the
  // school ever had, read by a stored flag one writer set against a fixed 10.
  const passScope = await scopedPassRate({ schoolId, academicYear: await schoolYearOf(schoolId) });
  const passRate = passScope.rate ?? 0;
  // The average over the same pupils, on /20 — it was a mean percentage.
  const averagePerformance = passScope.average;

  return res.json({
    success: true,
    dashboard: {
      exams:   { total, draft, scheduled, ongoing, completed, published, archived },
      results: {
        published:          publishedResults,
        pending:            pendingResults,
        missingGrades:      studentsWithMissingGrades,
        averagePerformance,
        passRate,
        passRateScope:      { academicYear: passScope.academicYear, withResults: passScope.withResults,
                              passed: passScope.passed, passMark: passScope.passMark },
        // WHICH exams the two actionable counts are about.
        //
        // The results strip on the exams page turns each count into a link, and
        // a count has nowhere to send anybody. Note that /stats returns the
        // same figures from the same queries and is NOT what that page reads —
        // adding these there first fixed nothing, and this is the endpoint the
        // dashboard hook calls.
        //
        // Capped: a school with a hundred exams short of a mark does not need a
        // hundred ids to be told to go and look.
        missingGradeExams:  dashMissingExams.slice(0, 20).map(String),
        pendingExams:       dashPendingExams.slice(0, 20).map(String),
      },
      recentExams,
    },
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/stats
// ─────────────────────────────────────────────────────────

router.get("/stats", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, message: "schoolId is required" });
  }

  const { term, academicYear, classId } = req.query;

  const base = { schoolId, deletedAt: null };
  if (term !== undefined && !(Number.isInteger(Number(term)) && Number(term) >= 1)) return res.status(400).json({ success: false, message: "term must be a positive integer" });
  if (term)         base.term         = Number(term);
  if (academicYear) base.academicYear = academicYear;
  if (classId) {
    base.$or = [{ classId }, { classIds: classId }];
  }

  const [
    total, draft, scheduled, ongoing,
    completed, published, archived,
  ] = await Promise.all([
    Exam.countDocuments(base),
    Exam.countDocuments({ ...base, status: "draft"     }),
    Exam.countDocuments({ ...base, status: "scheduled" }),
    Exam.countDocuments({ ...base, status: "ongoing"   }),
    Exam.countDocuments({ ...base, status: "completed" }),
    Exam.countDocuments({ ...base, status: "published" }),
    Exam.countDocuments({ ...base, status: "archived"  }),
  ]);

  const todayStr   = new Date().toISOString().split("T")[0];
  const in7DaysStr = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  const upcoming = await Exam.countDocuments({
    ...base,
    status:    "scheduled",
    startDate: { $gte: todayStr, $lte: in7DaysStr },
  });

  const [publishedResults, pendingResults, missingGrades] =
    await Promise.all([
      ResultSummary.countDocuments({ schoolId, isPublished: true  }),
      ResultSummary.countDocuments({ schoolId, isPublished: false }),
      StudentScore.countDocuments({
        schoolId,
        score:     null,
        isAbsent:  false,
        isExempt:  false,
        deletedAt: null,
      }),
    ]);

  // The one pass rate (shared/passRate.js) over the scope asked for — the
  // school's current year when none is.
  const passScope = await scopedPassRate({
    schoolId, academicYear: academicYear || await schoolYearOf(schoolId),
    term: term || null, classId: classId || null,
  });
  const passRate = passScope.rate ?? 0;

  // The average over the same pupils, on /20 — it was a mean percentage.
  const averagePerformance = passScope.average;

  const completedExamIds = await Exam.distinct("_id", {
    ...base,
    status: { $in: ["completed", "published"] },
  });

  const examsWithResults = completedExamIds.length > 0
    ? await ResultSummary.distinct("examId", {
        schoolId,
        examId: { $in: completedExamIds },
      })
    : [];

  const missingResults = Math.max(
    0,
    completedExamIds.length - examsWithResults.length
  );

  // WHICH exams these counts are about, not just how many.
  //
  // The results strip on the exams page turns each of these numbers into a
  // link, and a count alone has nowhere to send anybody: every tile went to
  // /exams/results, which is single-exam analytics and shows nothing about a
  // missing mark. An id is the difference between a number and a destination.
  //
  // Capped, because this is a dashboard: a school with a hundred exams missing
  // marks does not need a hundred ids to be told to go and look.
  const [missingGradeExams, pendingExams] = await Promise.all([
    StudentScore.distinct("examId", {
      schoolId, score: null, isAbsent: false, isExempt: false, deletedAt: null,
    }),
    ResultSummary.distinct("examId", { schoolId, isPublished: false }),
  ]);

  return res.json({
    success: true,
    stats: {
      total,
      draft,
      scheduled,
      ongoing,
      completed,
      published,
      archived,
      upcoming,
      avgPassRate:    passRate,
      missingResults,
      results: {
        published:          publishedResults,
        pending:            pendingResults,
        missingGrades,
        averagePerformance,
        passRate,
        passRateScope:      { academicYear: passScope.academicYear, term: passScope.term,
                              withResults: passScope.withResults, passed: passScope.passed,
                              passMark: passScope.passMark },
        // The exams behind the two actionable counts, so the strip can link to
        // the screen where the work is done rather than to a page about
        // something else.
        missingGradeExams:  missingGradeExams.slice(0, 20).map(String),
        pendingExams:       pendingExams.slice(0, 20).map(String),
      },
    },
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/reports
// ─────────────────────────────────────────────────────────

router.get("/reports", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { academicYear, term, classId, page = 1, limit = 20 } = req.query;

  const query = {
    schoolId,
    deletedAt: null,
    status: { $in: ["completed", "published"] },
  };
  if (academicYear) query.academicYear = academicYear;
  if (term !== undefined && !(Number.isInteger(Number(term)) && Number(term) >= 1)) return res.status(400).json({ success: false, message: "term must be a positive integer" });
  if (term)         query.term         = Number(term);
  if (classId) {
    query.$or = [{ classId }, { classIds: classId }];
  }

  const skip  = (Number(page) - 1) * Number(limit); if (!(skip >= 0) || !(Number(limit) >= 1)) return res.status(400).json({ success: false, message: "page and limit must be positive integers" });
  const total = await Exam.countDocuments(query);
  const exams = await Exam.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  return res.json({
    success: true,
    exams,
    total,
    page:  Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
}));

router.get("/reports/results", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const { examId, classId, page = 1, limit = 50 } = req.query;

  // Published unless the caller is an administrator — the rule every other
  // read of a ResultSummary applies (docs/35 §5); this list had been left out.
  const query = { schoolId, deletedAt: null, ...feedScopes.publishedUnlessAdmin(req) };
  if (examId)  query.examId  = examId;
  if (classId) query.classId = classId;

  const skip    = (Number(page) - 1) * Number(limit); if (!(skip >= 0) || !(Number(limit) >= 1)) return res.status(400).json({ success: false, message: "page and limit must be positive integers" });
  const total   = await ResultSummary.countDocuments(query);
  const results = await ResultSummary.find(query)
    .sort({ classPosition: 1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  // Backfill studentName / admissionNo / className for rows processed before
  // the fields were denormalised (patches in-memory AND persists).
  await backfillResultNames(results, schoolId);

  return res.json({
    success: true,
    results,
    total,
    page:  Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
}));

router.get("/reports/submissions", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId, classId } = req.query;

  const query = { schoolId, deletedAt: null };
  if (examId)  query.examId  = examId;
  if (classId) query.classId = classId;

  const subjects = await ExamSubject.find(query).lean();
  return res.json({
    success:     true,
    submissions: subjects,
    total:       subjects.length,
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/submissions
// ─────────────────────────────────────────────────────────

// Every exam subject in the school with its submission status. Staff view:
// tenant-scoped but, until this guard, readable by any signed-in account.
router.get("/submissions", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId, classId, subjectId, status } = req.query;

  const query = { schoolId, deletedAt: null };
  if (examId)    query.examId           = examId;
  if (classId)   query.classId          = classId;
  if (subjectId) query.subjectId        = subjectId;
  if (status)    query.submissionStatus = status;

  const subjects = await ExamSubject.find(query).lean();
  return res.json({
    success:     true,
    submissions: subjects,
    total:       subjects.length,
  });
}));

router.get("/submissions/results", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const { classId, examId } = req.query;

  // Published unless the caller is an administrator, as above.
  const query = { schoolId, deletedAt: null, ...feedScopes.publishedUnlessAdmin(req) };
  if (examId)  query.examId  = examId;
  if (classId) query.classId = classId;

  const results = await ResultSummary.find(query)
    .sort({ classPosition: 1 })
    .lean();

  // Backfill studentName / admissionNo / className for rows processed before
  // the fields were denormalised (patches in-memory AND persists).
  await backfillResultNames(results, schoolId);

  return res.json({ success: true, results, total: results.length });
}));


/**
 * Marks entered per (exam, class, subject), in one grouped query.
 *
 * The two submission views asked StudentScore.countDocuments once per
 * ExamSubject — a school of a hundred classes and twelve subjects made 1,200
 * counts to draw one screen. One $group over the same filter gives the same
 * numbers; a key with no entry counts as zero, as an empty count did.
 */
const enteredCountsFor = async (match) => {
  const rows = await StudentScore.aggregate([
    { $match: { ...match, score: { $ne: null }, deletedAt: null } },
    { $group: { _id: { examId: "$examId", classId: "$classId", subjectId: "$subjectId" }, n: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((r) => [`${r._id.examId}|${r._id.classId}|${r._id.subjectId}`, r.n]));
  return (es) => counts.get(`${es.examId}|${es.classId}|${es.subjectId}`) ?? 0;
};

/**
 * Pupils enrolled per class — the denominator of "entered / total" (A7,
 * decided 2026-10-27). Nothing wrote ExamSubject.totalStudents, so every
 * subject read "2/0 entered". Enrolled is the register's roster: approved,
 * active, not deleted — the pupils whose marks the teacher has to enter.
 */
const enrolledCountsFor = async (schoolId, classIds) => {
  const ids = [...new Set(classIds.filter(Boolean).map(String))];
  if (!ids.length) return () => 0;
  const Student = require("../db/models/Student");
  const rows = await Student.aggregate([
    { $match: { schoolId: String(schoolId), classId: { $in: ids }, status: "approved", isActive: { $ne: false }, deletedAt: null } },
    { $group: { _id: "$classId", n: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((r) => [String(r._id), r.n]));
  return (es) => counts.get(String(es.classId)) ?? 0;
};

router.get("/submissions/submissions", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId, classId } = req.query;

  const query = { schoolId, deletedAt: null };
  if (examId)  query.examId  = examId;
  if (classId) query.classId = classId;

  // The teacher is the class-subject assignment's (A8), not the exam's copy.
  const subjects = await withAssignedTeachers(await ExamSubject.find(query).lean(), schoolId);
  const entered  = await enteredCountsFor({ schoolId, ...(examId ? { examId } : {}), ...(classId ? { classId } : {}) });
  const enrolled = await enrolledCountsFor(schoolId, subjects.map((es) => es.classId));
  const enriched = subjects.map((es) => ({ ...es, totalScoresEntered: entered(es), totalStudents: enrolled(es) }));
  return res.json({
    success:     true,
    submissions: enriched,
    total:       enriched.length,
  });
}));

// ═════════════════════════════════════════════════════════
// DYNAMIC ROUTES — AFTER ALL STATIC ROUTES
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// GET /api/exams/:id
// ─────────────────────────────────────────────────────────

router.get("/:id", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const exam = await Exam.findOne({
    _id:       req.params.id,
    schoolId,
    deletedAt: null,
  }).lean();

  if (!exam) return res.status(404).json({ message: "Exam not found" });

  const subjects = await ExamSubject.find({
    examId:    exam._id,
    deletedAt: null,
  }).lean();

  return res.json({ success: true, exam: { ...exam, subjects } });
}));

// ─────────────────────────────────────────────────────────
// POST /api/exams
// ─────────────────────────────────────────────────────────

/** Exam.term as the schema holds it: an integer 1-3 (a numeric string casts). */
const isTermNumber = (term) => {
  const n = Number(term);
  return term !== null && term !== "" && Number.isInteger(n) && n >= 1 && n <= 3;
};

router.post("/", adminOnly, asyncHandler(async (req, res) => {
  const {
    name, type, academicYear, term, sequenceNumber,
    startDate, endDate, description, instructions,
    totalMarks, passMark, status, subjects,
  } = req.body;

  if (!name?.trim())  return res.status(400).json({ message: "name is required" });
  if (!academicYear)  return res.status(400).json({ message: "academicYear is required" });
  if (!term)          return res.status(400).json({ message: "term is required" });
  // The schema's 1-3, said as a 400. A label such as "Term 1" — what the
  // mobile screens used to send — left as a 500, which the mobile outbox
  // reads as "offline, retry", so it was retried for ever.
  if (!isTermNumber(term)) return res.status(400).json({ message: "term must be 1-3" });
  // The schema constrains this to 1-6, so an out-of-range value would arrive
  // as a ValidationError and leave with a 500. A 400 says which field.
  if (sequenceNumber != null && sequenceNumber !== "") {
    const sq = Number(sequenceNumber);
    if (!Number.isInteger(sq) || sq < 1 || sq > 6) {
      return res.status(400).json({ message: "sequenceNumber must be 1-6" });
    }
  }

  const schoolId = resolveSchoolId(req, req.body.schoolId);

  /**
   * ── An id the client may have chosen ─────────────────────────────────────
   *
   * This called uuidv4() unconditionally, which is fine for a browser and wrong
   * for a machine that was offline. The desktop application writes the exam to
   * its own mirror first and queues this request; if the server then invents a
   * different id, the reply describes a document the client has never heard of
   * and the row it actually created is orphaned — one exam on screen, another in
   * the database, neither aware of the other.
   *
   * So a supplied _id is kept, exactly as POST /api/fees/payments does. It also
   * makes the create idempotent in its own right, which is the belt to
   * middleware/idempotency.js's braces.
   */
  const examId = req.body._id || uuidv4();

  const existing = await Exam.findById(examId).lean();
  if (existing) {
    // Two ways to arrive here. Ordinarily the idempotency middleware answers a
    // repeat before it reaches this handler — but its records expire after a
    // fortnight, and a machine that was offline for longer than that replays
    // with nothing stored. Returning the row rather than a duplicate-key error
    // lets the queue mark the write done, which it is.
    if (String(existing.schoolId) !== String(schoolId)) {
      return res.status(409).json({
        success: false, code: "EXAM_ID_TAKEN",
        message: "That exam id already belongs to another school",
      });
    }
    const subjects = await ExamSubject.find({ examId, deletedAt: null }).lean();
    return res.status(200).json({
      success:  true,
      replay:   true,
      exam:     { ...existing, subjects },
      serverId: existing._id,
    });
  }

  const resolvedIds = resolveClassIdsFromBody(req.body);
  const classData   = await resolveClassData(resolvedIds, schoolId);

  const exam = await Exam.create({
    _id:          examId,
    schoolId,
    classId:      classData.primaryClassId,
    className:    classData.primaryClassName,
    classIds:     classData.classIds,
    classNames:   classData.classNames,
    name:         name.trim(),
    type:         type         || "test",
    academicYear,
    term,
    // Which sequence this exam is, and the reason it must be stored: it is what
    // decides whether the card printed from this exam is a SEQUENCE card. This
    // was not read from the body at all, so every exam created here came out
    // with sequenceNumber null, reportTypeFor called it a term report, and a
    // card the school had named "First Sequence" printed "Term 1" across the
    // top. Requiring it on the form fixed nothing while the server dropped it.
    ...(sequenceNumber != null && sequenceNumber !== ""
      ? { sequenceNumber: Number(sequenceNumber) }
      : {}),
    startDate:    startDate    || null,
    endDate:      endDate      || null,
    description:  description  || null,
    instructions: instructions || null,
    totalMarks:   totalMarks   ?? 100,
    passMark:     passMark     ?? 50,
    status:       status       || "draft",
    createdBy:    req.user?._id || null,
  });

  const createdSubjects = [];
  if (Array.isArray(subjects) && subjects.length > 0) {
    for (const s of subjects) {
      if (!s.subjectId) continue;
      const subjectDoc = await Subject.findOne({ _id: String(s.subjectId), schoolId }).lean();
      const teacherDoc = s.teacherId
        ? await User.findOne({ _id: String(s.teacherId), schoolId }).lean() : null;
      if (!subjectDoc) {
        return res.status(400).json({ message: "subjectId " + s.subjectId + " is not a subject of this school" });
      }
      if (s.teacherId && !teacherDoc) {
        return res.status(400).json({ message: "teacherId " + s.teacherId + " is not a member of this school" });
      }
      const es = await ExamSubject.create({
        _id:              uuidv4(),
        examId:           exam._id,
        subjectId:        s.subjectId,
        classId:          classData.primaryClassId || s.classId || null,
        schoolId,
        teacherId:        s.teacherId   || null,
        subjectName:      subjectDoc?.name || null,
        teacherName:      teacherDoc?.name || null,
        // The EXAM's own totals, not a literal 100/50. A school marking out of
        // 20 — which is the whole system — created subjects that said 100, so
        // an 18 was stored as "18 out of 100", normalised to 3.6, and printed
        // as an F on every report card. exam.controller.js already inherited
        // these; this path did not.
        maxScore:         s.maxScore    ?? totalMarks ?? 100,
        passMark:         s.passMark    ?? passMark   ?? 50,
        // The subject's own coefficient unless this request weights the paper
        // itself — as POST /:examId/subjects does. A literal 100 here counted
        // every subject on an exam created in one request as coefficient 1,
        // whatever the school had set, and nothing on screen said so.
        weight:           s.weight      ?? Math.round(weightFor(coefficientOf(subjectDoc))),
        isPractical:      s.isPractical ?? false,
        isTheory:         s.isTheory    ?? true,
        isOral:           s.isOral      ?? false,
        submissionStatus: "pending",
      });
      createdSubjects.push(es);
    }
  }

  /*
   * ── The other half of the sequence ──────────────────────────────────────
   *
   * "CA is an assessment type under every sequence" has to be true of the
   * data, not of a screen. An administrator who creates Sequence 1 gets both
   * halves: the paper they just described, and a CA exam bound to it carrying
   * the same subjects, the same teachers and the same coefficients.
   *
   * Skipped when the school has CA off, when the exam is not bound to a
   * sequence, and when the exam IS the CA — a CA does not get a CA.
   *
   * Deliberately not fatal. A school losing the exam it just created because
   * the companion could not be written is a worse outcome than a sequence with
   * one half, which an administrator can see and fix; ensureCaExam is
   * idempotent, so the next edit or the next create picks it up.
   */
  let caExam = null;
  if (type !== "ca") {
    try {
      const made = await sequenceAssessment.ensureCaExam({
        paper:    exam.toObject(),
        userId:   req.user?._id || null,
        // An id the client chose, for a create made with no connection: the
        // same reason the paper's own _id is honoured above.
        caExamId: req.body.caExamId || null,
      });
      caExam = made.exam;
    } catch (err) {
      console.error("[exams] CA companion not created:", err.message);
    }
  }

  console.log(`✅ Exam created: ${exam.name} [${exam._id}]`);
  return res.status(201).json({
    success:  true,
    exam:     { ...exam.toObject(), subjects: createdSubjects },
    // The CA exam, so a client that has just created a sequence knows where to
    // send CA marks without going looking for it.
    caExam:   caExam ? { _id: caExam._id, name: caExam.name, type: caExam.type } : null,
    serverId: exam._id,
  });
}));

// ─────────────────────────────────────────────────────────
// PUT /api/exams/:id
// ─────────────────────────────────────────────────────────

router.put("/:id", adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const {
    name, type, academicYear, term, sequenceNumber,
    startDate, endDate, description, instructions,
    totalMarks, passMark, status,
  } = req.body;

  // Same checks the create route makes: the schema constrains both, so an
  // out-of-range value would arrive as a ValidationError and leave as a 500.
  if (term !== undefined && !isTermNumber(term)) {
    return res.status(400).json({ message: "term must be 1-3" });
  }
  if (sequenceNumber != null && sequenceNumber !== "") {
    const sq = Number(sequenceNumber);
    if (!Number.isInteger(sq) || sq < 1 || sq > 6) {
      return res.status(400).json({ message: "sequenceNumber must be 1-6" });
    }
  }

  const resolvedIds = resolveClassIdsFromBody(req.body);
  const classData   = resolvedIds.length > 0
    ? await resolveClassData(resolvedIds, schoolId) : null;

  const updates = {
    ...(name         !== undefined && { name: name.trim() }),
    ...(type         !== undefined && { type }),
    ...(academicYear !== undefined && { academicYear }),
    ...(term         !== undefined && { term }),
    /*
     * The sequence, which this route did not read at all.
     *
     * The create route was fixed to store it; editing an exam went on dropping
     * it. The form sent the value, the server ignored it, and reopening the
     * form read back the stored null — so the selection "disappeared" every
     * time, and the card printed from that exam still said Term 1.
     *
     * Blank clears it rather than being skipped: a promotion exam belongs to no
     * sequence, and switching an exam to one has to be able to say so. That is
     * why this is `!== undefined` on the key rather than a truthiness test —
     * "not sent" and "sent as empty" are different instructions.
     */
    ...(sequenceNumber !== undefined && {
      sequenceNumber: sequenceNumber === null || sequenceNumber === ""
        ? null
        : Number(sequenceNumber),
    }),
    ...(startDate    !== undefined && { startDate }),
    ...(endDate      !== undefined && { endDate }),
    ...(description  !== undefined && { description }),
    ...(instructions !== undefined && { instructions }),
    ...(totalMarks   !== undefined && { totalMarks }),
    ...(passMark     !== undefined && { passMark }),
    ...(status       !== undefined && { status }),
    updatedBy: req.user?._id || null,
  };

  if (classData) {
    updates.classId    = classData.primaryClassId;
    updates.className  = classData.primaryClassName;
    updates.classIds   = classData.classIds;
    updates.classNames = classData.classNames;
  }

  const exam = await Exam.findOneAndUpdate(
    { _id: req.params.id, schoolId, deletedAt: null },
    updates,
    { returnDocument: 'after', runValidators: true }
  ).lean();

  if (!exam) return res.status(404).json({ message: "Exam not found" });
  console.log(`✅ Exam updated: ${exam.name}`);
  return res.json({ success: true, exam });
}));

// ─────────────────────────────────────────────────────────
// PATCH /api/exams/:id/status
// ─────────────────────────────────────────────────────────

router.patch("/:id/status", adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const { status } = req.body;

  const validStatuses = [
    "draft", "scheduled", "ongoing",
    "completed", "published", "archived",
  ];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: `Invalid status: ${status}` });
  }

  const updates = { status, updatedBy: req.user?._id };
  if (status === "published") {
    updates.resultsPublished   = true;
    updates.resultsPublishedAt = new Date();
    updates.publishedBy        = req.user?._id;
    await ResultSummary.updateMany(
      { examId: req.params.id, schoolId },
      { isPublished: true, publishedAt: new Date() }
    );
  }

  const exam = await Exam.findOneAndUpdate(
    { _id: req.params.id, schoolId, deletedAt: null },
    updates,
    { returnDocument: 'after' }
  ).lean();

  if (!exam) return res.status(404).json({ message: "Exam not found" });
  console.log(`✅ Exam status → ${status}: ${exam.name}`);
  return res.json({ success: true, exam });
}));

// ─────────────────────────────────────────────────────────
// DELETE /api/exams/:id
// ─────────────────────────────────────────────────────────

router.delete("/:id", adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const exam = await Exam.findOneAndUpdate(
    { _id: req.params.id, schoolId, deletedAt: null },
    { deletedAt: new Date(), status: "archived" },
    { returnDocument: 'after' }
  ).lean();

  if (!exam) return res.status(404).json({ message: "Exam not found" });

  /*
   * The sequence's continuous assessment goes with its paper.
   *
   * Archiving the paper and leaving the CA behind would leave a half a
   * sequence in the exam list — an exam nothing pairs with, whose marks reach
   * no report card and which an administrator has no way to recognise as
   * orphaned.
   *
   * Soft, like the paper's own delete: the marks are not touched and both
   * exams can be revived together.
   */
  if (exam.type !== "ca") {
    await Exam.updateMany(
      { parentExamId: String(exam._id), type: "ca", deletedAt: null },
      { $set: { deletedAt: new Date(), status: "archived" } }
    ).catch((err) => console.error("[exams] CA not archived:", err.message));
  }

  console.log(`🗑️  Exam soft-deleted: ${exam.name}`);
  return res.json({ success: true, message: "Exam archived" });
}));

// ─────────────────────────────────────────────────────────
// EXAM SUBJECTS
// ─────────────────────────────────────────────────────────

router.get("/:examId/subjects", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const subjects = await ExamSubject.find({
    examId:    req.params.examId,
    schoolId,
    deletedAt: null,
  }).lean();
  return res.json({ success: true, subjects: await withAssignedTeachers(subjects, schoolId) });
}));

router.post("/:examId/subjects", adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const examId   = req.params.examId;

  const exam = await Exam.findOne({ _id: examId, schoolId }).lean();
  if (!exam) return res.status(404).json({ message: "Exam not found" });

  const {
    subjectId, classId, teacherId,
    maxScore, passMark, weight,
    isPractical, isTheory, isOral,
  } = req.body;

  if (!subjectId) return res.status(400).json({ message: "subjectId is required" });

  const subjectDoc      = await Subject.findOne({ _id: String(subjectId), schoolId }).lean();
  const teacherDoc      = teacherId ? await User.findOne({ _id: String(teacherId), schoolId }).lean() : null;
  if (!subjectDoc) return res.status(400).json({ message: "subjectId is not a subject of this school" });
  if (teacherId && !teacherDoc) return res.status(400).json({ message: "teacherId is not a member of this school" });
  const resolvedClassId = classId || exam.classId;
  if (resolvedClassId && !(await Class.exists({ _id: String(resolvedClassId), schoolId }))) {
    return res.status(400).json({ message: "classId is not a class of this school" });
  }

  /**
   * ── The id, and the two ways a repeat arrives ────────────────────────────
   *
   * A supplied _id is kept, as POST /api/exams and POST /api/fees/payments do,
   * so a request queued by an offline machine can be replayed without creating
   * a second row. See the note on POST /api/exams for why a server-invented id
   * makes a write unqueueable rather than merely awkward.
   *
   * The uniqueness rule below then does double duty. A replay of the SAME row
   * finds itself by id and is answered with what is stored; a genuinely
   * different attempt to add the same subject twice is still the 409 it was.
   * Ordered id-first because the two are otherwise indistinguishable — the
   * replay would take the 409, and a 409 stops the offline queue and waits for
   * a person, on work that had in fact succeeded.
   */
  const examSubjectId = req.body._id || uuidv4();

  const priorById = await ExamSubject.findById(examSubjectId).lean();
  if (priorById) {
    if (String(priorById.schoolId) !== String(schoolId)) {
      return res.status(409).json({
        success: false, code: "EXAM_SUBJECT_ID_TAKEN",
        message: "That exam subject id already belongs to another school",
      });
    }
    return res.status(200).json({ success: true, replay: true, subject: priorById });
  }

  const existing = await ExamSubject.findOne({
    examId,
    subjectId,
    classId:   resolvedClassId,
    deletedAt: null,
  }).lean();

  if (existing) {
    return res.status(409).json({
      message: "Subject already added to this exam for this class",
    });
  }

  // The subject's school-wide coefficient is the default weighting for this
  // exam. Subject.coefficient is a plain multiplier (1, 2, …) because that is
  // what the admin types; ExamSubject.weight is percentage-style (100 = ×1),
  // so it is scaled here. An explicit `weight` in the request still wins —
  // that is the per-exam override.
  const subjectCoefficient = Number(subjectDoc?.coefficient) > 0
    ? Number(subjectDoc.coefficient)
    : 1;
  const resolvedWeight = weight ?? Math.round(subjectCoefficient * 100);

  const es = await ExamSubject.create({
    _id:         examSubjectId,
    examId,
    subjectId,
    classId:     resolvedClassId,
    schoolId,
    teacherId:   teacherId   || null,
    subjectName: subjectDoc?.name || null,
    teacherName: teacherDoc?.name || null,
    // As above: inherit the exam's totals rather than assuming /100.
    maxScore:    maxScore    ?? exam.totalMarks ?? 100,
    passMark:    passMark    ?? exam.passMark   ?? 50,
    weight:      resolvedWeight,
    isPractical: isPractical ?? false,
    isTheory:    isTheory    ?? true,
    isOral:      isOral      ?? false,
  });

  /*
   * The same subject on the sequence's continuous assessment.
   *
   * A subject attached to the paper after the CA was created would otherwise
   * be markable in one half of the sequence and not the other, and a teacher
   * would find Mathematics on the paper's sheet and missing from the CA sheet
   * with nothing to say why. Idempotent and non-fatal, for the reasons
   * ensureCaExam is.
   */
  if (exam.type !== "ca") {
    await sequenceAssessment.mirrorSubjectToCa(exam, es)
      .catch((err) => console.error("[exams] CA subject not mirrored:", err.message));
  }

  return res.status(201).json({ success: true, subject: es });
}));

/**
 * PUT /api/exams/:examId/subjects/:id — the settings of one exam subject.
 *
 * This is where a subject's COEFFICIENT is set. The stored field is `weight`
 * (percentage-style: 100 = coefficient 1, 200 = coefficient 2), because that
 * is what the grading service and the report card renderer already read.
 *
 * Admin-only: a coefficient rescales every student's average in the class,
 * which is a head's decision, not a marker's.
 */
router.put(
  "/:examId/subjects/:id",
  adminOnly,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.body.schoolId);
    const { maxScore, passMark, weight, teacherId, isPractical, isTheory, isOral } = req.body;

    const updates = {};
    for (const [key, value] of Object.entries({ maxScore, passMark, weight })) {
      if (value === undefined) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ message: `${key} must be a positive number` });
      }
      updates[key] = n;
    }
    if (teacherId !== undefined) {
      const teacherDoc = teacherId ? await User.findOne({ _id: String(teacherId), schoolId }).lean() : null;
      if (teacherId && !teacherDoc) {
        return res.status(400).json({ message: "teacherId is not a member of this school" });
      }
      updates.teacherId   = teacherId || null;
      updates.teacherName = teacherDoc?.name || null;
    }
    if (isPractical !== undefined) updates.isPractical = Boolean(isPractical);
    if (isTheory    !== undefined) updates.isTheory    = Boolean(isTheory);
    if (isOral      !== undefined) updates.isOral      = Boolean(isOral);

    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const es = await ExamSubject.findOneAndUpdate(
      { _id: req.params.id, examId: req.params.examId, schoolId, deletedAt: null },
      updates,
      { returnDocument: 'after', runValidators: true }
    ).lean();
    if (!es) return res.status(404).json({ message: "Exam subject not found" });

    // A changed coefficient or maxScore makes already-computed averages stale.
    // Recomputing silently would rewrite results an admin may have published,
    // so the caller is told instead and decides when to reprocess.
    const hasScores = await StudentScore.exists({
      examId: req.params.examId, subjectId: es.subjectId, schoolId, deletedAt: null,
    });

    return res.json({
      success: true,
      subject: es,
      reprocessRequired: Boolean(hasScores && (updates.weight !== undefined || updates.maxScore !== undefined)),
    });
  })
);

// adminOnly: this was the one route in the file with no guard of its own, so
// any signed-in account of the school — a pupil included — could soft-delete a
// subject out of an exam. Its sibling PUT is admin-only for a lesser change.
router.delete(
  "/:examId/subjects/:subjectId",
  adminOnly,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.query.schoolId);
    const es = await ExamSubject.findOneAndUpdate(
      {
        _id:    req.params.subjectId,
        examId: req.params.examId,
        schoolId,
      },
      { deletedAt: new Date() },
      { returnDocument: 'after' }
    ).lean();
    if (!es) return res.status(404).json({ message: "Exam subject not found" });
    return res.json({ success: true, message: "Subject removed from exam" });
  })
);

// ─────────────────────────────────────────────────────────
// SCORES
// ─────────────────────────────────────────────────────────

// The whole cohort’s marks for one exam. Its sibling POST .../scores/bulk was
// staffOnly and this read was not, so a pupil could fetch every classmate’s
// score for any exam in their school by asking for it.
//
// WHO READS THIS SHEET: every holder of exams.view in the school — the
// teaching roles, the bursar excluded — for every class, published or not.
// That breadth is the recorded policy for teachers' reads of marks (docs/20
// §7b, §11.7; docs/22 §4), recorded there as a product decision still to be
// taken, and it is not taken here: the write below is confined to the
// teacher's own (class, subject) pair, the read is the school's. An operator
// names the school first; no school is no school, never every school.
router.get("/:examId/scores", staffOnly, asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const { classId, subjectId } = req.query;
  const query = {
    examId:    req.params.examId,
    schoolId,
    deletedAt: null,
  };
  if (classId)   query.classId   = classId;
  if (subjectId) query.subjectId = subjectId;
  const scores = await StudentScore.find(query).lean();
  return res.json({ success: true, scores });
}));

router.post("/:examId/scores/bulk", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const examId   = req.params.examId;
  const { classId: bodyClassId, subjectId: bodySubjectId, examSubjectId, scores } = req.body;

  if (!bodyClassId || !bodySubjectId || !Array.isArray(scores)) {
    return res.status(400).json({
      message: "classId, subjectId, and scores[] are required",
    });
  }

  const exam = await Exam.findOne({ _id: examId, schoolId }).lean();
  if (!exam) return res.status(404).json({ message: "Exam not found" });

  // ── The class and subject come from the exam, not the request ───────────
  // The ExamSubject row is the exam's own statement of which class sits which
  // subject. When one exists it decides both — the body is only allowed to
  // NAME it — and it must be this exam's and this school's: the old
  // ExamSubject.findById(examSubjectId) took any school's row, whose maxScore
  // then validated the sheet and whose submission status was flipped below.
  // Where an exam carries no ExamSubject rows the body's pair is used, but
  // the class and the subject must both be this school's.
  const examSubject = examSubjectId
    ? await ExamSubject.findOne({
        _id: String(examSubjectId), examId, schoolId, deletedAt: null,
      }).lean()
    : await ExamSubject.findOne({
        examId, subjectId: String(bodySubjectId), classId: String(bodyClassId),
        schoolId, deletedAt: null,
      }).lean();
  if (examSubjectId && !examSubject) {
    return res.status(404).json({ message: "Exam subject not found" });
  }
  const classId   = String(examSubject?.classId   ?? bodyClassId);
  const subjectId = String(examSubject?.subjectId ?? bodySubjectId);
  if (!examSubject) {
    const [classOk, subjectOk] = await Promise.all([
      Class.exists({ _id: classId, schoolId }),
      Subject.exists({ _id: subjectId, schoolId }),
    ]);
    if (!classOk)   return res.status(404).json({ message: "Class not found" });
    if (!subjectOk) return res.status(404).json({ message: "Subject not found" });
  }

  // ── The assignment is the boundary, not the capability ───────────────────
  // exams.view says "you may work with marks"; the TeacherAssignment row says
  // whose. Quiz authoring and homework already refuse an unassigned teacher
  // with SUBJECT_NOT_ASSIGNED, and the registry's own note says assignment is
  // what decides "who can enter the marks of whom". Without this check any
  // teacher could rewrite any class's sheet in their school. Asked of the
  // PAIR the exam itself names, never of the pair the request claimed.
  if (req.user?.role === "teacher") {
    const ok = await teacherAssigned(TeacherAssignment, {
      teacherId: req.user._id || req.user.id,
      schoolId,
      classId,
      subjectId,
    });
    if (!ok) {
      return res.status(403).json({
        success: false,
        code:    "SUBJECT_NOT_ASSIGNED",
        message: "You are not assigned to this class and subject",
      });
    }
  }

  // Nothing checked isLocked or isPublished here, so a published report card
  // could be rewritten under a parent who had already read it. An admin may
  // still correct a mistake, but only with a reason that gets recorded.
  const audit = await guardResultWrite(req, res, { examId, schoolId, subjectId });
  if (!audit) return;

  // Every pupil on the sheet is one of this school's. A studentId from
  // elsewhere would otherwise mint a row in this school's pipeline that
  // points at another school's child.
  const sheetStudentIds = [...new Set(
    scores.map((s) => (s?.studentId ? String(s.studentId) : null)).filter(Boolean)
  )];
  const knownStudents = new Set(
    (await StudentRoster.find({ _id: { $in: sheetStudentIds }, schoolId })
      .select("_id").lean()).map((s) => String(s._id))
  );

  // A mark of 23/20 (or a blank cell on a present student) silently corrupts
  // every average and grade computed from it, so the sheet is validated before
  // anything is written. Absent and exempt rows carry no score; every other
  // student must have a real number between 0 and the subject's ceiling.
  //
  // The ceiling is the one the mark is stored and graded against below — the
  // exam subject's — never a maxScore sent on the row. Checking the row's own
  // value let { score: 30, maxScore: 40 } through on a /20 subject, to be
  // stored as 30/20 (docs/39 §4.6a).
  const ceiling = examSubject?.maxScore ?? 100;
  const invalidScores = scores.filter((s) => {
    if (!s || s.isAbsent || s.isExempt)                           return false;
    if (s.score === null || s.score === undefined || s.score === "") return true;
    const n = Number(s.score);
    return !Number.isFinite(n) || n < 0 || n > ceiling;
  });
  if (invalidScores.length > 0) {
    return res.status(400).json({
      success: false,
      message: `${invalidScores.length} invalid score(s): every present student needs a mark between 0 and ${ceiling}`,
      invalid: invalidScores.map((s) => s.studentId),
    });
  }

  const gradingConfig = await GradingConfig.findOne({ schoolId }).lean();

  /*
   * ── CA marks into a school that has turned CA off ───────────────────────
   *
   * A new CA mark is refused: the school has said it does not assess that way,
   * the mark would appear on no report card and count towards no average, and
   * a teacher would be entering marks into nothing.
   *
   * An EXISTING CA mark may still be corrected. Turning CA off deletes
   * nothing — that is the whole point of the toggle — and a school that turns
   * it off mid-year must still be able to fix a mark somebody typed wrong
   * before they did, ready for the day they turn it back on.
   *
   * 400 rather than 403: this is a statement about the request, and the
   * offline queue stops on a 4xx and asks a person rather than retrying for
   * ever.
   */
  const caSettings = require("../../../shared/caAssessment")
    .caSettings(gradingConfig);
  const caLocked = exam.type === "ca" && !caSettings.caEnabled;

  // A count, not a collection: the documents this accumulated were never
  // read — the response and the log both asked only how many. The history
  // diff below works off priorByStudent, which is fetched up front.
  let savedCount      = 0;
  const failed        = [];
  const changes       = [];
  const ops           = [];
  const opRows        = [];
  const now           = new Date();

  // One read of the whole sheet's prior state. The alternative — a findOne per
  // student inside the loop — turns a 40-student save into 80 round trips.
  const priorRows = await StudentScore.find({
    examId, subjectId, schoolId,
    studentId: { $in: scores.map((s) => s?.studentId).filter(Boolean) },
  }).select("studentId score isAbsent isExempt teacherRemark").lean();

  const priorByStudent = new Map(
    priorRows.map((row) => [String(row.studentId), row])
  );

  for (const row of scores) {
    try {
      const { studentId, score, teacherRemark, isAbsent, isExempt } = row;
      if (!studentId) {
        failed.push({ ...row, reason: "Missing studentId" });
        continue;
      }
      if (!knownStudents.has(String(studentId))) {
        failed.push({ ...row, reason: "Student not found in this school" });
        continue;
      }

      // See caLocked above: corrections to a mark that already exists are
      // allowed; a new one is not.
      if (caLocked && !priorByStudent.has(String(studentId))) {
        failed.push({
          ...row,
          reason: "Continuous assessment is disabled for this school",
        });
        continue;
      }

      const maxScore = examSubject?.maxScore ?? 100;
      const computed = isAbsent || isExempt
        ? {
            percentage: null,
            grade:      null,
            remark:     null,
            gpaPoints:  null,
            isPassing:  false,
          }
        : computeGrade(score, maxScore, gradingConfig);

      // The row this mark belongs to, decided before the write rather than
      // inside it.
      //
      // $setOnInsert used to mint the id, which meant nothing outside the
      // bulkWrite knew it — and the audit entry below reached for `doc._id`,
      // a variable that does not exist in this scope. Every score row threw a
      // ReferenceError there, was caught by the try around it, and was counted
      // as failed. The mark itself had already been queued and did save, so a
      // teacher saw "1 saved, 1 failed" for one pupil, and ResultChangeLog —
      // the entire record of who changed a mark from what to what — was never
      // written to at all.
      const prior   = priorByStudent.get(String(studentId));
      const scoreId = prior?._id ? String(prior._id) : uuidv4();

      // Collected and sent as one write after the loop. This is the save at
      // the end of entering a mark sheet, and it awaited an upsert per
      // pupil: a class of forty paid forty sequential round trips, on the
      // screen where somebody has just typed for twenty minutes.
      ops.push({
        updateOne: {
          filter: { examId, studentId, subjectId, schoolId },
          update: {
            $set: {
              examSubjectId: examSubject?._id || null,
              classId,
              score:         score         ?? null,
              maxScore,
              percentage:    computed.percentage,
              grade:         computed.grade,
              remark:        computed.remark,
              gpaPoints:     computed.gpaPoints,
              isPassing:     computed.isPassing,
              teacherRemark: teacherRemark || null,
              isAbsent:      isAbsent      ?? false,
              isExempt:      isExempt      ?? false,
              enteredBy:     req.user?._id || null,
              enteredAt:     now,
              updatedBy:     req.user?._id || null,
              syncStatus:    "synced",
              lastSyncedAt:  now,
            },
            $setOnInsert: {
              _id: scoreId, examId, studentId, subjectId, schoolId,
            },
          },
          upsert: true,
        },
      });
      opRows.push(row);

      // Record only what moved. Re-saving an unchanged sheet is common and
      // must not fill the history with noise.
      const fields = prior
        ? [
            diffField("score",         prior.score         ?? null, score         ?? null),
            diffField("isAbsent",      prior.isAbsent      ?? false, isAbsent     ?? false),
            diffField("isExempt",      prior.isExempt      ?? false, isExempt     ?? false),
            diffField("teacherRemark", prior.teacherRemark ?? null, teacherRemark ?? null),
          ].filter(Boolean)
        : [{ field: "score", oldValue: null, newValue: score ?? null }];

      for (const f of fields) {
        changes.push({
          entity:    "score",
          entityId:  scoreId,
          action:    prior ? "updated" : "created",
          studentId: String(studentId),
          subjectId,
          ...f,
        });
      }
    } catch (err) {
      failed.push({ ...row, reason: err.message });
    }
  }

  // One write for the sheet. Unordered, so a single rejected row does not
  // discard the other thirty-nine, and the rows that did fail are still
  // named individually: writeErrors carry the index of the op that raised
  // them, and opRows maps that index back to the pupil.
  let writeErrors = [];
  if (ops.length) {
    try {
      await StudentScore.bulkWrite(ops, { ordered: false });
    } catch (e) {
      writeErrors = e?.writeErrors ?? e?.result?.writeErrors ?? [];
      if (!writeErrors.length) throw e;
    }
  }

  for (const we of writeErrors) {
    const idx = we.index ?? we.err?.index;
    const row = opRows[idx];
    failed.push({
      ...(row ?? {}),
      reason: we.errmsg || we.err?.errmsg || "Write failed",
    });
  }
  savedCount = ops.length - writeErrors.length;

  await logResultChange(audit, changes);

  if (examSubject) {
    await ExamSubject.findByIdAndUpdate(examSubject._id, {
      submissionStatus: "submitted",
      submittedBy:      req.user?._id,
      submittedAt:      now,
    });

    if (examSubject.submissionStatus !== "submitted") {
      await logResultChange(audit, {
        entity:   "examSubject",
        entityId: String(examSubject._id),
        action:   "submitted",
        subjectId,
        field:    "submissionStatus",
        oldValue: examSubject.submissionStatus ?? "pending",
        newValue: "submitted",
      });
    }
  }

  console.log(`📝 Scores saved: ${savedCount} | failed: ${failed.length}`);
  return res.status(201).json({
    success:       true,
    saved:         savedCount,
    failed:        failed.length,
    failedRecords: failed,
  });
}));

// ─────────────────────────────────────────────────────────
// POST /api/exams/:examId/process
// ─────────────────────────────────────────────────────────

router.post("/:examId/process", adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const examId   = req.params.examId;
  const { classId } = req.body;

  const exam = await Exam.findOne({ _id: examId, schoolId }).lean();
  if (!exam) return res.status(404).json({ message: "Exam not found" });

  const result = await processExam({ exam, schoolId, classId: classId || null, userId: req.user?._id ?? null });
  return res.status(result.status).json(result.body);
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/:examId/results
// ─────────────────────────────────────────────────────────

router.get("/:examId/results", staffOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { classId } = req.query;
  // Published unless the caller is an administrator — the feed's rule for
  // this collection and GET /api/results/:examId's, applied here too.
  const query = { examId: req.params.examId, schoolId, deletedAt: null, ...feedScopes.publishedUnlessAdmin(req) };
  if (classId) query.classId = classId;
  const results = await ResultSummary.find(query)
    .sort({ classPosition: 1 })
    .lean();

  await backfillResultNames(results, schoolId);

  // Each pupil's average on /20, the school's remark and pass/fail.
  return res.json({ success: true, results: await withAverage20(results, schoolId) });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/:examId/submissions
// ─────────────────────────────────────────────────────────

router.get("/:examId/submissions", staffOnly, asyncHandler(async (req, res) => {
  const schoolId      = resolveSchoolId(req, req.query.schoolId);
  const { teacherId } = req.query;

  const query = {
    examId:    req.params.examId,
    schoolId,
    deletedAt: null,
  };
  // The teacher is the class-subject assignment's (A8), not the one copied
  // onto the exam when it was made — so "a teacher's subjects" is filtered
  // after the assignment is read, not on the copy.
  const subjects = (await withAssignedTeachers(await ExamSubject.find(query).lean(), schoolId))
    .filter((es) => !teacherId || es.teacherIds.includes(String(teacherId)));
  const entered  = await enteredCountsFor({ examId: req.params.examId, schoolId });
  const enrolled = await enrolledCountsFor(schoolId, subjects.map((es) => es.classId));
  const enriched = subjects.map((es) => ({ ...es, totalScoresEntered: entered(es), totalStudents: enrolled(es) }));

  return res.json({ success: true, submissions: enriched });
}));

// ─────────────────────────────────────────────────────────
// PATCH /:examId/subjects/:examSubjectId/submit
// ─────────────────────────────────────────────────────────

router.patch(
  "/:examId/subjects/:examSubjectId/submit",
  staffOnly,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.body.schoolId);
    const now      = new Date();

    const es = await ExamSubject.findOneAndUpdate(
      {
        _id:    req.params.examSubjectId,
        examId: req.params.examId,
        schoolId,
      },
      {
        submissionStatus: "submitted",
        submittedBy:      req.user?._id,
        submittedAt:      now,
        rejectedBy:       null,
        rejectedAt:       null,
        rejectReason:     null,
      },
      { returnDocument: 'after' }
    ).lean();

    if (!es) return res.status(404).json({ message: "Exam subject not found" });
    console.log(`📤 Marks submitted: ${es.subjectName}`);
    return res.json({ success: true, subject: es });
  })
);

// ─────────────────────────────────────────────────────────
// PATCH /:examId/subjects/:examSubjectId/approve
// ─────────────────────────────────────────────────────────

router.patch(
  "/:examId/subjects/:examSubjectId/approve",
  adminOnly,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.body.schoolId);
    const now      = new Date();

    const es = await ExamSubject.findOneAndUpdate(
      {
        _id:    req.params.examSubjectId,
        examId: req.params.examId,
        schoolId,
      },
      {
        submissionStatus: "approved",
        approvedBy:       req.user?._id,
        approvedAt:       now,
        rejectedBy:       null,
        rejectedAt:       null,
        rejectReason:     null,
      },
      { returnDocument: 'after' }
    ).lean();

    if (!es) return res.status(404).json({ message: "Exam subject not found" });
    console.log(`✅ Marks approved: ${es.subjectName}`);
    return res.json({ success: true, subject: es });
  })
);

// ─────────────────────────────────────────────────────────
// PATCH /:examId/subjects/:examSubjectId/reject
// ─────────────────────────────────────────────────────────

router.patch(
  "/:examId/subjects/:examSubjectId/reject",
  adminOnly,
  asyncHandler(async (req, res) => {
    const schoolId   = resolveSchoolId(req, req.body.schoolId);
    const { reason } = req.body;
    const now        = new Date();

    if (!reason?.trim()) {
      return res.status(400).json({ message: "A rejection reason is required" });
    }

    const es = await ExamSubject.findOneAndUpdate(
      {
        _id:    req.params.examSubjectId,
        examId: req.params.examId,
        schoolId,
      },
      {
        submissionStatus: "rejected",
        rejectedBy:       req.user?._id,
        rejectedAt:       now,
        rejectReason:     reason.trim(),
        approvedBy:       null,
        approvedAt:       null,
      },
      { returnDocument: 'after' }
    ).lean();

    if (!es) return res.status(404).json({ message: "Exam subject not found" });
    console.log(`❌ Marks rejected: ${es.subjectName} — ${reason}`);
    return res.json({ success: true, subject: es });
  })
);

// ─────────────────────────────────────────────────────────
// PATCH /:examId/lock
// ─────────────────────────────────────────────────────────

router.patch("/:examId/lock", adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const examId   = req.params.examId;
  const now      = new Date();

  const result = await ResultSummary.updateMany(
    { examId, schoolId },
    { isLocked: true, lockedAt: now }
  );
  await Exam.findOneAndUpdate(
    { _id: examId, schoolId },
    { resultsLockedAt: now }
  );

  await logResultChange(
    {
      examId, schoolId,
      reason:     (req.body?.reason || "").trim() || null,
      isOverride: false,
      actor: {
        id:   req.user?._id ? String(req.user._id) : null,
        name: req.user?.name || null,
        role: req.user?.role || null,
      },
    },
    {
      entity:   "exam",
      entityId: examId,
      action:   "locked",
      field:    "isLocked",
      oldValue: false,
      newValue: true,
    }
  );

  return res.json({
    success: true,
    message: "Results locked",
    locked:  result?.modifiedCount ?? 0,
  });
}));

// ─────────────────────────────────────────────────────────
// PATCH /:examId/unlock
// ─────────────────────────────────────────────────────────

router.patch("/:examId/unlock", adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const examId   = req.params.examId;

  // Unlocking is the act that makes published marks editable again, so it is
  // the one that most needs a recorded justification. Locking does not: it
  // only ever narrows what can happen.
  const reason = (req.body?.reason || req.body?.changeReason || "").trim();
  if (!reason) {
    return res.status(400).json({
      success: false,
      code:    "REASON_REQUIRED",
      message: "Send a `reason` explaining why these results are being unlocked.",
    });
  }

  const result = await ResultSummary.updateMany(
    { examId, schoolId },
    { isLocked: false, lockedAt: null }
  );
  await Exam.findOneAndUpdate(
    { _id: examId, schoolId },
    { resultsLockedAt: null }
  );

  // Awaited, and allowed to throw: an unlock that leaves no record is exactly
  // the event this table exists to capture.
  await logResultChange(
    {
      examId, schoolId,
      reason,
      isOverride: true,
      actor: {
        id:   req.user?._id ? String(req.user._id) : null,
        name: req.user?.name || null,
        role: req.user?.role || null,
      },
    },
    {
      entity:   "exam",
      entityId: examId,
      action:   "unlocked",
      field:    "isLocked",
      oldValue: true,
      newValue: false,
    }
  );

  return res.json({
    success:  true,
    message:  "Results unlocked",
    unlocked: result?.modifiedCount ?? 0,
  });
}));

// ─────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────

router.use((err, req, res, next) => {
  console.error("❌ exam.routes error:", err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
  });
});

module.exports = router;