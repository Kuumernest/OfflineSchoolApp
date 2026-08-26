// backend/scripts/check-communication-policy.js
"use strict";

/**
 * Assert the communication matrix.
 *
 * This is a security boundary: it decides which students can reach which
 * other students, whether a guardian can message a child who is not theirs,
 * and whether an administrator can read a private thread. A regression here
 * is a privacy incident rather than a bug, so the rules are pinned by
 * example and not merely by reading the code.
 *
 * Pure — no database, no network. Safe to run anywhere.
 *
 *   node scripts/check-communication-policy.js
 */

const P = require("../src/services/communication/policy.service");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (actual === expected) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${actual}, expected ${expected}`); }
};

const S = "school-1";
const admin    = { kind: "user", role: "school_admin", id: "a1", schoolId: S };
const teacher  = { kind: "user", role: "teacher",      id: "t1", schoolId: S };
const teacher2 = { kind: "user", role: "teacher",      id: "t2", schoolId: S };
const student  = { kind: "user", role: "student",      id: "s1", schoolId: S };
const student2 = { kind: "user", role: "student",      id: "s2", schoolId: S };
const guardian = { kind: "guardian", id: "g1", schoolId: S, studentIds: ["s1"] };
const guardian2= { kind: "guardian", id: "g2", schoolId: S, studentIds: ["s2"] };
const foreign  = { kind: "user", role: "teacher", id: "t9", schoolId: "school-2" };

const M = (f, t, cfg) => P.canMessage(f, t, cfg).allowed;

console.log("--- matrix, default settings (student<->student ON) ---");
check("admin->student",     M(admin, student),     true);
check("admin->teacher",     M(admin, teacher),     true);
check("admin->guardian",    M(admin, guardian),    true);
check("teacher->student",   M(teacher, student),   true);
check("teacher->teacher",   M(teacher, teacher2),  true);
check("teacher->guardian",  M(teacher, guardian),  true);
check("teacher->admin",     M(teacher, admin),     true);
check("student->teacher",   M(student, teacher),   true);
check("student->admin",     M(student, admin),     true);
check("student->student",   M(student, student2),  true);
check("student->guardian",  M(student, guardian),  false);
check("guardian->teacher",  M(guardian, teacher),  true);
check("guardian->admin",    M(guardian, admin),    true);
check("guardian->own kid",  M(guardian, student),  true);
check("guardian->other kid",M(guardian, student2), false);
check("guardian->guardian", M(guardian, guardian2),false);

console.log("--- a school may close student<->student ---");
check("student->student OFF when disabled",
  M(student, student2, { studentToStudent: false }), false);
check("student->teacher still fine when peer messaging is off",
  M(student, teacher, { studentToStudent: false }), true);

console.log("--- school can restrict upward channels ---");
check("student->admin OFF",    M(student, admin,   { studentToAdmin: false }),   false);
check("guardian->teacher OFF", M(guardian, teacher,{ guardianToTeacher: false }),false);
check("guardian->admin OFF",   M(guardian, admin,  { guardianToAdmin: false }),  false);

console.log("--- tenancy and self ---");
check("cross-school denied",       M(teacher, foreign), false);
check("admin cross-school denied", M(admin, foreign),   false);
check("self-message denied",       M(teacher, teacher), false);
check("guardian self denied",      M(guardian, guardian), false);

console.log("--- unknown principals get nothing ---");
check("null sender",    M(null, teacher),                              false);
check("null recipient", M(teacher, null),                              false);
check("bogus kind",     M({ kind: "robot", id: "x", schoolId: S }, teacher), false);
check("bogus role",     M({ kind: "user", role: "janitor", id: "j", schoolId: S }, teacher), false);

console.log("--- conversation membership ---");
const convo = {
  schoolId: S,
  participants: [{ kind: "user", id: "t1" }, { kind: "user", id: "s1" }],
};
check("member posts",        P.canPostToConversation(teacher, convo).allowed,  true);
check("non-member blocked",  P.canPostToConversation(teacher2, convo).allowed, false);
check("admin not auto-member", P.canPostToConversation(admin, convo).allowed,  false);

const archived = { ...convo, isArchived: true };
check("archived blocks post",   P.canPostToConversation(teacher, archived).allowed, false);
check("archived still readable", P.canReadConversation(teacher, archived).allowed,  true);

const readOnly = { ...convo, isReadOnly: true };
check("readonly blocks member", P.canPostToConversation(teacher, readOnly).allowed, false);
check("readonly allows admin",  P.canPostToConversation({ ...admin, id: "t1" }, readOnly).allowed, true);

console.log("--- reading vs auditing ---");
check("member reads",        P.canReadConversation(student, convo).allowed, true);
check("stranger cannot read",P.canReadConversation(teacher2, convo).allowed, false);
check("admin audits",        P.canReadConversation(admin, convo).allowed, true);
check("audit reason tagged", P.canReadConversation(admin, convo).reason, "admin-audit");
check("audit disabled",      P.canReadConversation(admin, convo, { adminAudit: false }).allowed, false);
check("foreign admin denied",P.canReadConversation({ ...admin, schoolId: "other" }, convo).allowed, false);
check("guardian stranger",   P.canReadConversation(guardian, convo).allowed, false);

console.log("--- guardian participant keys do not collide with users ---");
const collide = { schoolId: S, participants: [{ kind: "guardian", id: "s1" }] };
check("user s1 is NOT the guardian s1", P.canPostToConversation(student, collide).allowed, false);
check("guardian s1 is",
  P.canPostToConversation({ kind: "guardian", id: "s1", schoolId: S }, collide).allowed, true);

console.log("--- settings defaults ---");
const d = P.resolveSettings(undefined);
check("s2s default on",    d.studentToStudent,  true);
check("s2admin default on",d.studentToAdmin,    true);
check("audit default on",  d.adminAudit,        true);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
