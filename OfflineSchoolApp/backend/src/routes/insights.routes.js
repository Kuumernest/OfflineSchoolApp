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

const IntelligenceReview = require("../db/models/IntelligenceReview");
const { scopes: feedScopes } = require("../config/syncFeed");
const reviewCases     = require("../services/intelligence/reviewCases.service");
const pilots          = require("../services/intelligence/pilot.service");
const strengthsSvc    = require("../services/intelligence/strengths.service");
const explorationSvc  = require("../services/intelligence/exploration.service");
const ExplorationEvidence = require("../db/models/ExplorationEvidence");
const IntelligencePilot = require("../db/models/IntelligencePilot");

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

// ─────────────────────────────────────────────────────────────────────────────
// CALIBRATION REVIEW — the same engine, laid out for a human to judge
//
// Who may see what follows the one hierarchy every intelligence read uses:
//
//   teacher        the classes they hold an assignment for
//   school_admin   the whole school
//   super_admin    the school they have selected with ?schoolId, which the
//                  middleware has already checked exists
//
// The engine's answer is the same whoever asks. Only the set of pupils differs,
// and it is resolved once, here, by the same primitive the sync feed uses to
// decide which pupils a teacher's machine may hold.
//
// And one more rule, for the review itself: a teacher who has not yet answered
// a case does not see what colleagues answered. The package is built for the
// viewer, in reviewCases.service, so that two independent judgements are
// actually independent.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reading reviews is a staffroom right, not an office-wide one.
 *
 * subjectRead admits the bursar, because subject intelligence is computed from
 * marks the bursar can already read and carries no money. A review is a
 * different kind of thing: a named colleague's written judgement about a named
 * child — the same class of record as an intervention note, which the bursar
 * is deliberately kept out of. insights.viewTaught is held by exactly the
 * hierarchy that may read one: the teacher for their classes, the head for the
 * school, the operator for the school they have selected. A school that wants
 * its bursar on the review sheet can delegate it; the default does not.
 */
const reviewRead = requirePermission("insights.viewTaught");

/** Who is looking, for the contamination shield. */
const viewerOf = (req) => ({ userId: String(req.user._id ?? req.user.id), role: req.user.role });

/**
 * Which pupils this caller may review: a school and, for a teacher, a class list.
 *
 * feedScopes.taughtStudentsOnly is the sync feed's own answer to "which pupils
 * does this teacher get" — reused rather than restated, so a teacher can never
 * see more on the review sheet than their desktop is allowed to mirror.
 *
 * `?classId=` narrows to one class; for a teacher it must be one they teach.
 * Answers the response itself when it cannot resolve, and returns null.
 */
const reviewScope = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) {
    res.status(400).json({ success: false, message: "schoolId is required" });
    return null;
  }

  let classIds = null;
  if (isTeacher(req)) {
    const filter = await feedScopes.taughtStudentsOnly(req, { TeacherAssignment });
    classIds = filter.classId?.$in ?? [];
  }

  const asked = req.query.classId ? String(req.query.classId) : null;
  if (asked) {
    const klass = await Class.findOne({ _id: asked, schoolId, deletedAt: null }).select("_id").lean();
    if (!klass) {
      res.status(404).json({ success: false, message: "Class not found" });
      return null;
    }
    if (!(await mayReadClass(req, { schoolId, classId: asked }))) { forbidden(res); return null; }
    classIds = [asked];
  }

  return { schoolId, classIds };
};

/** The pupil, in this school, with the class the caller must be allowed to reach. */
const pupilForReview = async (req, res, schoolId, studentId) => {
  const student = await Student.findOne({ _id: String(studentId ?? ""), schoolId, deletedAt: null })
    .select("classId").lean();
  if (!student) {
    res.status(404).json({ success: false, message: "Student not found" });
    return null;
  }
  const classId = student.classId ? String(student.classId) : null;
  if (!(await mayReadClass(req, { schoolId, classId }))) { forbidden(res); return null; }
  return { student, classId };
};

/**
 * GET /api/insights/review-cases?classId=&limit=
 *
 * The queue: the cases the calibration machinery would put in front of a
 * teacher, over live pupils the caller may see, in the order a reviewer's time
 * is best spent, with any judgements attached as this viewer may see them.
 */
