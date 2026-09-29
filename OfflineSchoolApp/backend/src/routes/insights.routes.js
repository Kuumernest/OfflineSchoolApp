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
const learningSvc     = require("../services/intelligence/learningEvidence.service");
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
  const asOf = asOfOf(req) ?? strengthsSvc.startOfToday();
  const [liveS, offS] = await Promise.all([
    strengthsSvc.profileFor({ schoolId, studentId: String(pupil.student._id), asOf }),
    strengthsSvc.offlineProfileFor({ schoolId, studentId: String(pupil.student._id), asOf }),
  ]);
  const strengthsCmp = compareProfiles(
    { engineVersion: liveS?.strengthEngineVersion ?? null, profile: liveS, guidance: null },
    { engineVersion: offS?.strengthEngineVersion ?? null, profile: offS, guidance: null }
  );
  // The development layer, on the same asOf, through both roads.
  const devSvc = require("../services/intelligence/development.service");
  const [liveD, offD] = await Promise.all([
    devSvc.historyFor({ schoolId, studentId: String(pupil.student._id), asOf }),
    devSvc.offlineHistoryFor({ schoolId, studentId: String(pupil.student._id), asOf }),
  ]);
  const developmentCmp = compareProfiles(
    { engineVersion: liveD?.developmentEngineVersion ?? null, profile: liveD, guidance: null },
    { engineVersion: offD?.developmentEngineVersion ?? null, profile: offD, guidance: null }
  );
  // Guidance and the intervention interpretation, both roads, on the same asOf.
  const gSvc = require("../services/intelligence/developmentGuidance.service");
  const ivShared = require("../../../shared/interventions");
  const [liveG, offG] = await Promise.all([gSvc.guidanceFor({ schoolId, studentId: String(pupil.student._id), asOf }), gSvc.offlineGuidanceFor({ schoolId, studentId: String(pupil.student._id), asOf })]);
  const liveT = liveD ? ivShared.triggersFor({ development: liveD, guidance: liveG }) : [], offT = offD ? ivShared.triggersFor({ development: offD, guidance: offG }) : [];
  const guidanceCmp = compareProfiles({ engineVersion: liveG?.guidanceEngineVersion ?? null, profile: liveG, guidance: null }, { engineVersion: offG?.guidanceEngineVersion ?? null, profile: offG, guidance: null });
  const interventionCmp = compareProfiles({ engineVersion: ivShared.INTERVENTION_ENGINE_VERSION, profile: { triggers: liveT }, guidance: null }, { engineVersion: ivShared.INTERVENTION_ENGINE_VERSION, profile: { triggers: offT }, guidance: null });
  // Development plans: each active plan's review on both roads.
  const plansSvcC = require("../services/intelligence/developmentPlans.service");
  const planDocs = await plansSvcC.listFor({ schoolId, studentId: String(pupil.student._id) });
  const planPairs = await Promise.all(planDocs.map(async (d) => ({ plan: plansSvcC.view(d, { asOf, viewer: "staff" }), live: await plansSvcC.systemReview({ doc: d, schoolId, studentId: String(pupil.student._id), asOf }), off: await plansSvcC.offlineSystemReview({ doc: d, schoolId, studentId: String(pupil.student._id), asOf }) })));
  const planCmp = compareProfiles({ engineVersion: require("../../../shared/adaptiveSupport").ADAPTIVE_SUPPORT_ENGINE_VERSION, profile: planPairs.map((p) => ({ plan: p.plan, review: p.live })), guidance: null },
    { engineVersion: require("../../../shared/adaptiveSupport").ADAPTIVE_SUPPORT_ENGINE_VERSION, profile: planPairs.map((p) => ({ plan: JSON.parse(JSON.stringify(p.plan)), review: p.off })), guidance: null });
  const mismatches = [
    ...(planCmp.summary.planState ? ["PLAN_STATE_MISMATCH"] : []), ...(planCmp.summary.planObjective ? ["PLAN_OBJECTIVE_MISMATCH"] : []), ...(planCmp.summary.planMilestone ? ["PLAN_MILESTONE_MISMATCH"] : []),
    ...(planCmp.summary.planEvidenceBoundary ? ["PLAN_EVIDENCE_BOUNDARY_MISMATCH"] : []), ...(planCmp.summary.planReview ? ["PLAN_REVIEW_MISMATCH"] : []), ...(planCmp.summary.planAdaptation ? ["PLAN_ADAPTATION_MISMATCH"] : []),
    ...(planCmp.summary.planVersion ? ["PLAN_VERSION_MISMATCH"] : []),
    ...(guidanceCmp.summary.guidanceState ? ["GUIDANCE_STATE_MISMATCH"] : []), ...(guidanceCmp.summary.guidanceReason ? ["GUIDANCE_REASON_MISMATCH"] : []), ...(guidanceCmp.summary.guidanceEvidence ? ["GUIDANCE_EVIDENCE_MISMATCH"] : []),
    ...(interventionCmp.summary.interventionTrigger ? ["INTERVENTION_TRIGGER_MISMATCH"] : []), ...(interventionCmp.summary.interventionRule ? ["INTERVENTION_RULE_MISMATCH"] : []),
    ...(guidanceCmp.summary.engineVersion || guidanceCmp.summary.versions || interventionCmp.summary.engineVersion ? ["VERSION_MISMATCH"] : []),
  ];
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), ...academic,
      identical: academic.identical && strengthsCmp.identical && developmentCmp.identical && guidanceCmp.identical && interventionCmp.identical && planCmp.identical,
      strengths: { identical: strengthsCmp.identical, engineVersion: strengthsCmp.engineVersion, summary: strengthsCmp.summary, differences: strengthsCmp.differences,
                   versions: { live: versionsOf(liveS), offline: versionsOf(offS) } },
      development: { identical: developmentCmp.identical, engineVersion: developmentCmp.engineVersion, summary: developmentCmp.summary, differences: developmentCmp.differences },
      guidance: { identical: guidanceCmp.identical, engineVersion: guidanceCmp.engineVersion, summary: guidanceCmp.summary, differences: guidanceCmp.differences },
      interventions: { identical: interventionCmp.identical, engineVersion: interventionCmp.engineVersion, summary: interventionCmp.summary, differences: interventionCmp.differences },
      plans: { identical: planCmp.identical, engineVersion: planCmp.engineVersion, summary: planCmp.summary, differences: planCmp.differences, count: planPairs.length },
      mismatches,
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
  const profile = await strengthsSvc.profileFor({ schoolId, studentId: id, asOf: asOfOf(req) });
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
  const p = await strengthsSvc.profileFor({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
      explorationAreas: p?.explorationAreas ?? [], interestSignals: p?.interestSignals ?? [],
      strengths: (p?.strengths ?? []).map((d) => ({ dimension: d.dimension, persistence: d.persistence, confidence: d.confidence })),
      emergingAreas: (p?.emergingAreas ?? []).map((d) => ({ dimension: d.dimension, persistence: d.persistence, confidence: d.confidence })),
      limitations: p?.limitations ?? ["no_academic_profile"], confidence: p?.confidence ?? "insufficient",
      notInferred: p?.notInferred ?? [], versions: versionsOf(p),
    },
  });
}));

