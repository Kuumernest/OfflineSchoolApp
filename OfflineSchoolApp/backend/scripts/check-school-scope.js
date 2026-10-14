// backend/scripts/check-school-scope.js
"use strict";

/**
 * The school, at the door — proved with two schools in the database.
 *
 * Two rules live in middleware/auth.js and are tested here through the real
 * routers, with real tokens, and with data in BOTH schools so that an empty
 * answer cannot pass for a refused one:
 *
 *   1. A school that the platform has switched off, or deleted, takes its
 *      staff and pupils with it. Sign-in is refused (403 SCHOOL_INACTIVE),
 *      and a token issued BEFORE the switch is refused at its next use
 *      (401 SCHOOL_INACTIVE) — no blacklist, one cached row read. Switching
 *      the school back on lifts both at once.
 *
 *   2. A school-scoped caller — administrator, bursar, teacher, pupil — who
 *      names another school in the query, the body or the path is refused
 *      with 403 SCHOOL_ACCESS_DENIED. Not corrected, not answered about their
 *      own school: refused. A super_admin may name any school, and a school
 *      that does not exist is a 404 for them and a 403 for everyone else.
 *
 *   node scripts/check-school-scope.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, `expected ${e}\n     got ${a}`);
};

(async () => {
  process.env.JWT_SECRET         = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-only-refresh-secret-long-enough";
  process.env.NODE_ENV           = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School  = mongoose.model("School");
  const User    = mongoose.model("User");
  const Student = mongoose.model("Student");
  const Class   = mongoose.model("Class");
  const AcademicStructure = mongoose.model("AcademicStructure");
  const { invalidateSchool } = require(path.join(SRC, "utils/schoolContext"));

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  const YEAR = "2026-2027";
  const PASSWORD = "Check-only-passw0rd";

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA" },
    { _id: B, name: "Beta College",  code: "BETA"  },
  ]);
  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("root",      "super_admin",  null, "Root"),
    mkUser("admin-a",   "school_admin", A,    "Admin A"),
    mkUser("bursar-a",  "bursar",       A,    "Bursar A"),
    mkUser("teacher-a", "teacher",      A,    "Teacher A"),
    mkUser("student-a", "student",      A,    "Student A"),
    mkUser("admin-b",   "school_admin", B,    "Admin B"),
  ]);
  await Class.create([{ _id: "cls-a", schoolId: A, name: "1A" }, { _id: "cls-b", schoolId: B, name: "1B" }]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([pupil("stu-a1", A, "cls-a", 1), pupil("stu-a2", A, "cls-a", 2), pupil("stu-b1", B, "cls-b", 1)]);
  // The document the path-parameter route serves, in both schools, marked.
  await AcademicStructure.create([
    { schoolId: A, academicYear: YEAR, passMark: 10 },
    { schoolId: B, academicYear: YEAR, passMark: 11 },
  ]).catch(() => { /* schema may require more; the route still answers 200/404 per school */ });

  // ── The real routers, behind the real door ──────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth",               require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/super-admin",        auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use("/api/admin",              auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use("/api/academic-structure", auth.authenticate, require(path.join(SRC, "routes/academicStructure.routes")));
  app.use("/api/announcements",      auth.authenticate, require(path.join(SRC, "routes/announcement.routes")));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));

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
  const sign  = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const login = (email) => call("POST", "/auth/login", { body: { email, password: PASSWORD } });
  const as    = (token) => ({
    get:  (url)       => call("GET",  url, { token }),
    post: (url, body) => call("POST", url, { token, body }),
    put:  (url, body) => call("PUT",  url, { token, body }),
  });
  const T = {
    root:     sign("root",      "super_admin",  null),
    adminA:   sign("admin-a",   "school_admin", A),
    bursarA:  sign("bursar-a",  "bursar",       A),
    teacherA: sign("teacher-a", "teacher",      A),
    studentA: sign("student-a", "student",      A),
    adminB:   sign("admin-b",   "school_admin", B),
  };
  const root = as(T.root);
  const denied = (r) => [r.status, r.body?.code];
  const listOf = (body) => body?.students ?? body?.data?.students ?? body?.data ?? [];

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- a deactivated school blocks authentication ---");
  let r = await login("admin-a@example.test");
  check("active school: the administrator signs in", r.status, 200);
  const before = r.body?.token;
  const refreshBefore = r.body?.refreshToken;
  check("  and holds a refresh token for the test below", typeof refreshBefore, "string");
  r = await as(before).get(`/admin/students?schoolId=${A}`);
  check("  and reads their pupils", [r.status, listOf(r.body).length], [200, 2]);

  r = await root.post(`/super-admin/schools/${A}/deactivate`, { reason: "Subscription lapsed" });
  check("the platform switches Alpha off", [r.status, r.body?.school?.isActive], [200, false]);

  for (const [who, email] of [["school admin", "admin-a"], ["teacher", "teacher-a"], ["bursar", "bursar-a"]]) {
    r = await login(`${email}@example.test`);
    check(`${who} of a deactivated school cannot sign in: 403 SCHOOL_INACTIVE`, denied(r), [403, "SCHOOL_INACTIVE"]);
  }
  r = await call("POST", "/auth/login", { body: { enrollmentNo: "A-1", password: PASSWORD } });
  check("nor can a pupil (no such enrolment on a User, so the ordinary 401)", r.status, 401);

  r = await as(before).get(`/admin/students?schoolId=${A}`);
  check("the token issued BEFORE the switch is refused at its next use: 401 SCHOOL_INACTIVE", denied(r), [401, "SCHOOL_INACTIVE"]);
  r = await as(before).get("/admin/students");
  check("  even without naming a school", denied(r), [401, "SCHOOL_INACTIVE"]);
  for (const [who, token] of [["teacher", T.teacherA], ["bursar", T.bursarA], ["pupil", T.studentA]]) {
    r = await as(token).get("/api/announcements".replace("/api", ""));
    check(`  ${who}'s token too`, denied(r), [401, "SCHOOL_INACTIVE"]);
  }
  r = await call("POST", "/auth/refresh", { body: { refreshToken: refreshBefore } });
  check("a refresh token cannot mint a new session for a closed school: 401 SCHOOL_INACTIVE", denied(r), [401, "SCHOOL_INACTIVE"]);
  r = await call("POST", "/auth/refresh", { token: before, body: {} });
  check("  nor can the access token (Mode B goes through the door)", denied(r), [401, "SCHOOL_INACTIVE"]);

  r = await root.get(`/admin/students?schoolId=${A}`);
  check("the super admin still reads the closed school", [r.status, listOf(r.body).length], [200, 2]);
  r = await as(T.adminB).get(`/admin/students?schoolId=${B}`);
  check("Beta, still open, is unaffected", r.status, 200);

  r = await root.post(`/super-admin/schools/${A}/activate`, {});
  check("the platform switches Alpha back on", [r.status, r.body?.school?.isActive], [200, true]);
  r = await login("admin-a@example.test");
  check("reactivated: sign-in works again", r.status, 200);
  r = await as(before).get(`/admin/students?schoolId=${A}`);
  check("  and the OLD token works again — nothing was blacklisted", r.status, 200);
  r = await call("POST", "/auth/refresh", { body: { refreshToken: refreshBefore } });
  check("  and the refresh token too", r.status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- naming another school is refused, however it is named ---");
  const ROUTES = {
    query: (token) => as(token).get(`/admin/students?schoolId=${B}`),
    body:  (token) => as(token).post("/admin/settings/admins", { name: "X", email: "x@example.test", schoolId: B }),
    path:  (token) => as(token).get(`/academic-structure/${B}/${YEAR}`),
    read:  (token) => as(token).get(`/announcements?schoolId=${B}`),
  };
  for (const [who, token] of [["school admin", T.adminA], ["teacher", T.teacherA], ["bursar", T.bursarA], ["pupil", T.studentA]]) {
    for (const [how, fire] of Object.entries(ROUTES)) {
      const res = await fire(token);
      check(`${who} naming Beta in the ${how} → 403 SCHOOL_ACCESS_DENIED`, denied(res), [403, "SCHOOL_ACCESS_DENIED"]);
    }
  }
  check("nothing was created in Beta by any of it", await User.countDocuments({ email: "x@example.test" }), 0);

  console.log("\n--- their own school, however it is named, is served as before ---");
  r = await as(T.adminA).get(`/admin/students?schoolId=${A}`);
  check("school admin: query naming Alpha → 200, Alpha's pupils", [r.status, listOf(r.body).map((s) => s._id).sort()], [200, ["stu-a1", "stu-a2"]]);
  r = await as(T.adminA).get("/admin/students?schoolId=");
  check("  an empty schoolId is 'unspecified', not another school", r.status, 200);
  r = await as(T.adminA).get("/admin/students");
  check("  and none at all is their own", [r.status, listOf(r.body).length], [200, 2]);
  r = await as(T.teacherA).get(`/academic-structure/${A}/${YEAR}`);
  check("teacher: the path naming Alpha is not refused by the school guard", r.status === 403 && r.body?.code === "SCHOOL_ACCESS_DENIED", false);
  r = await as(T.bursarA).get(`/announcements?schoolId=${A}`);
  check("bursar: reading Alpha's announcements is not refused by the school guard", r.body?.code === "SCHOOL_ACCESS_DENIED", false);
  r = await as(T.adminA).post("/admin/settings/admins", { name: "Own", email: "own@example.test", schoolId: A });
  check("  appointing in their own school → 201, in Alpha", [r.status, r.body?.admin?.schoolId], [201, A]);

  console.log("\n--- the super admin may name any school ---");
  r = await root.get(`/admin/students?schoolId=${B}`);
  check("query naming Beta → Beta's pupils", [r.status, listOf(r.body).map((s) => s._id)], [200, ["stu-b1"]]);
  r = await root.get(`/academic-structure/${B}/${YEAR}`);
  check("path naming Beta → not refused", r.body?.code === "SCHOOL_ACCESS_DENIED", false);
  r = await root.post("/admin/settings/admins", { name: "Beta Two", email: "beta2@example.test", schoolId: B });
  check("body naming Beta → the account lands in Beta", [r.status, r.body?.admin?.schoolId], [201, B]);

  console.log("\n--- a school that does not exist is answered explicitly ---");
  const GHOST = "68c00000000000000000ffff";
  r = await as(T.adminA).get(`/admin/students?schoolId=${GHOST}`);
  check("school admin naming a ghost → 403 SCHOOL_ACCESS_DENIED (not theirs, whatever it is)", denied(r), [403, "SCHOOL_ACCESS_DENIED"]);
  r = await as(T.adminA).get("/admin/students?schoolId=not-even-an-id");
  check("  or a string that could never be one → 403", denied(r), [403, "SCHOOL_ACCESS_DENIED"]);
  r = await root.get(`/admin/students?schoolId=${GHOST}`);
  check("super admin naming a ghost → 404 SCHOOL_NOT_FOUND", denied(r), [404, "SCHOOL_NOT_FOUND"]);
  r = await root.get("/admin/students?schoolId=not-even-an-id");
  check("  or a string that could never be one → 404", denied(r), [404, "SCHOOL_NOT_FOUND"]);
  r = await root.get(`/academic-structure/${GHOST}/${YEAR}`);
  check("  a ghost in the path is not a 500", r.status < 500, true);

  console.log("\n--- a deleted school is closed to its own people too ---");
  await School.softDelete(B, null);
  invalidateSchool(B);
  r = await as(T.adminB).get("/admin/students");
  check("Beta's administrator, after Beta is deleted → 401 SCHOOL_INACTIVE", denied(r), [401, "SCHOOL_INACTIVE"]);
  r = await login("admin-b@example.test");
  check("  and cannot sign in → 403 SCHOOL_INACTIVE", denied(r), [403, "SCHOOL_INACTIVE"]);
  r = await root.get(`/admin/students?schoolId=${B}`);
  check("  and for the super admin it is a 404", denied(r), [404, "SCHOOL_NOT_FOUND"]);

  console.log("\n--- a user whose school was never a row is not locked out ---");
  await mkUser("legacy", "school_admin", "school-legacy", "Legacy Admin");
  r = await login("legacy@example.test");
  check("sign-in works: a dangling schoolId is not a closed school", r.status, 200);
  r = await as(sign("legacy", "school_admin", "school-legacy")).get("/admin/students");
  check("  and so does a request", r.status, 200);
  r = await as(sign("legacy", "school_admin", "school-legacy")).get(`/admin/students?schoolId=${A}`);
  check("  but naming Alpha is still refused", denied(r), [403, "SCHOOL_ACCESS_DENIED"]);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
