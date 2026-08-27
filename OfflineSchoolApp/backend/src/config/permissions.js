// backend/src/config/permissions.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PERMISSIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Capabilities, and which roles hold them by default.
 *
 * config/roles.js answers "who is this person". This file answers "what may
 * they do", and it is the layer a school can adjust: an administrator can hand
 * the bursar a capability, or take one away, without a code change and without
 * being able to dismantle the separation the roles exist to enforce.
 *
 * ── Why the defaults are written as role sets ─────────────────────────────
 *
 * Every default below is one of the sets from config/roles.js rather than a
 * hand-listed group. That is deliberate and it is the safety property of this
 * whole change: the guards being replaced already used those sets, so a
 * permission whose default is FINANCE_ROLES admits exactly the accounts its
 * old guard admitted. Nobody gains or loses access when a route migrates from
 * authorize(SET) to requirePermission(key).
 *
 * scripts/check-role-matrix.js proves that route by route. If you are tempted
 * to widen a default here because a screen 403s, the honest fix is almost
 * always the screen — or an explicit, argued change to the set in roles.js.
 *
 * ── delegable ────────────────────────────────────────────────────────────
 *
 * A permission marked `delegable: false` cannot be granted or revoked by a
 * school administrator. Those are the ones the design exists to protect:
 *
 *   • Anything that alters a mark, publishes a result, or reissues a card.
 *     The bursar takes the money; a school that could hand them results.edit
 *     has bought a fee system and thrown away the reason for it.
 *   • User and permission management. A role that can grant itself
 *     permissions has no ceiling, and neither does anybody it appoints.
 *   • Promotion, report-card templates, school settings, sync push. Each
 *     rewrites the school rather than recording something about it.
 *   • Message audit. Reading a conversation you are not part of is the
 *     strongest right in the system and is never a side effect.
 *
 * Everything else is a school's business. A small school where the bursar also
 * runs the gate is a real school, and this is how it says so.
 *
 * ── Two roles are not adjustable at all ──────────────────────────────────
 *
 * Overrides apply to `bursar` and `teacher` only.
 *
 * super_admin holds everything, always: it is the operator of the deployment
 * and the account that fixes a school which has locked itself out.
 *
 * school_admin is fixed for exactly that reason — self-lockout. An admin who
 * can revoke school_admin permissions can revoke permissions.manage from the
 * only role that has it, and then nobody in the school can undo it. A setting
 * whose worst case is "call the vendor" is not a setting.
 *
 * student is fixed because the student surface is not built from this registry
 * — students reach their own records through routes that scope to the caller,
 * not through capability checks.
 *
 * ── What is deliberately NOT in here ─────────────────────────────────────
 *
 * Every key below is checked by something. That is enforced by
 * scripts/check-role-matrix.js, which fails on a permission nothing consults —
 * because a checkbox on the permissions screen that governs nothing is a lie
 * told to an administrator about their own school.
 *
 * Two areas therefore have no keys yet, and both are honest gaps rather than
 * oversights:
 *
 *   Messaging is governed by a matrix, not a capability: who may talk to whom
 *   depends on both parties and on per-school switches, which is what
 *   services/communication/policy.service.js exists for. Only messages.audit
 *   is here, because reading a thread you are not part of is a capability
 *   rather than a relationship.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const {
  ROLES,
  ADMIN_ROLES,
  FINANCE_ROLES,
  OFFICE_ROLES,
  TEACHING_ROLES,
  STAFF_ROLES,
} = require("./roles");

const ALL = [
  ROLES.SUPER_ADMIN,
  ROLES.SCHOOL_ADMIN,
  ROLES.BURSAR,
  ROLES.TEACHER,
  ROLES.STUDENT,
];

