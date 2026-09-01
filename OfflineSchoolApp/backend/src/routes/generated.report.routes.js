// backend/src/routes/generated-reports.routes.js
"use strict";

const express         = require("express");
const router          = express.Router();
const { v4: uuidv4 }  = require("uuid");
const GeneratedReport = require("../db/models/GeneratedReport");

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

const { requirePermission } = require("../../middleware/permissions");

/**
 * The frozen copies of issued report cards.
 *
 * Third router found with no authorisation at all. What is stored here is the
 * rendered card a parent may already be holding, so writing it is an admin
 * act: replacing one silently supersedes a document already in circulation.
 *
 * Reads stay open to teachers, who legitimately look up what a class was
 * issued. Guardians and students do not come through here at all — they read
 * their own cards through /api/portal and /api/students, which scope to the
 * child from the token rather than from a parameter.
 */
const readReports  = requirePermission("reports.viewIssued");
const writeReports = requirePermission("reports.manage");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) {
    return String(provided).trim();
  }
  return req.user?.schoolId;
};

// ─────────────────────────────────────────────────────────
// POST /api/generated-reports
// Called by the device after generating a PDF.
// Stores the frozen rendered HTML and variable payload.
// Upserts on examId + studentId so re-generation updates
// the existing record rather than creating a duplicate.
// ─────────────────────────────────────────────────────────

