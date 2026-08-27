// backend/src/config/roles.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROLES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The one place a role name is written down.
 *
 * Before this file existed, authorisation was spelled three different ways —
 * `authorize("admin", "school_admin", "super_admin")` in some routers, a
 * module-local `new Set([...])` in others, and a bare `req.user.role === ...`
 * in the rest. Every one of them carried its own copy of the role list, which
 * is why "admin" survived in twenty places after it stopped being a role
 * anybody could hold (see normalizeRole below).
 *
 * Adding a role to a system like that is the dangerous kind of change: a list
 * you miss either hands the new role a power it should not have, or locks it
 * out of a screen its whole job depends on, and neither shows up until someone
 * hits the route. The sets below exist so that a new role is one edit.
 *
 * ── The five roles ────────────────────────────────────────────────────────
 *
 *   super_admin   The operator of the deployment. Crosses schools.
 *   school_admin  Runs one school: users, academics, configuration, approvals.
 *   bursar        Runs one school's money. Reads the roster; touches no grade.
 *   teacher       Teaches: registers, scores, homework, their own classes.
 *   student       Their own record and their own learning.
 *
 * Guardians are deliberately absent. A parent is not a User and has no role —
 * they authenticate through the portal against a GuardianAccess row. See
 * services/communication/policy.service.js, which speaks in principals rather
 * than roles for exactly this reason.
 *
 * ── Why the bursar is not a second admin ──────────────────────────────────
 *
 * A bursar handles cash daily and is the one person in the building with a
 * standing reason to touch a student's record. Giving them school_admin — as
 * this codebase effectively did, since the fee router's guard was the admin
 * guard — means the person who takes the money can also change the grade of
 * the child whose parent paid it, promote them, and edit the audit trail
 * afterwards. The separation below is not bureaucracy; it is what makes the
 * ledger worth believing.
 *
 * FINANCE_ROLES keeps the admins in it on purpose. An admin who cannot see
 * the books cannot approve anything, and approval is the half of segregation
 * of duties that actually protects the school.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ROLES = {
  SUPER_ADMIN:  "super_admin",
  SCHOOL_ADMIN: "school_admin",
  BURSAR:       "bursar",
  TEACHER:      "teacher",
  STUDENT:      "student",
};

/** Every value the User.role enum accepts, in descending authority. */
const ALL_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.SCHOOL_ADMIN,
  ROLES.BURSAR,
  ROLES.TEACHER,
  ROLES.STUDENT,
];

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY NAMES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "admin" was never a role in the User schema — the enum has always been
 * super_admin | school_admin | teacher | student, and admin.routes.js maps an
 * incoming "admin" to "school_admin" before it is ever stored. Yet "admin"
 * appeared in every guard list in the codebase, which is a string no account
 * could ever match: dead code that read like a permission.
 *
 * It is dropped from the guards and normalised here instead. The mapping is
 * kept rather than deleted because a database seeded before the enum existed
 * could still hold a row saying "admin", and silently locking that person out
 * of their own school is a worse outcome than one alias.
 */
const ROLE_ALIASES = {
  admin: ROLES.SCHOOL_ADMIN,
};

/**
 * Canonical role for a stored value. Applied where a role enters the system —
 * middleware/auth.js when it stamps req.user, and the login response — so that
 * every guard downstream compares against the five names above and nothing else.
 *
 * @param {unknown} role
 * @returns {string|null} a value from ALL_ROLES, or null if unrecognised
 */
const normalizeRole = (role) => {
  const raw = String(role ?? "").trim().toLowerCase();
  if (!raw) return null;
  const canonical = ROLE_ALIASES[raw] ?? raw;
  return ALL_ROLES.includes(canonical) ? canonical : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// ROLE SETS
//
// Named for the authority they carry, not for who happens to be in them today.
// A guard that says ADMIN_ROLES states "this is a governance decision"; one
// that says FINANCE_ROLES states "this is the ledger". That is what makes the
// next role cheap to add.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Governance, configuration, academic authority, and approval.
 *
 * Everything the school would not survive being wrong: user accounts, roles,
 * classes, subjects, grading, result locking, report-card templates, promotion,
 * backup, sync, security. The bursar is not here, and that exclusion is the
 * whole point of this change.
 */
const ADMIN_ROLES = [ROLES.SUPER_ADMIN, ROLES.SCHOOL_ADMIN];

/**
 * The ledger: fees, payments, receipts, expenses, payroll, financial reports.
 * Admins retain access because they approve — see the header note.
 */
const FINANCE_ROLES = [ROLES.SUPER_ADMIN, ROLES.SCHOOL_ADMIN, ROLES.BURSAR];

/**
 * The office rather than the staffroom: the desk that deals with parents and
 * money. Used where a screen is fine for a bursar and wrong for a teacher —
 * the arrears watch list names children by what their family owes.
 */
const OFFICE_ROLES = [ROLES.SUPER_ADMIN, ROLES.SCHOOL_ADMIN, ROLES.BURSAR];

/**
 * Academic work: marking a register, entering a score, setting a timetable,
 * running an exam. Teachers belong; the bursar does not.
 */
const TEACHING_ROLES = [ROLES.SUPER_ADMIN, ROLES.SCHOOL_ADMIN, ROLES.TEACHER];

/**
 * Anyone employed by the school. Reads that every member of staff needs and
 * no student may have — the student roster, a class list, attendance figures.
 *
 * A write route must never use this set. If a bursar may see it but not change
 * it, the GET takes STAFF_ROLES and the POST takes TEACHING_ROLES or
 * ADMIN_ROLES; one guard covering both is how read-only access quietly becomes
 * write access.
 */
const STAFF_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.SCHOOL_ADMIN,
  ROLES.BURSAR,
  ROLES.TEACHER,
];

// ─────────────────────────────────────────────────────────────────────────────
// PREDICATES
// ─────────────────────────────────────────────────────────────────────────────

const has = (set, role) => set.includes(normalizeRole(role));

const isAdmin   = (role) => has(ADMIN_ROLES,   role);
const isFinance = (role) => has(FINANCE_ROLES, role);
const isStaff   = (role) => has(STAFF_ROLES,   role);
const isBursar  = (role) => normalizeRole(role) === ROLES.BURSAR;

module.exports = {
  ROLES,
  ALL_ROLES,
  ROLE_ALIASES,
  normalizeRole,

  ADMIN_ROLES,
  FINANCE_ROLES,
  OFFICE_ROLES,
  TEACHING_ROLES,
  STAFF_ROLES,

  isAdmin,
  isFinance,
  isStaff,
  isBursar,
};
