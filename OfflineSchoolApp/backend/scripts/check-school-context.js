// backend/scripts/check-school-context.js
"use strict";

/**
 * A super_admin inside a school sees that school — the same figures its own
 * administrator sees — and nothing of any other.
 *
 * ── What went wrong ───────────────────────────────────────────────────────
 *
 * The operator stepped into a school with 70 pupils and read a dashboard of
 * zeros. The API was right the whole time: every stats route resolves the
 * school from the request, and answered the real figures when asked. Two
 * things on either side of it were not.
 *
 *   1. /api/messages/* built its caller from req.user.schoolId — null for a
 *      super_admin, by design — and answered 401 "Not authenticated" to a
 *      perfectly good token. The web client took 401 for an expired session,
 *      refreshed, and tried again: the loop the operator watched in the log.
 *
 *   2. Each refresh handed the web client the server's copy of the user, whose
 *      schoolId is null, and the client kept it. The school the operator was
 *      inside is not on the account; it is a context the client mirrors into
 *      user.schoolId, which is where every page reads its school from. The
 *      layout still believed it was inside the school; every query on the
 *      page had lost the school and went quiet. That is the dashboard of zeros.
 *
 * So the first defect caused the second, and the API was innocent of both.
 * This pins the server half from both ends: the stats a super_admin gets for a
 * named school are the SAME objects its own admin gets; a second school's
 * figures are different and do not leak; the account never acquires a school;
 * and messaging honours the named school exactly as the admin routes do.
 *
 * Two schools with distinguishable data, the real routers behind the real door,
 * an in-memory database. Nothing here touches MONGODB_URI.
 *
 *   node scripts/check-school-context.js
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
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Student           = mongoose.model("Student");
  const Class             = mongoose.model("Class");
  const Subject           = mongoose.model("Subject");
  const Exam              = mongoose.model("Exam");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Conversation      = require(path.join(SRC, "db/models/Conversation"));
  const { StudentAttendance } = require(path.join(SRC, "db/models/Attendance"));
  await Promise.all([School.init(), User.init(), Conversation.init()]);

  // ── Two schools, distinguishable at a glance ──────────────────────────────
  // A has three pupils, two teachers, two classes, three subjects, two exams;
  // B has two, one, one, one, one. Any figure that is equal across the two,
  // or zero, is a wrong answer.
  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  const NOWHERE = "68c000000000000000000ff9";
  const YEAR = "2026/2027";
  const PASSWORD = "Check-only-passw0rd";

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test",
      settings: { academicYear: YEAR, currentTerm: "First Term" } },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test",
      settings: { academicYear: YEAR, currentTerm: "First Term" } },
  ]);

  const mkUser = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("root",       "super_admin",  null, "Root Operator"),
    mkUser("admin-a",    "school_admin", A,    "Admin A"),
    mkUser("admin-b",    "school_admin", B,    "Admin B"),
    mkUser("teacher-a1", "teacher",      A,    "Teacher A1"),
    mkUser("teacher-a2", "teacher",      A,    "Teacher A2"),
    mkUser("teacher-b1", "teacher",      B,    "Teacher B1"),
  ]);

  await Class.create([
    { _id: "cls-a1", schoolId: A, name: "Form 1A" },
    { _id: "cls-a2", schoolId: A, name: "Form 2A" },
    { _id: "cls-b1", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([
    { _id: "sub-a1", schoolId: A, name: "Maths A",   classId: "cls-a1" },
    { _id: "sub-a2", schoolId: A, name: "English A", classId: "cls-a1" },
    { _id: "sub-a3", schoolId: A, name: "Physics A", classId: "cls-a2" },
    { _id: "sub-b1", schoolId: B, name: "Maths B",   classId: "cls-b1" },
  ]);
  await TeacherAssignment.create([
    { schoolId: A, teacher: "teacher-a1", class: "cls-a1", subject: "sub-a1" },
    { schoolId: A, teacher: "teacher-a2", class: "cls-a2", subject: "sub-a3" },
    { schoolId: B, teacher: "teacher-b1", class: "cls-b1", subject: "sub-b1" },
  ]);
  await Exam.create([
    { schoolId: A, name: "Alpha Seq 1", type: "test", academicYear: YEAR, term: 1, status: "completed" },
    { schoolId: A, name: "Alpha Seq 2", type: "test", academicYear: YEAR, term: 1, status: "ongoing" },
    { schoolId: B, name: "Beta Seq 1",  type: "test", academicYear: YEAR, term: 1, status: "completed" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId, studentName: `Pupil ${n}`,
    enrollmentNo: `${schoolId === A ? "A" : "B"}-${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("stu-a1", A, "cls-a1", 1), pupil("stu-a2", A, "cls-a1", 2), pupil("stu-a3", A, "cls-a2", 3),
    pupil("stu-b1", B, "cls-b1", 1), pupil("stu-b2", B, "cls-b1", 2),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  await StudentAttendance.create([
    { schoolId: A, classId: "cls-a1", studentId: "stu-a1", markedBy: "teacher-a1", date: today, status: "present" },
    { schoolId: A, classId: "cls-a1", studentId: "stu-a2", markedBy: "teacher-a1", date: today, status: "absent"  },
    { schoolId: B, classId: "cls-b1", studentId: "stu-b1", markedBy: "teacher-b1", date: today, status: "present" },
  ]);

  // Conversations the operator is a party to, one per school, plus one in A
  // they are not in. What they may list in A is the first; never the third.
  const party = (kind, id, name, role) => ({ kind, id, name, role, joinedAt: new Date() });
  // directKey is the sorted pair the model keeps unique per school.
  await Conversation.create([
    { _id: "conv-a-root", schoolId: A, kind: "direct", title: null, lastMessageAt: new Date(),
      directKey: "user:admin-a|user:root",
      participants: [party("user", "root", "Root Operator", "super_admin"), party("user", "admin-a", "Admin A", "school_admin")] },
    { _id: "conv-b-root", schoolId: B, kind: "direct", title: null, lastMessageAt: new Date(),
      directKey: "user:admin-b|user:root",
      participants: [party("user", "root", "Root Operator", "super_admin"), party("user", "admin-b", "Admin B", "school_admin")] },
    { _id: "conv-a-staff", schoolId: A, kind: "direct", title: null, lastMessageAt: new Date(),
      directKey: "user:admin-a|user:teacher-a1",
      participants: [party("user", "admin-a", "Admin A", "school_admin"), party("user", "teacher-a1", "Teacher A1", "teacher")] },
  ]);

  // ── The real routers, behind the real door ────────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth",        require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use("/api/admin",       auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use("/api/messages",    auth.authenticate, require(path.join(SRC, "routes/messages.routes")));
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
  const as = (token) => ({
    get:  (url)       => call("GET",  url, { token }),
    post: (url, body) => call("POST", url, { token, body }),
  });
  // Signed in through the real login, so the token is the one the client holds.
  const login = await call("POST", "/auth/login", { body: { email: "root@example.test", password: PASSWORD } });
  const root     = as(login.body.token);
  const adminA   = as(sign("admin-a",    "school_admin", A));
  const adminB   = as(sign("admin-b",    "school_admin", B));
  const teacherA = as(sign("teacher-a1", "teacher",      A));

  const STATS = ["/admin/stats", "/admin/students/stats", "/admin/teachers/stats", "/admin/classes/stats",
                 "/admin/subjects/stats", "/admin/exams/stats", "/admin/attendance/stats"];
  // The comparable part of each answer: the figures, not the envelope.
  const figures = (body) => {
    const { success, ...rest } = body.stats ? { success: body.success, ...body.stats } : body;
    void success;
    delete rest.data;
    return rest;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1–3. the operator has no school, and steps into one ---");

  check("1. the super_admin account has no school",
    (await User.findById("root").lean()).schoolId ?? null, null);
  check("   and signs in like anyone else", [login.status, login.body.user?.role, login.body.user?.schoolId], [200, "super_admin", null]);

  const enterA = await root.post(`/super-admin/schools/${A}/enter`);
  check("2. the super_admin can enter School A", enterA.status, 200);
  check("3. and the context handed back is School A", [enterA.body.school?._id, enterA.body.school?.name], [A, "Alpha Academy"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4–5. inside School A, the same figures as its own admin ---");

  const seenA = {};
  for (const route of STATS) {
    const mine   = await root.get(`${route}?schoolId=${A}`);
    const theirs = await adminA.get(route);
    check(`4. ${route}: 200 for both`, [mine.status, theirs.status], [200, 200]);
    check(`   ${route}: the super_admin gets exactly what School A's admin gets`,
      figures(mine.body), figures(theirs.body));
    seenA[route] = figures(mine.body);
  }
  check("5. students are not zero",   seenA["/admin/students/stats"].total,  3);
  check("   teachers are not zero",   seenA["/admin/teachers/stats"].total,  2);
  check("   classes are not zero",    seenA["/admin/classes/stats"].total,   2);
  check("   subjects are not zero",   seenA["/admin/subjects/stats"].total,  3);
  check("   exams are not zero",      seenA["/admin/exams/stats"].total,     2);
  check("   attendance is not zero",  [seenA["/admin/attendance/stats"].todayPresent, seenA["/admin/attendance/stats"].todayAbsent], [1, 1]);
  check("   and the dashboard block agrees",
    [seenA["/admin/stats"].approvedStudents, seenA["/admin/stats"].totalTeachers, seenA["/admin/stats"].totalClasses, seenA["/admin/stats"].totalSubjects],
    [3, 2, 2, 3]);
  check("   school-info is School A's",
    (await root.get(`/admin/school-info?schoolId=${A}`)).body.school?.name, "Alpha Academy");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6–8. then School B, and nothing of A comes along ---");

  const enterB = await root.post(`/super-admin/schools/${B}/enter`);
  check("6. the super_admin can enter School B", [enterB.status, enterB.body.school?._id], [200, B]);

  const seenB = {};
  for (const route of STATS) {
    const mine   = await root.get(`${route}?schoolId=${B}`);
    const theirs = await adminB.get(route);
    check(`7. ${route}: the super_admin gets exactly what School B's admin gets`,
      figures(mine.body), figures(theirs.body));
    seenB[route] = figures(mine.body);
  }
  check("   School B's figures are School B's",
    [seenB["/admin/students/stats"].total, seenB["/admin/teachers/stats"].total, seenB["/admin/classes/stats"].total, seenB["/admin/subjects/stats"].total, seenB["/admin/exams/stats"].total],
    [2, 1, 1, 1, 1]);
  check("8. and differ from School A's on every count — nothing leaked across",
    STATS.filter((r) => JSON.stringify(seenA[r]) === JSON.stringify(seenB[r])), []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9–10. back to the platform, still without a school ---");

  const platform = await root.get("/super-admin/dashboard");
  check("9. the platform dashboard answers with no school named", platform.status, 200);
  check("   a school-scoped route with no school named has nothing to answer about",
    (await root.get("/admin/students/stats")).status, 400);
  check("10. the account still has no school after entering two",
    (await User.findById("root").lean()).schoolId ?? null, null);
  check("    and /auth/me says so", (await root.get("/auth/me")).body.user?.schoolId, null);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 11–13. a school's own admin is unchanged ---");

  check("11. School A's admin sees School A",
    figures((await adminA.get("/admin/stats")).body).approvedStudents, 3);
  const cross = await adminA.get(`/admin/stats?schoolId=${B}`);
  check("12. and is refused School B", [cross.status, cross.body.code], [403, "SCHOOL_ACCESS_DENIED"]);
  const crossT = await teacherA.get(`/admin/students/stats?schoolId=${B}`);
  check("13. SCHOOL_ACCESS_DENIED still stands for any school-scoped caller",
    [crossT.status, crossT.body.code], [403, "SCHOOL_ACCESS_DENIED"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 14–18. messaging follows the named school, not the account ---");

  const noCtx = await root.get("/messages/conversations");
  check("14. with no school named, conversations are refused — and not as a bad token",
    [noCtx.status, noCtx.body.code], [400, "SCHOOL_CONTEXT_REQUIRED"]);

  const inA = await root.get(`/messages/conversations?schoolId=${A}`);
  check("15. in School A, the super_admin's School A conversations", inA.status, 200);
  check("    exactly the one they are party to there",
    (inA.body.conversations ?? []).map((c) => c._id), ["conv-a-root"]);
  const auditA = await root.get(`/messages/audit/conversations?schoolId=${A}`);
  check("    and the audit view lists School A's threads and only those",
    [auditA.status, (auditA.body.conversations ?? []).map((c) => c._id).sort()],
    [200, ["conv-a-root", "conv-a-staff"]]);

  const inB = await root.get(`/messages/conversations?schoolId=${B}`);
  check("16. in School B, School B's", [inB.status, (inB.body.conversations ?? []).map((c) => c._id)], [200, ["conv-b-root"]]);

  const adminCross = await adminA.get(`/messages/conversations?schoolId=${B}`);
  check("17. School A's admin cannot read School B's conversations",
    [adminCross.status, adminCross.body.code], [403, "SCHOOL_ACCESS_DENIED"]);
  check("    and their own list is School A's",
    (await adminA.get("/messages/conversations")).body.conversations?.map((c) => c._id).sort(),
    ["conv-a-root", "conv-a-staff"]);

  const gone = await root.get(`/messages/conversations?schoolId=${NOWHERE}`);
  check("18. a school that does not exist is a 404, not an empty list",
    [gone.status, gone.body.code], [404, "SCHOOL_NOT_FOUND"]);
  const junk = await root.get("/messages/conversations?schoolId=not-a-school");
  check("    and so is a value that is not a school id at all",
    [junk.status, junk.body.code], [404, "SCHOOL_NOT_FOUND"]);
  const junkStats = await root.get("/admin/students/stats?schoolId=not-a-school");
  check("    the stats routes agree", [junkStats.status, junkStats.body.code], [404, "SCHOOL_NOT_FOUND"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (err) => {
  console.error("\n  check-school-context crashed:", err);
  process.exit(1);
});