router.get("/review-cases", reviewRead, asyncHandler(async (req, res) => {
  const scope = await reviewScope(req, res);
  if (!scope) return undefined;

  const pkg = await reviewCases.reviewPackage(scope, viewerOf(req));
  const { report, ...sheet } = pkg;
  void report;

  // A queue, not a dump: the sheet is already in priority order, and a client
  // that asks for the first twenty gets the twenty most worth a teacher's time.
  const limit = Math.max(1, Math.min(200, Number.parseInt(String(req.query.limit ?? ""), 10) || 200));
  return res.json({
    success: true,
    data: { generatedAt: new Date(), ...sheet, cases: sheet.cases.slice(0, limit), totalCases: sheet.cases.length },
  });
}));

/**
 * GET /api/insights/calibration-summary?classId=
 *
 * What the data is, what the engine said, the flags, the sensitivity table and
 * how the review is going — for the pupils the caller may see. No salt, no
 * export, no download.
 */
router.get("/calibration-summary", reviewRead, asyncHandler(async (req, res) => {
  const scope = await reviewScope(req, res);
  if (!scope) return undefined;
  return res.json({
    success: true,
    data: { generatedAt: new Date(), ...(await reviewCases.calibrationSummary(scope, viewerOf(req))) },
  });
}));

/**
 * GET /api/insights/reviews/student/:studentId
 *
 * Every judgement recorded about one pupil, newest first, each named — subject
 * to the shield: a teacher sees their own, and colleagues' only on cases they
 * have answered themselves.
 */
router.get("/reviews/student/:studentId", reviewRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, message: "schoolId is required" });
  }
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;

  const viewer = viewerOf(req);
  const all = await reviewCases.reviewsFor({ schoolId, studentIds: [String(pupil.student._id)] });
  const answered = new Set(all.filter((r) => String(r.reviewedBy) === viewer.userId).map(reviewCases.caseKey));
  const visible = all.filter((r) =>
    !reviewCases.shielded(viewer, answered.has(reviewCases.caseKey(r))));

  return res.json({
    success: true,
    data: visible.map(reviewCases.publicReview),
    hiddenCount: all.length - visible.length,
  });
}));

/**
 * POST /api/insights/reviews
 *
 * A teacher records their judgement of one engine conclusion about one pupil.
 *
 * The case is verified against the engine before anything is stored: a review
 * has to be OF something the engine actually said today, and its
 * classifications are taken from the server rather than the request. One
 * reviewer gets one review per case — a second opinion is a revision, through
 * PATCH, so that a person cannot count twice in the tally. And a review made
 * under one engine version is refused if the client saw the case under another.
 */
router.post("/reviews", requirePermission("insights.review"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, message: "schoolId is required" });
  }
  const pupil = await pupilForReview(req, res, schoolId, req.body.studentId);
  if (!pupil) return undefined;

  const category  = String(req.body.category ?? "").trim();
  const subjectId = req.body.subjectId ? String(req.body.subjectId) : null;
  if (!category || category.length > 60) {
    return res.status(400).json({ success: false, code: "INVALID_REVIEW", message: "category is required" });
  }
  if (!req.body.review || typeof req.body.review !== "object") {
    return res.status(400).json({ success: false, code: "INVALID_REVIEW", message: "review form is required" });
  }
  const problems = reviewCases.validateReview(req.body.review, "review");
  if (problems.length) {
    return res.status(400).json({ success: false, code: "INVALID_REVIEW", problems });
  }

  // The version the reviewer saw the case under. If the engine has moved since
  // the sheet was loaded, the judgement is of something that no longer exists.
  if (req.body.engineVersion && String(req.body.engineVersion) !== subjectInsights.ENGINE_VERSION) {
    return res.status(409).json({
      success: false, code: "STALE_ENGINE_VERSION",
      message: "The case was loaded under a different engine version. Reload it and review again.",
      current: subjectInsights.ENGINE_VERSION,
    });
  }

  const actor       = String(req.user._id ?? req.user.id);
  const requestedId = req.body._id ? String(req.body._id) : null;

  // The offline outbox resends a create after a dropped connection; the row
  // that already exists is the answer, exactly as for an intervention.
  const replayed = requestedId ? await IntelligenceReview.findOne({ _id: requestedId, schoolId }) : null;
  if (replayed) return res.status(201).json({ success: true, data: replayed });

  const studentId = String(pupil.student._id);
  const duplicate = await IntelligenceReview.findOne({
    schoolId, studentId, category, subjectId, reviewedBy: actor, deletedAt: null,
  }).select("_id").lean();
  if (duplicate) {
    return res.status(409).json({
      success: false, code: "DUPLICATE_REVIEW",
      message: "You have already reviewed this case. Revise that review instead.",
      reviewId: String(duplicate._id),
    });
  }

  // A review of a STRENGTH reading names the dimension (or subject) in
  // subjectId under the category "strength"; it is verified against the
  // current strengths profile the way an academic case is verified against
  // the sheet, and stored with the server's reading.
  const found = category === "strength"
    ? await strengthsSvc.strengthReviewCase({ schoolId, studentId, code: subjectId })
    : await reviewCases.caseFor({ schoolId, studentId, category, subjectId });
  if (!found) {
    return res.status(404).json({
      success: false, code: "CASE_NOT_FOUND",
      message: "The engine produces no such case for this pupil today.",
    });
  }

  const item = await IntelligenceReview.create({
    _id:             requestedId ?? undefined,
    schoolId,
    studentId,
    classId:         pupil.classId ?? "",
    subjectId,
    category,
    engineVersion:   subjectInsights.ENGINE_VERSION,
    classifications: found.classifications,
    review:          req.body.review,
    reviewedBy:      actor,
  });

  return res.status(201).json({ success: true, data: item });
}));

