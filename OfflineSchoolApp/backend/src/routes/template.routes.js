// backend/src/routes/template.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const ReportTemplate  = require("../db/models/ReportTemplate");
const GeneratedReport = require("../db/models/GeneratedReport");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) {
    return String(provided).trim();
  }
  return req.user?.schoolId;
};

const scanVariables = (html) => {
  const found = new Set();
  const re    = /\{\{[\w\s./]+\}\}/g;
  let   match;
  while ((match = re.exec(html)) !== null) {
    found.add(match[0].trim());
  }
  return [...found];
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/templates
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  if (!schoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }

  const templates = await ReportTemplate.find({
    schoolId,
    deletedAt: null,
  })
    .sort({ isDefault: -1, updatedAt: -1 })
    .lean();

  return res.json({ success: true, count: templates.length, templates });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/templates/default
// Must be BEFORE /:id
// ─────────────────────────────────────────────────────────────────────────────

router.get("/default", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  if (!schoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }

  const template = await ReportTemplate.findOne({
    schoolId,
    isDefault: true,
    deletedAt: null,
  }).lean();

  if (!template) {
    return res.status(404).json({
      success: false,
      error:   "No default template found for this school",
    });
  }

  return res.json({ success: true, template });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/templates/:id
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const template = await ReportTemplate.findOne({
    _id:      req.params.id,
    schoolId,
    deletedAt: null,
  }).lean();

  if (!template) {
    return res.status(404).json({ success: false, error: "Template not found" });
  }

  return res.json({ success: true, template });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/templates
// ─────────────────────────────────────────────────────────────────────────────

router.post("/", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const { name, html, css, isDefault } = req.body;

  if (!schoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }
  if (!name?.trim()) {
    return res.status(400).json({ success: false, error: "name is required" });
  }
  if (!html?.trim()) {
    return res.status(400).json({ success: false, error: "html is required" });
  }

  if (isDefault) {
    await ReportTemplate.updateMany(
      { schoolId, deletedAt: null },
      { $set: { isDefault: false } }
    );
  }

  const template = await ReportTemplate.create({
    _id:       uuidv4(),
    schoolId,
    name:      name.trim(),
    html,
    css:       css       || "",
    isDefault: !!isDefault,
    version:   1,
    variables: scanVariables(html),
    createdBy: req.user?._id || null,
    updatedBy: req.user?._id || null,
  });

  console.log(`✅ Template created: "${template.name}" [${template._id}]`);

  return res.status(201).json({ success: true, template: template.toObject() });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/templates/:id
// ─────────────────────────────────────────────────────────────────────────────

router.put("/:id", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const { name, html, css, isDefault } = req.body;

  const template = await ReportTemplate.findOne({
    _id:      req.params.id,
    schoolId,
    deletedAt: null,
  });

  if (!template) {
    return res.status(404).json({ success: false, error: "Template not found" });
  }

  if (isDefault && !template.isDefault) {
    await ReportTemplate.updateMany(
      { schoolId, _id: { $ne: template._id }, deletedAt: null },
      { $set: { isDefault: false } }
    );
  }

  if (name !== undefined) template.name      = name.trim();
  if (html !== undefined) {
    template.html      = html;
    template.variables = scanVariables(html);
  }
  if (css       !== undefined) template.css       = css;
  if (isDefault !== undefined) template.isDefault = !!isDefault;

  template.version  += 1;
  template.updatedBy = req.user?._id || null;

  await template.save();

  console.log(
    `✅ Template updated: "${template.name}" v${template.version} [${template._id}]`
  );

  return res.json({ success: true, template: template.toObject() });
}));

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/templates/:id
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/:id", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const template = await ReportTemplate.findOne({
    _id:      req.params.id,
    schoolId,
    deletedAt: null,
  });

  if (!template) {
    return res.status(404).json({ success: false, error: "Template not found" });
  }

  if (template.isDefault) {
    return res.status(400).json({
      success: false,
      error:   "Cannot delete the default template. Set another template as default first.",
    });
  }

  template.deletedAt = new Date();
  await template.save();

  console.log(`🗑️  Template deleted: "${template.name}" [${template._id}]`);

  return res.json({ success: true, message: "Template deleted" });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/templates/:id/preview
