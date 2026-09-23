// backend/src/routes/insights.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { requirePermission, requireAnyPermission } = require("../../middleware/permissions");
const { ROLES }           = require("../config/roles");
const { teacherAssigned } = require("../utils/teacherScope");
const { displayName, byName } = require("../utils/studentName");

const Student           = require("../db/models/Student");
const Class             = require("../db/models/Class");
const Intervention      = require("../db/models/Intervention");
const TeacherAssignment = require("../db/models/TeacherAssignment");

const earlyWarning    = require("../services/earlyWarning.service");
const subjectInsights = require("../services/intelligence/subjectInsights.service");
const guidance        = require("../services/intelligence/guidance.service");
const { TRANSITIONS } = require("../services/intervention.service");

/**
 * Cross-cutting reads over data other modules write.
 *
 * Nothing here has a write route and nothing here owns a collection: this
 * router exists to answer questions that span attendance, results, homework
 * and fees at once — the questions a head teacher actually asks.
 *
 * ── Two audiences, two capabilities, two payloads ─────────────────────────
 *
 * The watch list is the office's. It names children by fee arrears, which is
 * bursar knowledge, and it stays on insights.view with teachers excluded.
 *
 * The subject routes are the staffroom's. They answer "what has been happening
 * to this pupil, subject by subject" out of published marks alone, and they are
 * reachable on insights.viewTaught as well. They carry no money — not filtered
 * out at the edge, but absent by construction: subjectInsights.service.js does
 * not require fees.service and scripts/check-intelligence.js fails if it ever
 * starts to.
 *
 * ── Which pupils a teacher gets ───────────────────────────────────────────
 *
 * The classes they hold an active assignment for, asked through
 * utils/teacherScope.js — the same function the register, the mark sheet and
 * homework already ask, so there is no second authorisation model to keep in
 * step. That is narrower than this platform's READ policy for marks, which is
 * school-wide for teachers (docs/20 §7b, and scripts/check-teacher-read-scope.js
 * pins it). The narrower rule is deliberate for a new surface: an intelligence
 * profile is a pupil-centric record like the roster, which students.viewTaught
 * already scopes this way, and widening a boundary later is a decision somebody
 * can take while narrowing one is a regression somebody has to discover.
 *
 * What is NOT narrowed is which subjects appear in that profile. A pupil's
 * whole subject picture is shown to a teacher who may see the pupil, because
 * the same teacher can already read every published mark in the school and
 * hiding half the picture would protect nothing while making the profile
 * useless to a form master.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

const isTeacher = (req) => req.user?.role === ROLES.TEACHER;

/**
 * What "open" means, taken from the lifecycle rather than redefined.
 *
 * planned and active are the two states somebody still has work to do in;
 * completed and cancelled are finished. Derived from the state machine's own
 * table so that a fifth state, if one is ever added, cannot be silently left
 * out of a teacher's list.
 */
const OPEN_STATUSES = Object.entries(TRANSITIONS)
  .filter(([, next]) => next.length > 0)
  .map(([status]) => status);

/**
 * One guidance item, trimmed for a list of forty pupils.
 *
 * Keeps what tells a teacher which child to open — the area, the reason, how
 * loudly it is said — and drops the evidence and the suggested actions, which
 * are what the pupil route exists to show.
 */
const guidanceSummary = (item) => ({
  type:          item.type,
  priority:      item.priority,
  subjectId:     item.subjectId ?? null,
  subjectName:   item.subjectName ?? null,
  rationaleCode: item.rationaleCode,
  confidence:    item.confidence,
});

/**
 * May this caller see pupils in this class?
 *
 * Everyone who reached the guard may, except a teacher, who must hold an
 * assignment in the class. `subjectId: null` asks teacherScope's CLASS-level
 * question, which a subject teacher satisfies — a teacher of Mathematics in 3A
 * holds an assignment in 3A.
 */
