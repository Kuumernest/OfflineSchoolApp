// backend/src/controllers/exam.controller.js
"use strict";

const Exam        = require("../db/models/Exam");
const ExamSubject = require("../db/models/ExamSubject");
const ExamScore   = require("../db/models/ExamScore");
const ExamResult  = require("../db/models/ExamResult");
const Subject     = require("../db/models/Subject");
const User        = require("../db/models/User");
const Class       = require("../db/models/Class");

const { computeResults, publishResults } =
  require("../services/examResult.service");

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided)
    return String(provided).trim();
  return req.user?.schoolId;
};

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─────────────────────────────────────────────────────────
// LIST EXAMS
// GET /api/exams
// ─────────────────────────────────────────────────────────

exports.listExams = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const {
    status, classId, academicYear, term,
    page  = 1,
    limit = 50,
  } = req.query;

  if (!schoolId) {
    return res.status(400).json({ message: "schoolId is required" });
  }

  const filter = { schoolId, deletedAt: null };
  if (status)       filter.status       = status;
  if (academicYear) filter.academicYear = academicYear;
  if (term)         filter.term         = term;
  if (classId) {
    filter.$or = [
      { classId  },
      { classIds: classId },
    ];
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await Exam.countDocuments(filter);
  const exams = await Exam.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  return res.json({
    success: true,
    exams,
    total,
    pagination: {
      total,
      page:       Number(page),
      limit:      Number(limit),
      totalPages: Math.ceil(total / Number(limit)),
    },
  });
});

// ─────────────────────────────────────────────────────────
// DASHBOARD
// GET /api/exams/dashboard
// ─────────────────────────────────────────────────────────

exports.getDashboard = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  if (!schoolId) {
    return res.status(400).json({ message: "schoolId is required" });
  }

  const base = { schoolId, deletedAt: null };

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

  const publishedResults = await ExamResult.countDocuments({
    schoolId,
    isPublished: true,
  });

  const pendingResults = await Exam.countDocuments({
    ...base,
    status:           "completed",
    resultsPublished: false,
  });

  const missingGrades = await ExamSubject.countDocuments({
    schoolId,
    submissionStatus: "pending",
    deletedAt:        null,
  });

  const avgAgg = await ExamResult.aggregate([
    { $match: { schoolId } },
    { $group: { _id: null, avg: { $avg: "$percentage" } } },
  ]);
  const averagePerformance = avgAgg[0]?.avg
    ? Math.round(avgAgg[0].avg)
    : 0;

  const passAgg = await ExamResult.aggregate([
    { $match: { schoolId } },
    {
      $group: {
        _id:    null,
        total:  { $sum: 1 },
        passed: { $sum: { $cond: ["$isPassing", 1, 0] } },
      },
    },
  ]);
  const passRate = passAgg[0]?.total > 0
    ? Math.round((passAgg[0].passed / passAgg[0].total) * 100)
    : 0;

  const recentExams = await Exam.find(base)
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  return res.json({
    success: true,
    dashboard: {
      exams: {
        total, draft, scheduled, ongoing,
        completed, published, archived,
      },
      results: {
        published:          publishedResults,
        pending:            pendingResults,
        missingGrades,
        averagePerformance,
        passRate,
      },
      recentExams,
    },
  });
});

// ─────────────────────────────────────────────────────────
// GET SINGLE EXAM
// GET /api/exams/:id
// ─────────────────────────────────────────────────────────

exports.getExam = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { id }   = req.params;

  const exam = await Exam.findOne({
    _id: id,
    ...(schoolId ? { schoolId } : {}),
    deletedAt: null,
  }).lean();

  if (!exam) {
    return res.status(404).json({ message: "Exam not found" });
  }

  const subjects = await ExamSubject.find({
    examId:    id,
    deletedAt: null,
  }).lean();

  const scoresCount = await ExamScore.countDocuments({
    examId:    id,
    deletedAt: null,
  });

  return res.json({
    success: true,
    exam: {
      ...exam,
      subjects,
      subjectCount: subjects.length,
      scoresCount,
    },
  });
});

// ─────────────────────────────────────────────────────────
// CREATE EXAM
// POST /api/exams
// ─────────────────────────────────────────────────────────

