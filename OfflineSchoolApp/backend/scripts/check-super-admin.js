// backend/scripts/check-super-admin.js
"use strict";

/**
 * The platform role, proved with two schools in the database.
 *
 * super_admin has always been able to cross schools: utils/tenant.js takes it
 * at its word about which school a request is for, and the permission registry
 * hands it every school capability. What did not exist was the platform
 * itself — no way to create a school, switch one off, look across all of them,
 * or read a record of having done so — and nothing checked that the school a
 * super_admin named was real.
 *
 * The property that matters most is the negative one, and it is tested with
 * data on both sides so an empty answer cannot pass for a scoped one: a school
 * administrator, a bursar, a teacher, a student and a guardian must get from
 * the platform routes exactly what they got before those routes existed, which
 * is nothing; and a school administrator naming another school must still be
 * answered about their own.
 *
 *   node scripts/check-super-admin.js
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School       = mongoose.model("School");
  const User         = mongoose.model("User");
  const Student      = mongoose.model("Student");
  const Class        = mongoose.model("Class");
  const TermResult   = mongoose.model("TermResult");
  const AnnualResult = mongoose.model("AnnualResult");
  const FeeCharge    = mongoose.model("FeeCharge");
  const FeePayment   = mongoose.model("FeePayment");
  const AuditLog     = mongoose.model("AuditLog");
  const { StudentAttendance } = require(path.join(SRC, "db/models/Attendance"));
  const permissions  = require(path.join(SRC, "services/permissions.service"));

  // Mongoose builds indexes in the background after the model compiles; the
  // duplicate-code assertions below need the unique index to exist first.
  await School.init();

  // ── Two schools, populated with distinguishable records ─────────────────
  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  const YEAR = "2026/2027";
  const PASSWORD = "Check-only-passw0rd";

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test",
      settings: { academicYear: YEAR, currentTerm: "First Term" } },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test",
      settings: { academicYear: YEAR, currentTerm: "First Term" } },
  ]);

  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: PASSWORD,
    role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("root",      "super_admin",  null, "Root Operator"),
    mkUser("admin-a",   "school_admin", A,    "Admin A"),
    mkUser("admin-b",   "school_admin", B,    "Admin B"),
    mkUser("bursar-a",  "bursar",       A,    "Bursar A"),
    mkUser("teacher-a", "teacher",      A,    "Teacher A"),
    mkUser("teacher-b", "teacher",      B,    "Teacher B"),
    mkUser("student-a", "student",      A,    "Student A"),
  ]);

  await Class.create([
    { _id: "cls-a", schoolId: A, name: "Form 1A" },
    { _id: "cls-b", schoolId: B, name: "Form 1B" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("stu-a1", A, "cls-a", 1), pupil("stu-a2", A, "cls-a", 2), pupil("stu-a3", A, "cls-a", 3),
    pupil("stu-b1", B, "cls-b", 1), pupil("stu-b2", B, "cls-b", 2),
  ]);

  const day = "2026-09-14";
  await StudentAttendance.create([
    { schoolId: A, classId: "cls-a", studentId: "stu-a1", markedBy: "teacher-a", date: day, status: "present" },
    { schoolId: A, classId: "cls-a", studentId: "stu-a2", markedBy: "teacher-a", date: day, status: "present" },
    { schoolId: A, classId: "cls-a", studentId: "stu-a3", markedBy: "teacher-a", date: day, status: "absent"  },
    { schoolId: B, classId: "cls-b", studentId: "stu-b1", markedBy: "teacher-b", date: day, status: "late"    },
    { schoolId: B, classId: "cls-b", studentId: "stu-b2", markedBy: "teacher-b", date: day, status: "present" },
  ]);
  await TermResult.create([
    { schoolId: A, academicYear: YEAR, term: 1, classId: "cls-a", studentId: "stu-a1", termAverage: 14, isPassing: true },
    { schoolId: A, academicYear: YEAR, term: 1, classId: "cls-a", studentId: "stu-a2", termAverage: 8,  isPassing: false },
    { schoolId: B, academicYear: YEAR, term: 1, classId: "cls-b", studentId: "stu-b1", termAverage: 12, isPassing: true },
    { schoolId: B, academicYear: YEAR, term: 2, classId: "cls-b", studentId: "stu-b1", termAverage: 16, isPassing: true },
  ]);
  await AnnualResult.create([
    { schoolId: A, academicYear: YEAR, classId: "cls-a", studentId: "stu-a1", annualAverage: 14, promotionStatus: "promoted" },
    { schoolId: A, academicYear: YEAR, classId: "cls-a", studentId: "stu-a2", annualAverage: 8,  promotionStatus: "repeated" },
    { schoolId: B, academicYear: YEAR, classId: "cls-b", studentId: "stu-b1", annualAverage: 14, promotionStatus: "pending"  },
  ]);
  await FeeCharge.create([
    { schoolId: A, studentId: "stu-a1", academicYear: YEAR, code: "TUI", label: "Tuition", amount: 100000, waivedAmount: 0 },
    { schoolId: A, studentId: "stu-a2", academicYear: YEAR, code: "TUI", label: "Tuition", amount: 100000, waivedAmount: 20000 },
    { schoolId: B, studentId: "stu-b1", academicYear: YEAR, code: "TUI", label: "Tuition", amount: 50000,  waivedAmount: 0 },
  ]);
  await FeePayment.create([
    { schoolId: A, studentId: "stu-a1", academicYear: YEAR, amount: 60000, method: "cash" },
    { schoolId: A, studentId: "stu-a1", academicYear: YEAR, amount: -10000, method: "cash", reversesId: "x" },
    { schoolId: B, studentId: "stu-b1", academicYear: YEAR, amount: 50000, method: "cash" },
  ]);

  // ── The real routers, behind the real door ──────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth",        require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use("/api/admin",       auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
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
  const sign = (id, role, schoolId) =>
    jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });

  const T = {
    adminA:   sign("admin-a",   "school_admin", A),
    adminB:   sign("admin-b",   "school_admin", B),
    bursarA:  sign("bursar-a",  "bursar",       A),
    teacherA: sign("teacher-a", "teacher",      A),
    studentA: sign("student-a", "student",      A),
    guardian: jwt.sign({ accessId: "acc-1", schoolId: A }, process.env.JWT_SECRET,
                       { audience: "portal", expiresIn: "1h" }),
  };
  const as = (token) => ({
    get:   (url)       => call("GET",   url, { token }),
    post:  (url, body) => call("POST",  url, { token, body }),
    patch: (url, body) => call("PATCH", url, { token, body }),
  });
  const auditRows = (filter) => AuditLog.find(filter).sort({ at: 1 }).lean();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. a super admin signs in like anyone else ---");
  const login = await call("POST", "/auth/login", { body: { email: "root@example.test", password: PASSWORD } });
  check("login → 200", login.status, 200);
  check("role is super_admin", login.body?.user?.role, "super_admin");
  check("belongs to no school", login.body?.user?.schoolId ?? null, null);
  const perms = login.body?.user?.permissions ?? [];
  check("holds the four platform capabilities",
    ["platform.schools", "platform.manageSchools", "platform.dashboard", "platform.audit"]
      .every((k) => perms.includes(k)), true);
  check("and every school capability too (users.manage, results.publish, fees.manage)",
    ["users.manage", "results.publish", "fees.manage"].every((k) => perms.includes(k)), true);
  const ROOT_TOKEN = login.body?.token;
  const root = as(ROOT_TOKEN);

  const adminLogin = await call("POST", "/auth/login", { body: { email: "admin-a@example.test", password: PASSWORD } });
  check("a school admin's login carries no platform capability",
    (adminLogin.body?.user?.permissions ?? []).filter((k) => k.startsWith("platform.")), []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. creating a school ---");
  let r = await root.post("/super-admin/schools", { name: "Gamma School", code: "gamma", email: "Gamma@Example.test", city: "Buea" });
  check("POST /super-admin/schools → 201", r.status, 201);
  const G = r.body?.school?._id;
  check("the school has an id", typeof G, "string");
  check("code is upper-cased by the model", r.body?.school?.code, "GAMMA");
  check("email is lower-cased", r.body?.school?.email, "gamma@example.test");
  check("created active", r.body?.school?.isActive, true);
  check("with zero pupils and staff", r.body?.school?.counts, { students: 0, teachers: 0, admins: 0, bursars: 0 });

  r = await root.post("/super-admin/schools", { name: "Another", code: "GAMMA" });
  check("a duplicate code → 409", r.status, 409);
  r = await root.post("/super-admin/schools", { code: "NONAME" });
  check("no name → 400", r.status, 400);
  r = await root.post("/super-admin/schools", { name: "X", email: "not-an-email" });
  check("a bad email → 400", r.status, 400);

  let rows = await auditRows({ action: "school.created" });
  check("one school.created audit row", rows.length, 1);
  check("  by the super admin", rows[0]?.actorId, "root");
  check("  naming the new school", rows[0]?.schoolId, G);
  check("  with what it was created as", rows[0]?.after?.name, "Gamma School");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. listing schools ---");
  r = await root.get("/super-admin/schools");
  check("GET /super-admin/schools → 200", r.status, 200);
  check("three schools", r.body?.total, 3);
  const alpha = (r.body?.schools ?? []).find((s) => s._id === A);
  check("Alpha shows 3 approved pupils", alpha?.counts?.students, 3);
  check("1 teacher, 1 admin, 1 bursar", [alpha?.counts?.teachers, alpha?.counts?.admins, alpha?.counts?.bursars], [1, 1, 1]);
  r = await root.get("/super-admin/schools?search=beta");
  check("search by name → Beta only", (r.body?.schools ?? []).map((s) => s.name), ["Beta College"]);
  r = await root.get("/super-admin/schools?search=GAM");
  check("search matches the code", (r.body?.schools ?? []).map((s) => s.code), ["GAMMA"]);
  r = await root.get("/super-admin/schools?status=inactive");
  check("no inactive school yet", r.body?.total, 0);
  r = await root.get("/super-admin/schools?limit=2&page=2");
  check("pagination: page 2 of 2 holds the third", [r.body?.pages, r.body?.schools?.length], [2, 1]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. one school in detail ---");
  r = await root.get(`/super-admin/schools/${A}`);
  check("GET /super-admin/schools/:id → 200", r.status, 200);
  check("the school", r.body?.school?.name, "Alpha Academy");
  check("its administrators and bursar, by email",
    (r.body?.admins ?? []).map((u) => u.email).sort(), ["admin-a@example.test", "bursar-a@example.test"]);
  check("no password field leaks", (r.body?.admins ?? []).some((u) => "password" in u), false);
  r = await root.get("/super-admin/schools/68c00000000000000000ffff");
  check("an unknown id → 404", r.status, 404);
  r = await root.get("/super-admin/schools/not-an-id");
  check("a malformed id → 404, not 500", r.status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. changing and switching off a school ---");
  r = await root.patch(`/super-admin/schools/${A}`, { phone: "+237 600 000 000", city: "Limbe", motto: "ignored" });
  check("PATCH → 200", r.status, 200);
  check("only identity fields changed", r.body?.changed?.sort(), ["city", "phone"]);
  rows = await auditRows({ action: "school.updated" });
  check("school.updated recorded with before/after",
    [rows[0]?.before?.city ?? null, rows[0]?.after?.city], [null, "Limbe"]);
  r = await root.patch(`/super-admin/schools/${A}`, { motto: "x" });
  check("a PATCH with nothing it owns → 400", r.status, 400);
  r = await root.patch(`/super-admin/schools/${A}`, { code: "BETA" });
  check("taking another school's code → 409", r.status, 409);

  r = await root.post(`/super-admin/schools/${B}/deactivate`, {});
  check("deactivating without a reason → 400", r.status, 400);
  r = await root.post(`/super-admin/schools/${B}/deactivate`, { reason: "Unpaid subscription" });
  check("deactivate → 200, isActive false", [r.status, r.body?.school?.isActive], [200, false]);
  r = await root.get("/super-admin/schools?status=inactive");
  check("it now lists as inactive", (r.body?.schools ?? []).map((s) => s._id), [B]);
  rows = await auditRows({ action: "school.deactivated" });
  check("school.deactivated recorded with the reason", rows[0]?.reason, "Unpaid subscription");
  r = await root.post(`/super-admin/schools/${B}/deactivate`, { reason: "again" });
  check("deactivating twice changes nothing", r.body?.changed, false);
  check("  and records nothing", (await auditRows({ action: "school.deactivated" })).length, 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 13. a deactivated school takes its staff with it ---");
  r = await as(T.adminB).get(`/admin/students?schoolId=${B}`);
  check("its administrator's existing token is refused on the next request: 401 SCHOOL_INACTIVE", [r.status, r.body?.code], [401, "SCHOOL_INACTIVE"]);
  const adminBLogin = await call("POST", "/auth/login", { body: { email: "admin-b@example.test", password: PASSWORD } });
  check("and cannot sign in: 403 SCHOOL_INACTIVE", [adminBLogin.status, adminBLogin.body?.code], [403, "SCHOOL_INACTIVE"]);
  r = await root.get(`/admin/students?schoolId=${B}`);
  check("the super admin can still read a deactivated school", r.status, 200);
  r = await root.post(`/super-admin/schools/${B}/enter`, {});
  check("and enter it, told that it is off", [r.status, r.body?.school?.isActive], [200, false]);
  r = await root.post(`/super-admin/schools/${B}/activate`, {});
  check("activate → 200, isActive true", [r.status, r.body?.school?.isActive], [200, true]);
  check("school.activated recorded", (await auditRows({ action: "school.activated" })).length, 1);
  r = await as(T.adminB).get(`/admin/students?schoolId=${B}`);
  check("reactivated: the same token works again", r.status, 200);
  check("and its administrator can sign in again",
    (await call("POST", "/auth/login", { body: { email: "admin-b@example.test", password: PASSWORD } })).status, 200);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. inside a school, the super admin is that school's admin ---");
  r = await root.get(`/admin/students?schoolId=${A}`);
  const listOf = (body) => body?.students ?? body?.data?.students ?? body?.data ?? [];
  check("GET /admin/students?schoolId=A → 200", r.status, 200);
  check("Alpha's three pupils", listOf(r.body).map((s) => s._id).sort(), ["stu-a1", "stu-a2", "stu-a3"]);
  r = await root.get(`/admin/students?schoolId=${B}`);
  check("GET /admin/students?schoolId=B → Beta's two", listOf(r.body).map((s) => s._id).sort(), ["stu-b1", "stu-b2"]);
  r = await root.get(`/admin/stats?schoolId=${A}`);
  check("the admin dashboard figures for A", r.status, 200);
  r = await root.get(`/admin/settings/admins?schoolId=${B}`);
  check("Beta's admins", (r.body?.admins ?? []).map((u) => u._id), ["admin-b"]);

  r = await root.post("/admin/settings/admins", { name: "New Gamma Admin", email: "gamma-admin@example.test", schoolId: G });
  check("appointing Gamma's first administrator through the existing route → 201", r.status, 201);
  check("  in Gamma", r.body?.admin?.schoolId, G);
  check("  as school_admin", r.body?.admin?.role, "school_admin");
  rows = await auditRows({ action: "admin.created" });
  check("admin.created recorded, against Gamma, by root", [rows[0]?.schoolId, rows[0]?.actorId], [G, "root"]);
  r = await root.get(`/super-admin/schools/${G}`);
  check("Gamma now shows one admin", r.body?.school?.counts?.admins, 1);

  r = await root.post(`/super-admin/schools/${A}/enter`, {});
  check("entering Alpha → 200 with its context", [r.status, r.body?.school?.name, r.body?.school?.academicYear], [200, "Alpha Academy", YEAR]);
  check("school.entered recorded for Alpha", (await auditRows({ action: "school.entered", schoolId: A })).length, 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. across schools ---");
  r = await root.get("/super-admin/dashboard");
  check("GET /super-admin/dashboard → 200", r.status, 200);
  const t = r.body?.totals ?? {};
  check("3 schools, 3 active", [t.schools, t.activeSchools], [3, 3]);
  check("5 approved pupils", t.students, 5);
  check("2 teachers", t.teachers, 2);
  check("attendance: 5 marked, 3 present → 60%", [t.attendance?.marked, t.attendance?.present, t.attendance?.rate], [5, 3, 60]);
  check("results: 4, average 12.5, pass rate 75%", [t.academics?.results, t.academics?.average, t.academics?.passRate], [4, 12.5, 75]);
  check("promotion: 2 decided, 1 promoted → 50%, 1 pending not counted", [t.promotion?.decided, t.promotion?.rate, t.promotion?.pending], [2, 50, 1]);
  check("fees: billed 230000, paid 100000 (a reversal netted), 43%", [t.fees?.billed, t.fees?.paid, t.fees?.collectionRate], [230000, 100000, 43]);

  r = await root.get(`/super-admin/dashboard?schoolId=${A}`);
  check("filtered to Alpha: 3 pupils, 1 school", [r.body?.totals?.students, r.body?.totals?.schools], [3, 1]);
  r = await root.get(`/super-admin/dashboard?academicYear=${encodeURIComponent(YEAR)}&term=2`);
  check("term 2 results only: 1 result, average 16", [r.body?.totals?.academics?.results, r.body?.totals?.academics?.average], [1, 16]);
  check("  while fees stay for the year (term is a free label on a charge)", r.body?.totals?.fees?.billed, 230000);
  r = await root.get("/super-admin/dashboard?academicYear=1999/2000");
  check("a year with no data: zeros and null rates, not invented 100%s",
    [r.body?.totals?.academics?.results, r.body?.totals?.academics?.passRate, r.body?.totals?.fees?.collectionRate], [0, null, null]);
  r = await root.get("/super-admin/dashboard?schoolId=68c00000000000000000ffff");
  check("an unknown school filter → 404", r.status, 404);

  r = await root.get("/super-admin/performance");
  check("GET /super-admin/performance → one row per school", (r.body?.schools ?? []).length, 3);
  const rowA = (r.body?.schools ?? []).find((s) => s.schoolId === A);
  check("Alpha's row: 3 pupils, 67% present, 50% pass, 50% promoted, 28% collected (50 000 of 180 000)",
    [rowA?.students, rowA?.attendance?.rate, rowA?.academics?.passRate, rowA?.promotion?.rate, rowA?.fees?.collectionRate],
    [3, 67, 50, 50, 28]);
  r = await root.get("/super-admin/filters");
  check("the filter options know the year with data", r.body?.academicYears, [YEAR]);
  check("  and every school", (r.body?.schools ?? []).length, 3);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8, 10, 11. everyone else is refused ---");
  const PLATFORM = [
    ["GET",   "/super-admin/schools"],
    ["POST",  "/super-admin/schools"],
    ["GET",   `/super-admin/schools/${A}`],
    ["PATCH", `/super-admin/schools/${A}`],
    ["POST",  `/super-admin/schools/${A}/activate`],
    ["POST",  `/super-admin/schools/${A}/deactivate`],
    ["POST",  `/super-admin/schools/${A}/enter`],
    ["GET",   "/super-admin/dashboard"],
    ["GET",   "/super-admin/performance"],
    ["GET",   "/super-admin/filters"],
    ["GET",   "/super-admin/audit"],
  ];
  for (const [who, token] of [["a school admin", T.adminA], ["a bursar", T.bursarA], ["a teacher", T.teacherA], ["a student", T.studentA]]) {
    const answers = [];
    for (const [m, u] of PLATFORM) {
      const res = await call(m, u, { token, body: m === "GET" ? undefined : { name: "x", reason: "x" } });
      answers.push(`${m} ${u.replace(A, ":A")} → ${res.status}${res.body?.permission ? ` (${res.body.permission})` : ""}`);
    }
    const all403 = answers.every((a) => / → 403 \(platform\./.test(a));
    if (all403) ok(`${who} gets 403 naming a platform.* capability on all ${PLATFORM.length} platform routes`);
    else bad(`${who} is refused on every platform route`, answers.join("\n"));
  }
  {
    const res = await call("GET", "/super-admin/schools", { token: T.guardian });
    check("a guardian's portal token → 401", res.status, 401);
    const none = await call("GET", "/super-admin/schools");
    check("no token → 401", none.status, 401);
  }
  const schoolsBefore = await School.countDocuments();
  await as(T.adminA).post("/super-admin/schools", { name: "Sneaky School" });
  check("a school admin's attempt created nothing", await School.countDocuments(), schoolsBefore);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. a school admin naming another school is refused ---");
  r = await as(T.adminA).get(`/admin/students?schoolId=${B}`);
  check("GET /admin/students?schoolId=B as Alpha's admin → 403 SCHOOL_ACCESS_DENIED", [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);
  check("  and none of Beta's pupils in the body", listOf(r.body).length, 0);
  r = await as(T.adminA).get(`/admin/settings/admins?schoolId=${B}`);
  check("GET /admin/settings/admins?schoolId=B → 403", r.status, 403);
  r = await as(T.adminA).post("/admin/settings/admins", { name: "Planted", email: "planted@example.test", schoolId: B });
  check("appointing an admin 'in' Beta → 403, nothing created", [r.status, await User.countDocuments({ email: "planted@example.test" })], [403, 0]);
  r = await as(T.adminA).get(`/admin/students?schoolId=${A}`);
  check("naming their OWN school still works", [r.status, listOf(r.body).length], [200, 3]);
  r = await as(T.adminA).post("/admin/settings/admins", { name: "Planted", email: "planted@example.test", schoolId: A });
  check("  and appointing in their own school lands there", [r.status, r.body?.admin?.schoolId], [201, A]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 12. the school context cannot be forged ---");
  const forgedRole = jwt.sign({ id: "admin-a", role: "super_admin", schoolId: null }, process.env.JWT_SECRET, { expiresIn: "1h" });
  r = await as(forgedRole).get("/super-admin/schools");
  check("a token claiming super_admin for a school_admin's id → 403 (the role comes from the database)", r.status, 403);
  r = await as(forgedRole).get(`/admin/students?schoolId=${B}`);
  check("  and naming Beta is still refused: 403 SCHOOL_ACCESS_DENIED", [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);
  const forgedSchool = jwt.sign({ id: "admin-a", role: "school_admin", schoolId: B }, process.env.JWT_SECRET, { expiresIn: "1h" });
  r = await as(forgedSchool).get("/admin/students");
  check("a token claiming Beta for Alpha's admin is answered about Alpha", listOf(r.body).map((s) => s._id).sort(), ["stu-a1", "stu-a2", "stu-a3"]);
  const wrongSecret = jwt.sign({ id: "root", role: "super_admin" }, "not-the-secret", { expiresIn: "1h" });
  r = await as(wrongSecret).get("/super-admin/schools");
  check("a token signed with the wrong secret → 401", r.status, 401);

  r = await as(T.adminA).get("/admin/students?schoolId=68c00000000000000000ffff");
  check("a school admin naming a school that does not exist → 403 SCHOOL_ACCESS_DENIED (not theirs, whatever it is)", [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);
  r = await root.get("/admin/students?schoolId=68c00000000000000000ffff");
  check("a super admin naming a school that does not exist → 404 SCHOOL_NOT_FOUND", [r.status, r.body?.code], [404, "SCHOOL_NOT_FOUND"]);
  r = await root.get("/admin/students?schoolId=school-that-is-not-an-id");
  check("  or an id that could never be one → 404", r.status, 404);
  await School.softDelete(G, null);
  const { invalidateSchool } = require(path.join(SRC, "utils/schoolContext"));
  invalidateSchool(G);
  r = await root.get(`/admin/students?schoolId=${G}`);
  check("  or a deleted school → 404", r.status, 404);
  r = await root.get(`/super-admin/schools/${G}`);
  check("  which the platform no longer lists either", r.status, 404);
  r = await root.get("/super-admin/schools");
  check("  (two schools remain)", r.body?.total, 2);

  // No school may acquire a platform capability through the overrides.
  await School.updateOne({ _id: A }, { $set: { "settings.permissions.bursar.granted": ["platform.schools", "fees.view"] } });
  permissions.invalidate(A);
  const bursarUser = await User.findById("bursar-a").lean();
  check("a bursar 'granted' platform.schools in the school's settings still does not hold it",
    await permissions.can({ ...bursarUser, role: "bursar" }, "platform.schools"), false);
  check("  (while an ordinary grant works)", await permissions.can({ ...bursarUser, role: "bursar" }, "fees.view"), true);
  r = await as(T.bursarA).get("/super-admin/schools");
  check("  and the route agrees: 403", r.status, 403);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 14. the record ---");
  r = await root.get("/super-admin/audit");
  check("GET /super-admin/audit → 200", r.status, 200);
  const actions = (r.body?.entries ?? []).map((e) => e.action);
  for (const a of ["school.created", "school.updated", "school.deactivated", "school.activated", "school.entered", "admin.created"]) {
    check(`  contains ${a}`, actions.includes(a), true);
  }
  check("every row names its actor", (r.body?.entries ?? []).every((e) => e.actorId), true);
  check("every row is stamped", (r.body?.entries ?? []).every((e) => e.at), true);
  r = await root.get(`/super-admin/audit?schoolId=${B}`);
  check("filtered to Beta: only Beta's rows", (r.body?.entries ?? []).every((e) => e.schoolId === B), true);
  check("  including its deactivation and reactivation",
    (r.body?.entries ?? []).map((e) => e.action).filter((a) => a.startsWith("school.")).sort(),
    ["school.activated", "school.deactivated", "school.entered"]);
  r = await root.get("/super-admin/audit?action=admin.created");
  check("filtered by action", (r.body?.entries ?? []).every((e) => e.action === "admin.created"), true);
  check("  Alpha's admin appointing 'Planted' is in the record too, under Alpha",
    (r.body?.entries ?? []).some((e) => e.actorId === "admin-a" && e.schoolId === A), true);
  r = await as(T.adminA).get("/super-admin/audit");
  check("a school admin cannot read the record", r.status, 403);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
