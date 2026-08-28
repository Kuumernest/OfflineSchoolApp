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
const Class         = require("../db/models/Class");
const Subject       = require("../db/models/Subject");
const User          = require("../db/models/User");

const { requirePermission } = require("../../middleware/permissions");
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

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

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

const resolveClassData = async (classIdArray) => {
  if (!classIdArray || classIdArray.length === 0) {
    return {
      primaryClassId:   null,
      primaryClassName: null,
      classIds:         [],
      classNames:       null,
    };
  }
  const classRecords = await Class.find({ _id: { $in: classIdArray } }).lean();
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

const computeGrade = (score, maxScore, gradingConfig) => {
  if (score === null || score === undefined) {
    return {
      percentage: null,
      grade:      null,
      remark:     null,
      gpaPoints:  null,
      isPassing:  null,
    };
  }
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const grades     = gradingConfig?.grades || [];
  const passMark   = gradingConfig?.passMark ?? 50;
  const match      = grades.find(
    (g) => percentage >= g.minMark && percentage <= g.maxMark
  );
  return {
    percentage,
    grade:     match?.grade     || null,
    remark:    match?.remark    || null,
    gpaPoints: match?.gpaPoints ?? null,
    isPassing: percentage >= passMark,
  };
};

// ═════════════════════════════════════════════════════════
// STATIC ROUTES — ALL BEFORE /:id
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// GET /api/exams
// ─────────────────────────────────────────────────────────

router.get("/", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const {
    status, classId, academicYear, term,
    page = 1, limit = 50,
  } = req.query;

  const query = { schoolId, deletedAt: null };
  if (status)       query.status       = status;
  if (academicYear) query.academicYear = academicYear;
  if (term)         query.term         = term;
  if (classId) {
    query.$or = [
      { classId  },
      { classIds: classId },
    ];
  }

  const skip  = (Number(page) - 1) * Number(limit);
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

router.get("/dashboard", asyncHandler(async (req, res) => {
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

  const avgResult = await ResultSummary.aggregate([
    { $match: { schoolId, isPublished: true } },
    {
      $group: {
        _id:       null,
        avg:       { $avg: "$percentage" },
        passCount: { $sum: { $cond: ["$isPassing", 1, 0] } },
        total:     { $sum: 1 },
      },
    },
  ]);

  const averagePerformance = avgResult[0]?.avg
    ? Math.round(avgResult[0].avg) : 0;
  const passRate = avgResult[0]?.total > 0
    ? Math.round((avgResult[0].passCount / avgResult[0].total) * 100) : 0;

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
      },
      recentExams,
    },
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/stats
// ─────────────────────────────────────────────────────────

router.get("/stats", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, message: "schoolId is required" });
  }

  const { term, academicYear, classId } = req.query;

  const base = { schoolId, deletedAt: null };
  if (term)         base.term         = term;
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

  const resultFilter = {
    schoolId,
    isPublished: true,
    ...(term         ? { term }         : {}),
    ...(academicYear ? { academicYear } : {}),
  };

  const [passAgg, publishedResults, pendingResults, missingGrades] =
    await Promise.all([
      ResultSummary.aggregate([
        { $match: resultFilter },
        {
          $group: {
            _id:       null,
            passCount: { $sum: { $cond: ["$isPassing", 1, 0] } },
            total:     { $sum: 1 },
            avgPct:    { $avg: "$percentage" },
          },
        },
      ]),
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

  const passRate = passAgg[0]?.total > 0
    ? Math.round((passAgg[0].passCount / passAgg[0].total) * 100)
    : 0;

  const averagePerformance = passAgg[0]?.avgPct != null
    ? Math.round(passAgg[0].avgPct)
    : 0;

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
      },
    },
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/reports
// ─────────────────────────────────────────────────────────

router.get("/reports", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { academicYear, term, classId, page = 1, limit = 20 } = req.query;

  const query = {
    schoolId,
    deletedAt: null,
    status: { $in: ["completed", "published"] },
  };
  if (academicYear) query.academicYear = academicYear;
  if (term)         query.term         = term;
  if (classId) {
    query.$or = [{ classId }, { classIds: classId }];
  }

  const skip  = (Number(page) - 1) * Number(limit);
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

router.get("/reports/results", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId, classId, page = 1, limit = 50 } = req.query;

  const query = { schoolId };
  if (examId)  query.examId  = examId;
  if (classId) query.classId = classId;

  const skip    = (Number(page) - 1) * Number(limit);
  const total   = await ResultSummary.countDocuments(query);
  const results = await ResultSummary.find(query)
    .sort({ classPosition: 1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  return res.json({
    success: true,
    results,
    total,
    page:  Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
}));

router.get("/reports/submissions", asyncHandler(async (req, res) => {
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

router.get("/submissions", asyncHandler(async (req, res) => {
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

router.get("/submissions/results", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { classId, examId } = req.query;

  const query = { schoolId };
  if (examId)  query.examId  = examId;
  if (classId) query.classId = classId;

  const results = await ResultSummary.find(query)
    .sort({ classPosition: 1 })
    .lean();
  return res.json({ success: true, results, total: results.length });
}));

router.get("/submissions/submissions", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId, classId } = req.query;

  const query = { schoolId, deletedAt: null };
  if (examId)  query.examId  = examId;
  if (classId) query.classId = classId;

  const subjects = await ExamSubject.find(query).lean();
  const enriched = await Promise.all(
    subjects.map(async (es) => {
      const count = await StudentScore.countDocuments({
        examId:    es.examId,
        subjectId: es.subjectId,
        classId:   es.classId,
        schoolId,
        score:     { $ne: null },
        deletedAt: null,
      });
      return { ...es, totalScoresEntered: count };
    })
  );
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

router.get("/:id", asyncHandler(async (req, res) => {
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

router.post("/", asyncHandler(async (req, res) => {
  const {
    name, type, academicYear, term,
    startDate, endDate, description, instructions,
    totalMarks, passMark, status, subjects,
  } = req.body;

  if (!name?.trim())  return res.status(400).json({ message: "name is required" });
  if (!academicYear)  return res.status(400).json({ message: "academicYear is required" });
  if (!term)          return res.status(400).json({ message: "term is required" });

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
  const classData   = await resolveClassData(resolvedIds);

  const exam = await Exam.create({
    _id:          examId,
    schoolId,
    classId:      classData.primaryClassId,
    className:    classData.primaryClassName,
    classIds:     classData.classIds,
    classNames:   classData.classNames,
    name:         name.trim(),
    type:         type         || "first_test",
    academicYear,
    term,
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
      const subjectDoc = await Subject.findById(s.subjectId).lean();
      const teacherDoc = s.teacherId
        ? await User.findById(s.teacherId).lean() : null;
      const es = await ExamSubject.create({
        _id:              uuidv4(),
        examId:           exam._id,
        subjectId:        s.subjectId,
        classId:          classData.primaryClassId || s.classId || null,
        schoolId,
        teacherId:        s.teacherId   || null,
        subjectName:      subjectDoc?.name || null,
        teacherName:      teacherDoc?.name || null,
        maxScore:         s.maxScore    ?? 100,
        passMark:         s.passMark    ?? 50,
        weight:           s.weight      ?? 100,
        isPractical:      s.isPractical ?? false,
        isTheory:         s.isTheory    ?? true,
        isOral:           s.isOral      ?? false,
        submissionStatus: "pending",
      });
      createdSubjects.push(es);
    }
  }

  console.log(`✅ Exam created: ${exam.name} [${exam._id}]`);
  return res.status(201).json({
    success:  true,
    exam:     { ...exam.toObject(), subjects: createdSubjects },
    serverId: exam._id,
  });
}));

// ─────────────────────────────────────────────────────────
// PUT /api/exams/:id
// ─────────────────────────────────────────────────────────

router.put("/:id", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const {
    name, type, academicYear, term,
    startDate, endDate, description, instructions,
    totalMarks, passMark, status,
  } = req.body;

  const resolvedIds = resolveClassIdsFromBody(req.body);
  const classData   = resolvedIds.length > 0
    ? await resolveClassData(resolvedIds) : null;

  const updates = {
    ...(name         !== undefined && { name: name.trim() }),
    ...(type         !== undefined && { type }),
    ...(academicYear !== undefined && { academicYear }),
    ...(term         !== undefined && { term }),
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
    { new: true, runValidators: true }
  ).lean();

  if (!exam) return res.status(404).json({ message: "Exam not found" });
  console.log(`✅ Exam updated: ${exam.name}`);
  return res.json({ success: true, exam });
}));

// ─────────────────────────────────────────────────────────
// PATCH /api/exams/:id/status
// ─────────────────────────────────────────────────────────

router.patch("/:id/status", asyncHandler(async (req, res) => {
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
    { new: true }
  ).lean();

  if (!exam) return res.status(404).json({ message: "Exam not found" });
  console.log(`✅ Exam status → ${status}: ${exam.name}`);
  return res.json({ success: true, exam });
}));

// ─────────────────────────────────────────────────────────
// DELETE /api/exams/:id
// ─────────────────────────────────────────────────────────

router.delete("/:id", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const exam = await Exam.findOneAndUpdate(
    { _id: req.params.id, schoolId, deletedAt: null },
    { deletedAt: new Date(), status: "archived" },
    { new: true }
  ).lean();

  if (!exam) return res.status(404).json({ message: "Exam not found" });
  console.log(`🗑️  Exam soft-deleted: ${exam.name}`);
  return res.json({ success: true, message: "Exam archived" });
}));

// ─────────────────────────────────────────────────────────
// EXAM SUBJECTS
// ─────────────────────────────────────────────────────────

router.get("/:examId/subjects", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const subjects = await ExamSubject.find({
    examId:    req.params.examId,
    schoolId,
    deletedAt: null,
  }).lean();
  return res.json({ success: true, subjects });
}));

router.post("/:examId/subjects", asyncHandler(async (req, res) => {
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

  const subjectDoc      = await Subject.findById(subjectId).lean();
  const teacherDoc      = teacherId ? await User.findById(teacherId).lean() : null;
  const resolvedClassId = classId || exam.classId;

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
    _id:         uuidv4(),
    examId,
    subjectId,
    classId:     resolvedClassId,
    schoolId,
    teacherId:   teacherId   || null,
    subjectName: subjectDoc?.name || null,
    teacherName: teacherDoc?.name || null,
    maxScore:    maxScore    ?? 100,
    passMark:    passMark    ?? 50,
    weight:      resolvedWeight,
    isPractical: isPractical ?? false,
    isTheory:    isTheory    ?? true,
    isOral:      isOral      ?? false,
  });

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
      updates.teacherId = teacherId || null;
      const teacherDoc = teacherId ? await User.findById(teacherId).lean() : null;
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
      { new: true, runValidators: true }
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

router.delete(
  "/:examId/subjects/:subjectId",
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.query.schoolId);
    const es = await ExamSubject.findOneAndUpdate(
      {
        _id:    req.params.subjectId,
        examId: req.params.examId,
        schoolId,
      },
      { deletedAt: new Date() },
      { new: true }
    ).lean();
    if (!es) return res.status(404).json({ message: "Exam subject not found" });
    return res.json({ success: true, message: "Subject removed from exam" });
  })
);

// ─────────────────────────────────────────────────────────
// SCORES
// ─────────────────────────────────────────────────────────

router.get("/:examId/scores", asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
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
  const { classId, subjectId, examSubjectId, scores } = req.body;

  if (!classId || !subjectId || !Array.isArray(scores)) {
    return res.status(400).json({
      message: "classId, subjectId, and scores[] are required",
    });
  }

  const exam = await Exam.findOne({ _id: examId, schoolId }).lean();
  if (!exam) return res.status(404).json({ message: "Exam not found" });

  // Nothing checked isLocked or isPublished here, so a published report card
  // could be rewritten under a parent who had already read it. An admin may
  // still correct a mistake, but only with a reason that gets recorded.
  const audit = await guardResultWrite(req, res, { examId, schoolId, subjectId });
  if (!audit) return;

  const examSubject = examSubjectId
    ? await ExamSubject.findById(examSubjectId).lean()
    : await ExamSubject.findOne({
        examId, subjectId, classId, deletedAt: null,
      }).lean();

  const gradingConfig = await GradingConfig.findOne({ schoolId }).lean();
  const saved         = [];
  const failed        = [];
  const changes       = [];
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

      const doc = await StudentScore.findOneAndUpdate(
        { examId, studentId, subjectId, schoolId },
        {
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
            _id: uuidv4(), examId, studentId, subjectId, schoolId,
          },
        },
        { upsert: true, new: true }
      ).lean();

      saved.push(doc);

      // Record only what moved. Re-saving an unchanged sheet is common and
      // must not fill the history with noise.
      const prior = priorByStudent.get(String(studentId));
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
          entityId:  String(doc._id),
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

  console.log(`📝 Scores saved: ${saved.length} | failed: ${failed.length}`);
  return res.status(201).json({
    success:       true,
    saved:         saved.length,
    failed:        failed.length,
    failedRecords: failed,
  });
}));