exports.createExam = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);

  const {
    id,
    name, type, academicYear, term,
    classId, className, classIds, classNames,
    startDate, endDate, totalMarks, passMark,
    description, instructions, status, subjects,
  } = req.body;

  // Exam._id is a String UUID, so a client that authored this exam offline
  // can supply the id it already stored locally. Re-POSTing the same id is
  // then a no-op that returns the existing exam, which is what makes the
  // mobile outbox safe to retry.
  if (id) {
    const existing = await Exam.findById(String(id)).lean();
    if (existing) {
      return res.status(200).json({ success: true, exam: existing, deduplicated: true });
    }
  }

  if (!name?.trim()) {
    return res.status(400).json({ message: "name is required" });
  }
  if (!academicYear) {
    return res.status(400).json({ message: "academicYear is required" });
  }
  if (!term) {
    return res.status(400).json({ message: "term is required" });
  }

  // Resolve class names from IDs if classIds provided
  let resolvedClassNames = classNames || null;
  let resolvedClassId    = classId    || null;
  let resolvedClassName  = className  || null;
  let resolvedClassIds   = classIds   || [];

  if (Array.isArray(classIds) && classIds.length > 0) {
    const classRecords = await Class.find({
      _id: { $in: classIds },
    }).lean();
    const nameMap = new Map(classRecords.map((c) => [String(c._id), c.name]));
    const orderedNames = classIds
      .filter((cid) => nameMap.has(cid))
      .map((cid)    => nameMap.get(cid));

    resolvedClassIds   = classIds;
    resolvedClassNames = orderedNames.join(", ") || null;
    resolvedClassId    = classIds[0]    || null;
    resolvedClassName  = orderedNames[0] || null;
  }

  const exam = await Exam.create({
    ...(id ? { _id: String(id) } : {}),
    schoolId,
    name:         name.trim(),
    type:         type         || "first_test",
    academicYear,
    term,
    classId:      resolvedClassId,
    className:    resolvedClassName,
    classIds:     resolvedClassIds,
    classNames:   resolvedClassNames,
    startDate:    startDate    || null,
    endDate:      endDate      || null,
    totalMarks:   totalMarks   ?? 100,
    passMark:     passMark     ?? 50,
    description:  description  || null,
    instructions: instructions || null,
    status:       status       || "draft",
    createdBy:    req.user?._id || null,
  });

  // Create ExamSubjects if provided
  const createdSubjects = [];
  if (Array.isArray(subjects) && subjects.length > 0) {
    for (const s of subjects) {
      if (!s.subjectId) continue;
      try {
        const subjectDoc = await Subject.findById(s.subjectId).lean();
        const teacherDoc = s.teacherId
          ? await User.findById(s.teacherId).lean()
          : null;

        const es = await ExamSubject.create({
          ...(s.id ? { _id: String(s.id) } : {}),
          examId:      exam._id,
          subjectId:   s.subjectId,
          classId:     s.classId || resolvedClassId,
          schoolId,
          teacherId:   s.teacherId   || null,
          subjectName: subjectDoc?.name || s.subjectName || null,
          teacherName: teacherDoc?.name || null,
          maxScore:    s.maxScore    ?? totalMarks ?? 100,
          passMark:    s.passMark    ?? passMark   ?? 50,
          weight:      s.weight      ?? 100,
          isPractical: s.isPractical ?? false,
          isTheory:    s.isTheory    ?? true,
          isOral:      s.isOral      ?? false,
        });
        createdSubjects.push(es.toObject());
      } catch (err) {
        console.warn("[createExam] subject create failed:", err.message);
      }
    }
  }

  console.log(`✅ Exam created: ${exam.name} [${exam._id}]`);

  return res.status(201).json({
    success:  true,
    exam:     { ...exam.toObject(), subjects: createdSubjects },
    serverId: exam._id,
  });
});

// ─────────────────────────────────────────────────────────
// UPDATE EXAM
// PUT /api/exams/:id
// ─────────────────────────────────────────────────────────

exports.updateExam = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const { id }   = req.params;

  const updates = { ...req.body, updatedBy: req.user?._id };
  delete updates._id;
  delete updates.schoolId;

  // Resolve class data if classIds provided
  if (Array.isArray(updates.classIds) && updates.classIds.length > 0) {
    const classRecords = await Class.find({
      _id: { $in: updates.classIds },
    }).lean();
    const nameMap = new Map(classRecords.map((c) => [String(c._id), c.name]));
    const names   = updates.classIds
      .filter((cid) => nameMap.has(cid))
      .map((cid) => nameMap.get(cid));
    updates.classNames  = names.join(", ") || null;
    updates.classId     = updates.classIds[0] || null;
    updates.className   = names[0]            || null;
  }

  const exam = await Exam.findOneAndUpdate(
    { _id: id, schoolId, deletedAt: null },
    updates,
    { new: true, runValidators: true }
  ).lean();

  if (!exam) {
    return res.status(404).json({ message: "Exam not found" });
  }

  console.log(`✅ Exam updated: ${exam.name}`);
  return res.json({ success: true, exam });
});

