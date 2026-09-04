// backend/src/config/syncFeed.js
"use strict";

/**
 * What a device is allowed to mirror.
 *
 * ── Why this file is a security boundary and not a convenience ────────────
 *
 * An offline client keeps a COPY of whatever it is sent, on a machine in a
 * school office, in a file anybody with the machine can read. So the question
 * "what may this caller pull" is exactly the question "what may this caller
 * read", and any gap between the two is a gap that persists to disk.
 *
 * The REST routes answer that question per request, with a capability each.
 * This table answers it per collection, with the same capabilities — and the
 * assertions in scripts/check-sync-feed.js exist to keep the two answers the
 * same. A collection reachable here but not there would let a bursar mirror
 * exam marks; the reverse would leave a screen permanently empty on the desktop
 * with nothing saying why.
 *
 * ── Why every model must be classified ───────────────────────────────────
 *
 * Because the dangerous case is the one nobody decided about. A new model added
 * to src/db/models is, by omission, either invisible to every desktop (a screen
 * that never works and nobody knows why) or — if the feed ever grew a default —
 * mirrored to everyone. Neither should be reachable by forgetting.
 *
 * So the boot-time check below refuses to start if a model is in neither list.
 * Adding a model means saying, once, whether a device may hold it. That is a
 * sentence of thought at the moment the author has the context, instead of a
 * question somebody else has to reconstruct later.
 */

const fs   = require("fs");
const path = require("path");

const { ROLES, STAFF_ROLES, ADMIN_ROLES } = require("./roles");
const { isPermission }       = require("./permissions");

// ─────────────────────────────────────────────────────────────────────────────
// SCOPES
//
// A capability says whether a caller may read a KIND of thing. A scope says
// WHICH of them. The two are not interchangeable: a teacher holds
// students.viewTaught, and what makes that safe is not the capability but the
// filter that goes with it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything in the caller's school. The floor, not a scope in itself —
 * the route applies tenancy regardless, and this documents that nothing
 * further is narrowed.
 */
const wholeSchool = () => ({});

/**
 * Only the pupils this teacher actually teaches.
 *
 * A teacher's timetable determines their classes, and their classes determine
 * their pupils. Without this a teacher's desktop would mirror the whole roster —
 * every guardian's name and phone number for the school — which is precisely
 * what the capability students.viewTaught exists to prevent.
 */
const taughtStudentsOnly = async (req, models) => {
  if (req.user?.role !== ROLES.TEACHER) return {};

  const teacherId = String(req.user._id ?? req.user.id);
  const assignments = await models.TeacherAssignment.find({
    schoolId: req.user.schoolId,
    $or: [{ teacher: teacherId }, { teacherId }],
    deletedAt: null,
  }).select("class classId").lean();

  const classIds = [...new Set(
    assignments.map((a) => String(a.classId ?? a.class ?? "")).filter(Boolean)
  )];

  // No classes means no pupils — said explicitly, because an empty $in would
  // otherwise be read as "no filter" by anything that builds on this.
  return { classId: { $in: classIds } };
};

/**
 * Only results that have been published, unless the caller is an admin.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * GET /api/results/:examId is gated on results.view, which a bursar and a
 * teacher both hold — and then, INSIDE the handler, it forces
 * isPublished: true for anybody who is not an admin. So the server has never
 * shown an unpublished result to a teacher.
 *
 * The feed had no such rule, so it mirrored the whole collection: unpublished
 * marks, on a teacher's or a bursar's machine, in a file they can read. That is
 * exactly the gap this file's own header warns about — a difference between what
 * a caller may PULL and what they may READ is a difference that persists to
 * disk, and a local handler filtering it afterwards is a screen being polite
 * about data that should not have been sent.
 *
 * Unpublished marks are a real confidence: a provisional grade seen early is a
 * grade argued about before the school has decided it.
 *
 * ── Why the admin list rather than results.publish ────────────────────────
 *
 * Because the controller uses the roles, not a capability — isAdmin(role) over
 * ["super_admin", "school_admin", "admin"]. Reproducing the rule as written
 * keeps the two the same; pairing it with results.publish instead would be a
 * different rule that happens to agree today. ("admin" in that list is the dead
 * legacy string, aliased to school_admin at the door, so ADMIN_ROLES covers it.)
 */