/** Shorthand for a definition. */
const p = (key, module, defaults, delegable, note) => ({
  key, module, defaults, delegable, note,
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY
//
// Grouped by module, in the order the modules appear in the product. `defaults`
// is the set of roles that hold the capability out of the box; `delegable` says
// whether a school administrator may change that for the bursar or a teacher.
// ─────────────────────────────────────────────────────────────────────────────

const PERMISSION_DEFS = [

  // ── Money in ──────────────────────────────────────────────────────────────
  p("fees.view",        "fees", FINANCE_ROLES, true,
    "Read the ledger: structures, a student account, the arrears list."),
  p("fees.manage",      "fees", FINANCE_ROLES, true,
    "Create fee structures, apply them to classes, record and reverse payments."),

  // ── Money out ─────────────────────────────────────────────────────────────
  p("expenses.view",    "expenses", FINANCE_ROLES, true, null),
  p("expenses.manage",  "expenses", FINANCE_ROLES, true,
    "Record and void expenses, and maintain expense categories."),

  p("payroll.view",     "payroll", FINANCE_ROLES, true, null),
  p("payroll.process",  "payroll", FINANCE_ROLES, true,
    "Generate, confirm and reverse a payroll run."),
  p("payroll.setSalary","payroll", ADMIN_ROLES, false,
    "Set what a member of staff is owed. Never the paying clerk: somebody who " +
    "can both raise a salary and pay it is not meaningfully supervised."),

  p("finance.reports",  "finance", FINANCE_ROLES, true, null),

  p("fees.refund",      "fees", FINANCE_ROLES, true,
    "Give money back. Above the school's refund threshold this raises a request " +
    "rather than writing the payment."),
  p("fees.waive",       "fees", FINANCE_ROLES, true,
    "Reduce or write off a charge. Above the waiver threshold this raises a " +
    "request rather than reducing the bill."),
  p("fees.plan",        "fees", FINANCE_ROLES, true,
    "Agree an instalment plan with a family. Changes when the fees are due, " +
    "never how much is owed — a reduction is a waiver, which needs approval."),
  p("fees.remind",      "fees", FINANCE_ROLES, true,
    "Send a family a reminder about what is outstanding. Reads the due date " +
    "entered on the fee structure to decide who is late."),
  p("fees.penalize",    "fees", FINANCE_ROLES, true,
    "Add the late fee a structure defines to bills that have passed their due " +
    "date. Adds money to a family's bill, so it is never automatic."),

  // ── The second signature ──────────────────────────────────────────────────
  //
  // Two capabilities, and the split between them IS the segregation. Raising is
  // part of running the fee desk and travels with the money permissions above.
  // Deciding is the countersignature, and it is locked: a school that could
  // hand approvals.decide to the bursar would have a workflow that asks one
  // person to sign their own work, which is worse than no workflow at all
  // because it looks like a control.
  p("approvals.view",   "approvals", FINANCE_ROLES, true,
    "See what is waiting for a decision. A bursar sees their own requests; an " +
    "administrator sees the school's."),
  p("approvals.decide", "approvals", ADMIN_ROLES, false,
    "Approve or reject. Never the person who raised it — that is enforced " +
    "per request, by user, and holds for a super admin too."),
  p("approvals.configure", "approvals", ADMIN_ROLES, false,
    "Set the amounts above which a second signature is required."),

  // ── The people ────────────────────────────────────────────────────────────
  p("students.view",    "students", OFFICE_ROLES, true,
    "The roster: name, admission number, class, guardian, contact. No marks."),
  p("students.viewTaught", "students", TEACHING_ROLES, true,
    "The narrower question a teacher asks — the students in my own classes."),
  p("students.manage",  "students", ADMIN_ROLES, true,
    "Create and edit a student record, suspend, restore, move a class."),
  p("students.admit",   "students", ADMIN_ROLES, false,
    "Approve or reject an application. Who joins the school is not delegated."),
  p("students.delete",  "students", ADMIN_ROLES, false, null),
  p("students.viewFull", "students", ADMIN_ROLES, true,
    "The whole student record in the admission console, as opposed to the " +
    "roster fields students.view opens."),

  p("teachers.view",    "teachers", ADMIN_ROLES, true,
    "The staff list and one member of staff's record."),
  p("teachers.manage",  "teachers", ADMIN_ROLES, false,
    "Create, edit and deactivate staff accounts, and assign them to classes. " +
    "Assignment decides who may enter marks for whom."),

  p("users.manage",     "users", ADMIN_ROLES, false,
    "Read and administer accounts across the school."),

  // ── The academic frame ────────────────────────────────────────────────────
  p("classes.view",     "classes", OFFICE_ROLES, true,
    "The class list. The bursar needs it: a fee structure is billed to classes."),
  p("classes.manage",   "classes", ADMIN_ROLES, true,
    "Create, rename and remove a class."),

  p("subjects.view",    "subjects", ADMIN_ROLES, true, null),
  p("subjects.manage",  "subjects", ADMIN_ROLES, true,
    "Create, edit and remove a subject, and set its coefficient."),

  p("school.view",      "school", OFFICE_ROLES, true,
    "The school's own name, logo and address — the letterhead on every receipt " +
    "and printed document."),

  p("timetable.view",   "timetable", TEACHING_ROLES, true, null),
  p("timetable.manage", "timetable", ADMIN_ROLES, true, null),

  p("periods.view",     "periods", TEACHING_ROLES, true, null),
  p("periods.manage",   "periods", ADMIN_ROLES, true,
    "The shape of the school day. Every timetable is built on it."),

  // ── Attendance ────────────────────────────────────────────────────────────
  p("attendance.view",  "attendance", STAFF_ROLES, true,
    "Registers and attendance reports. Read-only — see attendance.mark."),
  p("attendance.mark",  "attendance", TEACHING_ROLES, true, null),
  p("attendance.markStaff", "attendance", ADMIN_ROLES, true,
    "The staff register. A teacher marking a colleague present is not the job."),

  // ── Exams and results ─────────────────────────────────────────────────────
  p("exams.view",       "exams", TEACHING_ROLES, true, null),
  p("exams.manage",     "exams", ADMIN_ROLES, false,
    "Create exams, configure subjects and marks, lock and unlock results."),

  p("results.view",     "results", STAFF_ROLES, true,
    "Read a result, a ranking or a report card. A look, not a licence."),
  p("results.edit",     "results", TEACHING_ROLES, false,
    "Enter or recalculate a mark. Locked: the person who collects the fees " +
    "must never be able to move the grade of the child who paid them."),
  p("results.publish",  "results", ADMIN_ROLES, false,
    "Publish, delete, reissue an already-issued card, and read the change log."),

  // TEACHING_ROLES rather than ADMIN_ROLES, because that is the guard this
  // replaces: a teacher legitimately looks up what a class was issued. The web
  // console does not offer them the screen, which is a menu decision — the API
  // has always allowed the read and this does not change it.
  p("reports.viewIssued", "reports", TEACHING_ROLES, true,
    "Read the frozen copy of a report card that has already been issued."),
  p("reports.manage",   "reports", ADMIN_ROLES, false,
    "The report-card template every card in the school is rendered from, and " +
    "replacing an issued card — which supersedes a document a parent holds."),

  // ── End of year ───────────────────────────────────────────────────────────
  p("promotion.run",    "promotion", ADMIN_ROLES, false,
    "Rewrite which class every child belongs to. The most consequential " +
    "academic act in the system."),

  // ── Paper ─────────────────────────────────────────────────────────────────
  p("documents.print",  "documents", TEACHING_ROLES, true,
    "Class lists, ID cards, transcripts — academic documents. A receipt " +
    "prints from the fee ledger instead."),
  p("documents.manage", "documents", ADMIN_ROLES, false,
    "Student photos, document verification, and handing out guardian codes."),

  p("exports.roster",   "exports", STAFF_ROLES, true, null),
  p("exports.finance",  "exports", FINANCE_ROLES, true, null),
  p("exports.academic", "exports", ADMIN_ROLES, true,
    "Class history: the record of who was promoted, held back or moved."),

  // ── The gate ──────────────────────────────────────────────────────────────
  p("gate.scan",        "gate", TEACHING_ROLES, true,
    "The person on the gate in the morning is usually a teacher on duty."),
  p("gate.manage",      "gate", ADMIN_ROLES, true,
    "Reissue a card, flush the notification queue."),

  // ── Talking ───────────────────────────────────────────────────────────────
  //
  // Reading an announcement is not in here on purpose: announcement reads are
  // open to every signed-in account, students included, so there is no
  // capability to grade. Sending a direct message is not in here either — see
  // the note at the top of the file about the messaging matrix.
  p("announcements.view", "announcements", STAFF_ROLES, true,
    "Read the school's announcements. Separate from posting one, which is " +
    "announcements.create — and added because nothing covered READING an " +
    "announcement: those routes predate this layer and still gate on role " +
    "names directly. It governs whether a device may mirror them for offline " +
    "use (src/config/syncFeed.js); the read routes themselves are unchanged, " +
    "and every staff role holds it, so nothing that worked stops working."),
  p("announcements.create", "announcements", TEACHING_ROLES, true,
    "A broadcast to the school. Fee reminders go to one family through " +
    "messages.send instead."),
  p("announcements.manage", "announcements", ADMIN_ROLES, true,
    "Act on somebody else's announcement, and read the delivery audit."),
  p("messages.audit",   "messages", ADMIN_ROLES, false,
    "Read a conversation you are not part of. Recorded server-side."),

  // ── Cross-cutting reads ───────────────────────────────────────────────────
  p("insights.view",    "insights", OFFICE_ROLES, true,
    "The watch list. Names children by fee arrears, so teachers are out."),

  // ── Coursework ────────────────────────────────────────────────────────────
  p("homework.view",    "homework", TEACHING_ROLES, true,
    "Students reach their own homework without this — the list route lets them " +
    "through on identity, because homework is for them to read."),
  p("homework.manage",  "homework", TEACHING_ROLES, true, null),
  p("quiz.author",      "quiz", TEACHING_ROLES, true,
    "The question bank, answers included."),

  // ── The machinery ─────────────────────────────────────────────────────────
  //
  // dashboard.view covers /api/admin/stats and the per-module /*/stats
  // endpoints behind it. One capability rather than six, because they are one
  // screen: the figures on the admin dashboard. Splitting them would mean a
  // school could grant half a dashboard, which is not a state anybody wants.
  p("dashboard.view",   "dashboard", ADMIN_ROLES, true,
    "The school-wide figures on the administrator dashboard."),

  p("settings.view",    "settings", ADMIN_ROLES, true,
    "Read school configuration: grading, ID cards, analytics."),
  p("settings.manage",  "settings", ADMIN_ROLES, false,
    "Change school configuration, grading and the academic year. Locked: these " +
    "decide how every mark in the school is interpreted."),

  p("permissions.manage", "permissions", ADMIN_ROLES, false,
    "This screen. A role that can grant itself permissions has no ceiling."),
  p("sync.push",        "sync", ADMIN_ROLES, false,
    "Write period definitions and promotion decisions from a device."),
];

const PERMISSION_KEYS = PERMISSION_DEFS.map((d) => d.key);

const BY_KEY = new Map(PERMISSION_DEFS.map((d) => [d.key, d]));

const MODULES = [...new Set(PERMISSION_DEFS.map((d) => d.module))];

/** Keys an administrator may grant or revoke. */
const DELEGABLE_KEYS = PERMISSION_DEFS.filter((d) => d.delegable).map((d) => d.key);

/** Keys nobody may grant or revoke through the API. */
const LOCKED_KEYS = PERMISSION_DEFS.filter((d) => !d.delegable).map((d) => d.key);

/** Roles whose permissions a school administrator may adjust. */
const ADJUSTABLE_ROLES = [ROLES.BURSAR, ROLES.TEACHER];

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULTS PER ROLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The out-of-the-box permission set for each role, inverted from the registry
 * so the two can never disagree.
 *
 * super_admin is given every key rather than only those naming it. It appears
 * in every set in roles.js already, so the result is identical today — stating
 * it explicitly means a permission added tomorrow with a narrower default
 * cannot accidentally lock out the account that exists to fix things.
 */
const DEFAULTS_BY_ROLE = Object.freeze(
  ALL.reduce((acc, role) => {
    acc[role] =
      role === ROLES.SUPER_ADMIN
        ? [...PERMISSION_KEYS]
        : PERMISSION_DEFS.filter((d) => d.defaults.includes(role)).map((d) => d.key);
    return acc;
  }, {})
);

/**
 * Is `key` a permission this codebase knows about?
 *
 * Used at the edges — an override read back from the database, a key arriving
 * in a request body. A typo must be dropped rather than stored, or a school
 * ends up with a permission nothing will ever check.
 */
const isPermission = (key) => BY_KEY.has(String(key ?? ""));

const definitionOf = (key) => BY_KEY.get(String(key ?? "")) ?? null;

module.exports = {
  PERMISSION_DEFS,
  PERMISSION_KEYS,
  MODULES,
  DELEGABLE_KEYS,
  LOCKED_KEYS,
  ADJUSTABLE_ROLES,
  DEFAULTS_BY_ROLE,
  isPermission,
  definitionOf,
};