// ─────────────────────────────────────────────────────────
// UPDATE STATUS
// PATCH /api/exams/:id/status
// ─────────────────────────────────────────────────────────

const VALID_STATUSES = [
  "draft", "scheduled", "ongoing",
  "completed", "published", "archived",
];

exports.updateExamStatus = asyncHandler(async (req, res) => {
  const schoolId     = resolveSchoolId(req, req.body.schoolId);
  const { id }       = req.params;
  const { status }   = req.body;

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ message: `Invalid status: ${status}` });
  }

  const extra = {};

  if (status === "published") {
    extra.resultsPublished   = true;
    extra.resultsPublishedAt = new Date();
    extra.publishedBy        = req.user?._id || null;

    // Publish all ExamResult docs for this exam
    await publishResults({
      examId:      id,
      publishedBy: req.user?._id || null,
    });
  }

  const exam = await Exam.findOneAndUpdate(
    { _id: id, ...(schoolId ? { schoolId } : {}), deletedAt: null },
    { $set: { status, updatedBy: req.user?._id, ...extra } },
    { new: true }
  ).lean();

  if (!exam) {
    return res.status(404).json({ message: "Exam not found" });
  }

  console.log(`✅ Exam status → ${status}: ${exam.name}`);
  return res.json({ success: true, exam });
});

// ─────────────────────────────────────────────────────────
// DELETE EXAM (soft)
// DELETE /api/exams/:id
// ─────────────────────────────────────────────────────────

exports.deleteExam = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { id }   = req.params;

  const exam = await Exam.findOneAndUpdate(
    { _id: id, schoolId, deletedAt: null },
    { $set: { deletedAt: new Date(), updatedBy: req.user?._id } },
    { new: true }
  ).lean();

  if (!exam) {
    return res.status(404).json({ message: "Exam not found" });
  }

  console.log(`🗑️ Exam deleted: ${exam.name}`);
  return res.json({ success: true, message: "Exam deleted" });
});

// ─────────────────────────────────────────────────────────
// GET SUBMISSIONS (ExamSubjects for an exam)
// GET /api/exams/:examId/submissions
// ─────────────────────────────────────────────────────────

exports.getSubmissions = asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
  const { examId } = req.params;
  const { classId, subjectId, status, teacherId } = req.query;

  const filter = { examId, deletedAt: null };
  if (schoolId)  filter.schoolId          = schoolId;
  if (classId)   filter.classId           = classId;
  if (subjectId) filter.subjectId         = subjectId;
  if (status)    filter.submissionStatus  = status;
  if (teacherId) filter.teacherId         = teacherId;

  const subjects = await ExamSubject.find(filter)
    .sort({ subjectName: 1 })
    .lean();

  // Attach score count to each subject
  const enriched = await Promise.all(
    subjects.map(async (es) => {
      const count = await ExamScore.countDocuments({
        examSubjectId: es._id,
        score:         { $ne: null },
        deletedAt:     null,
      });
      return { ...es, totalScoresEntered: count };
    })
  );

  return res.json({ success: true, submissions: enriched });
});

// ─────────────────────────────────────────────────────────
// PROCESS RESULTS
// POST /api/exams/:examId/process
// ─────────────────────────────────────────────────────────

exports.processResults = asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.body.schoolId);
  const { examId } = req.params;
  const { classId } = req.body;

  const result = await computeResults({ examId, classId, schoolId });

  // Update exam status to completed if not already published
  const exam = await Exam.findById(examId).lean();
  if (exam && exam.status === "ongoing") {
    await Exam.findByIdAndUpdate(examId, { status: "completed" });
  }

  console.log(`✅ Results processed: ${result.computed} student(s)`);

  return res.json({
    success:   true,
    processed: result.computed,
    message:   `Results processed for ${result.computed} student(s)`,
    warnings:  result.warnings,
    isPartial: result.isPartial,
    stats:     result.stats,
  });
});

// ─────────────────────────────────────────────────────────
// GET RESULTS
// GET /api/exams/:examId/results
// ─────────────────────────────────────────────────────────

exports.getResults = asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
  const { examId } = req.params;
  const { classId, page = 1, limit = 50 } = req.query;

  const filter = { examId, deletedAt: null };
  if (schoolId) filter.schoolId = schoolId;
  if (classId)  filter.classId  = classId;

  // Non-admins only see published results
  const isAdmin = ["super_admin", "school_admin", "admin"].includes(
    req.user?.role
  );
  if (!isAdmin) filter.isPublished = true;

  const skip    = (Number(page) - 1) * Number(limit);
  const total   = await ExamResult.countDocuments(filter);
  const results = await ExamResult.find(filter)
    .sort({ classPosition: 1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  return res.json({ success: true, results, total });
});