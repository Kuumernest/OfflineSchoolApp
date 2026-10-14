// desktop/scripts/check-teacher-roster.js
"use strict";
/**
 * The staff register, answered from the mirror, lists who is timetabled.
 *
 * GET /api/attendance/teachers/roster with a date and a period is the server's
 * timetable rule (backend/src/utils/teacherSchedule.js) over the mirrored
 * collections: slot → active class → active period → active teacher of this
 * school, one row per teacher however many slots. Without a date the handler
 * is what it was: every active teacher.
 *
 * And the one thing a mirror can do that the server cannot: not know. A mirror
 * with no timetable for the school that has never pulled the collection must
 * decline — hand the request to the network — rather than answer "nobody is
 * scheduled", because those two are different facts and the screen shows them
 * differently.
 *
 *   node scripts/check-teacher-roster.js
 */
const api = require("../src/main/api");
const { open, documents, state } = require("../src/main/db/store");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const db   = open(":memory:");
const docs = documents(db);
const sync = state(db);
const ctx  = (session = { userId: "admin-1", schoolId: "S1", role: "school_admin" }) => ({
  docs, session, state: sync, queue: { add: () => ({ seq: 1, duplicate: false }) },
});
const roster = (query, c = ctx()) =>
  api.handle({ method: "GET", path: "/api/attendance/teachers/roster", query }, c);
const ids = (r) => (r?.data?.teachers ?? []).map((t) => t._id);

const MON = "2026-09-14", TUE = "2026-09-15", SUN = "2026-09-20";

// ── People, classes, periods ───────────────────────────────────────────────
docs.putMany("user", [
  { _id: "t1", schoolId: "S1", role: "teacher", isActive: true,  name: "Ama",  email: "ama@x.test" },
  { _id: "t2", schoolId: "S1", role: "teacher", isActive: true,  name: "Bea",  email: "bea@x.test" },
  { _id: "t3", schoolId: "S1", role: "teacher", isActive: true,  name: "Cy",   email: "cy@x.test" },   // assigned only
  { _id: "t4", schoolId: "S1", role: "teacher", isActive: false, name: "Dee",  email: "dee@x.test" },  // switched off
  { _id: "t5", schoolId: "S1", role: "teacher", isActive: true,  name: "Eli",  email: "eli@x.test" },  // inactive class
  { _id: "t6", schoolId: "S1", role: "teacher", isActive: true,  name: "Fay",  email: "fay@x.test" },  // Tuesday
  { _id: "t8", schoolId: "S1", role: "teacher", isActive: true,  name: "Hal",  email: "hal@x.test" },  // inactive period
  { _id: "tb", schoolId: "S2", role: "teacher", isActive: true,  name: "Bob",  email: "bob@y.test" },  // other school
  { _id: "a1", schoolId: "S1", role: "school_admin", isActive: true, name: "Admin", email: "adm@x.test" },
]);
docs.putMany("class", [
  { _id: "c3a", schoolId: "S1", name: "Form 3A", isActive: true, deletedAt: null },
  { _id: "c4b", schoolId: "S1", name: "Form 4B", isActive: true, deletedAt: null },
  { _id: "c5c", schoolId: "S1", name: "Form 5C", isActive: true, deletedAt: null },
  { _id: "c6d", schoolId: "S1", name: "Form 6D", isActive: true, deletedAt: null },
  { _id: "c7e", schoolId: "S1", name: "Form 7E", isActive: true, deletedAt: null },
  { _id: "c8f", schoolId: "S1", name: "Form 8F", isActive: true, deletedAt: null },
  { _id: "c9z", schoolId: "S1", name: "Form 9Z", isActive: false, deletedAt: null },
  { _id: "c1b", schoolId: "S2", name: "Form 1B", isActive: true, deletedAt: null },
]);
docs.putMany("period", [
  { _id: "p1",  schoolId: "S1", name: "Period 1", startTime: "08:00", endTime: "09:00", sortOrder: 1, isActive: true,  deletedAt: null },
  { _id: "p2",  schoolId: "S1", name: "Period 2", startTime: "10:00", endTime: "11:00", sortOrder: 2, isActive: true,  deletedAt: null },
  { _id: "p3",  schoolId: "S1", name: "Period 3", startTime: "12:00", endTime: "13:00", sortOrder: 3, isActive: false, deletedAt: null },
  { _id: "p1b", schoolId: "S2", name: "Period 1", startTime: "08:00", endTime: "09:00", sortOrder: 1, isActive: true,  deletedAt: null },
]);
docs.putMany("teacherAssignment", [
  { _id: "ta1", schoolId: "S1", teacher: "t3", class: "c3a", subject: "maths", isActive: true },
]);

console.log("\n--- before the timetable has ever been pulled ---");
check("no slots and no cursor: the mirror declines, so the network answers",
  roster({ schoolId: "S1", date: MON, periodId: "p1" }), null);
check("  the plain roster still answers locally", ids(roster({ schoolId: "S1" })).sort(), ["t1", "t2", "t3", "t5", "t6", "t8"]);