/**
 * PATCH /api/insights/reviews/:id
 *
 * The author corrects their own review. Nobody else may — a head who disagrees
 * writes their own, they do not edit a teacher's. What was said before is kept
 * on the record, and the engine version the review was made under is not
 * touched: it was a judgement of what 1.0.0 said, whatever the engine says now.
 */
router.patch("/reviews/:id", requirePermission("insights.review"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, message: "schoolId is required" });
  }
  const item = await IntelligenceReview.findOne({ _id: String(req.params.id), schoolId, deletedAt: null });
  if (!item) {
    return res.status(404).json({ success: false, message: "Review not found" });
  }
  const actor = String(req.user._id ?? req.user.id);
  if (String(item.reviewedBy) !== actor) {
    return res.status(403).json({
      success: false, code: "NOT_AUTHOR",
      message: "Only the teacher who wrote a review may revise it.",
    });
  }
  if (req.body.version !== undefined && Number(req.body.version) !== item.version) {
    return res.status(409).json({ success: false, code: "VERSION_CONFLICT", data: item });
  }
  if (!req.body.review || typeof req.body.review !== "object") {
    return res.status(400).json({ success: false, code: "INVALID_REVIEW", message: "review form is required" });
  }
  const problems = reviewCases.validateReview(req.body.review, "review");
  if (problems.length) {
    return res.status(400).json({ success: false, code: "INVALID_REVIEW", problems });
  }

  item.revisions.push({ review: item.review.toObject ? item.review.toObject() : item.review, replacedAt: new Date() });
  item.review    = req.body.review;
  item.revisedAt = new Date();
  item.version  += 1;
  await item.save();

  return res.json({ success: true, data: item });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PILOT — the frame around a validation exercise
//
// Reading the pilot's state is a staffroom right (a teacher should know the
// exercise is on, and which kind it is). Opening, advancing and concluding one
// is the head's, on insights.pilot, and the operator's for the school they have
// selected. Status is written by pilot.service and by nothing else; the
// evidence a decision rests on is taken by the server, never posted.
// ─────────────────────────────────────────────────────────────────────────────

const pilotManage = requirePermission("insights.pilot");
const isOffice = (req) => !isTeacher(req);

const pilotErr = (res, err) => {
  if (!err.code || !err.status) throw err;
  const { status, code, message, ...extra } = err;
  return res.status(status).json({ success: false, code, message, ...extra });
};

/** What a teacher sees of a pilot: that it exists, its kind, its state. */
const leanPilot = (p) => (p ? {
  pilotRunId: p.pilotRunId, kind: p.kind, status: p.status, engineVersion: p.engineVersion,
  label: p.label, startedAt: p.startedAt, endedAt: p.endedAt,
} : null);

/**
 * GET /api/insights/pilot
 * The school's open pilot, or its most recently closed one. Full record for
 * the office, the lean shape for a teacher.
 */
router.get("/pilot", reviewRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const open = await pilots.openPilot(schoolId);
  const latest = open ?? await IntelligencePilot.findOne({ schoolId, deletedAt: null }).sort({ updatedAt: -1 });
  const pub = pilots.publicPilot(latest);
  return res.json({
    success: true,
    data: { generatedAt: new Date(), open: Boolean(open), pilot: isOffice(req) ? pub : leanPilot(pub) },
  });
}));

