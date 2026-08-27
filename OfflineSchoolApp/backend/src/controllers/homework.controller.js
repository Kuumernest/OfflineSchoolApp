"use strict";

const Homework = require("../db/models/Homework");
const { z } = require("zod");

// homework.manage defaults to TEACHING_ROLES, which is exactly what this
// predicate spelled out by hand — including "admin", a string no account can
// hold. The bursar is not in it: setting homework is not a finance job.
//
// Now async, because a capability can be adjusted per school and that means
// reading the school. Every caller was already inside an async handler, so the
// only change at the call sites is an await.
const permissions = require("../services/permissions.service");

const assertManager = async (req) => {
  if (!(await permissions.can(req.user, "homework.manage"))) {
    const err = new Error("Only teachers and administrators can manage homework");
    err.statusCode = 403;
    throw err;
  }
};
const schoolIdFor = (req, supplied) =>
  String(req.user?.role === "super_admin" && supplied ? supplied : req.user?.schoolId || supplied || "");

const bodyToDocument = (body, schoolId) => ({
  _id: body.id || body._id,
  schoolId,
  classId: body.classId || body.class_id,
  subjectId: body.subjectId || body.subject_id,
  createdBy: body.createdBy || body.created_by,
  title: body.title,
  description: body.description ?? null,
  instructions: body.instructions ?? null,
  dueDate: body.dueDate || body.due_date || null,
  maxScore: body.maxScore ?? body.max_score ?? 100,
  allowLate: body.allowLate ?? body.allow_late ?? true,
  latePenalty: body.latePenalty ?? body.late_penalty ?? 0,
  attachmentUrl: body.attachmentUrl || body.attachment_url || null,
  attachmentName: body.attachmentName || body.attachment_name || null,
  attachmentType: body.attachmentType || body.attachment_type || null,
  isPublished: body.isPublished ?? body.is_published ?? false,
});

const homeworkInput = z.object({
  id: z.string().min(1).max(100).optional(),
  schoolId: z.string().min(1).max(100).optional(),
  classId: z.string().min(1).max(100).optional(),
  class_id: z.string().min(1).max(100).optional(),
  subjectId: z.string().min(1).max(100).optional(),
  subject_id: z.string().min(1).max(100).optional(),
  createdBy: z.string().min(1).max(100).optional(),
  created_by: z.string().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(250),
  description: z.string().max(10000).nullable().optional(),
  instructions: z.string().max(10000).nullable().optional(),
  dueDate: z.string().max(50).nullable().optional(),
  due_date: z.string().max(50).nullable().optional(),
  maxScore: z.number().finite().min(0).max(100000).optional(),
  max_score: z.number().finite().min(0).max(100000).optional(),
  allowLate: z.boolean().optional(), allow_late: z.boolean().optional(),
  latePenalty: z.number().finite().min(0).max(100).optional(),
  late_penalty: z.number().finite().min(0).max(100).optional(),
  attachmentUrl: z.string().url().nullable().optional(),
  attachment_url: z.string().url().nullable().optional(),
  attachmentName: z.string().max(255).nullable().optional(),
  attachment_name: z.string().max(255).nullable().optional(),
  attachmentType: z.string().max(100).nullable().optional(),
  attachment_type: z.string().max(100).nullable().optional(),
  isPublished: z.boolean().optional(), is_published: z.boolean().optional(),
  version: z.number().int().positive().optional(),
}).strict();

exports.list = async (req, res, next) => {
  try {
    const schoolId = schoolIdFor(req, req.query.schoolId);
    const query = { schoolId, deletedAt: null };
    if (req.query.classId) query.classId = req.query.classId;
    if (req.query.subjectId) query.subjectId = req.query.subjectId;
    const homework = await Homework.find(query).sort({ dueDate: 1, createdAt: -1 }).lean();
    return res.json({ success: true, homework });
  } catch (err) { return next(err); }
};