const publishedUnlessAdmin = (req) =>
  ADMIN_ROLES.includes(req.user?.role) ? {} : { isPublished: true };

// ─────────────────────────────────────────────────────────────────────────────
// THE FEED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef  {object} FeedEntry
 * @property {string}   collection  Name the client stores it under.
 * @property {string}   model       Mongoose model name.
 * @property {string|string[]} permission  Capability the caller must hold. An
 *           array means ANY of them is enough — used where two capabilities
 *           genuinely both grant reading the collection and differ in WHICH
 *           documents, with the scope drawing that line. Not a place to pair a
 *           collection with something loosely related.
 * @property {Function} [scope]     Extra filter, given (req, models).
 * @property {string[]} [omit]      Fields never sent, whatever the caller holds.
 * @property {string}   [why]       Only where the pairing is not obvious.
 */

/** @type {FeedEntry[]} */
const FEED = [
  // ── The shape of the school ──────────────────────────────────────────────
  { collection: "school",  model: "School",  permission: "school.view" },
  { collection: "class",   model: "Class",   permission: "classes.view" },
  { collection: "subject", model: "Subject", permission: "subjects.view" },
  { collection: "period",  model: "Period",  permission: "periods.view" },
  {
    collection: "teacherAssignment", model: "TeacherAssignment",
    permission: "subjects.view",
    why: "Which teacher takes which subject in which class. Paired with " +
         "subjects.view because that is the screen it is drawn on, and it " +
         "carries no more than the names those three things already have.",
  },
  { collection: "timetableSlot", model: "TimetableSlot", permission: "timetable.view" },
  { collection: "gradingConfig", model: "GradingConfig", permission: "results.view" },
  {
    collection: "announcement", model: "Announcement",
    permission: "announcements.view",
    why: "announcements.view was added for this. Nothing previously covered " +
         "READING an announcement — those routes gate on role names directly " +
         "and predate the capability layer — so there was no honest capability " +
         "to pair this with. Inventing a weak pairing (dashboard.view, say) " +
         "would have made the boundary a fiction.",
  },

  // ── People ───────────────────────────────────────────────────────────────
  {
    collection: "student", model: "Student",
    // Either is enough, because they are the same permission to read pupils
    // asked at two scopes — and a teacher holds ONLY viewTaught. Requiring
    // students.view alone would have given a teacher's desktop no pupils at
    // all, which is how this was first written and what the assertions caught.
    permission: ["students.view", "students.viewTaught"],
    scope: taughtStudentsOnly,
    why: "Not students.viewFull: the mirror carries the roster a school works " +
         "from every day, not the fuller record behind one pupil. Which pupils " +
         "is decided by the scope — a caller holding only viewTaught gets the " +
         "classes they teach, and one holding students.view gets the school.",
  },
  {
    collection: "user", model: "User",
    permission: "users.manage",
    // Not a precaution — the schema marks password select:false, so a plain
    // .find() would omit it anyway. Named here so that a future projection
    // change cannot quietly start including it, and because tempPassword is
    // NOT select:false.
    omit: ["password", "tempPassword"],
    why: "The staff directory. users.manage rather than teachers.view because " +
         "this collection includes admin and bursar accounts, not only " +
         "teachers — and who holds an account with authority over the " +
         "school's money is not roster information.",
  },

  // ── Money ────────────────────────────────────────────────────────────────
  { collection: "feeStructure", model: "FeeStructure", permission: "fees.view" },
  { collection: "feeCharge",    model: "FeeCharge",    permission: "fees.view" },
  { collection: "feePayment",   model: "FeePayment",   permission: "fees.view" },
  { collection: "paymentPlan",  model: "PaymentPlan",  permission: "fees.view" },
  { collection: "expense",         model: "Expense",         permission: "expenses.view" },
  { collection: "expenseCategory", model: "ExpenseCategory", permission: "expenses.view" },
  { collection: "payrollRun",      model: "PayrollRun",      permission: "payroll.view" },
  { collection: "salaryPayment",   model: "SalaryPayment",   permission: "payroll.view" },
  {
    collection: "salaryStructure", model: "SalaryStructure",
    permission: "payroll.setSalary",
    why: "What each member of staff is paid, which is a narrower thing than " +
         "payroll.view. Somebody who processes a payroll run needs the totals; " +
         "they do not need every colleague's salary mirrored onto their machine.",
  },
  { collection: "approvalRequest", model: "ApprovalRequest", permission: "approvals.view" },

  // ── Academic ─────────────────────────────────────────────────────────────
  /**
   * TWO models, not one, and this entry used to name a third that does not exist.
   *
   * src/db/models/Attendance.js registers StudentAttendance and
   * TeacherAttendance and nothing called "Attendance". A feed entry naming an
   * unregistered model does not throw — the endpoint answers
   * { error: "MODEL_NOT_REGISTERED" } for that collection and the client stores
   * nothing — so attendance was silently never mirrored at all. The boot check
   * below could not catch it either, because it verifies that every model FILE
   * is classified and a file may register whatever names it likes.
   * scripts/check-sync-feed.js now asserts registration as well.
   *
   * Both are gated on attendance.view, which is what the read routes use:
   * staffRead in attendance.routes.js is requirePermission("attendance.view")
   * for the staff register as much as for the pupils'. markStaff gates WRITING
   * it, which is a different question.
   */
  { collection: "studentAttendance", model: "StudentAttendance", permission: "attendance.view" },
  { collection: "teacherAttendance", model: "TeacherAttendance", permission: "attendance.view" },
  { collection: "exam",         model: "Exam",         permission: "exams.view" },
  { collection: "examSubject",  model: "ExamSubject",  permission: "exams.view" },
  { collection: "studentScore", model: "StudentScore", permission: "results.view" },
  { collection: "resultSummary", model: "ResultSummary", permission: "results.view" },
  {
    collection: "termResult", model: "TermResult",
    permission: "results.view",
    scope: publishedUnlessAdmin,
    why: "Scoped like ExamResult: non-admins only see published term results. " +
         "Mirrored so the desktop can render term report cards offline.",
  },
  {
    collection: "annualResult", model: "AnnualResult",
    permission: "results.view",
    scope: publishedUnlessAdmin,
    why: "Scoped like ExamResult: non-admins only see published annual results. " +
         "Mirrored so the desktop can render annual report cards offline.",
  },
  {
    collection: "academicStructure", model: "AcademicStructure",
    permission: "exams.view",
    why: "The academic year layout (terms, sequences, promotion rules). Needed " +
         "by the desktop to create exams and compute term/annual averages offline.",
  },
  { collection: "grade",        model: "Grade",        permission: "results.view" },
  { collection: "homework",     model: "Homework",     permission: "homework.view" },
  { collection: "reportTemplate", model: "ReportTemplate", permission: "reports.manage" },
  { collection: "enrollment",   model: "Enrollment",   permission: ["students.view", "students.viewTaught"] },
  { collection: "promotionRun",      model: "PromotionRun",      permission: "promotion.run" },
  { collection: "promotionDecision", model: "PromotionDecision", permission: "promotion.run" },
  { collection: "studentApplication", model: "StudentApplication", permission: "students.admit" },
];