sync.setCursor("timetableSlot", "cursor-1");
let r = roster({ schoolId: "S1", date: MON, periodId: "p1" });
check("a pulled but empty timetable: nobody is scheduled, said as such", [r?.status, ids(r), r?.data?.scheduled], [200, [], true]);

// ── The timetable ─────────────────────────────────────────────────────────
docs.putMany("timetableSlot", [
  { _id: "s1", schoolId: "S1", classId: "c3a", subjectId: "maths",   teacherId: "t1", periodId: "p1", dayOfWeek: "MON", deletedAt: null },
  { _id: "s2", schoolId: "S1", classId: "c4b", subjectId: "physics", teacherId: "t1", periodId: "p1", dayOfWeek: "MON", deletedAt: null },
  { _id: "s3", schoolId: "S1", classId: "c3a", subjectId: "maths",   teacherId: "t2", periodId: "p2", dayOfWeek: "MON", deletedAt: null },
  { _id: "s4", schoolId: "S1", classId: "c5c", subjectId: "art",     teacherId: "t2", periodId: "p1", dayOfWeek: "MON", deletedAt: "2026-09-01T00:00:00.000Z" },
  { _id: "s5", schoolId: "S1", classId: "c6d", subjectId: "music",   teacherId: "t4", periodId: "p1", dayOfWeek: "MON", deletedAt: null },
  { _id: "s6", schoolId: "S1", classId: "c9z", subjectId: "drama",   teacherId: "t5", periodId: "p1", dayOfWeek: "MON", deletedAt: null },
  { _id: "s7", schoolId: "S1", classId: "c7e", subjectId: "french",  teacherId: "t6", periodId: "p1", dayOfWeek: "TUE", deletedAt: null },
  { _id: "s8", schoolId: "S1", classId: "c8f", subjectId: "history", teacherId: "t8", periodId: "p3", dayOfWeek: "MON", deletedAt: null },
  { _id: "s9", schoolId: "S1", classId: "c8f", subjectId: "latin",   teacherId: "ghost", periodId: "p1", dayOfWeek: "MON", deletedAt: null },
  { _id: "sb", schoolId: "S2", classId: "c1b", subjectId: "maths",   teacherId: "tb", periodId: "p1b", dayOfWeek: "MON", deletedAt: null },
]);

console.log("\n--- Monday, Period 1 ---");
r = roster({ schoolId: "S1", date: MON, periodId: "p1" });
check("only the teacher timetabled in that period", ids(r), ["t1"]);
check("  the envelope names the date, weekday and period",
  [r.data.scheduled, r.data.date, r.data.dayOfWeek, r.data.periodId, r.data.period?.name, r.data.count],
  [true, MON, "MON", "p1", "Period 1", 1]);
check("  two classes in one period are one row with two slots",
  r.data.teachers[0].slots.map((s) => `${s.classId}/${s.className}/${s.periodId}`), ["c3a/Form 3A/p1", "c4b/Form 4B/p1"]);
check("  the server's row shape", Object.keys(r.data.teachers[0]).sort(), ["_id", "email", "name", "role", "slots"]);
check("assigned only (t3), switched off (t4), inactive class (t5), Tuesday (t6), deleted slot (t2), stale id, other school: none listed",
  ["t3", "t4", "t5", "t6", "t2", "ghost", "tb"].some((id) => ids(r).includes(id)), false);

console.log("\n--- the period and the day decide ---");
check("Period 2", ids(roster({ schoolId: "S1", date: MON, periodId: "p2" })), ["t2"]);
check("back to Period 1", ids(roster({ schoolId: "S1", date: MON, periodId: "p1" })), ["t1"]);
check("a period switched off: nobody", ids(roster({ schoolId: "S1", date: MON, periodId: "p3" })), []);
check("the other school's period: nobody", ids(roster({ schoolId: "S1", date: MON, periodId: "p1b" })), []);
check("Tuesday, Period 1", ids(roster({ schoolId: "S1", date: TUE, periodId: "p1" })), ["t6"]);
check("Sunday: nobody, and it is not everybody", ids(roster({ schoolId: "S1", date: SUN })), []);
r = roster({ schoolId: "S1", date: MON });
check("the day without a period: everyone timetabled that day, once", ids(r), ["t1", "t2"]);
check("  slots per teacher", r.data.teachers.map((t) => t.slots.map((s) => s.periodId).join("+")), ["p1+p1", "p2"]);

console.log("\n--- the tenant boundary and the old answer ---");
check("the other school, asked from this session, lists only its own staff by its own id",
  ids(roster({ schoolId: "S2", date: MON, periodId: "p1b" })), ["tb"]);
check("a session with no school and no query: declined", roster({ date: MON }, ctx({ userId: "x", role: "teacher" })), null);
r = roster({ schoolId: "S1" });
check("without a date: every active teacher, the four old fields, no scheduled flag",
  [ids(r).sort(), Object.keys(r.data.teachers[0]).sort(), r.data.scheduled],
  [["t1", "t2", "t3", "t5", "t6", "t8"], ["_id", "email", "name", "role"], undefined]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