/**
 * GET /api/insights/pilot/preflight?classId=
 * May a REAL pilot start here? Every precondition a query can answer, and the
 * two that a person must sign. Read before opening; enforced again on open.
 */
router.get("/pilot/preflight", pilotManage, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const classIds = req.query.classId ? String(req.query.classId).split(",").filter(Boolean) : null;
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await pilots.preflight({ schoolId, classIds })) } });
}));

/** POST /api/insights/pilot/:id/findings — record a finding. PATCH …/:findingId — move its status. */
router.post("/pilot/:id/findings", pilotManage, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pilot = await IntelligencePilot.findOne({ _id: String(req.params.id), schoolId, deletedAt: null });
  if (!pilot) return res.status(404).json({ success: false, message: "Pilot not found" });
  try {
    const f = await pilots.addFinding(pilot, {
      category: String(req.body.category ?? ""), severity: String(req.body.severity ?? ""), summary: req.body.summary,
      evidence: req.body.evidence ? String(req.body.evidence).slice(0, 4000) : null,
      affectedCases: req.body.affectedCases, recommendedNextAction: req.body.recommendedNextAction ? String(req.body.recommendedNextAction).slice(0, 1000) : null,
      actor: String(req.user._id ?? req.user.id),
    });
    return res.status(201).json({ success: true, data: f.toObject ? f.toObject() : f, pilot: pilots.publicPilot(pilot) });
  } catch (err) { return pilotErr(res, err); }
}));
router.patch("/pilot/:id/findings/:findingId", pilotManage, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pilot = await IntelligencePilot.findOne({ _id: String(req.params.id), schoolId, deletedAt: null });
  if (!pilot) return res.status(404).json({ success: false, message: "Pilot not found" });
  try {
    const f = await pilots.updateFinding(pilot, String(req.params.findingId), {
      status: req.body.status, recommendedNextAction: req.body.recommendedNextAction, actor: String(req.user._id ?? req.user.id),
    });
    return res.json({ success: true, data: f.toObject ? f.toObject() : f, pilot: pilots.publicPilot(pilot) });
  } catch (err) { return pilotErr(res, err); }
}));

/** GET /api/insights/pilot/history — every pilot the school has run, newest first. */
router.get("/pilot/history", pilotManage, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const rows = await IntelligencePilot.find({ schoolId, deletedAt: null }).sort({ createdAt: -1 });
  return res.json({ success: true, data: rows.map(pilots.publicPilot) });
}));

/**
 * GET /api/insights/pilot/evidence
 * The evidence counts as they stand now, for the open pilot's scope (or the
 * whole school when none is open). Not stored: the stored snapshot is the one
 * taken at a transition.
 */
router.get("/pilot/evidence", pilotManage, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const open = await pilots.openPilot(schoolId);
  const evidence = await pilots.evidenceFor({ schoolId, classIds: open?.classIds ?? null });
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), pilotRunId: open ? String(open._id) : null, evidence,
      minimum: pilots.MINIMUM_EVIDENCE, shortfalls: pilots.evidenceShortfalls(evidence),
    },
  });
}));

/**
 * POST /api/insights/pilot  { kind, classIds?, label? }
 * Opens a pilot at the caller's school in READY. One open pilot per school.
 */
router.post("/pilot", pilotManage, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const classIds = Array.isArray(req.body.classIds) ? req.body.classIds.map(String) : null;
  if (classIds && classIds.length) {
    const found = await Class.countDocuments({ _id: { $in: classIds }, schoolId, deletedAt: null });
    if (found !== new Set(classIds).size) {
      return res.status(404).json({ success: false, code: "CLASS_NOT_FOUND", message: "A class in the scope is not in this school." });
    }
  }
  try {
    const pilot = await pilots.createPilot({
      schoolId, classIds, kind: String(req.body.kind ?? ""),
      label: req.body.label ? String(req.body.label).slice(0, 120) : null,
      actor: String(req.user._id ?? req.user.id),
      attestations: req.body.attestations && typeof req.body.attestations === "object" ? req.body.attestations : null,
    });
    return res.status(201).json({ success: true, data: pilots.publicPilot(pilot) });
  } catch (err) { return pilotErr(res, err); }
}));

