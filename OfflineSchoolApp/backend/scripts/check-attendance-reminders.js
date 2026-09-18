// backend/scripts/check-attendance-reminders.js
"use strict";

/**
 * The attendance reminder names the class it is about, and opens its register.
 *
 * The teacher dashboard's "attendance not marked" card was built from a count
 * the server computed by comparing StudentAttendance against a teacherId field
 * it does not have — so nothing ever counted as marked — and the day's classes
 * it listed carried names but no ids, so the card could open no register.
 *
 * This pins the server's half: today's classes come from the teacher's own
 * slots in their own school, each with classId, subjectId, periodId and the
 * date, and each saying whether a register exists for the class today; the
 * missing count is one per class, not per slot; a register can be read for a
 * named date; and the write the reminder leads to is still refused for a
 * class the teacher holds no active assignment to, or in another school.
 *
 *   node scripts/check-attendance-reminders.js
 */

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
  const Student           = mongoose.model("Student");
  const Period            = mongoose.model("Period");
  const TimetableSlot     = mongoose.model("TimetableSlot");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Register          = mongoose.model("StudentAttendance");

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test" },
  ]);
  const PASSWORD = "Check-only-passw0rd";
  const mkUser = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teacher-a",  "teacher",      A),   // Mathematics 3A at P1 and P2, Physics 4B at P2
    mkUser("teacher-a2", "teacher",      A),   // no slots, no assignments
    mkUser("teacher-b",  "teacher",      B),
    mkUser("admin-a",    "school_admin", A),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "maths-3a",   schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "physics-4b", schoolId: A, name: "Physics",     classId: "form4b" },
    { _id: "maths-1b",   schoolId: B, name: "Mathematics", classId: "form1b" },
  ]);
  await Period.create([
    { _id: "p1",  schoolId: A, name: "Period 1", startTime: "08:00", endTime: "09:00", sortOrder: 1 },
    { _id: "p2",  schoolId: A, name: "Period 2", startTime: "10:00", endTime: "11:00", sortOrder: 2 },
    { _id: "p1b", schoolId: B, name: "Period 1", startTime: "08:00", endTime: "09:00", sortOrder: 1 },
  ]);
  const DAY   = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][new Date().getDay()];
  const OTHER = DAY === "MON" ? "TUE" : "MON";
  // teacher-a holds Form 3A and Form 4B in the same period on purpose: the
  // reminder for two slots of one class must be one card, and a slot in a
  // second class must be another. The collection's unique
  // (teacher, day, period) index forbids writing that today, so the index is
  // dropped first — the rows stand for data written before it existed, which
  // is exactly what the register and the reminders must cope with. Without
  // this the seed raced the index build and failed whenever the build won.
  await TimetableSlot.init();
  await TimetableSlot.collection.dropIndex("unique_teacher_day_period").catch(() => {});
  await TimetableSlot.create([
    { _id: "68d100000000000000000001", schoolId: A, classId: "form3a", subjectId: "maths-3a",   teacherId: "teacher-a", periodId: "p1", dayOfWeek: DAY },
    { _id: "68d100000000000000000002", schoolId: A, classId: "form3a", subjectId: "maths-3a",   teacherId: "teacher-a", periodId: "p2", dayOfWeek: DAY },
    { _id: "68d100000000000000000003", schoolId: A, classId: "form4b", subjectId: "physics-4b", teacherId: "teacher-a", periodId: "p2", dayOfWeek: DAY },
    { _id: "68d100000000000000000004", schoolId: A, classId: "form4b", subjectId: "physics-4b", teacherId: "teacher-a", periodId: "p1", dayOfWeek: OTHER },
    { _id: "68d100000000000000000005",    schoolId: B, classId: "form1b", subjectId: "maths-1b",   teacherId: "teacher-b", periodId: "p1b", dayOfWeek: DAY },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "teacher-a", class: "form3a", subject: "maths-3a" },
    { schoolId: A, teacher: "teacher-a", class: "form4b", subject: "physics-4b" },
    { schoolId: B, teacher: "teacher-b", class: "form1b", subject: "maths-1b" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([pupil("st-a1", A, "form3a", 1), pupil("st-a3", A, "form4b", 3), pupil("st-b1", B, "form1b", 1)]);

  const TODAY     = new Date().toISOString().slice(0, 10);
  const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // Form 3A's register for today exists — marked by the office, not the teacher.
  await Register.create({
    schoolId: A, classId: "form3a", studentId: "st-a1", markedBy: "admin-a", date: TODAY, status: "present",
  });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/teacher",    auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
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
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const sign = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const as = (id, role, schoolId) => {
    const token = sign(id, role, schoolId);
    return { get: (url) => call("GET", url, { token }), post: (url, body) => call("POST", url, { token, body }) };
  };
  const teacherA  = as("teacher-a",  "teacher",      A);
  const teacherA2 = as("teacher-a2", "teacher",      A);
  const teacherB  = as("teacher-b",  "teacher",      B);
  const adminA    = as("admin-a",    "school_admin", A);

  const shape = (c) => ({ classId: c.classId, periodId: c.periodId, date: c.date, marked: c.attendanceMarked });
  // Two slots in one period tie on time and the server does not order ties;
  // compare as a set, keyed by class/period.
  const byKey = (list) => [...list].sort((x, y) => (x.classId + "/" + x.periodId).localeCompare(y.classId + "/" + y.periodId));

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the day's classes carry the ids a reminder needs ---");
  let r = await teacherA.get("/teacher/stats/summary");
  let today = r.body?.todayClasses ?? [];
  check("stats/summary → 200 with today's three slots", [r.status, today.map((c) => c.classId + "/" + c.periodId).sort()], [200, ["form3a/p1", "form3a/p2", "form4b/p2"]]);
  check("  the earliest slot leads", today[0]?.classId + "/" + today[0]?.periodId, "form3a/p1");
  check("  each carries classId, periodId, the date and the marked flag", byKey(today).map(shape), [
    { classId: "form3a", periodId: "p1", date: TODAY, marked: true },
    { classId: "form3a", periodId: "p2", date: TODAY, marked: true },
    { classId: "form4b", periodId: "p2", date: TODAY, marked: false },
  ]);
  const fourB = today.find((c) => c.classId === "form4b");
  check("  and subjectId, names and times", [fourB?.subjectId, fourB?.className, fourB?.subjectName, fourB?.startTime], ["physics-4b", "Form 4B", "Physics", "10:00 AM"]);
  check("  the slot on another day is not today's", today.length, 3);
  check("one register missing — Form 4B; Form 3A's two slots are one register, already taken", r.body?.todayAttendanceMissing, 1);

  r = await teacherA.get("/teacher/my-workload");
  check("my-workload answers the same classes with the same ids", byKey(r.body?.data?.todayClasses ?? []).map(shape), byKey(today).map(shape));

  r = await teacherB.get("/teacher/stats/summary");
  check("another school's teacher sees only their own slot, in their school", [(r.body?.todayClasses ?? []).map((c) => c.classId), r.body?.todayAttendanceMissing], [["form1b"], 1]);
  r = await teacherA2.get("/teacher/stats/summary");
  check("a teacher with no slots today: no classes, nothing missing", [r.body?.todayClasses, r.body?.todayAttendanceMissing], [[], 0]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the register for a named date ---");
  r = await teacherA.get(`/attendance/students/today?classId=form4b&date=${YESTERDAY}`);
  check("?date= opens that day's register: the date is echoed, the roster is the class's", [r.status, r.body?.date, (r.body?.roster ?? []).map((x) => x.student._id), r.body?.records?.length], [200, YESTERDAY, ["st-a3"], 0]);
  r = await teacherA.get("/attendance/students/today?classId=form3a&date=not-a-date");
  check("a value that is not a date is today, with today's marks", [r.body?.date, r.body?.records?.length, r.body?.roster?.[0]?.attendance?.status], [TODAY, 1, "present"]);
  r = await adminA.get("/attendance/students/today?classId=form4b");
  check("the office reads the same register", [r.status, r.body?.roster?.length], [200, 1]);
  r = await teacherA.get("/attendance/students/today?classId=form1b");
  check("another school's class by id → an empty roster, not Beta's pupils", r.body?.roster ?? [], []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the write the reminder leads to ---");
  const mark = (who, classId, studentId, extra = {}) => who.post("/attendance/students/bulk", {
    classId, date: TODAY, records: [{ studentId, status: "present" }], ...extra,
  });
  r = await mark(teacherA2, "form4b", "st-a3", { periodId: "p2" });
  check("a reminder's payload used by a teacher not assigned to the class → 403 CLASS_NOT_ASSIGNED", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
  r = await mark(teacherA, "form1b", "st-b1");
  check("the same payload aimed at another school's class → nothing written", [r.status >= 400 || (r.body?.saved ?? 0) === 0, await Register.countDocuments({ classId: "form1b" })], [true, 0]);
  r = await mark(teacherA, "form4b", "st-a3", { periodId: "p2" });
  check("the assigned teacher marks Form 4B from the reminder → 201", [r.status, r.body?.saved], [201, 1]);

  r = await teacherA.get("/teacher/stats/summary");
  check("after marking, Form 4B is no longer a reminder and nothing is missing", [r.body?.todayAttendanceMissing, (r.body?.todayClasses ?? []).every((c) => c.attendanceMarked)], [0, true]);

  await TeacherAssignment.updateOne({ teacher: "teacher-a", class: "form4b" }, { $set: { isActive: false } });
  r = await mark(teacherA, "form4b", "st-a3", { periodId: "p2" });
  check("an assignment switched off no longer authorises the write → 403", r.status, 403);
  r = await mark(adminA, "form4b", "st-a3");
  check("the office still writes the register → 201", r.status, 201);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