/** Every engine version beneath a reading, in one place. */
const versionsOf = (p) => ({ academic: p?.academicEngineVersion ?? null, strengths: p?.strengthEngineVersion ?? null,
  learningIntegration: p?.learningIntegrationVersion ?? null, learningEvidence: p?.learningEvidenceVersion ?? null, exploration: EXPLORATION_ENGINE_VERSION_OF() });
const EXPLORATION_ENGINE_VERSION_OF = () => require("../../../shared/exploration").EXPLORATION_ENGINE_VERSION;

/** GET /api/insights/student/:studentId/profile — the current reading and every snapshot before it. */
router.get("/student/:studentId/profile", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const id = String(pupil.student._id);
  const [p, history] = await Promise.all([strengthsSvc.profileFor({ schoolId, studentId: id, asOf: asOfOf(req) }), strengthsSvc.history({ schoolId, studentId: id })]);
  return res.json({
    success: true,
    data: {
      generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
      current: p ? { ...strengthsSvc.readingOf(p), academicEngineVersion: p.academicEngineVersion, strengthEngineVersion: p.strengthEngineVersion,
                     learningIntegrationVersion: p.learningIntegrationVersion, learningEvidenceVersion: p.learningEvidenceVersion } : null,
      history: history.map((h) => ({
        snapshotId: String(h._id), profileVersion: h.profileVersion, academicEngineVersion: h.academicEngineVersion,
        strengthEngineVersion: h.strengthEngineVersion, learningIntegrationVersion: h.learningIntegrationVersion ?? null, learningEvidenceVersion: h.learningEvidenceVersion ?? null,
        explorationEngineVersion: h.explorationEngineVersion ?? null, sourcePeriod: h.sourcePeriod, periodLabel: h.periodLabel,
        generatedAt: h.generatedAt, recordedBy: h.recordedBy, profile: h.profile,
      })),
    },
  });
}));

