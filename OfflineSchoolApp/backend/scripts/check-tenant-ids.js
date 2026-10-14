// backend/scripts/check-tenant-ids.js
"use strict";

/**
 * Knowing an id grants nothing.
 *
 * The object-level findings of docs/20-authorization-audit.md, proved over
 * HTTP with data in two schools: a teacher's roster is the classes they are
 * assigned (F1) and carries roster fields only (F4); the offline-replay dedup
 * lookups are the caller's school's (F2, N1, admin F-6); a by-id student
 * route answers 404 for another school's pupil, never 403 (F7); the student
 * surface cannot read other classes' content (F3), rewrite the guardian on
 * file (F9) or receipt another school's notice (F5); the debug count is one
 * school's (F6); a public application names a real, open school and a class
 * of it (F11); a re-approval hashes the temporary password and binds only to
 * this school's class and login (admin F-1/F-2/F-3); an application is deleted
 * within the school (admin F-4); a teacher's email cannot collide with another
 * staff account (admin F-5); a school-less account reads nobody (users F-6);
 * and the login does not say which addresses belong to pupils (auth F-7), nor
 * hand a temporary password a renewable session (auth F-8).
 *
 *   node scripts/check-tenant-ids.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const bcrypt   = require("bcryptjs");
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
  process.env.JWT_SECRET         = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-only-refresh-secret-long-enough";
  process.env.NODE_ENV           = "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School             = mongoose.model("School");
  const User               = mongoose.model("User");
  const Class              = mongoose.model("Class");
  const Subject            = mongoose.model("Subject");
  const Student            = mongoose.model("Student");
  const StudentApplication = mongoose.model("StudentApplication");
  const TeacherAssignment  = mongoose.model("TeacherAssignment");
  const Announcement       = mongoose.model("Announcement");

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test", applicationsOpen: true },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test",  applicationsOpen: false },
  ]);

  const PASSWORD = "Check-only-passw0rd";
  const OID = (n) => `68d00000000000000000${String(n).padStart(4, "0")}`;
  const mkUser = (id, role, schoolId, extra = {}) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true, ...extra,
  });
  await Promise.all([
    mkUser("admin-a",    "school_admin", A),
    mkUser("admin-b",    "school_admin", B),
    mkUser("bursar-a",   "bursar",       A),
    mkUser("teacher-a",  "teacher",      A),      // Mathematics in 3A
    mkUser("teacher-a2", "teacher",      A),      // nothing
    mkUser("noschool",   "school_admin", null),   // a mis-provisioned row
    mkUser(OID(1),       "student",      B, { enrollmentNo: "B-0001" }),
    mkUser("pupil-a",    "student",      A, { enrollmentNo: "A-0001" }),
    mkUser("pupil-a2",   "student",      A, { enrollmentNo: "A-0002" }),
    mkUser("pupil-p",    "student",      A, { enrollmentNo: "A-0009" }),
    mkUser("temp-a",     "bursar",       A, { mustResetPassword: true }),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form3b", schoolId: A, name: "Form 3B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "maths-3a", schoolId: A, name: "Mathematics", classId: "form3a" },
    { _id: "maths-1b", schoolId: B, name: "Mathematics", classId: "form1b" },
  ]);
  const ta = await TeacherAssignment.create({ schoolId: A, teacher: "teacher-a", class: "form3a", subject: "maths-3a" });
  const pupil = (id, userId, schoolId, classId, n, extra = {}) => ({
    _id: id, userId, schoolId, classId, studentName: `Pupil ${n}`, firstName: "Pupil", lastName: String(n),
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${String(n).padStart(4, "0")}`, isActive: true, status: "approved",
    guardianName: "A Parent", guardianPhone: "+237600000001", medicalConditions: "asthma",
    nationalId: `NID-${n}`, gateToken: `gate-${id}`, ...extra,
  });
  await Student.create([
    pupil("st-a1", "pupil-a",  A, "form3a", 1),
    pupil("st-a2", "pupil-a2", A, "form3a", 2, { guardianPhone: null, guardianName: null }),
    pupil("st-a3", "u-st-a3",  A, "form3b", 3),
    pupil("st-b1", OID(1),     B, "form1b", 1),
    // A pending direct enrolment whose login already exists (a re-approval).
    pupil("st-p",  "pupil-p",  A, null,     9, { status: "pending" }),
  ]);
  await StudentApplication.create({ _id: "app-a1", schoolId: A, studentName: "Applicant A", status: "pending" }).catch(() => null);
  await Announcement.create({ _id: "ann-b", schoolId: B, title: "Beta only", body: "For Beta", audience: "all", isActive: true });

  // ── Real routers, mounted as server.js mounts them ──────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const optionalAuthenticate = (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) { req.user = null; return next(); }
    return auth.authenticate(req, res, next);
  };
  const studentRoutes = require(path.join(SRC, "routes/students.routes"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth",     require(path.join(SRC, "routes/auth.routes")));
  app.use("/api",          require(path.join(SRC, "routes/public.routes")));
  app.use("/api/students", optionalAuthenticate, studentRoutes);
  app.use("/api/student",  auth.authenticate,    studentRoutes);
  app.use("/api/users",    auth.authenticate,    require(path.join(SRC, "routes/user.routes")));
  app.use("/api/admin",    auth.authenticate,    require(path.join(SRC, "routes/admin.routes")));
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
    return {
      get:    (url)       => call("GET",    url, { token }),
      post:   (url, body) => call("POST",   url, { token, body }),
      put:    (url, body) => call("PUT",    url, { token, body }),
      patch:  (url, body) => call("PATCH",  url, { token, body }),
      delete: (url)       => call("DELETE", url, { token }),
    };
  };
  const adminA   = as("admin-a",    "school_admin", A);
  const adminB   = as("admin-b",    "school_admin", B);
  const bursarA  = as("bursar-a",   "bursar",       A);
  const teacherA = as("teacher-a",  "teacher",      A);
  const teacherA2= as("teacher-a2", "teacher",      A);
  const noSchool = as("noschool",   "school_admin", null);
  const pupilA   = as("pupil-a",    "student",      A);
  const pupilA2  = as("pupil-a2",   "student",      A);
  const listOf   = (body) => body?.students ?? body?.data?.students ?? body?.data ?? [];
  const PRIVATE  = ["guardianPhone", "medicalConditions", "nationalId", "gateToken", "documents"];
  const leaks    = (row) => PRIVATE.filter((k) => row && row[k] !== undefined);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- F1/F4: a teacher's roster is their classes, and roster fields only ---");

  let r = await teacherA.get("/students/teacher/students?classId=form3b");
  check("naming a class they are not assigned → 403", r.status, 403);
  r = await teacherA.get("/students/teacher/students?classId=form3a");
  check("naming their own class → 200, its pupils", [r.status, listOf(r.body).map((s) => s._id).sort()], [200, ["st-a1", "st-a2"]]);
  check("  and no guardian, medical, identity or gate fields on any row", listOf(r.body).flatMap(leaks), []);
  r = await teacherA.get("/students/teacher/students");
  check("no class named → only the assigned class", listOf(r.body).every((s) => s.classId === "form3a"), true);
  r = await teacherA2.get("/students/teacher/students");
  check("a teacher with no assignment → an empty roster", [r.status, listOf(r.body).length], [200, 0]);
  r = await teacherA2.get("/students/teacher/students?classId=form3a");
  check("  and cannot name a class to get one → 403", r.status, 403);

  r = await bursarA.get("/students");
  check("the bursar's roster (students.view) → 200 without the record fields", [r.status, listOf(r.body).flatMap(leaks)], [200, []]);
  r = await adminA.get("/students");
  check("the administrator (students.viewFull) → the record", listOf(r.body).some((s) => s.medicalConditions === "asthma"), true);
  r = await bursarA.get("/students/st-a1");
  check("one pupil for the bursar → no gate token, no medical field", leaks(r.body?.student), []);
  r = await adminA.get("/students/st-a1");
  check("  for the administrator → the record", r.body?.student?.gateToken, "gate-st-a1");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- F2/F7: by-id student routes are one school's, and say 404 ---");

  r = await adminB.get("/students/st-a1");
  check("another school's pupil by id → 404", r.status, 404);
  for (const [how, fire] of Object.entries({
    suspend:  () => adminB.patch("/students/st-a1/suspend", {}),
    restore:  () => adminB.patch("/students/st-a1/restore", {}),
    move:     () => adminB.patch("/students/st-a1/move", { classId: "form1b" }),
    edit:     () => adminB.patch("/students/st-a1", { firstName: "X" }),
    history:  () => adminB.get("/students/st-a1/history"),
    editable: () => adminB.get("/students/st-a1/editable"),
    delete:   () => adminB.delete("/students/st-a1"),
    approve:  () => adminB.put("/students/st-p/approve", { classId: "form1b" }),
    reject:   () => adminB.put("/students/st-p/reject", { reason: "no" }),
  })) {
    r = await fire();
    check(`  ${how} → 404, not 403`, r.status, 404);
  }
  const a1 = await Student.findOne({ _id: "st-a1" }).lean();
  check("  and nothing about st-a1 changed", [a1.status, a1.classId, a1.firstName, a1.deletedAt ?? null], ["approved", "form3a", "Pupil", null]);

  r = await adminB.post("/students", { id: "st-a1", name: "Copy", classId: "form1b" });
  check("the enrolment dedup with another school's id → 409, no record shown", [r.status, r.body?.student?.guardianPhone ?? null, r.body?.deduplicated ?? false], [409, null, false]);
  r = await adminA.post("/students", { id: "st-a1", name: "Copy", classId: "form3a" });
  check("  the school's own replay → deduplicated, roster shape only", [r.status, r.body?.deduplicated, leaks(r.body?.student)], [200, true, []]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- F3/F5/F6/F9: the student surface ---");

  r = await pupilA.get("/student/subject-content?classId=form1b&subjectId=maths-1b");
  check("a pupil asking for another class's content gets their own class's (nothing here) → 200, empty", [r.status, r.body?.items?.length ?? r.body?.data?.items?.length ?? 0], [200, 0]);

  r = await pupilA.post("/student/announcements/ann-b/read", {});
  check("a pupil receipting another school's announcement → 404", r.status, 404);
  check("  no receipt landed", ((await Announcement.findOne({ _id: "ann-b" }).lean())?.readBy ?? []).length, 0);

  r = await pupilA.put("/student/profile", { guardianPhone: "+237699999999", guardianName: "Somebody Else" });
  check("a pupil rewriting the guardian on file → accepted but not applied", [r.status < 300, (await Student.findOne({ _id: "st-a1" }).lean()).guardianPhone], [true, "+237600000001"]);
  r = await pupilA2.put("/student/profile", { guardianPhone: "+237677777777", guardianName: "First Entry" });
  check("  an EMPTY guardian field may still be filled", (await Student.findOne({ _id: "st-a2" }).lean()).guardianPhone, "+237677777777");

  r = await bursarA.get("/students/debug-count");
  check("the debug count is not for the bursar → 403", r.status, 403);
  r = await adminA.get("/students/debug-count");
  check("  the administrator gets their school's figures, no platform total", [r.status, r.body?.student?.rawStudentTotal ?? null, r.body?.student?.schoolStudentTotal], [200, null, 4]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- F11: a public application names a real, open school and its class ---");

  const apply = (body) => call("POST", "/students/apply", { body: { name: "New Child", guardianName: "P", guardianPhone: "+237611111111", ...body } });
  r = await apply({ schoolId: "68c00000000000000000ffff", classId: "form3a" });
  check("a school that does not exist → 404", r.status, 404);
  r = await apply({ schoolId: B, classId: "form1b" });
  check("a school that closed admissions → 403", r.status, 403);
  r = await apply({ schoolId: A, classId: "form1b" });
  check("another school's class → 400", r.status, 400);
  r = await apply({ schoolId: A, classId: "form3a", documents: [{ title: "Birth cert", url: "http://evil.example/x" }, { title: "Photo", url: "/uploads/applications/ok.jpg" }] });
  check("a valid application → accepted", r.status < 300, true);
  const applied = await Student.findOne({ studentName: "New Child", schoolId: A }).lean();
  check("  absolute document URLs are dropped, relative upload paths kept", (applied?.documents ?? []).map((d) => d.url), [null, "/uploads/applications/ok.jpg"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- admin F-1/F-2/F-3: approval binds within the school and hashes the password ---");

  r = await adminA.put("/admin/students/st-p/approve", { classId: "form1b" });
  check("approving into another school's class → 400", r.status, 400);
  r = await adminA.put("/admin/students/st-p/approve", { classId: "form3a" });
  check("approving into the school's own class → 200 with a temporary password", [r.status, typeof (r.body?.tempPassword ?? r.body?.data?.tempPassword)], [200, "string"]);
  const temp = r.body?.tempPassword ?? r.body?.data?.tempPassword;
  const login = await User.findOne({ _id: "pupil-p" }).select("+password").lean();
  check("  the login's stored password is a bcrypt hash, not the clear text", [String(login.password).startsWith("$2"), login.password === temp], [true, false]);
  check("  and the temporary password verifies against it", await bcrypt.compare(temp, login.password), true);
  check("  the login stays in its school", login.schoolId, A);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- admin F-4/F-5/F-6, N1: deletes, emails and replays are one school's ---");

  if (await StudentApplication.exists({ _id: "app-a1" })) {
    r = await adminB.delete("/admin/students/app-a1");
    check("another school's application deleted by id → 404", r.status, 404);
    check("  still there", (await StudentApplication.findOne({ _id: "app-a1" }).lean())?.deletedAt ?? null, null);
  }

  r = await adminA.put("/admin/teachers/teacher-a", { email: "admin-b@example.test" });
  check("giving a teacher another staff account's email → 409", r.status, 409);
  check("  the teacher's email is unchanged", (await User.findOne({ _id: "teacher-a" }).lean()).email, "teacher-a@example.test");

  r = await adminB.post("/admin/classes", { id: "form3a", name: "Mine now" });
  check("replaying another school's class id → 409, no row", [r.status, r.body?.class ?? null], [409, null]);
  r = await adminB.post("/admin/subjects", { id: "maths-3a", name: "Maths", classId: "form1b" });
  check("replaying another school's subject id → 409, no row", [r.status, r.body?.subject ?? null], [409, null]);
  r = await adminB.post("/admin/assignments", { id: String(ta._id), teacherId: "teacher-a", classId: "form3a", subjectId: "maths-3a" });
  check("replaying another school's assignment id → refused, no row shown", [r.status >= 400, r.body?.assignment ?? null], [true, null]);
  r = await adminA.post("/admin/assignments", { id: String(ta._id), teacherId: "teacher-a", classId: "form3a", subjectId: "maths-3a" });
  check("  the school's own replay → deduplicated, ids only", [r.status, r.body?.deduplicated, Object.keys(r.body?.assignment ?? {}).sort()], [200, true, ["_id", "classId", "id", "schoolId", "subjectId", "teacherId"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- users F-6: a school-less school_admin reads nobody ---");
  r = await noSchool.get(`/users/${OID(1)}`);
  check("no school on the session → 403, not another school's user", r.status, 403);
  r = await adminB.get(`/users/${OID(1)}`);
  check("  the user's own school's admin → 200", r.status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- auth F-7/F-8: the login does not point out pupils, and a temporary password does not renew ---");
  r = await call("POST", "/auth/login", { body: { email: "pupil-a@example.test", password: "wrong" } });
  const unknown = await call("POST", "/auth/login", { body: { email: "nobody@example.test", password: "wrong" } });
  check("a pupil's email with a staff login → the same 401 as an unknown address", [r.status, r.body?.message], [unknown.status, unknown.body?.message]);
  r = await call("POST", "/auth/login", { body: { email: "temp-a@example.test", password: PASSWORD } });
  check("a temporary-password login → a session, but no refresh token", [r.status, typeof r.body?.token, r.body?.refreshToken ?? null], [200, "string", null]);
  r = await call("POST", "/auth/login", { body: { email: "bursar-a@example.test", password: PASSWORD } });
  check("  an ordinary login still gets one", typeof r.body?.refreshToken, "string");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  // Explicit: with the auth and public routers mounted, something keeps the
  // event loop alive after cleanup (the suite printed its summary and hung
  // under npm). The verdict is in, so the process ends here.
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