// ─────────────────────────────────────────────────────────────────────────────
// DELIBERATELY NOT MIRRORED
//
// Each with the reason, because "it is not in the feed" is not an answer
// somebody can act on a year from now. Anything here is online-only, and a
// screen that needs it has to say so rather than showing an empty list.
// ─────────────────────────────────────────────────────────────────────────────

const EXCLUDED = {
  // The FILE, whose two registered models are in the FEED above as
  // studentAttendance and teacherAttendance. Listed here so the filename-based
  // classification check is satisfied without implying the data is unmirrored.
  Attendance:
    "Not a model name at all — the file registers StudentAttendance and " +
    "TeacherAttendance, both of which ARE mirrored. See the note on them.",

  // ── Holds secrets ───────────────────────────────────────────────────────
  Notification:
    "The rendered message body, which for adminWelcome and every password " +
    "reset CONTAINS THE TEMPORARY PASSWORD. Mirroring this would write staff " +
    "credentials into a SQLite file on an office machine, in clear text, and " +
    "keep them there. A screen that needs delivery history reads it online.",

  IdempotencyKey:
    "Server-side replay protection. A client holding a copy could only use it " +
    "to guess which requests have been made.",

  // ── Server-authoritative, and meaningless on a client ──────────────────
  Counter:
    "The atomic sequences behind receipt and enrolment numbers. Two offline " +
    "machines holding a copy would both believe they knew the next value, " +
    "which is exactly the collision the device code exists to avoid.",

  SyncLog:
    "A record of other devices' syncs. Operational, not school data.",

  SyncOverwrite:
    "An instruction to one specific device, consumed by the existing mobile " +
    "sync engine. Not state to mirror.",

  // ── Messaging: a separate audience question ─────────────────────────────
  Conversation:
    "Private correspondence between staff and families. There is a policy " +
    "layer over who may read a thread (services/communication/policy.service) " +
    "and it is per-thread, not per-collection — so it cannot be expressed as " +
    "one capability here. Online-only until the feed can carry a per-document " +
    "scope.",

  Message:
    "As Conversation. messages.audit is an audit capability, not a licence to " +
    "mirror every message in the school.",

  GuardianAccess:
    "Which guardian may see which pupil. Read on demand by the portal; a stale " +
    "mirrored copy of an access grant is the one kind of staleness that must " +
    "not happen.",

  // ── Belongs to another surface entirely ────────────────────────────────
  GateEvent:
    "Arrival and departure scans, written by the gate device and read live. A " +
    "desktop mirror of it would be out of date the moment it was fetched.",

  DocumentVerification:
    "Public verification records, reached by their own unauthenticated route.",

  GeneratedReport:
    "Rendered report-card PDFs. Files, not documents — they belong in a file " +
    "cache with its own size budget, not in the document mirror.",

  Content:
    "Uploaded teaching material. Same reason: files.",

  QuizModule:
    "Quiz definitions including the answers. The mobile app has its own " +
    "carefully-scoped cache for these (examCache.service) precisely because " +
    "mirroring answers to a device is a decision needing more care than a " +
    "capability check.",

  ResultChangeLog:
    "An audit trail of mark changes. Append-only server-side and read on " +
    "demand; mirroring it would double the academic data on the machine to " +
    "answer a question that is asked rarely.",

  ExamSubject: null,   // placeholder overwritten below — see the check
};