/** GET …/profile/timeline — per dimension: academic periods at strength, events by date, the reading. */
router.get("/student/:studentId/profile/timeline", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const p = await strengthsSvc.profileFor({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
    asOf: p?.fusion.asOf ?? null, windows: p?.fusion.windows ?? null, timeline: p?.fusion.timeline ?? {},
    contradictions: [...(p?.fusion.contradictions ?? []), ...(p?.learningIntegration?.contradictions ?? [])],
    learningRelationships: p?.learningIntegration?.relationships ?? {},
    versions: versionsOf(p) } });
}));

/** GET …/profile/changes — what changed since the last snapshot, and the evidence that arrived since. */
router.get("/student/:studentId/profile/changes", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const c = await strengthsSvc.changesSince({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), ...(c ?? { previous: null, current: null, newEvidence: null, comparison: null, pendingSnapshot: false }) } });
}));

/** GET …/profile/evidence — the fused evidence items, each traceable; the pupil sees their own. */
router.get("/student/:studentId/profile/evidence", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const p = await strengthsSvc.profileFor({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
    authority: p?.fusion.authority ?? null, coverage: p?.fusion.coverage ?? null, evidence: p?.fusion.evidence ?? [], rejected: p?.fusion.rejected ?? [],
    // 1.2.0: the learning-evidence authority, the independent items that reached a dimension, what was unavailable.
    learningAuthority: p?.learningIntegration?.authority ?? null,
    learningIntegration: p?.learningIntegration ? { version: p.learningIntegration.version, learningEvidenceVersion: p.learningIntegration.learningEvidenceVersion,
      independentLearningItems: p.learningIntegration.independentLearningItems, duplicateEventsCollapsed: p.learningIntegration.duplicateEventsCollapsed,
      items: p.learningIntegration.items, modalities: p.learningIntegration.modalities, missingModalities: p.learningIntegration.missingModalities,
      quality: p.learningIntegration.quality, contradictions: p.learningIntegration.contradictions } : null,
    versions: versionsOf(p),
    dimensions: [...(p?.strengths ?? []), ...(p?.emergingAreas ?? []), ...(p?.decliningAreas ?? [])].map((d) => ({
      dimension: d.dimension, state: d.state, baseState: d.baseState, fusedState: d.fusedState, confidence: d.confidence, baseConfidence: d.baseConfidence, fused: d.fused,
      academic: d.academic, learningEvidence: d.learningEvidence, corroboration: d.corroboration, context: d.context, interpretation: d.interpretation })) } });
}));

// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPMENT — how the evidence-backed profile changed over time (Stage 14)
// ─────────────────────────────────────────────────────────────────────────────

const developmentSvc = require("../services/intelligence/development.service");

/**
 * GET /api/insights/student/:studentId/development
 *
 * The pupil's development history on one day: trajectories per dimension,
 * change events between consecutive observations, contradiction records over
 * time, coverage history, quality. Derived from the immutable snapshots and
 * the current reading built for the same asOf; nothing is stored. Same
 * readers as the strengths: the pupil their own, a teacher within scope, the
 * school's admin, the operator with a school. No score.
 */
router.get("/student/:studentId/development", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const h = await developmentSvc.historyFor({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
    engineVersion: h?.developmentEngineVersion ?? null, asOf: h?.asOf ?? null, versions: h?.versions ?? null, history: h?.history ?? null,
    observations: h?.observations ?? [], trajectories: h?.trajectories ?? [], changes: h?.changes ?? [], contradictions: h?.contradictions ?? [],
    coverage: h?.coverage ?? null, quality: h?.quality ?? null, notInferred: h?.notInferred ?? [] } });
}));

/** GET …/development/changes — the change events, optionally within [from, to] and for one dimension or subject. */
router.get("/student/:studentId/development/changes", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const h = await developmentSvc.historyFor({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  const dateOf = (v) => { const d = v ? new Date(String(v)) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
  const filter = { from: dateOf(req.query.from), to: dateOf(req.query.to), dimensionId: req.query.dimensionId ? String(req.query.dimensionId) : null, subjectId: req.query.subjectId ? String(req.query.subjectId) : null };
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
    engineVersion: h?.developmentEngineVersion ?? null, asOf: h?.asOf ?? null, filter: { ...filter, from: filter.from?.toISOString() ?? null, to: filter.to?.toISOString() ?? null },
    changes: developmentSvc.changesOf(h, filter), contradictions: (h?.contradictions ?? []).filter((c) => !filter.dimensionId || c.dimension === filter.dimensionId) } });
}));

