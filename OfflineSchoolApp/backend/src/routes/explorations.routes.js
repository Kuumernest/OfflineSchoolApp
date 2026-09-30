// backend/src/routes/explorations.routes.js
"use strict";

/**
 * The exploration catalog and a pupil's moves through an exploration.
 *
 * ── Who may do what ───────────────────────────────────────────────────────
 *
 * The catalog is readable by anyone signed in with a teaching capability or
 * as a pupil: it carries no pupil. A pupil acts on their own explorations
 * (start, submit, skip, abandon, reflect); staff who may read the pupil act
 * on theirs too (a teacher can start an activity with a class), and only
 * staff record an observation or rate a performance. The bursar holds no
 * teaching capability and reaches none of it.
 *
 * Every write here accepts the client's id or is a state move that is a
 * no-op when already made, so the offline queue's retries are safe.
 *
 * Mounted at /api/explorations behind authenticate.
 */

const express = require("express");
const router  = express.Router();

const { requirePermission } = require("../../middleware/permissions");
const { ROLES }             = require("../config/roles");
const { teacherAssigned }   = require("../utils/teacherScope");
const Student               = require("../db/models/Student");
const TeacherAssignment     = require("../db/models/TeacherAssignment");
const StudentExploration    = require("../db/models/StudentExploration");
const exploration           = require("../services/intelligence/exploration.service");
const { resolveSchoolId }   = require("../utils/tenant");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isStudent = (req) => req.user?.role === ROLES.STUDENT;
const isTeacher = (req) => req.user?.role === ROLES.TEACHER;
const actorOf   = (req) => String(req.user._id ?? req.user.id);
const langOf    = (req) => (String(req.query.lang ?? req.headers["accept-language"] ?? "en").toLowerCase().startsWith("fr") ? "fr" : "en");

/** Staff on the teaching capability; a pupil by role, limited to their own rows below. */
const read = (req, res, next) => (isStudent(req) ? next() : requirePermission("insights.viewTaught")(req, res, next));
const staffOnly = requirePermission("insights.viewTaught");

const svcError = (res, err) => {
  if (!err.status) throw err;
  const { status, code, message, ...extra } = err;
  return res.status(status).json({ success: false, code, message, ...extra });
};

/** May this caller act on this exploration? A pupil: own rows. A teacher: pupils in their classes. */
const mayTouch = async (req, res, e) => {
  if (isStudent(req)) {
    const own = await Student.findOne({ _id: e.studentId, schoolId: e.schoolId, userId: actorOf(req), deletedAt: null }).select("_id").lean();
    if (!own) { res.status(403).json({ success: false, code: "OWN_EXPLORATIONS_ONLY", message: "A student acts on their own explorations." }); return false; }
    return true;
  }
  if (isTeacher(req)) {
    const ok = await teacherAssigned(TeacherAssignment, { teacherId: actorOf(req), schoolId: e.schoolId, classId: e.classId, subjectId: null });
    if (!ok) { res.status(403).json({ success: false, code: "CLASS_NOT_ASSIGNED", message: "You may only see explorations for the classes you teach." }); return false; }
  }
  return true;
};

const loadFor = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) { res.status(400).json({ success: false, message: "schoolId is required" }); return null; }
  const e = await StudentExploration.findOne({ _id: String(req.params.id), schoolId, deletedAt: null }).lean();
  if (!e) { res.status(404).json({ success: false, code: "EXPLORATION_NOT_FOUND", message: "No such exploration" }); return null; }
  if (!(await mayTouch(req, res, e))) return null;
  return { schoolId, e };
};

/** GET /api/explorations/activities?area=&level=&resources=a,b&lang= */
router.get("/activities", read, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId) || null;
  const resources = req.query.resources ? String(req.query.resources).split(",").filter(Boolean) : null;
  const rows = await exploration.catalog({ schoolId, lang: langOf(req), area: req.query.area ? String(req.query.area) : null, level: req.query.level ? String(req.query.level) : null, resources });
  return res.json({ success: true, data: { activities: rows, count: rows.length } });
}));

/** GET /api/explorations/activities/:activityId */
router.get("/activities/:activityId", read, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId) || null;
  const a = await exploration.activityById({ schoolId, activityId: String(req.params.activityId) });
  if (!a) return res.status(404).json({ success: false, code: "ACTIVITY_NOT_FOUND", message: "No such activity" });
  const { localize } = require("../../../shared/exploration");
  return res.json({ success: true, data: localize(a, langOf(req)) });
}));

/** POST /api/explorations/:id/start | /skip | /not-interested | /abandon  { version? } */
for (const [path, fn] of [
  ["start",          (a) => exploration.start(a)],
  ["skip",           (a) => exploration.skip(a)],
  ["not-interested", (a) => exploration.skip({ ...a, notInterested: true })],
  ["abandon",        (a) => exploration.abandon(a)],
]) {
  router.post(`/:id/${path}`, read, asyncHandler(async (req, res) => {
    const ctx = await loadFor(req, res);
    if (!ctx) return undefined;
    try {
      const e = await fn({ schoolId: ctx.schoolId, explorationId: ctx.e._id, actor: actorOf(req), version: req.body?.version });
      return res.json({ success: true, data: e });
    } catch (err) { return svcError(res, err); }
  }));
}

/** POST /api/explorations/:id/submit  { outputs:[{label,value}], completionMode?, reflection?, version? } */
router.post("/:id/submit", read, asyncHandler(async (req, res) => {
  const ctx = await loadFor(req, res);
  if (!ctx) return undefined;
  try {
    const e = await exploration.submit({ schoolId: ctx.schoolId, explorationId: ctx.e._id, actor: actorOf(req), body: req.body ?? {} });
    return res.json({ success: true, data: e });
  } catch (err) { return svcError(res, err); }
}));

/** POST /api/explorations/:id/reflection — the pupil's own account; a pupil only. */
router.post("/:id/reflection", read, asyncHandler(async (req, res) => {
  if (!isStudent(req)) return res.status(403).json({ success: false, code: "STUDENT_ONLY", message: "A reflection is written by the student." });
  const ctx = await loadFor(req, res);
  if (!ctx) return undefined;
  try {
    const r = await exploration.reflect({ schoolId: ctx.schoolId, explorationId: ctx.e._id, actor: actorOf(req), body: req.body ?? {} });
    return res.status(201).json({ success: true, data: r });
  } catch (err) { return svcError(res, err); }
}));

/** POST /api/explorations/:id/observation — a teacher's observation of the activity. */
router.post("/:id/observation", staffOnly, asyncHandler(async (req, res) => {
  const ctx = await loadFor(req, res);
  if (!ctx) return undefined;
  try {
    const o = await exploration.observe({ schoolId: ctx.schoolId, explorationId: ctx.e._id, actor: actorOf(req), body: req.body ?? {} });
    return res.status(201).json({ success: true, data: o });
  } catch (err) { return svcError(res, err); }
}));

/** POST /api/explorations/:id/performance — a teacher rates the output against the activity's criteria. */
router.post("/:id/performance", staffOnly, asyncHandler(async (req, res) => {
  const ctx = await loadFor(req, res);
  if (!ctx) return undefined;
  try {
    const e = await exploration.ratePerformance({ schoolId: ctx.schoolId, explorationId: ctx.e._id, actor: actorOf(req), body: req.body ?? {} });
    return res.json({ success: true, data: e });
  } catch (err) { return svcError(res, err); }
}));

module.exports = router;
