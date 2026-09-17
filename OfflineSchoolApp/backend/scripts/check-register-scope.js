// backend/scripts/check-register-scope.js
"use strict";

/**
 * A teacher marks the register of the classes they are assigned to — for any
 * subject — and of no other class.
 *
 * docs/20-authorization-audit.md N7, decided at CLASS level: a form master
 * takes the whole class, not one subject in it, so being assigned to the class
 * for any subject is enough, and being assigned to no class means no register.
 * Administrators and the super admin are unchanged. Both attendance routes and
 * the legacy /api/teacher/attendance/mark path answer the same way.
 *
 *   node scripts/check-register-scope.js
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
  const Student           = mongoose.model("Student");
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
    mkUser("physics-a", "teacher",      A),   // Physics in 3A only
    mkUser("maths-a",   "teacher",      A),   // Mathematics in 4B only
    mkUser("idle-a",    "teacher",      A),   // an inactive assignment to 3A
    mkUser("teacher-b", "teacher",      B),
    mkUser("admin-a",   "school_admin", A),
    mkUser("root",      "super_admin",  null),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "physics-a", class: "form3a", subject: "physics-3a" },
    { schoolId: A, teacher: "maths-a",   class: "form4b", subject: "maths-4b" },
    { schoolId: A, teacher: "idle-a",    class: "form3a", subject: "maths-3a", isActive: false },
    { schoolId: B, teacher: "teacher-b", class: "form1b", subject: "maths-1b" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([pupil("st-a1", A, "form3a", 1), pupil("st-a3", A, "form4b", 3), pupil("st-b1", B, "form1b", 1)]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/attendance", auth.authenticate, require(path.join(SRC, "routes/attendance.routes")));
  app.use("/api/teacher",    auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
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
    return { post: (url, body) => call("POST", url, { token, body }) };
  };
  const physics = as("physics-a", "teacher",      A);
  const maths   = as("maths-a",   "teacher",      A);
  const idle    = as("idle-a",    "teacher",      A);
  const beta    = as("teacher-b", "teacher",      B);
  const admin   = as("admin-a",   "school_admin", A);
  const root    = as("root",      "super_admin",  null);

  const DAY = "2026-09-14";
  const bulk   = (who, classId, studentId, extra = {}) => who.post("/attendance/students/bulk",
    { classId, date: DAY, records: [{ studentId, status: "present" }], ...extra });
  const single = (who, classId, studentId, extra = {}) => who.post("/attendance/students",
    { classId, studentId, date: DAY, status: "absent", ...extra });
  const legacy = (who, classId, studentId) => who.post("/teacher/attendance/mark",
    { classId, date: DAY, records: [{ studentId, status: "present" }] });
  const rows = (classId) => Register.countDocuments({ classId, date: DAY });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- N7: the register belongs to the classes a teacher is assigned to ---");

  let r = await bulk(physics, "form3a", "st-a1");
  check("assigned to 3A for Physics: marks 3A → 201", [r.status, r.body?.saved], [201, 1]);

  r = await bulk(physics, "form3a", "st-a1", { subjectId: "maths-3a" });
  check("  even naming a subject they do not teach — class level, not subject level → 201", r.status, 201);

  r = await bulk(physics, "form4b", "st-a3");
  check("not assigned to 4B: marks 4B → 403 CLASS_NOT_ASSIGNED", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
  check("  nothing written for 4B", await rows("form4b"), 0);

  r = await bulk(maths, "form3a", "st-a1");
  check("the Mathematics teacher of 4B on 3A → 403", r.status, 403);
  r = await bulk(maths, "form4b", "st-a3");
  check("  and on 4B → 201", r.status, 201);

  r = await bulk(idle, "form3a", "st-a1");
  check("an assignment switched off counts for nothing → 403", r.status, 403);

  r = await bulk(beta, "form3a", "st-a1");
  check("another school's teacher → refused", r.status >= 403 && r.status < 500, true);
  check("  and wrote nothing into Alpha's register", await Register.countDocuments({ classId: "form3a", markedBy: "teacher-b" }), 0);

  console.log("\n--- the single-entry route answers the same ---");
  r = await single(physics, "form3a", "st-a1");
  check("assigned → 201", r.status, 201);
  r = await single(physics, "form4b", "st-a3");
  check("not assigned → 403 CLASS_NOT_ASSIGNED", [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);
  r = await single(idle, "form3a", "st-a1");
  check("inactive assignment → 403", r.status, 403);

  console.log("\n--- the legacy teacher route answers the same (X25) ---");
  // Its lazy model getter used to hand back the Attendance MODULE and the
  // route 500'd after authorisation; it now writes StudentAttendance rows
  // with the schema's key and markedBy, like /api/attendance does.
  r = await legacy(physics, "form3a", "st-a1");
  check("assigned → 200, one row saved", [r.status, r.body?.saved?.length], [200, 1]);
  check("  the row is the school's, marked by the teacher",
    (await Register.findOne({ classId: "form3a", studentId: "st-a1", date: DAY, subjectId: null, periodId: null }).lean())?.markedBy, "physics-a");
  r = await legacy(idle, "form3a", "st-a1");
  check("not assigned (inactive row) → 403", r.status, 403);
  r = await legacy(physics, "form4b", "st-a3");
  check("another class → 403", r.status, 403);
  check("  nothing written for 4B by them", await Register.countDocuments({ classId: "form4b", markedBy: "physics-a" }), 0);
  r = await legacy(beta, "form3a", "st-a1");
  check("another school's teacher → 403", r.status, 403);
  r = await legacy(physics, "form3a", "st-b1");
  check("a pupil of another school on the list → not saved", [r.status, r.body?.saved?.length, r.body?.failed?.length], [200, 0, 1]);
  r = await legacy(admin, "form4b", "st-a3");
  check("the school's admin → 200 through the legacy route too", [r.status, r.body?.saved?.length], [200, 1]);

  console.log("\n--- administrators are unchanged ---");
  r = await bulk(admin, "form3a", "st-a1");
  check("the school's admin marks 3A → 201", r.status, 201);
  r = await bulk(admin, "form4b", "st-a3");
  check("  and 4B → 201", r.status, 201);
  r = await single(admin, "form4b", "st-a3");
  check("  single entry too → 201", r.status, 201);
  r = await bulk(root, "form3a", "st-a1", { schoolId: A });
  check("the super admin, naming the school → 201", r.status, 201);
  r = await bulk(admin, "form1b", "st-b1");
  check("the admin cannot mark another school's class: nothing saved", r.body?.saved ?? 0, 0);
  check("  nothing written for Beta", await rows("form1b"), 0);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