/** GET …/development/evidence — the evidence behind each trajectory: event references, boundaries, coverage. No note text ever. */
router.get("/student/:studentId/development/evidence", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const asOf = asOfOf(req);
  const id = String(pupil.student._id);
  const [h, p] = await Promise.all([developmentSvc.historyFor({ schoolId, studentId: id, asOf }), strengthsSvc.profileFor({ schoolId, studentId: id, asOf })]);
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
    engineVersion: h?.developmentEngineVersion ?? null, asOf: h?.asOf ?? null, versions: h?.versions ?? null,
    observations: h?.observations ?? [], evidence: developmentSvc.evidenceOf(h, p), contradictions: h?.contradictions ?? [] } });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GUIDANCE & INTERVENTIONS — downstream of the development history (Stage 15)
// ─────────────────────────────────────────────────────────────────────────────

const devGuidanceSvc = require("../services/intelligence/developmentGuidance.service");
const devInterventionsSvc = require("../services/intelligence/developmentInterventions.service");
const { requireAnyPermission: anyPermission } = require("../../middleware/permissions");

/** A pupil acts on their own record; staff need the intervention capability. The bursar has none. */
const interventionWrite = (req, res, next) => (isStudent(req) ? next() : anyPermission("interventions.create", "interventions.manage")(req, res, next));

/** GET …/development/guidance — bounded, categorical, evidence-linked guidance from the development history. Informs; never instructs. */
router.get("/student/:studentId/development/guidance", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const g = await devGuidanceSvc.guidanceFor({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)),
    guidanceEngineVersion: g?.guidanceEngineVersion ?? null, developmentEngineVersion: g?.developmentEngineVersion ?? null, asOf: g?.asOf ?? null,
    historySufficient: g?.historySufficient ?? false, items: g?.items ?? [], byCategory: g?.byCategory ?? {}, byDimension: g?.byDimension ?? {}, agency: g?.agency ?? "INFORMS_ONLY", notInferred: g?.notInferred ?? [] } });
}));

/** GET …/interventions — the pupil's development interventions, each with its observed outcome on asOf, and the triggers the history supports today. */
router.get("/student/:studentId/interventions", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const id = String(pupil.student._id), asOf = asOfOf(req), staff = !isStudent(req);
  const [docs, proposals] = await Promise.all([devInterventionsSvc.listFor({ schoolId, studentId: id }), devInterventionsSvc.proposalsFor({ schoolId, studentId: id, asOf })]);
  const items = await Promise.all(docs.map(async (d) => devInterventionsSvc.view(d, { outcome: await devInterventionsSvc.outcomeFor(d, { asOf }), staff })));
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), asOf: proposals.asOf, interventionEngineVersion: proposals.interventionEngineVersion,
    interventions: items, triggers: proposals.triggers, previews: proposals.previews, lifecycle: require("../../../shared/interventions").LIFECYCLE } });
}));

/** GET …/interventions/:interventionId — one, with its outcome. */
router.get("/student/:studentId/interventions/:interventionId", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const doc = await devInterventionsSvc.oneFor({ schoolId, studentId: String(pupil.student._id), interventionId: req.params.interventionId });
  if (!doc) return res.status(404).json({ success: false, message: "Intervention not found" });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), intervention: devInterventionsSvc.view(doc, { outcome: await devInterventionsSvc.outcomeFor(doc, { asOf: asOfOf(req) }), staff: !isStudent(req) }) } });
}));

/** POST …/interventions — propose, from a trigger the history supports. A pupil may propose only what they own. Idempotent on a client _id. */
router.post("/student/:studentId/interventions", interventionWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await devInterventionsSvc.propose({ schoolId, studentId: String(pupil.student._id), classId: pupil.student.classId ?? pupil.classId ?? null, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role, body: req.body ?? {}, asOf: asOfOf(req) });
    return res.status(201).json({ success: true, created: r.created, data: devInterventionsSvc.view(r.intervention, { staff: !isStudent(req) }) });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.supported ? { supported: err.supported } : {}) }); throw err; }
}));