// ─────────────────────────────────────────────────────────
// POST /api/exams/:examId/process
// ─────────────────────────────────────────────────────────

router.post("/:examId/process", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const examId   = req.params.examId;
  const { classId } = req.body;

  const exam = await Exam.findOne({ _id: examId, schoolId }).lean();
  if (!exam) return res.status(404).json({ message: "Exam not found" });

  const gradingConfig = await GradingConfig.findOne({ schoolId }).lean();
  const scoreQuery    = { examId, schoolId, deletedAt: null };
  if (classId) scoreQuery.classId = classId;

  const allScores    = await StudentScore.find(scoreQuery).lean();
  const examSubjects = await ExamSubject.find({
    examId,
    schoolId,
    deletedAt: null,
    ...(classId ? { classId } : {}),
  }).lean();

  const subjectMap = new Map(examSubjects.map((es) => [es.subjectId, es]));
  const byStudent  = {};
  for (const score of allScores) {
    if (!byStudent[score.studentId]) byStudent[score.studentId] = [];
    byStudent[score.studentId].push(score);
  }

  const summaries = [];

  for (const [studentId, scores] of Object.entries(byStudent)) {
    let totalScore    = 0;
    let maxTotalScore = 0;
    let passed        = 0;
    let failedCount   = 0;

    const subjectBreakdown = [];

    for (const s of scores) {
      const es       = subjectMap.get(s.subjectId);
      const maxScore = es?.maxScore ?? s.maxScore ?? 100;
      maxTotalScore += maxScore;

      if (!s.isAbsent && !s.isExempt && s.score !== null) {
        totalScore += s.score;
        const pct  = Math.round((s.score / maxScore) * 100);
        if (s.isPassing) passed++;
        else             failedCount++;

        subjectBreakdown.push({
          subjectId:      s.subjectId,
          subjectName:    es?.subjectName || s.subjectId,
          score:          s.score,
          maxScore,
          normalizedMark: Math.round((pct / 100) * 20 * 10) / 10,
          grade:          s.grade,
          points:         s.gpaPoints,
          remark:         s.remark,
          isPassing:      s.isPassing,
          isAbsent:       false,
        });
      } else {
        subjectBreakdown.push({
          subjectId:      s.subjectId,
          subjectName:    es?.subjectName || s.subjectId,
          score:          null,
          maxScore,
          normalizedMark: null,
          grade:          null,
          points:         null,
          remark:         s.isAbsent ? "Absent" : "Exempt",
          isPassing:      false,
          isAbsent:       s.isAbsent,
        });
      }
    }

    const percentage = maxTotalScore > 0
      ? Math.round((totalScore / maxTotalScore) * 100) : 0;
    const average    = scores.length > 0
      ? Math.round(totalScore / scores.length) : 0;
    const computed   = computeGrade(totalScore, maxTotalScore, gradingConfig);

    const existing = await ResultSummary.findOne({ examId, studentId, schoolId });

    let summary;
    if (existing) {
      summary = await ResultSummary.findByIdAndUpdate(
        existing._id,
        {
          $set: {
            classId:        classId || exam.classId,
            totalScore,
            maxTotalScore,
            percentage,
            average,
            overallGrade:   computed.grade,
            overallRemark:  computed.remark,
            gpa:            computed.gpaPoints,
            subjectsPassed: passed,
            subjectsFailed: failedCount,
            subjectsTotal:  scores.length,
            isPassing:      percentage >= (gradingConfig?.passMark ?? 50),
            subjectBreakdown,
            syncStatus:     "synced",
            lastSyncedAt:   new Date(),
          },
        },
        { new: true }
      ).lean();
    } else {
      summary = await ResultSummary.create({
        _id:            uuidv4(),
        examId,
        studentId,
        schoolId,
        classId:        classId || exam.classId,
        totalScore,
        maxTotalScore,
        percentage,
        average,
        overallGrade:   computed.grade,
        overallRemark:  computed.remark,
        gpa:            computed.gpaPoints,
        subjectsPassed: passed,
        subjectsFailed: failedCount,
        subjectsTotal:  scores.length,
        isPassing:      percentage >= (gradingConfig?.passMark ?? 50),
        subjectBreakdown,
        syncStatus:     "synced",
        lastSyncedAt:   new Date(),
      });
      summary = summary.toObject ? summary.toObject() : summary;
    }

    summaries.push(summary);
  }

  // ── Class positions ──────────────────────────────────────
  const grouped = {};
  for (const s of summaries) {
    const cId = s.classId || "unknown";
    if (!grouped[cId]) grouped[cId] = [];
    grouped[cId].push(s);
  }

  for (const classSummaries of Object.values(grouped)) {
    classSummaries.sort((a, b) => b.percentage - a.percentage);
    let pos = 1;
    for (let i = 0; i < classSummaries.length; i++) {
      if (
        i > 0 &&
        classSummaries[i].percentage < classSummaries[i - 1].percentage
      ) {
        pos = i + 1;
      }
      await ResultSummary.findByIdAndUpdate(classSummaries[i]._id, {
        classPosition: pos,
        totalInClass:  classSummaries.length,
      });
    }
  }

  await Exam.findByIdAndUpdate(examId, { status: "completed" });
  console.log(`✅ Results processed: ${summaries.length} students`);

  return res.json({
    success:   true,
    processed: summaries.length,
    message:   `Results processed for ${summaries.length} student(s)`,
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/:examId/results
// ─────────────────────────────────────────────────────────

router.get("/:examId/results", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { classId } = req.query;
  const query = { examId: req.params.examId, schoolId };
  if (classId) query.classId = classId;
  const results = await ResultSummary.find(query)
    .sort({ classPosition: 1 })
    .lean();
  return res.json({ success: true, results });
}));

// ─────────────────────────────────────────────────────────
// GET /api/exams/:examId/submissions
// ─────────────────────────────────────────────────────────

router.get("/:examId/submissions", asyncHandler(async (req, res) => {
  const schoolId      = resolveSchoolId(req, req.query.schoolId);
  const { teacherId } = req.query;

  const query = {
    examId:    req.params.examId,
    schoolId,
    deletedAt: null,
  };
  if (teacherId) query.teacherId = teacherId;

  const subjects = await ExamSubject.find(query).lean();

  const enriched = await Promise.all(
    subjects.map(async (es) => {
      const count = await StudentScore.countDocuments({
        examId:    req.params.examId,
        subjectId: es.subjectId,
        classId:   es.classId,
        schoolId,
        score:     { $ne: null },
        deletedAt: null,
      });
      return { ...es, totalScoresEntered: count };
    })
  );

  return res.json({ success: true, submissions: enriched });
}));

// ─────────────────────────────────────────────────────────
// PATCH /:examId/subjects/:examSubjectId/submit
// ─────────────────────────────────────────────────────────

router.patch(
  "/:examId/subjects/:examSubjectId/submit",
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
      { new: true }
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
      { new: true }
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
      { new: true }
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