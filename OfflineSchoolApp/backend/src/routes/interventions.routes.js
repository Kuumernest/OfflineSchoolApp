// backend/src/routes/interventions.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { requireAnyPermission } = require("../../middleware/permissions");
const { ROLES }           = require("../config/roles");
const { teacherAssigned } = require("../utils/teacherScope");

const Student           = require("../db/models/Student");
const User              = require("../db/models/User");
const Intervention      = require("../db/models/Intervention");
const TeacherAssignment = require("../db/models/TeacherAssignment");
const { transition }    = require("../services/intervention.service");
const interventionOutcome =
  require("../services/intelligence/interventionOutcome.service");

/**
 * Support actions: the one thing in the intelligence stack a human writes.
 *
 * ── Which pupils, and by whose rule ───────────────────────────────────────
 *
 * The classes a teacher holds an active assignment for, asked through
 * utils/teacherScope.js — the same function the register, the mark sheet,
 * homework and the insights router already ask. There is no second
 * authorisation model here and there must not be.
 *
 * `subjectId: null` asks teacherScope's CLASS-level question, which a subject
 * teacher satisfies: a teacher of Mathematics in 3A holds an assignment in 3A.
 * A form master and a subject teacher can both record that they supported a
 * child, which is how schools actually work.
 *
 * ── Why the bursar is nowhere in this file ────────────────────────────────
 *
 * None of the four interventions.* capabilities include FINANCE_ROLES, so the
 * bursar holds none of them and every route here answers 403. That is
 * deliberate: a support note says a named child was struggling and what was
 * done about it, which is staffroom and office knowledge, not the fee counter's.
 * The module reaches no financial service either, so the boundary is structural
 * rather than a filter — scripts/check-interventions.js asserts both.
 *
 * ── Errors from the lifecycle ─────────────────────────────────────────────
 *
 * services/intervention.service.js sets `err.status`, which is this repository's
 * convention, and middleware/errorHandler.js reads `err.statusCode`. A router
 * that forwards one to next() therefore answers 500 for what is a perfectly
 * ordinary 409 — an offline device sending a move the record has already moved
 * past. So the transition is translated here, as gate, documents and approvals
 * each do for their own services.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** Reading: the office school-wide, a teacher for their own classes. */
const read = requireAnyPermission("interventions.view", "interventions.viewTaught");

/** Writing: a teacher for their own classes, the office anywhere in its school. */
const write = requireAnyPermission("interventions.create", "interventions.manage");

const schoolOf = (req) => req.user.schoolId;

/**
 * May this caller act on a record in this class?
 *
 * Everyone who got past the capability guard may, except a teacher, who must
 * hold an assignment in the class.
 */
const mayReachClass = async (req, schoolId, classId) => {
  if (req.user.role !== ROLES.TEACHER) return true;
  if (!classId) return false;
  return teacherAssigned(TeacherAssignment, {
    teacherId: String(req.user._id ?? req.user.id),
    schoolId,
    classId,
    subjectId: null,
  });
};

const forbidden = (res) => res.status(403).json({
  success: false,
  code:    "CLASS_NOT_ASSIGNED",
  message: "You may only record support for the classes you teach.",
});

/**
 * An intervention may be handed to a colleague, and only to a colleague.
 *
 * A teacher of this school, checked against the roster rather than trusted from
 * the body: without it, an id from another school lands in `assignedTo` and
 * that school's staff appear on a workload they have never heard of.
 */
const validAssignee = async (schoolId, assignedTo) => {
  if (!assignedTo) return true;
  return Boolean(await User.exists({
    _id: String(assignedTo), schoolId, role: ROLES.TEACHER,
  }));
};

/** The pupil, in the caller's school only. 404 rather than 403 across schools. */
const pupilInSchool = (studentId, schoolId) =>
  Student.findOne({ _id: String(studentId), schoolId, deletedAt: null })
    .select("classId").lean();

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/interventions
 *
 * Record that somebody decided to act. Accepts a client-chosen `_id`, because
 * an offline device wrote the row locally before it had a connection.
 */