/** PATCH …/interventions/:interventionId — one lifecycle action: accept, decline, activate, mark_review_due, pause, resume, cancel, complete. */
router.patch("/student/:studentId/interventions/:interventionId", interventionWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await devInterventionsSvc.act({ schoolId, studentId: String(pupil.student._id), interventionId: req.params.interventionId, action: String(req.body?.action ?? ""), actor: String(req.user._id ?? req.user.id), actorRole: req.user.role, note: req.body?.note ?? null });
    return res.json({ success: true, changed: r.changed, data: devInterventionsSvc.view(r.intervention, { staff: !isStudent(req) }) });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message }); throw err; }
}));

/** POST …/interventions/:interventionId/review — staff record a review: the observed outcome on that day, a note, and whether it completes. */
router.post("/student/:studentId/interventions/:interventionId/review", anyPermission("interventions.create", "interventions.manage"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await devInterventionsSvc.review({ schoolId, studentId: String(pupil.student._id), interventionId: req.params.interventionId, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role, note: req.body?.note ?? null, complete: Boolean(req.body?.complete), asOf: asOfOf(req) });
    return res.json({ success: true, changed: r.changed, data: devInterventionsSvc.view(r.intervention, { outcome: r.outcome, staff: true }) });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message }); throw err; }
}));

// ─────────────────────────────────────────────────────────────────────────────
// DEVELOPMENT PLANS — objectives, milestones, review, adaptation (Stage 16)
// ─────────────────────────────────────────────────────────────────────────────

const plansSvc = require("../services/intelligence/developmentPlans.service");
const viewerOfPlan = (req) => (isStudent(req) ? "student" : "staff");

const planRead = async (req, res, withSystem = false) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) { res.status(400).json({ success: false, message: "schoolId is required" }); return null; }
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return null;
  return { schoolId, pupil, id: String(pupil.student._id), asOf: asOfOf(req), viewer: viewerOfPlan(req), withSystem };
};
const planErr = (res, err) => { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.existingPlanId ? { existingPlanId: err.existingPlanId } : {}), ...(err.available ? { available: err.available } : {}), ...(err.reason ? { reason: err.reason } : {}) }); throw err; };

/** GET …/development-plans — every plan as of the day, each with the adaptive engine's current reading. */
router.get("/student/:studentId/development-plans", strengthRead, asyncHandler(async (req, res) => {
  const c = await planRead(req, res); if (!c) return undefined;
  const docs = await plansSvc.listFor({ schoolId: c.schoolId, studentId: c.id });
  const plans = (await Promise.all(docs.map(async (d) => plansSvc.view(d, { asOf: c.asOf, viewer: c.viewer, system: ["ACTIVE", "REVIEW_DUE"].includes(d.status) ? await plansSvc.systemReview({ doc: d, schoolId: c.schoolId, studentId: c.id, asOf: c.asOf }) : null })))).filter(Boolean);
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(c.schoolId, c.pupil)), asOf: c.asOf ? c.asOf.toISOString() : null, engineVersions: plansSvc.engineVersions(), plans,
    vocabulary: { objectives: require("../../../shared/developmentPlanning").OBJECTIVE_CATEGORIES, reflectionCodes: require("../../../shared/developmentPlanning").REFLECTION_CODES, skipReasons: require("../../../shared/developmentPlanning").SKIP_REASONS } } });
}));

/** GET …/development-plans/:planId — one plan as of the day, with the system reading. */
router.get("/student/:studentId/development-plans/:planId", strengthRead, asyncHandler(async (req, res) => {
  const c = await planRead(req, res); if (!c) return undefined;
  const doc = await plansSvc.oneFor({ schoolId: c.schoolId, studentId: c.id, planId: req.params.planId });
  if (!doc) return res.status(404).json({ success: false, message: "Plan not found" });
  const system = await plansSvc.systemReview({ doc, schoolId: c.schoolId, studentId: c.id, asOf: c.asOf });
  const plan = plansSvc.view(doc, { asOf: c.asOf, viewer: c.viewer, system });
  if (!plan) return res.status(404).json({ success: false, message: "Plan did not exist as of that date" });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(c.schoolId, c.pupil)), plan } });
}));

/** POST …/development-plans — create from a current guidance item. Staff, or a pupil for a plan they own. Idempotent on a client _id. */
router.post("/student/:studentId/development-plans", interventionWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await plansSvc.create({ schoolId, studentId: String(pupil.student._id), classId: pupil.student.classId ?? pupil.classId ?? null, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role, body: req.body ?? {}, asOf: asOfOf(req) });
    return res.status(201).json({ success: true, created: r.created, data: plansSvc.view(r.plan, { viewer: viewerOfPlan(req) }) });
  } catch (err) { return planErr(res, err); }
}));