// ExamSubject is in the FEED. Left out of EXCLUDED properly rather than
// carrying a null, which the classification check would treat as unexplained.
delete EXCLUDED.ExamSubject;

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION CHECK — runs at require time
// ─────────────────────────────────────────────────────────────────────────────

const MODELS_DIR = path.join(__dirname, "..", "db", "models");

/** Every model file on disk, by its model name. */
const modelNames = () =>
  fs.readdirSync(MODELS_DIR)
    .filter((f) => f.endsWith(".js"))
    // index.js registers the others; it declares no schema of its own, so it
    // is not a model to classify. It exists because the feed resolves models
    // by name through mongoose.models, and a model no live module happened to
    // require was silently unservable — see the note in db/models/index.js.
    .filter((f) => f !== "index.js")
    .map((f) => f.replace(/\.js$/, ""));

/**
 * Fail at boot rather than at request time.
 *
 * The same reasoning as requirePermission throwing on an unknown capability:
 * a misconfiguration that only shows up when a particular caller hits a
 * particular path is a misconfiguration that reaches production.
 */
const assertEveryModelIsClassified = () => {
  const inFeed     = new Set(FEED.map((e) => e.model));
  const excluded   = new Set(Object.keys(EXCLUDED));
  const unclassified = modelNames().filter((m) => !inFeed.has(m) && !excluded.has(m));

  if (unclassified.length) {
    throw new Error(
      `src/config/syncFeed.js does not say whether a device may mirror: ` +
      `${unclassified.join(", ")}.\n` +
      `Add each to FEED with the capability that gates it, or to EXCLUDED ` +
      `with the reason it is online-only.`
    );
  }

  const both = [...inFeed].filter((m) => excluded.has(m));
  if (both.length) {
    throw new Error(`syncFeed lists these as both mirrored and excluded: ${both.join(", ")}`);
  }

  const unexplained = Object.entries(EXCLUDED).filter(([, why]) => !why || !String(why).trim());
  if (unexplained.length) {
    throw new Error(
      `These exclusions have no reason recorded: ${unexplained.map(([m]) => m).join(", ")}`
    );
  }

  const badPermission = FEED.filter(
    (e) => !required(e).every((k) => isPermission(k))
  );
  if (badPermission.length) {
    throw new Error(
      `syncFeed names capabilities that do not exist: ` +
      badPermission.map((e) => `${e.collection} -> ${required(e).join("|")}`).join(", ")
    );
  }
};

