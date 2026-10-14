// backend/scripts/check-teacher-schedule-roster.js
//
// The staff register lists who is timetabled, not who is employed.
//
// GET /attendance/teachers/roster with a date (and a period) answers from the
// timetable: a teacher is on the list only if an undeleted slot puts them in
// front of an active class of this school, on that weekday, in that period.
// Assignment alone does not; neither does an inactive account, a class that
// was switched off, a period that was, a slot on another day, or a slot in
// another school. Without a date the endpoint still answers as it always did —
// every active teacher — because the phone's reports use that list for names.
//
//   node scripts/check-teacher-schedule-roster.js
"use strict";

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Period            = mongoose.model("Period");
  const TimetableSlot     = mongoose.model("TimetableSlot");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const TeacherAttendance = mongoose.model("TeacherAttendance");

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);

  const PASSWORD = "Check-only-passw0rd";
  const mkUser = (id, role, schoolId, extra = {}) => User.create({
    _id: id, name: `Name ${id}`, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true, ...extra,
  });
  await Promise.all([
    mkUser("admin-a",   "school_admin", A),
    mkUser("pupil-a",   "student",      A),
    mkUser("teacher-a1", "teacher", A),                     // Form 3A and Form 4B, both at P1 on Monday
    mkUser("teacher-a2", "teacher", A),                     // Form 3A at P2; a deleted slot at P1
    mkUser("teacher-a3", "teacher", A),                     // assigned to Form 3A, never timetabled
    mkUser("teacher-a4", "teacher", A, { isActive: false }), // timetabled at P1, account switched off
    mkUser("teacher-a5", "teacher", A),                     // timetabled at P1 in a class switched off
    mkUser("teacher-a6", "teacher", A),                     // timetabled at P1 on Tuesday
    mkUser("teacher-a8", "teacher", A),                     // timetabled in a period switched off
    mkUser("teacher-b",  "teacher", B),                     // the other school, at P1 on Monday
  ]);

  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form5c", schoolId: A, name: "Form 5C" },
    { _id: "form6d", schoolId: A, name: "Form 6D" },
    { _id: "form7e", schoolId: A, name: "Form 7E" },
    { _id: "form8f", schoolId: A, name: "Form 8F" },
    { _id: "form9z", schoolId: A, name: "Form 9Z", isActive: false },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Period.create([
    { _id: "p1",  schoolId: A, name: "Period 1", startTime: "08:00", endTime: "09:00", sortOrder: 1 },
    { _id: "p2",  schoolId: A, name: "Period 2", startTime: "10:00", endTime: "11:00", sortOrder: 2 },
    { _id: "p3",  schoolId: A, name: "Period 3", startTime: "12:00", endTime: "13:00", sortOrder: 3, isActive: false },
    { _id: "p1b", schoolId: B, name: "Period 1", startTime: "08:00", endTime: "09:00", sortOrder: 1 },
  ]);

  const MON = "2026-09-14", TUE = "2026-09-15", SUN = "2026-09-20";
  await TimetableSlot.init();
  await TimetableSlot.create([
    { _id: "68d200000000000000000001", schoolId: A, classId: "form3a", subjectId: "maths",   teacherId: "teacher-a1", periodId: "p1", dayOfWeek: "MON" },
    { _id: "68d200000000000000000002", schoolId: A, classId: "form3a", subjectId: "maths",   teacherId: "teacher-a2", periodId: "p2", dayOfWeek: "MON" },
    { _id: "68d200000000000000000003", schoolId: A, classId: "form4b", subjectId: "physics", teacherId: "teacher-a2", periodId: "p1", dayOfWeek: "MON", deletedAt: new Date() },
    { _id: "68d200000000000000000004", schoolId: A, classId: "form5c", subjectId: "art",     teacherId: "teacher-a4", periodId: "p1", dayOfWeek: "MON" },
    { _id: "68d200000000000000000005", schoolId: A, classId: "form9z", subjectId: "music",   teacherId: "teacher-a5", periodId: "p1", dayOfWeek: "MON" },
    { _id: "68d200000000000000000006", schoolId: A, classId: "form6d", subjectId: "french",  teacherId: "teacher-a6", periodId: "p1", dayOfWeek: "TUE" },
    { _id: "68d200000000000000000007", schoolId: A, classId: "form7e", subjectId: "history", teacherId: "teacher-a8", periodId: "p3", dayOfWeek: "MON" },
    { _id: "68d200000000000000000008", schoolId: A, classId: "form8f", subjectId: "latin",   teacherId: "ghost-teacher", periodId: "p1", dayOfWeek: "MON" },
    { _id: "68d200000000000000000009", schoolId: B, classId: "form1b", subjectId: "maths",   teacherId: "teacher-b",  periodId: "p1b", dayOfWeek: "MON" },
  ]);
  // A second class for teacher-a1 in the same period. The collection's unique
  // index forbids double-booking a teacher, so a school that has the index can
  // not create this row today — but a slot written before the index existed, or
  // by an older client, is exactly the data the register must not list twice.
  await TimetableSlot.collection.dropIndex("unique_teacher_day_period").catch(() => {});
  await TimetableSlot.collection.insertOne({
    _id: new mongoose.Types.ObjectId("68d20000000000000000000a"), schoolId: A, classId: "form4b", subjectId: "physics",
    teacherId: "teacher-a1", periodId: "p1", dayOfWeek: "MON", deletedAt: null, version: 1,
  });
  await TeacherAssignment.create({ schoolId: A, teacher: "teacher-a3", class: "form3a", subject: "maths" });

  // ── The app, as the server mounts it ──────────────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/attendance", auth.authenticate, require(path.join(SRC, "routes/attendance.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, { token, body } = {}) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: out };
  };
  const sign  = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const admin = sign("admin-a", "school_admin", A);
  const pupil = sign("pupil-a", "student", A);
  const ids   = (r) => (r.body?.teachers ?? []).map((t) => t._id);
  const roster = (qs, token = admin) => call("GET", `/attendance/teachers/roster?${qs}`, { token });

  console.log("\n--- who is on the register for Monday, Period 1 ---");
  let r = await roster(`schoolId=${A}&date=${MON}&periodId=p1`);
  check("200 and only the teacher timetabled in that period", [r.status, ids(r)], [200, ["teacher-a1"]]);
  check("  the answer says what it resolved: the date, its weekday, the period",
    [r.body.scheduled, r.body.date, r.body.dayOfWeek, r.body.periodId, r.body.period?._id, r.body.period?.name],
    [true, MON, "MON", "p1", "p1", "Period 1"]);
  check("  two classes in the same period are one row carrying two slots",
    r.body.teachers[0].slots.map((s) => s.classId + "/" + s.className + "/" + s.periodId),
    ["form3a/Form 3A/p1", "form4b/Form 4B/p1"]);
  check("  the row has the fields the old roster had, plus its slots",
    Object.keys(r.body.teachers[0]).sort(), ["_id", "email", "name", "role", "slots"]);
  check("  count matches", r.body.count, 1);

  console.log("\n--- everyone the rule excludes ---");
  check("assigned to the class but never timetabled: not listed", ids(r).includes("teacher-a3"), false);
  check("timetabled but the account is switched off: not listed", ids(r).includes("teacher-a4"), false);
  check("timetabled in a class that is switched off: not listed", ids(r).includes("teacher-a5"), false);
  check("timetabled on Tuesday, asked about Monday: not listed", ids(r).includes("teacher-a6"), false);
  check("a slot that was deleted: not listed", ids(r).includes("teacher-a2"), false);
  check("a slot naming an account nobody holds: not listed", ids(r).includes("ghost-teacher"), false);
  check("the other school's teacher: not listed", ids(r).includes("teacher-b"), false);

  console.log("\n--- the period decides ---");
  r = await roster(`schoolId=${A}&date=${MON}&periodId=p2`);
  check("Period 2 lists the Period 2 teacher only", ids(r), ["teacher-a2"]);
  r = await roster(`schoolId=${A}&date=${MON}&periodId=p1`);
  check("back to Period 1: the Period 1 teacher only, nothing kept from Period 2", ids(r), ["teacher-a1"]);
  r = await roster(`schoolId=${A}&date=${MON}&periodId=p3`);
  check("a period that is switched off lists nobody", [r.status, ids(r), r.body.period], [200, [], null]);
  r = await roster(`schoolId=${A}&date=${MON}&periodId=p1b`);
  check("the other school's period id lists nobody here", [r.status, ids(r)], [200, []]);
  r = await roster(`schoolId=${A}&date=${MON}&periodId=nope`);
  check("an unknown period lists nobody", [r.status, ids(r)], [200, []]);

  console.log("\n--- the day decides ---");
  r = await roster(`schoolId=${A}&date=${TUE}&periodId=p1`);
  check("Tuesday, Period 1: the Tuesday teacher", [ids(r), r.body.dayOfWeek], [["teacher-a6"], "TUE"]);
  r = await roster(`schoolId=${A}&date=${SUN}`);
  check("a day with no slots at all: an empty list, not everybody", [r.status, ids(r), r.body.scheduled], [200, [], true]);
  r = await roster(`schoolId=${A}&date=${MON}`);
  check("a date with no period: everyone timetabled that day, once each, in name order",
    ids(r), ["teacher-a1", "teacher-a2"]);
  check("  each with their own slots", r.body.teachers.map((t) => t.slots.map((s) => s.periodId).join("+")), ["p1+p1", "p2"]);
  r = await roster(`schoolId=${A}&date=not-a-date`);
  check("an unreadable date falls back to today, as every attendance route does",
    [r.status, r.body.date], [200, new Date().toISOString().slice(0, 10)]);

  console.log("\n--- the door and the tenant boundary ---");
  r = await roster(`schoolId=${B}&date=${MON}&periodId=p1b`);
  check("naming the other school is refused", [r.status, r.body.code], [403, "SCHOOL_ACCESS_DENIED"]);
  r = await call("GET", `/attendance/teachers/roster?schoolId=${A}&date=${MON}&periodId=p1`);
  check("no token: 401", r.status, 401);
  r = await roster(`schoolId=${A}&date=${MON}&periodId=p1`, pupil);
  check("a pupil holds no attendance.view: 403", r.status, 403);

  console.log("\n--- without a date, the endpoint is what it was ---");
  r = await roster(`schoolId=${A}`);
  check("every active teacher, no timetable applied",
    [r.status, ids(r).sort(), r.body.scheduled],
    [200, ["teacher-a1", "teacher-a2", "teacher-a3", "teacher-a5", "teacher-a6", "teacher-a8"], undefined]);
  check("  with the four fields the old roster selected", Object.keys(r.body.teachers[0]).sort(), ["_id", "email", "name", "role"]);

  console.log("\n--- attendance records are unchanged by the filter ---");
  r = await call("POST", "/attendance/teachers/bulk", { token: admin, body: {
    schoolId: A, date: MON, records: [
      { teacherId: "teacher-a1", status: "present" },
      { teacherId: "teacher-a3", status: "late" },      // not timetabled today; the record is still the office's to write
    ],
  } });
  check("the register saves as before, timetabled or not", [r.status, r.body.saved, r.body.failed], [201, 2, 0]);
  r = await call("GET", `/attendance/teachers?schoolId=${A}&date=${MON}`, { token: admin });
  check("both records are on file for the day", (r.body.records ?? []).map((x) => x.teacherId).sort(), ["teacher-a1", "teacher-a3"]);
  check("one row per teacher per day — no period on the record", await TeacherAttendance.countDocuments({ schoolId: A, date: MON }), 2);
  r = await roster(`schoolId=${A}&date=${MON}&periodId=p1`);
  check("the Period 1 register still lists the one timetabled teacher, once", ids(r), ["teacher-a1"]);
  r = await call("POST", "/attendance/teachers/bulk", { token: admin, body: {
    schoolId: A, date: MON, records: [{ teacherId: "teacher-a1", status: "late" }],
  } });
  check("marking again for the same day updates the same row", [r.status, await TeacherAttendance.countDocuments({ schoolId: A, teacherId: "teacher-a1", date: MON })], [201, 1]);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.closeAllConnections?.();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