/**
 * PATCH /api/insights/pilot/:id  { to, note?, decision?, version? }
 * Moves the pilot one state along, under the rules in pilot.service.
 */
router.patch("/pilot/:id", pilotManage, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pilot = await IntelligencePilot.findOne({ _id: String(req.params.id), schoolId, deletedAt: null });
  if (!pilot) return res.status(404).json({ success: false, message: "Pilot not found" });
  if (req.body.version !== undefined && Number(req.body.version) !== pilot.version) {
    return res.status(409).json({ success: false, code: "VERSION_CONFLICT", data: pilots.publicPilot(pilot) });
  }
  try {
    await pilots.transition(pilot, String(req.body.to ?? ""), {
      actor: String(req.user._id ?? req.user.id),
      note: req.body.note ? String(req.body.note).slice(0, 2000) : null,
      decision: req.body.decision && typeof req.body.decision === "object" ? req.body.decision : null,
    });
    return res.json({ success: true, data: pilots.publicPilot(pilot) });
  } catch (err) { return pilotErr(res, err); }
}));

/**
 * GET /api/insights/student/:studentId/consistency
 *
 * One pupil through the live path and the offline path, diffed. For the pilot
 * protocol's "live == offline" check, by anyone who may read the pupil. A
 * difference is reported as found; nothing is normalised away.
 */
router.get("/student/:studentId/consistency", reviewRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const academic = await reviewCases.liveOfflineConsistency({ schoolId, studentId: String(pupil.student._id) });
  // The strengths layer, through both roads to the academic profile beneath it.
  const { compareProfiles } = require("../../scripts/calibration/consistency");
  const [liveS, offS] = await Promise.all([
    strengthsSvc.profileFor({ schoolId, studentId: String(pupil.student._id) }),
    strengthsSvc.offlineProfileFor({ schoolId, studentId: String(pupil.student._id) }),
  ]);
  const strengthsCmp = compareProfiles(
    { engineVersion: liveS?.strengthEngineVersion ?? null, profile: liveS, guidance: null },
    { engineVersion: offS?.strengthEngineVersion ?? null, profile: offS, guidance: null }
  );
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), ...academic,
      identical: academic.identical && strengthsCmp.identical,
      strengths: { identical: strengthsCmp.identical, engineVersion: strengthsCmp.engineVersion, differences: strengthsCmp.differences },
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// STRENGTHS & EXPLORATION — the layer above the academic engine
//
// Reads follow the intelligence hierarchy with one addition: a PUPIL reads
// their own profile and nobody else's, by role. The bursar holds no teaching
// capability and is out. Identity is joined here, after
// authorisation; the shared layer never sees a name.
// ─────────────────────────────────────────────────────────────────────────────

const isStudent = (req) => req.user?.role === ROLES.STUDENT;
// Staff read on the intelligence capability; a pupil reads by ROLE, as every
// student-facing route in this application does — pupils hold no capabilities,
// and the role matrix keeps it that way. pupilForStrengths then limits the
// pupil to their own record.
const strengthRead = (req, res, next) => (isStudent(req) ? next() : requirePermission("insights.viewTaught")(req, res, next));

/** The pupil this caller may read strengths for. A pupil: only themselves. */
const pupilForStrengths = async (req, res, schoolId, studentId) => {
  if (!isStudent(req)) return pupilForReview(req, res, schoolId, studentId);
  const actor = String(req.user._id ?? req.user.id);
  // "me": the pupil's own record, found by their account — a phone need not
  // know the Student id to ask about its owner.
  const own = await Student.findOne({ ...(String(studentId) === "me" ? {} : { _id: String(studentId ?? "") }), schoolId, userId: actor, deletedAt: null })
    .select("classId studentName name firstName lastName enrollmentNo").lean();
  if (!own) {
    res.status(403).json({ success: false, code: "OWN_PROFILE_ONLY", message: "A pupil may read only their own profile." });
    return null;
  }
  return { student: own, classId: own.classId ? String(own.classId) : null };
};

const identityOf = async (schoolId, pupil) => {
  const s = pupil.student.studentName !== undefined ? pupil.student
    : await Student.findOne({ _id: String(pupil.student._id), schoolId }).select("studentName name firstName lastName enrollmentNo classId").lean();
  return { studentId: String(pupil.student._id), name: displayName(s) || null, enrollmentNo: s?.enrollmentNo ?? null, classId: pupil.classId };
};