const mayReadClass = async (req, { schoolId, classId }) => {
  if (!isTeacher(req)) return true;
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
  message: "You may only see intelligence for the classes you teach.",
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OFFICE'S LIST — unchanged, and still office-only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/insights/early-warning?days=30
 *
 * The watch list: students whose attendance, results, homework or fee record
 * says something is going wrong, each with the reasons spelled out.
 *
 * insights.view defaults to OFFICE_ROLES rather than ADMIN_ROLES, because the
 * bursar is precisely who that sentence was describing. Read-only either way:
 * this router owns no collection and has no write route.
 */
router.get(
  "/early-warning",
  requirePermission("insights.view"),
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.query.schoolId);
    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    // Clamped rather than rejected: a hand-typed ?days=900 means "a long time",
    // and 7..120 keeps the window inside a school year's worth of signal.
    const days = Math.max(7, Math.min(120,
      Number.parseInt(String(req.query.days ?? ""), 10) || earlyWarning.DEFAULT_WINDOW_DAYS
    ));

    return res.json({
      success: true,
      data: await earlyWarning.watchlist({ schoolId, days }),
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECT INTELLIGENCE — the staffroom's, and money-free
// ─────────────────────────────────────────────────────────────────────────────

const subjectRead = requireAnyPermission("insights.view", "insights.viewTaught");

router.get("/student/:studentId/guidance", subjectRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const student = await Student.findOne({ _id: String(req.params.studentId), schoolId, deletedAt: null }).select("classId").lean();
  if (!student) return res.status(404).json({ success: false, message: "Student not found" });
  const classId = student.classId ? String(student.classId) : null;
  if (!(await mayReadClass(req, { schoolId, classId }))) return forbidden(res);
  return res.json({ success: true, data: { generatedAt: new Date(), studentId: String(student._id), classId, guidance: await guidance.guidanceFor({ schoolId, studentId: String(student._id) }) } });
}));

/**
 * GET /api/insights/student/:studentId
 *
 * One pupil's subject record over every published sequence: the measurements,
 * and the statements those measurements support, each carrying its evidence.
 */
router.get(
  "/student/:studentId",
  subjectRead,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.query.schoolId);
    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    const student = await Student.findOne({
      _id: String(req.params.studentId), schoolId, deletedAt: null,
    }).select("studentName name firstName lastName enrollmentNo classId").lean();

    // 404 rather than 403 for a pupil in another school: the caller is not
    // entitled to learn that the id exists somewhere else.
    if (!student) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    const classId = student.classId ? String(student.classId) : null;
    if (!(await mayReadClass(req, { schoolId, classId }))) return forbidden(res);

    const profile = await subjectInsights.profileFor({
      schoolId, studentId: String(student._id),
    });

    return res.json({
      success: true,
      data: {
        generatedAt:  new Date(),
        studentId:    String(student._id),
        name:         displayName(student) || null,
        enrollmentNo: student.enrollmentNo ?? null,
        classId,
        ...profile,
      },
    });
  })
);

/**
 * GET /api/insights/class/:classId
 *
 * The same engine across one class, carrying the statements without the full
 * per-subject measurements behind each pupil — a list a teacher scans, with
 * the pupil route holding the detail behind it.
 */
router.get(
  "/class/:classId",
  subjectRead,
  asyncHandler(async (req, res) => {
    const schoolId = resolveSchoolId(req, req.query.schoolId);
    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    const classId = String(req.params.classId);
    const klass = await Class.findOne({ _id: classId, schoolId, deletedAt: null })
      .select("name").lean();
    if (!klass) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    if (!(await mayReadClass(req, { schoolId, classId }))) return forbidden(res);

    const students = await Student.find({
      schoolId, classId, status: "approved", deletedAt: null,
    }).select("studentName name firstName lastName enrollmentNo classId").lean();

    /*
     * Two queries for the whole class, not two per pupil.
     *
     * analyse() is bulk by construction — one history read and one grading-config
     * read however many pupils are asked for — and the open interventions are a
     * single find over the class. A class of forty costs what one costs, which is
     * the difference between a screen a teacher opens and a screen a teacher
     * learns to avoid.
     *
     * guidanceForProfile is pure: it projects the profile that is already in
     * memory and issues no query at all.
     */
    const studentIds = students.map((s) => String(s._id));
    const [profiles, openInterventions] = await Promise.all([
      subjectInsights.analyse({ schoolId, studentIds }),
      Intervention.find({
        schoolId, classId, deletedAt: null,
        status: { $in: OPEN_STATUSES },
      }).select("studentId status actionCode sourceType sourceCode subjectId assignedTo updatedAt")
        .sort({ updatedAt: -1 }).lean(),
    ]);

    const openByStudent = new Map();
    for (const row of openInterventions) {
      const id = String(row.studentId);
      const list = openByStudent.get(id);
      if (list) list.push(row); else openByStudent.set(id, [row]);
    }

    const rows = students.map((student) => {
      const id = String(student._id);
      const profile = profiles.get(id);
      return {
        studentId:    id,
        name:         displayName(student) || null,
        enrollmentNo: student.enrollmentNo ?? null,
        coverage:     profile?.coverage ?? null,
        insights:     profile?.insights ?? [],
        // A SUMMARY: what the guidance says and how loudly, without the evidence
        // behind it. The evidence is what the pupil route is for, and carrying it
        // forty times over would make a scanning list into a record dump.
        guidance:     guidance.guidanceForProfile(profile).map(guidanceSummary),
        openInterventions: openByStudent.get(id) ?? [],
      };
    }).sort(byName);

    return res.json({
      success: true,
      data: {
        generatedAt: new Date(),
        classId,
        className:   klass.name ?? null,
        engine: {
          version: subjectInsights.ENGINE_VERSION,
          ...(await subjectInsights.gradingContextFor(schoolId)),
        },
        counts: {
          students:  rows.length,
          withRisk:     rows.filter((r) => r.insights.some((i) => i.type === "risk")).length,
          withStrength: rows.filter((r) => r.insights.some((i) => i.type === "strength")).length,
        },
        students: rows,
      },
    });
  })
);

module.exports = router;