exports.upsert = async (req, res, next) => {
  try {
    await assertManager(req);
    const parsed = homeworkInput.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ success: false, error: "Invalid homework", details: parsed.error.issues });
    req.body = parsed.data;
    const data = bodyToDocument(req.body, schoolIdFor(req, req.body.schoolId));
    if (req.user.role === "teacher" && data.createdBy !== String(req.user._id || req.user.id)) {
      return res.status(403).json({ message: "Teachers may create homework only for themselves" });
    }
    if (!data.schoolId || !data.classId || !data.subjectId || !data.createdBy || !data.title) {
      return res.status(400).json({ message: "schoolId, classId, subjectId, createdBy and title are required" });
    }
    const id = data._id;
    delete data._id;
    let homework;
    if (id) {
      const current = await Homework.findOne({ _id: id, schoolId: data.schoolId }).lean();
      if (current && req.user.role === "teacher" && current.createdBy !== String(req.user._id || req.user.id)) {
        return res.status(403).json({ message: "You do not own this homework" });
      }
      if (current && req.get("If-Match") && String(current.version) !== String(req.get("If-Match"))) {
        return res.status(412).json({ success: false, code: "VERSION_CONFLICT", current });
      }
      homework = await Homework.findOneAndUpdate(
        { _id: id, schoolId: data.schoolId },
        { $set: { ...data, deletedAt: null }, $inc: { version: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    } else {
      homework = await Homework.create({ ...data, version: 1 });
      homework = homework.toObject();
    }
    return res.status(201).json({ success: true, homework });
  } catch (err) { return next(err); }
};

exports.remove = async (req, res, next) => {
  try {
    await assertManager(req);
    const existing = await Homework.findOne({ _id: req.params.id, schoolId: schoolIdFor(req, req.query.schoolId || req.body.schoolId) }).lean();
    if (existing && req.user.role === "teacher" && existing.createdBy !== String(req.user._id || req.user.id)) {
      return res.status(403).json({ message: "You do not own this homework" });
    }
    if (existing && req.get("If-Match") && String(existing.version) !== String(req.get("If-Match"))) {
      return res.status(412).json({ success: false, code: "VERSION_CONFLICT", current: existing });
    }
    const homework = await Homework.findOneAndUpdate(
      { _id: req.params.id, schoolId: schoolIdFor(req, req.query.schoolId || req.body.schoolId) },
      { $set: { deletedAt: new Date() }, $inc: { version: 1 } },
      { new: true }
    ).lean();
    if (!homework) return res.status(404).json({ message: "Homework not found" });
    return res.json({ success: true, homework });
  } catch (err) { return next(err); }
};

exports.submit = async (req, res, next) => {
  try {
    if (req.user?.role !== "student") return res.status(403).json({ message: "Only students can submit homework" });
    const input = z.object({ text: z.string().max(10000).nullable().optional(), attachmentUrl: z.string().url().nullable().optional() }).strict().safeParse(req.body);
    if (!input.success) return res.status(422).json({ success: false, error: "Invalid submission", details: input.error.issues });
    const studentId = String(req.user._id || req.user.id);
    const homework = await Homework.findOneAndUpdate(
      { _id: req.params.id, schoolId: schoolIdFor(req, req.body.schoolId), deletedAt: null },
      { $pull: { submissions: { studentId } } },
      { new: true }
    );
    if (!homework) return res.status(404).json({ message: "Homework not found" });
    homework.submissions.push({ studentId, text: input.data.text ?? null, attachmentUrl: input.data.attachmentUrl ?? null });
    homework.version += 1;
    await homework.save();
    return res.status(201).json({ success: true, submission: homework.submissions.at(-1), version: homework.version });
  } catch (err) { return next(err); }
};

exports.grade = async (req, res, next) => {
  try {
    await assertManager(req);
    const input = z.object({ score: z.number().finite().min(0), feedback: z.string().max(5000).nullable().optional() }).strict().safeParse(req.body);
    if (!input.success) return res.status(422).json({ success: false, error: "Invalid grade", details: input.error.issues });
    const homework = await Homework.findOne({ _id: req.params.id, schoolId: schoolIdFor(req, req.body.schoolId), deletedAt: null });
    if (!homework) return res.status(404).json({ message: "Homework not found" });
    if (req.user.role === "teacher" && homework.createdBy !== String(req.user._id || req.user.id)) return res.status(403).json({ message: "You do not own this homework" });
    const submission = homework.submissions.id(req.params.submissionId);
    if (!submission) return res.status(404).json({ message: "Submission not found" });
    if (input.data.score > homework.maxScore) return res.status(422).json({ message: "Score cannot exceed maxScore" });
    submission.score = input.data.score;
    submission.feedback = input.data.feedback ?? null;
    submission.gradedBy = String(req.user._id || req.user.id);
    submission.gradedAt = new Date();
    homework.version += 1;
    await homework.save();
    return res.json({ success: true, submission, version: homework.version });
  } catch (err) { return next(err); }
};