/** Strength reviews on this pupil, as this viewer may see them (the shield applies). */
const strengthReviewsFor = async (req, schoolId, studentId) => {
  if (isStudent(req)) return undefined;
  const viewer = viewerOf(req);
  const all = (await reviewCases.reviewsFor({ schoolId, studentIds: [studentId] })).filter((r) => r.category === "strength");
  const answered = new Set(all.filter((r) => String(r.reviewedBy) === viewer.userId).map(reviewCases.caseKey));
  return all.filter((r) => !reviewCases.shielded(viewer, answered.has(reviewCases.caseKey(r)))).map(reviewCases.publicReview);
};

/** GET /api/insights/student/:studentId/strengths — the full profile, every claim with its evidence. */
router.get("/student/:studentId/strengths", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const id = String(pupil.student._id);
  const profile = await strengthsSvc.profileFor({ schoolId, studentId: id });
  const reviews = await strengthReviewsFor(req, schoolId, id);
  return res.json({
    success: true,
    data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), profile, ...(reviews ? { reviews } : {}) },
  });
}));

/** GET /api/insights/student/:studentId/exploration — the areas, the interest signals, the limits. */
router.get("/student/:studentId/exploration", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const p = await strengthsSvc.profileFor({ schoolId, studentId: String(pupil.student._id) });
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
      explorationAreas: p?.explorationAreas ?? [], interestSignals: p?.interestSignals ?? [],
      strengths: (p?.strengths ?? []).map((d) => ({ dimension: d.dimension, persistence: d.persistence, confidence: d.confidence })),
      emergingAreas: (p?.emergingAreas ?? []).map((d) => ({ dimension: d.dimension, persistence: d.persistence, confidence: d.confidence })),
      limitations: p?.limitations ?? ["no_academic_profile"], confidence: p?.confidence ?? "insufficient",
      notInferred: p?.notInferred ?? [], versions: { academic: p?.academicEngineVersion ?? null, strengths: p?.strengthEngineVersion ?? null },
    },
  });
}));

/** GET /api/insights/student/:studentId/profile — the current reading and every snapshot before it. */
router.get("/student/:studentId/profile", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const id = String(pupil.student._id);
  const [p, history] = await Promise.all([strengthsSvc.profileFor({ schoolId, studentId: id }), strengthsSvc.history({ schoolId, studentId: id })]);
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
      current: p ? { ...strengthsSvc.readingOf(p), academicEngineVersion: p.academicEngineVersion, strengthEngineVersion: p.strengthEngineVersion } : null,
      history: history.map((h) => ({
        snapshotId: String(h._id), profileVersion: h.profileVersion, academicEngineVersion: h.academicEngineVersion,
        strengthEngineVersion: h.strengthEngineVersion, sourcePeriod: h.sourcePeriod, periodLabel: h.periodLabel,
        generatedAt: h.generatedAt, recordedBy: h.recordedBy, profile: h.profile,
      })),
    },
  });
}));

/** POST /api/insights/student/:studentId/profile/snapshot — keep today's reading. Staff only. */
router.post("/student/:studentId/profile/snapshot", requirePermission("insights.viewTaught"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const snap = await strengthsSvc.snapshot({
      schoolId, studentId: String(pupil.student._id), classId: pupil.classId,
      actor: String(req.user._id ?? req.user.id), periodLabel: req.body?.periodLabel ?? null,
    });
    return res.status(201).json({ success: true, data: snap });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message }); throw err; }
}));

/** GET /api/insights/student/:studentId/evidence — everything the profile rests on, by kind. */
router.get("/student/:studentId/evidence", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const id = String(pupil.student._id);
  const [p, rows] = await Promise.all([strengthsSvc.profileFor({ schoolId, studentId: id }), strengthsSvc.evidenceRows({ schoolId, studentId: id })]);
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
      academicSignals: p?.academicSignals ?? [],
      strengthEvidence: [...(p?.strengths ?? []), ...(p?.emergingAreas ?? []), ...(p?.decliningAreas ?? [])]
        .map((d) => ({ dimension: d.dimension, state: d.state, evidence: d.evidence })),
      subjects: p?.subjects ?? [],
      explorationEvidence: rows,
      versions: { academic: p?.academicEngineVersion ?? null, strengths: p?.strengthEngineVersion ?? null },
    },
  });
}));