router.post("/", write, asyncHandler(async (req, res) => {
  const schoolId = schoolOf(req);

  const student = await pupilInSchool(req.body.studentId, schoolId);
  if (!student) {
    return res.status(404).json({ success: false, message: "Student not found" });
  }
  if (!(await mayReachClass(req, schoolId, String(student.classId)))) return forbidden(res);

  // An action is the whole point of the record; and one that claims to come
  // from guidance has to say WHICH guidance, or the link back to the evidence
  // is a claim nobody can check.
  if (!req.body.actionCode ||
      (req.body.sourceType === "guidance" && !req.body.sourceCode)) {
    return res.status(400).json({ success: false, code: "INVALID_INTERVENTION" });
  }
  if (!(await validAssignee(schoolId, req.body.assignedTo))) {
    return res.status(400).json({ success: false, code: "INVALID_ASSIGNEE" });
  }

  const actor       = String(req.user._id ?? req.user.id);
  const requestedId = req.body._id ? String(req.body._id) : null;

  /*
   * The replay, which is the ordinary case and not the rare one.
   *
   * A connection dropped after the server wrote the row and before the reply
   * arrived leaves the device holding an unsent request it will send again.
   * Answering the row that already exists — rather than writing a second one,
   * or erroring — is what keeps one decision from becoming two records about
   * the same child. Deliberately does NOT apply the resent body: the stored row
   * is the one the school has been working from.
   */
  const existing = requestedId
    ? await Intervention.findOne({ _id: requestedId, schoolId })
    : null;
  if (existing) return res.status(201).json({ success: true, data: existing });

  const item = await Intervention.create({
    _id:        requestedId ?? undefined,
    schoolId,
    studentId:  String(student._id),
    classId:    String(student.classId),
    createdBy:  actor,
    updatedBy:  actor,
    assignedTo: req.body.assignedTo ?? null,
    sourceType: req.body.sourceType ?? "other",
    sourceCode: req.body.sourceCode ?? null,
    actionCode: req.body.actionCode,
    // Which subject, when the guidance that prompted this named one. Null is a
    // real answer and the outcome comparison handles it — see the model.
    subjectId:  req.body.subjectId ?? null,
    notes:      req.body.notes ?? null,
  });

  return res.status(201).json({ success: true, data: item });
}));

/**
 * GET /api/interventions/student/:studentId
 *
 * What has been done, and is being done, for one pupil. Newest first.
 */
router.get("/student/:studentId", read, asyncHandler(async (req, res) => {
  const schoolId = schoolOf(req);

  const student = await pupilInSchool(req.params.studentId, schoolId);
  if (!student) {
    return res.status(404).json({ success: false, message: "Student not found" });
  }
  if (!(await mayReachClass(req, schoolId, String(student.classId)))) return forbidden(res);

  return res.json({
    success: true,
    data: await Intervention.find({
      schoolId, studentId: String(student._id), deletedAt: null,
    }).sort({ updatedAt: -1 }).lean(),
  });
}));

/**
 * GET /api/interventions/:id/evidence
 *
 * What the subject's marks looked like before this action started, and what
 * they look like now. An OBSERVATION, never a verdict: see the header of
 * services/intelligence/interventionOutcome.service.js for why the difference
 * matters and why nothing here is stored.
 */
router.get("/:id/evidence", read, asyncHandler(async (req, res) => {
  const schoolId = schoolOf(req);

  const item = await Intervention.findOne({
    _id: String(req.params.id), schoolId, deletedAt: null,
  }).lean();
  if (!item) {
    return res.status(404).json({ success: false, message: "Intervention not found" });
  }
  if (!(await mayReachClass(req, schoolId, item.classId))) return forbidden(res);

  return res.json({ success: true, data: await interventionOutcome.compare(item) });
}));

/**
 * PATCH /api/interventions/:id
 *
 * Move it along, reassign it, or record what happened.
 *
 * No DELETE route. The schema is soft-delete capable and nothing exposes it:
 * an abandoned intervention is `cancelled`, which keeps "we decided not to" in
 * the record instead of erasing that the school ever looked at the child.
 */
router.patch("/:id", write, asyncHandler(async (req, res) => {
  const schoolId = schoolOf(req);

  const item = await Intervention.findOne({
    _id: String(req.params.id), schoolId, deletedAt: null,
  });
  if (!item) {
    return res.status(404).json({ success: false, message: "Intervention not found" });
  }
  if (!(await mayReachClass(req, schoolId, item.classId))) return forbidden(res);

  /*
   * Two devices, one row. The stale edit is REFUSED and handed the current row
   * to resolve against, rather than being applied over the top — the same
   * explicit-conflict choice the rest of this application makes, because the
   * alternative is a teacher's note vanishing with nothing to say it did.
   */
  if (req.body.version !== undefined && Number(req.body.version) !== item.version) {
    return res.status(409).json({ success: false, code: "VERSION_CONFLICT", data: item });
  }
  if ("assignedTo" in req.body &&
      !(await validAssignee(schoolId, req.body.assignedTo))) {
    return res.status(400).json({ success: false, code: "INVALID_ASSIGNEE" });
  }

  const actor = String(req.user._id ?? req.user.id);

  if (req.body.status) {
    try {
      transition(item, req.body.status, actor);
    } catch (err) {
      // See the header: the service speaks `status`, the global handler reads
      // `statusCode`, so an unanswered throw here becomes a 500 for what is an
      // ordinary stale resend.
      if (err.message !== "INVALID_INTERVENTION_TRANSITION") throw err;
      return res.status(409).json({
        success: false,
        code:    "INVALID_INTERVENTION_TRANSITION",
        message: `An intervention that is ${item.status} cannot become ${req.body.status}.`,
        data:    item,
      });
    }
  }

  for (const key of ["assignedTo", "notes", "outcomeCode", "outcomeNotes"]) {
    if (key in req.body) item[key] = req.body[key];
  }

  item.updatedBy = actor;
  item.version  += 1;
  await item.save();

  return res.json({ success: true, data: item });
}));

module.exports = router;