// Returns raw HTML with placeholders when no student data is provided.
// Returns filled HTML when examId + studentId are provided.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/preview", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  const { examId, studentId } = req.body;

  const template = await ReportTemplate.findOne({
    _id:      req.params.id,
    schoolId,
    deletedAt: null,
  }).lean();

  if (!template) {
    return res.status(404).json({ success: false, error: "Template not found" });
  }

  // ── Raw layout preview ────────────────────────────────────────────────────
  if (!examId || !studentId) {
    return res.json({
      success:      true,
      isRaw:        true,
      templateName: template.name,
      renderedHtml: `<style>${template.css || ""}</style>${template.html}`,
    });
  }

  // ── Live preview with real student data ───────────────────────────────────
  const StudentScore  = require("../db/models/StudentScore");
  const ResultSummary = require("../db/models/ResultSummary");
  const ExamSubject   = require("../db/models/ExamSubject");
  const Exam          = require("../db/models/Exam");

  const [scores, examSubjects, summary, exam] = await Promise.all([
    StudentScore.find({ examId, studentId, deletedAt: null }).lean(),
    ExamSubject.find({  examId, deletedAt: null            }).lean(),
    ResultSummary.findOne({ examId, studentId }).lean(),
    Exam.findById(examId).lean(),
  ]);

  if (!scores.length && !summary) {
    return res.status(404).json({
      success: false,
      error:   "No result data found for this student in this exam",
    });
  }

  const subjectMap = new Map(
    examSubjects.map((es) => [String(es.subjectId), es])
  );

  const subjects = scores.map((score) => {
    const es      = subjectMap.get(String(score.subjectId)) || {};
    return {
      subjectName: es.subjectName  || String(score.subjectId),
      caScore:     null,
      examScore:   score.score,
      total:       score.score,
      grade:       score.grade    || null,
      remark:      score.remark   || null,
      isPassing:   score.isPassing || false,
      isAbsent:    score.isAbsent  || false,
    };
  });

  const data = {
    student: {
      fullName:        summary?.studentName || "",
      admissionNumber: summary?.admissionNo || "",
      gender:          "",
      dateOfBirth:     null,
      photoBase64:     null,
    },
    school: {
      name:          "",
      motto:         "",
      address:       "",
      phone:         "",
      principalName: "",
      logoBase64:    null,
    },
    className:    summary?.className   || "",
    stream:       "",
    term:         exam?.term           || "",
    academicYear: exam?.academicYear   || "",
    attendance: {
      daysPresent: 0,
      daysAbsent:  0,
      daysOpen:    0,
    },
    performance: {
      average:         summary?.average         || 0,
      position:        summary?.classPosition   || null,
      totalStudents:   summary?.totalInClass    || null,
      grade:           summary?.overallGrade    || "",
      remark:          summary?.overallRemark   || "",
      promotionStatus: summary?.promotionStatus || "",
    },
    subjects,
    classTeacher:     "",
    teacherComment:   summary?.overallRemark || "",
    principalComment: "",
    nextTermDate:     null,
  };

  const { resolvePlaceholders } = require("../engine/placeholder.engine");
  const resolvedHtml = resolvePlaceholders(template.html, data);
  const fullHtml     = `<style>${template.css || ""}</style>${resolvedHtml}`;

  return res.json({
    success:      true,
    isRaw:        false,
    templateName: template.name,
    renderedHtml: fullHtml,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/templates/:id/duplicate
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/duplicate", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);

  const original = await ReportTemplate.findOne({
    _id:      req.params.id,
    schoolId,
    deletedAt: null,
  }).lean();

  if (!original) {
    return res.status(404).json({ success: false, error: "Template not found" });
  }

  const copy = await ReportTemplate.create({
    _id:       uuidv4(),
    schoolId,
    name:      `${original.name} (Copy)`,
    html:      original.html,
    css:       original.css  || "",
    isDefault: false,
    version:   1,
    variables: original.variables || [],
    createdBy: req.user?._id || null,
    updatedBy: req.user?._id || null,
  });

  console.log(`📋 Template duplicated: "${copy.name}" [${copy._id}]`);

  return res.status(201).json({ success: true, template: copy.toObject() });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/templates/:id/default
// ─────────────────────────────────────────────────────────────────────────────

router.patch("/:id/default", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId || req.query.schoolId);

  const template = await ReportTemplate.findOne({
    _id:      req.params.id,
    schoolId,
    deletedAt: null,
  });

  if (!template) {
    return res.status(404).json({ success: false, error: "Template not found" });
  }

  await ReportTemplate.updateMany(
    { schoolId, deletedAt: null },
    { $set: { isDefault: false } }
  );

  template.isDefault = true;
  await template.save();

  console.log(`⭐ Default template set: "${template.name}" [${template._id}]`);

  return res.json({ success: true, message: "Default template updated" });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/templates/:id/generated
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/generated", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const reports = await GeneratedReport.find({
    templateId: req.params.id,
    schoolId,
    deletedAt:  null,
  })
    .sort({ createdAt: -1 })
    .lean();

  return res.json({ success: true, count: reports.length, reports });
}));

module.exports = router;