/**
 * POST /api/insights/student/:studentId/evidence
 * A pupil records interest or a reflection about themselves; a teacher or the
 * office records exposure, performance or an observation. The kind a source
 * may record is fixed in strengths.service — nobody records ability on a
 * pupil's behalf from the pupil's seat, and a pupil's interest is never
 * entered as a teacher's observation.
 */
router.post("/student/:studentId/evidence", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const actor = String(req.user._id ?? req.user.id);
  const requestedId = req.body?._id ? String(req.body._id) : null;
  const replayed = requestedId ? await ExplorationEvidence.findOne({ _id: requestedId, schoolId }) : null;
  if (replayed) return res.status(201).json({ success: true, data: replayed });
  const source = isStudent(req) ? "student" : isTeacher(req) ? "teacher" : "office";
  try {
    const row = await strengthsSvc.recordEvidence({ schoolId, studentId: String(pupil.student._id), classId: pupil.classId, source, actor, body: req.body ?? {} });
    return res.status(201).json({ success: true, data: row });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message }); throw err; }
}));

// ─────────────────────────────────────────────────────────────────────────────
// EXPLORATION — what a pupil may explore, what they explored, what it produced
//
// Reads follow the strengths rules: staff on insights.viewTaught scoped to
// the pupils they may read; a pupil their own, by role. The pupil's reflection
// text reaches staff only when the pupil shared it (exploration.service
// applies the policy); a guardian's view is progress only, on the portal.
// ─────────────────────────────────────────────────────────────────────────────

const explorationViewer = (req) => (isStudent(req) ? "student" : "staff");
const langOf = (req) => (String(req.query.lang ?? req.headers["accept-language"] ?? "en").toLowerCase().startsWith("fr") ? "fr" : "en");
const explErr = (res, err) => {
  if (!err.status) throw err;
  const { status, code, message, ...extra } = err;
  return res.status(status).json({ success: false, code, message, ...extra });
};

/** GET /api/insights/student/:studentId/explorations — the pupil's list, as the viewer may see it. */
router.get("/student/:studentId/explorations", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const rows = await explorationSvc.history({ schoolId, studentId: String(pupil.student._id), viewer: explorationViewer(req), lang: langOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), explorations: rows } });
}));

/** GET …/explorations/recommended?resources=a,b&count= — what to put in front of the pupil, with reasons. */
router.get("/student/:studentId/explorations/recommended", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const resources = req.query.resources ? String(req.query.resources).split(",").filter(Boolean) : null;
  const r = await explorationSvc.recommended({ schoolId, studentId: String(pupil.student._id), resources, count: req.query.count, lang: langOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), ...r } });
}));

/** GET …/explorations/history — the same list; the name the brief uses. */
router.get("/student/:studentId/explorations/history", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const rows = await explorationSvc.history({ schoolId, studentId: String(pupil.student._id), viewer: explorationViewer(req), lang: langOf(req) });
  const counts = rows.reduce((o, r) => { o[r.status] = (o[r.status] ?? 0) + 1; return o; }, {});
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), counts, areasExplored: [...new Set(rows.map((r) => r.area))].sort(), explorations: rows } });
}));

/** POST …/explorations  { activityId, action: start|save|skip|not_interested|discover, _id?, reasons?, relevance? } */
router.post("/student/:studentId/explorations", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const { exploration, replayed } = await explorationSvc.choose({ schoolId, studentId: String(pupil.student._id), classId: pupil.classId, actor: String(req.user._id ?? req.user.id), body: req.body ?? {} });
    return res.status(201).json({ success: true, data: exploration, replayed });
  } catch (err) { return explErr(res, err); }
}));

/** GET …/exploration-evidence — the rows explorations produced, by kind. */
router.get("/student/:studentId/exploration-evidence", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const rows = await explorationSvc.evidenceFor({ schoolId, studentId: String(pupil.student._id) });
  const byKind = rows.reduce((o, r) => { o[r.kind] = (o[r.kind] ?? 0) + 1; return o; }, {});
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), byKind, evidence: rows } });
}));

/** GET /api/insights/explorations/summary?classId= — the office's counts. No pupil, no reflection. */
router.get("/explorations/summary", requirePermission("insights.viewTaught"), asyncHandler(async (req, res) => {
  const scope = await reviewScope(req, res);
  if (!scope) return undefined;
  return res.json({ success: true, data: { generatedAt: new Date(), scope, ...(await explorationSvc.summary(scope)) } });
}));

module.exports = router;