/** PATCH …/development-plans/:planId — one lifecycle action (propose, accept, decline, activate, pause, resume, close, …) or an adaptation to apply. */
router.patch("/student/:studentId/development-plans/:planId", interventionWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const base = { schoolId, studentId: String(pupil.student._id), planId: req.params.planId, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role };
  try {
    if (req.body?.actionType && !req.body?.action) { const r = await plansSvc.applyAdaptation({ ...base, actionType: String(req.body.actionType) }); return res.json({ success: true, changed: true, data: plansSvc.view(r.plan, { viewer: viewerOfPlan(req) }) }); }
    const r = await plansSvc.act({ ...base, action: String(req.body?.action ?? ""), note: req.body?.note ?? null });
    return res.json({ success: true, changed: r.changed, data: plansSvc.view(r.plan, { viewer: viewerOfPlan(req) }) });
  } catch (err) { return planErr(res, err); }
}));

const planAction = (action) => asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await plansSvc.act({ schoolId, studentId: String(pupil.student._id), planId: req.params.planId, action, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role, note: req.body?.note ?? null });
    return res.json({ success: true, changed: r.changed, data: plansSvc.view(r.plan, { viewer: viewerOfPlan(req) }) });
  } catch (err) { return planErr(res, err); }
});
router.post("/student/:studentId/development-plans/:planId/accept", interventionWrite, planAction("accept"));
router.post("/student/:studentId/development-plans/:planId/decline", interventionWrite, planAction("decline"));
router.post("/student/:studentId/development-plans/:planId/pause", interventionWrite, planAction("pause"));

/** POST …/development-plans/:planId/milestones/:milestoneId — start, complete, skip (with a reason), block, unblock. Its owner or staff. */
router.post("/student/:studentId/development-plans/:planId/milestones/:milestoneId", interventionWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await plansSvc.milestone({ schoolId, studentId: String(pupil.student._id), planId: req.params.planId, milestoneId: req.params.milestoneId, action: String(req.body?.action ?? "complete"), reason: req.body?.reason ?? null, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role });
    return res.json({ success: true, changed: r.changed, data: plansSvc.view(r.plan, { viewer: viewerOfPlan(req) }) });
  } catch (err) { return planErr(res, err); }
}));

/** POST …/development-plans/:planId/reflect — the pupil's own reflection: controlled codes, an optional short note. */
router.post("/student/:studentId/development-plans/:planId/reflect", interventionWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await plansSvc.reflect({ schoolId, studentId: String(pupil.student._id), planId: req.params.planId, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role, codes: req.body?.codes ?? [], note: req.body?.note ?? null });
    return res.status(201).json({ success: true, data: plansSvc.view(r.plan, { viewer: viewerOfPlan(req) }) });
  } catch (err) { return planErr(res, err); }
}));

/** POST …/development-plans/:planId/constraints — an explicit operational constraint (staff, or the pupil about their own plan). */
router.post("/student/:studentId/development-plans/:planId/constraints", interventionWrite, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await plansSvc.constrain({ schoolId, studentId: String(pupil.student._id), planId: req.params.planId, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role, code: String(req.body?.code ?? ""), note: req.body?.note ?? null });
    return res.status(201).json({ success: true, data: plansSvc.view(r.plan, { viewer: viewerOfPlan(req) }) });
  } catch (err) { return planErr(res, err); }
}));

/** POST …/development-plans/:planId/review — staff: the system reading of the day beside the teacher's observation and decision. */
router.post("/student/:studentId/development-plans/:planId/review", anyPermission("interventions.create", "interventions.manage"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await plansSvc.review({ schoolId, studentId: String(pupil.student._id), planId: req.params.planId, actor: String(req.user._id ?? req.user.id), actorRole: req.user.role,
      teacherReview: req.body?.teacherReview ?? null, decision: String(req.body?.decision ?? "continue"), actionType: req.body?.actionType ?? null, note: req.body?.note ?? null, asOf: asOfOf(req) });
    return res.json({ success: true, data: plansSvc.view(r.plan, { viewer: "staff", system: r.system }), review: r.review });
  } catch (err) { return planErr(res, err); }
}));

/**
 * POST …/profile/rebuild — keep today's reading as a new snapshot when the
 * evidence has changed; otherwise return the one that already covers it.
 * Idempotent; engine versions are the server's; old snapshots untouched.
 */