/** The capabilities that would each be sufficient for one entry. */
const required = (entry) =>
  Array.isArray(entry.permission) ? entry.permission : [entry.permission];

/** Does this set of held capabilities satisfy the entry? */
const satisfies = (entry, held) => required(entry).some((k) => held.has(k));

/**
 * KNOWN GAPS — written down because a silent gap is the same as a bug.
 *
 * These follow from the capability model as it stands rather than from any
 * decision taken here, and the honest thing is to record them rather than pair
 * a collection with a loosely-related capability to make a screen light up.
 *
 * A TEACHER CANNOT MIRROR class, subject OR teacherAssignment. No capability
 * grants a teacher any of them: classes.view and subjects.view both default to
 * admin and bursar only. Today a teacher's screens get that data from the
 * /api/teacher routes and from /sync/pull, which are scoped by role in their
 * own way rather than by capability — so the data is reachable, just not
 * through this feed. The consequence for the desktop is that a teacher's
 * timetable would render class and subject IDS rather than names.
 *
 * Fixing it properly means deciding whether a teacher holds a
 * "may see the class list" capability, which is a change to the role matrix and
 * belongs in its own commit with its own thought — not as a side effect of
 * building a sync feed.
 *
 * A BURSAR CAN MIRROR EVERY EXAM MARK, because results.view defaults to include
 * the bursar. That is the existing model and this feed follows it faithfully,
 * but it is worth a second look precisely BECAUSE of offline: online it means a
 * screen a bursar would never visit, and offline it means a permanent copy of
 * the school's marks on the finance office machine. Mirroring makes an
 * over-broad capability more consequential than it was.
 */
const KNOWN_GAPS = [
  {
    who: "teacher",
    collections: ["class", "subject", "teacherAssignment"],
    because: "no capability grants a teacher any of them; their screens read " +
             "through /api/teacher and /sync/pull instead",
  },
  {
    who: "bursar",
    collections: ["user"],
    because: "a bursar holds payroll.view but not users.manage, so payslips " +
             "mirror without the staff names the payroll screen joins on — the " +
             "server reads those names gated only by payroll.view. The desktop " +
             "declines that one view rather than showing a payroll with every " +
             "name blank. Closing it properly means the feed being able to say " +
             "\"names, not the account directory\", which it cannot yet",
  },
];

const byCollection = new Map(FEED.map((e) => [e.collection, e]));

// Invoked here, at the very bottom, rather than beside its definition: it reads
// required() and every const above, and calling it earlier put it in front of
// their initialisation — a temporal dead zone error at require time, which
// takes the whole server down on boot. Which is the intended failure mode for a
// misclassified model, but not for this.
assertEveryModelIsClassified();

module.exports = {
  FEED,
  EXCLUDED,
  KNOWN_GAPS,
  STAFF_ROLES,
  required,
  satisfies,
  byCollection,
  modelNames,
  assertEveryModelIsClassified,
  scopes: { wholeSchool, taughtStudentsOnly, publishedUnlessAdmin },
};
