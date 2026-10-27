// backend/scripts/check-timetable-conflicts.js
//
// A timetable conflict is explained, and can be fixed, from the dashboard.
//
// The acceptance test from the task, end to end against the real routes: a
// teacher double-booked on purpose shows on the dashboard as 1 conflict; the
// conflicts endpoint names the teacher, both classes, both subjects, the day
// and the period; "Move to free period" offers only periods where the class
// AND the teacher are free; taking one brings the count back to 0. Around it:
// the other conflict kinds, the pre-save check, swaps, and "Save anyway".
//
//   node scripts/check-timetable-conflicts.js
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
  const Subject           = mongoose.model("Subject");
  const Period            = mongoose.model("Period");
  const TimetableSlot     = mongoose.model("TimetableSlot");
  const TeacherAssignment = mongoose.model("TeacherAssignment");

  const A = "68c0000000000000000000a1";
  await School.create({ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" });

  const mkUser = (id, name, role) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: A, isActive: true,
  });
  await Promise.all([
    mkUser("admin-a",  "Head Teacher", "school_admin"),
    mkUser("tabi",     "Mr. Tabi",     "teacher"),
    mkUser("ngono",    "Mrs. Ngono",   "teacher"),
    mkUser("fon",      "Mr. Fon",      "teacher"),
  ]);
  await Class.create([
    { _id: "form2a", schoolId: A, name: "Form 2A" },
    { _id: "form3b", schoolId: A, name: "Form 3B" },
  ]);
  await Subject.create([
    { _id: "maths",   schoolId: A, name: "Mathematics", code: "MAT" },
    { _id: "physics", schoolId: A, name: "Physics",     code: "PHY" },
    { _id: "english", schoolId: A, name: "English",     code: "ENG" },
  ]).catch(async () => {
    // Subject may require more fields; fall back to raw inserts.
    await Subject.collection.insertMany([
      { _id: "maths",   schoolId: A, name: "Mathematics" },
      { _id: "physics", schoolId: A, name: "Physics" },
      { _id: "english", schoolId: A, name: "English" },
    ]);
  });
  await Period.create([
    { _id: "p1", schoolId: A, name: "Period 1", startTime: "07:30", endTime: "08:25", sortOrder: 1 },
    { _id: "p2", schoolId: A, name: "Period 2", startTime: "08:25", endTime: "09:20", sortOrder: 2 },
    { _id: "br", schoolId: A, name: "Break",    startTime: "09:20", endTime: "09:40", sortOrder: 3, isBreak: true },
    { _id: "p3", schoolId: A, name: "Period 3", startTime: "09:40", endTime: "10:35", sortOrder: 4 },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "tabi",  class: "form2a", subject: "maths" },
    { schoolId: A, teacher: "tabi",  class: "form3b", subject: "physics" },
    { schoolId: A, teacher: "ngono", class: "form2a", subject: "maths" },
    { schoolId: A, teacher: "fon",   class: "form3b", subject: "english" },
  ]);

  await TimetableSlot.init();
  // Without the unique index, as production runs (autoIndex is off there):
  // that is how a double-booking reaches the database in the first place.
  await TimetableSlot.collection.dropIndex("unique_teacher_day_period").catch(() => {});
  await TimetableSlot.collection.dropIndex("unique_class_day_period").catch(() => {});

  // ── The app, as the server mounts it ──────────────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/admin/timetable", require(path.join(SRC, "routes/timetable.routes")));
  app.use("/api/admin", auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
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
  const sign    = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const admin   = sign("admin-a", "school_admin");
  const teacher = sign("tabi", "teacher");
  const dash    = async () => (await call("GET", `/admin/stats?schoolId=${A}`, { token: admin })).body?.stats?.timetableConflicts;
  const list    = async (lang = "en") => (await call("GET", `/admin/timetable/conflicts?lang=${lang}`, { token: admin })).body;

  const base = { schoolId: A, dayOfWeek: "MON" };
  let r = await call("POST", "/admin/timetable", { token: admin, body: { ...base, classId: "form2a", subjectId: "maths", teacherId: "tabi", periodId: "p3" } });
  check("a first lesson saves", r.status, 201);
  const mathsId = r.body.slot._id;
  await call("POST", "/admin/timetable", { token: admin, body: { ...base, classId: "form3b", subjectId: "english", teacherId: "fon", periodId: "p1" } });
  check("clean timetable: dashboard shows 0", await dash(), 0);

  console.log("\n--- prevention: the check before saving ---");
  const clash = { ...base, classId: "form3b", subjectId: "physics", teacherId: "tabi", periodId: "p3" };
  r = await call("POST", "/admin/timetable/check", { token: admin, body: clash });
  check("POST /check names the clash before Save", [r.status, r.body.conflicts.map((c) => c.conflict_type), r.body.canForce],
    [200, ["TEACHER_DOUBLE_BOOKED"], true]);
  r = await call("POST", "/admin/timetable", { token: admin, body: clash });
  check("saving it is refused with the full detail", [r.status, r.body.conflict, r.body.conflicts?.length], [409, "teacher", 1]);
  check("  and the message is plain language", r.body.error,
    "Mr. Tabi is scheduled for Mathematics in Form 2A AND Physics in Form 3B on Monday, Period 3 (09:40–10:35).");
  r = await call("POST", "/admin/timetable", { token: teacher, body: { ...clash, force: true } });
  check("a teacher cannot force it (no timetable.manage)", r.status, 403);

  console.log("\n--- ACCEPTANCE: a teacher double-booked on purpose ---");
  r = await call("POST", "/admin/timetable", { token: admin, body: { ...clash, force: true } });
  check("an admin may Save anyway", r.status, 201);
  const physicsId = r.body.slot._id;
  check("dashboard shows 1 conflict", await dash(), 1);

  let body = await list();
  const c = body.conflicts[0];
  check("the list holds exactly that one", [body.count, c.conflict_type], [1, "TEACHER_DOUBLE_BOOKED"]);
  check("  day, period number, start–end time", [c.day, c.periodNumber, c.startTime, c.endTime], ["MON", 3, "09:40", "10:35"]);
  check("  the teacher, both classes, both subjects",
    c.entries.map((e) => [e.teacherName, e.className, e.subjectName]).sort(),
    [["Mr. Tabi", "Form 2A", "Mathematics"], ["Mr. Tabi", "Form 3B", "Physics"]]);
  check("  every entry id", c.entries.map((e) => e.entryId).sort(), [mathsId, physicsId].sort());
  check("  ?lang=fr answers in French", (await list("fr")).conflicts[0].message,
    "Mr. Tabi a cours de Mathematics en Form 2A ET Physics en Form 3B le lundi, Period 3 (09:40–10:35).");

  r = await call("GET", `/admin/timetable/conflicts/options/${physicsId}`, { token: admin });
  const free = r.body.freePeriods.filter((p) => p.dayOfWeek === "MON").map((p) => p.periodId);
  check("Move: Monday offers P2 only — P1 has Form 3B, P3 is the clash, the break is no lesson", free, ["p2"]);
  check("  the same day is listed first", r.body.freePeriods[0].sameDay, true);
  check("Change teacher: nobody else is assigned Physics", r.body.freeTeachers, []);
  r = await call("GET", `/admin/timetable/conflicts/options/${mathsId}`, { token: admin });
  check("Change teacher for the Maths lesson: Mrs. Ngono, who teaches it to this class",
    r.body.freeTeachers.map((t) => [t.teacherName, t.teachesThisClass]), [["Mrs. Ngono", true]]);

  r = await call("PUT", `/admin/timetable/${physicsId}`, { token: admin, body: { dayOfWeek: "MON", periodId: "p2" } });
  check("taking the free period saves", r.status, 200);
  check("dashboard is back to 0", await dash(), 0);
  check("and the list is empty", (await list()).count, 0);

  console.log("\n--- swaps that create no new conflict ---");
  // Form 3B: English (Fon) at P1, Physics (Tabi) at P2. Put Tabi at P1 in 2A.
  await call("POST", "/admin/timetable", { token: admin, body: { ...base, classId: "form2a", subjectId: "maths", teacherId: "tabi", periodId: "p1", force: true } });
  body = await list();
  check("Tabi now clashes at P1? no — Form 3B's P1 is Fon's", body.count, 0);
  r = await call("GET", `/admin/timetable/conflicts/options/${physicsId}`, { token: admin });
  check("swapping 3B's Physics (Tabi) into P1 would double-book Tabi: not offered", r.body.swaps.length, 0);

  // Wednesday: 3B has English (Fon) at P1 and Physics (Tabi) at P2, while 2A
  // has Maths with Tabi at P2 — Tabi is double-booked at P2.
  const wed = { schoolId: A, dayOfWeek: "WED", force: true };
  await call("POST", "/admin/timetable", { token: admin, body: { ...wed, classId: "form3b", subjectId: "english", teacherId: "fon",  periodId: "p1" } });
  const wedPhys = (await call("POST", "/admin/timetable", { token: admin, body: { ...wed, classId: "form3b", subjectId: "physics", teacherId: "tabi", periodId: "p2" } })).body.slot._id;
  await call("POST", "/admin/timetable", { token: admin, body: { ...wed, classId: "form2a", subjectId: "maths", teacherId: "tabi", periodId: "p2" } });
  check("Wednesday's double-booking counts", await dash(), 1);
  r = await call("GET", `/admin/timetable/conflicts/options/${wedPhys}`, { token: admin });
  const swap = r.body.swaps.find((s) => s.dayOfWeek === "WED" && s.periodId === "p1");
  check("swapping 3B's Physics with its English at P1 is offered", Boolean(swap), true);
  for (const u of swap.updates) {
    const { entryId, ...fields } = u;
    r = await call("PUT", `/admin/timetable/${entryId}`, { token: admin, body: fields });
    check(`  swap save ${entryId === wedPhys ? "1" : "2"} is valid on its own`, r.status, 200);
  }
  check("after the swap the dashboard is back to 0", await dash(), 0);

  console.log("\n--- class, room and period-overlap conflicts ---");
  await TimetableSlot.collection.insertOne({ schoolId: A, classId: "form2a", subjectId: "english", teacherId: "fon", dayOfWeek: "TUE", periodId: "p1", room: "Lab 1", deletedAt: null, version: 1 });
  await TimetableSlot.collection.insertOne({ schoolId: A, classId: "form2a", subjectId: "physics", teacherId: "ngono", dayOfWeek: "TUE", periodId: "p1", deletedAt: null, version: 1 });
  await TimetableSlot.collection.insertOne({ schoolId: A, classId: "form3b", subjectId: "maths", teacherId: "tabi", dayOfWeek: "TUE", periodId: "p2", room: "lab 1 ", deletedAt: null, version: 1 });
  await TimetableSlot.collection.insertOne({ schoolId: A, classId: "form2a", subjectId: "english", teacherId: "ngono", dayOfWeek: "TUE", periodId: "p2", room: "Lab 1", deletedAt: null, version: 1 });
  await Period.create({ _id: "px", schoolId: A, name: "Extra", startTime: "10:00", endTime: "10:50", sortOrder: 5 });
  body = await list();
  check("each kind found, grouped by day, overlaps first (they are all week)",
    body.conflicts.map((x) => `${x.day}:${x.conflict_type}`),
    ["null:PERIOD_OVERLAP", "TUE:CLASS_DOUBLE_BOOKED", "TUE:ROOM_DOUBLE_BOOKED"]);
  check("room names match ignoring case and spaces",
    body.conflicts[2].message, "Room lab 1 is booked for Form 3B (Mathematics) AND Form 2A (English) on Tuesday, Period 2 (08:25–09:20).");
  check("overlap message", body.conflicts[0].message, "Period 3 (09:40–10:35) overlaps Extra (10:00–10:50): a lesson in one runs into the other.");
  check("dashboard count is the length of the list", await dash(), body.count);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