router.post("/student/:studentId/profile/rebuild", requirePermission("insights.viewTaught"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await strengthsSvc.snapshot({ schoolId, studentId: String(pupil.student._id), classId: pupil.classId, actor: String(req.user._id ?? req.user.id), periodLabel: req.body?.periodLabel ?? null });
    return res.status(r.created ? 201 : 200).json({ success: true, created: r.created, data: r.snapshot });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message }); throw err; }
}));

/** POST /api/insights/student/:studentId/profile/snapshot — keep today's reading. Staff only. */
router.post("/student/:studentId/profile/snapshot", requirePermission("insights.viewTaught"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const { snapshot: snap } = await strengthsSvc.snapshot({
      schoolId, studentId: String(pupil.student._id), classId: pupil.classId,
      actor: String(req.user._id ?? req.user.id), periodLabel: req.body?.periodLabel ?? null, force: true,
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

// ─────────────────────────────────────────────────────────────────────────────
// LEARNING EVIDENCE — what the school's own records say, kept apart by kind
//
// Same hierarchy as strengths: staff on insights.viewTaught for pupils they
// may read; a pupil their own, by role; operator by selection; bursar out.
// The pupil's reading carries no note text and no other pupil.
// ─────────────────────────────────────────────────────────────────────────────

// A reading may be asked "as of" a date: recency and past-due are read against
// it. An audit reads a term as it stood; a snapshot always uses today.
const asOfOf = (req) => { const d = req.query.asOf ? new Date(String(req.query.asOf)) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
const learningRead = async (req, res, pick) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const r = await learningSvc.readingFor({ schoolId, studentId: String(pupil.student._id), asOf: asOfOf(req) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), ...(r ? pick(r) : { learningEvidenceVersion: null }) } });
};

/** GET …/learning-evidence — the events, the patterns, the quality, the signals. Everything, by kind. */
router.get("/student/:studentId/learning-evidence", strengthRead, asyncHandler((req, res) => learningRead(req, res, (r) => ({
  learningEvidenceVersion: r.learningEvidenceVersion, asOf: r.asOf, windows: r.windows, counts: r.counts, rejected: r.rejected,
  events: r.events, patterns: r.patterns, quality: r.quality, signals: r.signals, integration: r.integration, timeline: r.timeline, concise: r.concise, notInferred: r.notInferred,
}))));

/** GET …/learning-patterns — the patterns only. */
router.get("/student/:studentId/learning-patterns", strengthRead, asyncHandler((req, res) => learningRead(req, res, (r) => ({
  learningEvidenceVersion: r.learningEvidenceVersion, asOf: r.asOf, patterns: r.patterns, concise: r.concise, notInferred: r.notInferred,
}))));

/** GET …/learning-coverage — quality and contradictions only. */
router.get("/student/:studentId/learning-coverage", strengthRead, asyncHandler((req, res) => learningRead(req, res, (r) => ({
  learningEvidenceVersion: r.learningEvidenceVersion, asOf: r.asOf, quality: r.quality, contradictions: r.quality.contradictions, counts: r.counts,
}))));

/** GET …/learning-changes — what changed since the last snapshot. */
router.get("/student/:studentId/learning-changes", strengthRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const c = await learningSvc.changesSince({ schoolId, studentId: String(pupil.student._id) });
  const hist = await learningSvc.history({ schoolId, studentId: String(pupil.student._id) });
  return res.json({ success: true, data: { generatedAt: new Date(), ...(await identityOf(schoolId, pupil)), ...(c ?? {}),
    history: hist.map((h) => ({ snapshotId: String(h._id), snapshotNumber: h.snapshotNumber, learningEvidenceVersion: h.learningEvidenceVersion, asOf: h.asOf, generatedAt: h.generatedAt, recordedBy: h.recordedBy, events: h.evidenceBoundary?.events ?? 0, coverage: h.reading?.quality?.overall?.level ?? null })) } });
}));

/** POST …/learning-evidence/rebuild — keep today's reading; idempotent on the evidence boundary. Staff only. */
router.post("/student/:studentId/learning-evidence/rebuild", requirePermission("insights.viewTaught"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  try {
    const r = await learningSvc.rebuild({ schoolId, studentId: String(pupil.student._id), classId: pupil.classId, actor: String(req.user._id ?? req.user.id) });
    return res.status(r.created ? 201 : 200).json({ success: true, created: r.created, data: r.snapshot });
  } catch (err) { if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message }); throw err; }
}));