router.post("/", writeReports, asyncHandler(async (req, res) => {
  const {
    studentId,
    examId,
    templateId,
    templateVersion,
    renderedHtml,
    variablePayload,
    term,
    academicYear,
    schoolId: bodySchoolId,
    pdfPath,
  } = req.body;

  if (!studentId) {
    return res.status(400).json({
      success: false,
      error:   "studentId is required",
    });
  }

  const resolvedSchoolId = resolveSchoolId(req, bodySchoolId);

  if (!resolvedSchoolId) {
    return res.status(400).json({
      success: false,
      error:   "schoolId is required",
    });
  }

  // Upsert — one record per student per exam
  const filter = examId
    ? { examId, studentId }
    : { studentId, term, academicYear, schoolId: resolvedSchoolId };

  const update = {
    $set: {
      schoolId:        resolvedSchoolId,
      examId:          examId          || null,
      templateId:      templateId      || null,
      templateVersion: templateVersion || 1,
      renderedHtml:    renderedHtml    || "",
      variablePayload: variablePayload || {},
      pdfPath:         pdfPath         || null,
      term:            term            || null,
      academicYear:    academicYear    || null,
      generatedBy:     req.user?._id   || null,
    },
    $setOnInsert: {
      _id:         uuidv4(),
      isPublished: false,
      deletedAt:   null,
    },
  };

  const report = await GeneratedReport.findOneAndUpdate(
    filter,
    update,
    { upsert: true, returnDocument: 'after' }
  ).lean();

  console.log(
    `📄 GeneratedReport saved: student=${studentId}`,
    `template=${templateId} v${templateVersion}`
  );

  return res.status(201).json({
    success:  true,
    reportId: report._id,
    report,
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/generated-reports
// List generated reports for a school.
// Supports filtering by examId, studentId, term, academicYear.
// Does NOT return renderedHtml or variablePayload in the list
// (too large — fetch individual record for those).
// ─────────────────────────────────────────────────────────

router.get("/", readReports, asyncHandler(async (req, res) => {
  const {
    examId,
    studentId,
    term,
    academicYear,
    isPublished,
    page  = 1,
    limit = 50,
    schoolId: qSchoolId,
  } = req.query;

  const schoolId = resolveSchoolId(req, qSchoolId);

  if (!schoolId) {
    return res.status(400).json({
      success: false,
      error:   "schoolId is required",
    });
  }

  const filter = { schoolId, deletedAt: null };
  if (examId)       filter.examId       = examId;
  if (studentId)    filter.studentId    = studentId;
  if (term)         filter.term         = term;
  if (academicYear) filter.academicYear = academicYear;
  if (isPublished !== undefined) {
    filter.isPublished = isPublished === "true";
  }

  const skip  = (Number(page) - 1) * Number(limit);
  const total = await GeneratedReport.countDocuments(filter);

  const reports = await GeneratedReport.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit))
    // Exclude large fields from list view
    .select("-renderedHtml -variablePayload")
    .lean();

  return res.json({
    success: true,
    total,
    page:    Number(page),
    pages:   Math.ceil(total / Number(limit)),
    count:   reports.length,
    reports,
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/generated-reports/:id
// Get a single generated report including the frozen HTML.
// ─────────────────────────────────────────────────────────

router.get("/:id", readReports, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const report = await GeneratedReport.findOne({
    _id:      req.params.id,
    ...(schoolId ? { schoolId } : {}),
    deletedAt: null,
  }).lean();

  if (!report) {
    return res.status(404).json({
      success: false,
      error:   "Generated report not found",
    });
  }

  return res.json({ success: true, report });
}));

// ─────────────────────────────────────────────────────────
// PUT /api/generated-reports/:id
// Update a generated report (e.g. publish it).
// ─────────────────────────────────────────────────────────

router.put("/:id", writeReports, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const { isPublished } = req.body;

  const updates = {};
  if (isPublished !== undefined) {
    updates.isPublished = Boolean(isPublished);
    updates.publishedAt = isPublished ? new Date() : null;
  }

  const report = await GeneratedReport.findOneAndUpdate(
    {
      _id:      req.params.id,
      ...(schoolId ? { schoolId } : {}),
    },
    { $set: updates },
    { returnDocument: 'after' }
  ).lean();

  if (!report) {
    return res.status(404).json({
      success: false,
      error:   "Generated report not found",
    });
  }

  return res.json({ success: true, report });
}));

// ─────────────────────────────────────────────────────────
// DELETE /api/generated-reports/:id
// Soft delete a generated report.
// ─────────────────────────────────────────────────────────

router.delete("/:id", writeReports, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const report = await GeneratedReport.findOneAndUpdate(
    {
      _id:      req.params.id,
      ...(schoolId ? { schoolId } : {}),
      deletedAt: null,
    },
    { $set: { deletedAt: new Date() } },
    { returnDocument: 'after' }
  ).lean();

  if (!report) {
    return res.status(404).json({
      success: false,
      error:   "Generated report not found",
    });
  }

  console.log(`🗑️ GeneratedReport deleted: ${report._id}`);
  return res.json({ success: true, message: "Report deleted" });
}));

// ─────────────────────────────────────────────────────────
// GET /api/generated-reports/student/:studentId
// All reports for a specific student.
// ─────────────────────────────────────────────────────────

router.get("/student/:studentId", readReports, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { studentId } = req.params;
  const { academicYear, term } = req.query;

  const filter = {
    studentId,
    deletedAt: null,
    ...(schoolId    ? { schoolId }    : {}),
    ...(academicYear ? { academicYear } : {}),
    ...(term         ? { term }         : {}),
  };

  const reports = await GeneratedReport.find(filter)
    .sort({ createdAt: -1 })
    .select("-renderedHtml -variablePayload")
    .lean();

  return res.json({
    success: true,
    count:   reports.length,
    reports,
  });
}));

// ─────────────────────────────────────────────────────────
// GET /api/generated-reports/exam/:examId
// All reports for a specific exam.
// ─────────────────────────────────────────────────────────

router.get("/exam/:examId", readReports, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId } = req.params;

  const filter = {
    examId,
    deletedAt: null,
    ...(schoolId ? { schoolId } : {}),
  };

  const reports = await GeneratedReport.find(filter)
    .sort({ createdAt: -1 })
    .select("-renderedHtml -variablePayload")
    .lean();

  return res.json({
    success: true,
    count:   reports.length,
    reports,
  });
}));

module.exports = router;