/** GET …/learning-evidence/consistency — live reading vs the reading from mirrored documents, diffed. */
router.get("/student/:studentId/learning-evidence/consistency", reviewRead, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return res.status(400).json({ success: false, message: "schoolId is required" });
  const pupil = await pupilForReview(req, res, schoolId, req.params.studentId);
  if (!pupil) return undefined;
  const { compareProfiles } = require("../../scripts/calibration/consistency");
  const asOf = asOfOf(req) ?? learningSvc.startOfToday();
  const [live, off] = await Promise.all([
    learningSvc.readingFor({ schoolId, studentId: String(pupil.student._id), asOf }),
    learningSvc.offlineReadingFor({ schoolId, studentId: String(pupil.student._id), asOf }),
  ]);
  const cmp = compareProfiles({ engineVersion: live?.learningEvidenceVersion ?? null, profile: live, guidance: null }, { engineVersion: off?.learningEvidenceVersion ?? null, profile: off, guidance: null });
  return res.json({ success: true, data: { generatedAt: new Date(), studentId: String(pupil.student._id), identical: cmp.identical, engineVersion: cmp.engineVersion, differences: cmp.differences } });
}));

// ─────────────────────────────────────────────────────────────────────────────
// ADVANCED INTELLIGENCE (Stage 17): explanation, synthesis, exploration
//
// Reads only. The same guard and the same pupil resolver as every strengths
// route: a pupil asks about themselves ("me"), staff on insights.viewTaught
// within their class scope, the operator with a schoolId. The viewer decides
// the projection the context builder applies; the service decides whether
// a model narrates; the validator decides whether its words are kept. No
// route here writes anything and no model is handed a way to.
// ─────────────────────────────────────────────────────────────────────────────

const advancedSvc = require("../services/intelligence/advancedIntelligence.service");
const advancedViewerOf = (req) => (isStudent(req) ? "student" : req.user?.role === ROLES.SUPER_ADMIN ? "super_admin" : req.user?.role === ROLES.SCHOOL_ADMIN ? "school_admin" : "teacher");
const advancedRead = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId ?? req.body?.schoolId);
  if (!schoolId) { res.status(400).json({ success: false, message: "schoolId is required" }); return null; }
  const pupil = await pupilForStrengths(req, res, schoolId, req.params.studentId);
  if (!pupil) return null;
  return { schoolId, pupil, id: String(pupil.student._id), asOf: asOfOf(req), viewer: advancedViewerOf(req), lang: langOf(req), identity: await identityOf(schoolId, pupil) };
};

/** GET …/intelligence-summary — the deterministic synthesis, the exploration candidates and the evidence they cite. Never a model. */
router.get("/student/:studentId/intelligence-summary", strengthRead, asyncHandler(async (req, res) => {
  const c = await advancedRead(req, res); if (!c) return undefined;
  const s = await advancedSvc.summaryFor({ schoolId: c.schoolId, studentId: c.id, asOf: c.asOf, viewer: c.viewer, lang: c.lang });
  return res.json({ success: true, data: { generatedAt: new Date(), ...c.identity, ...s } });
}));

const questionRoute = (operation) => asyncHandler(async (req, res) => {
  const c = await advancedRead(req, res); if (!c) return undefined;
  const question = req.body?.question;
  if (typeof question !== "string" || !question.trim()) return res.status(400).json({ success: false, code: "QUESTION_REQUIRED", message: "A question is required." });
  if (question.length > advancedSvc.QUESTION_MAX) return res.status(400).json({ success: false, code: "QUESTION_TOO_LONG", message: `A question is at most ${advancedSvc.QUESTION_MAX} characters.` });
  const r = await advancedSvc.explain({ schoolId: c.schoolId, studentId: c.id, asOf: c.asOf, viewer: c.viewer, lang: c.lang, question, operation, identity: c.identity });
  return res.json({ success: true, data: { generatedAt: new Date(), ...c.identity, ...r } });
});

/** POST …/explain { question } — why something is on the profile, what changed, why guidance, an intervention or a plan appeared, what evidence supports or is missing. */
router.post("/student/:studentId/explain", strengthRead, questionRoute("explain"));
/** POST …/ask { question } — the same pipeline for an open question; a career question becomes exploration, a sensitive or unauthorised one is refused. */
router.post("/student/:studentId/ask", strengthRead, questionRoute("answer"));

module.exports = router;
