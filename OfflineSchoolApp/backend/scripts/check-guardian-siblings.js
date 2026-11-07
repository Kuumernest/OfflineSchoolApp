// backend/scripts/check-guardian-siblings.js
"use strict";

/**
 * One guardian, three children — the ordinary family, never a duplicate.
 *
 * Mrs Bate has Eve (Form 1), Fay (Form 3) and Gus (Form 5). All three records
 * carry her name, email and phone, and Eve's and Fay's own email is hers too.
 *
 *   saving       all three save; the same phone passes B3 for each
 *   portal       one code opens all three; logging in with any child's
 *                admission number gives the same three to switch between
 *   profile      each child's profile shows Mrs Bate and that child's own
 *                balance (C10)
 *   fees         overdue is per child (Eve and Gus owe, Fay paid up); the
 *                To do count and amount add up the children (C6, C11)
 *   reminders    one reminder per owing child, each to Mrs Bate, each naming
 *                its child
 *   routes       three children enrolled on her email, a child edited to it,
 *                three siblings on it approved (both approve routes) — every
 *                one succeeds, each with its own login; and Mrs Bate, who also
 *                teaches here, still signs in and keeps it on her profile
 *
 *   node scripts/check-guardian-siblings.js
 */

const path     = require("path");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await M("Student").init(); // build the real indexes, unique ones included

  const { normalisePhone, checkStudentInput } = require("../../shared/studentValidation");
  const portal       = require(path.join(SRC, "services/portal.service"));
  const { overviewFor }    = require(path.join(SRC, "services/studentOverview.service"));
  const reminders          = require(path.join(SRC, "services/feeReminders.service"));
  const { actionItemsFor } = require(path.join(SRC, "services/actionItems.service"));

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const S = new mongoose.Types.ObjectId().toString();
  const YEAR  = "2026/2027";
  const TODAY = new Date("2026-10-27T10:00:00Z");
  const daysFrom = (n) => new Date(TODAY.getTime() + n * 86_400_000);
  await M("School").create({ _id: S, name: "Bright Future", email: "bf@example.test", settings: { academicYear: YEAR } });

  const KIDS = [["eve", "Eve Bate", "Form 1"], ["fay", "Fay Bate", "Form 3"], ["gus", "Gus Bate", "Form 5"]];

  console.log("\n--- saving ---");
  const phones = KIDS.map(() => normalisePhone("677 00 00 01", "guardianPhone"));
  check("the same guardian phone passes B3 for each child",
    phones.map((p) => [p.error ?? null, p.value]), KIDS.map(() => [null, "+237677000001"]));
  check("and raises no error from the student checks",
    KIDS.map(([, , className]) => checkStudentInput({ guardianPhone: "677000001" }, { className, now: TODAY }).errors),
    [[], [], []]);

  let saved = 0;
  for (const [id, name, className] of KIDS) {
    try {
      await M("Student").create({
        _id: id, userId: `u-${id}`, schoolId: S, classId: className, className,
        studentName: name, enrollmentNo: `BF-2026-00${++saved}`, status: "approved", isActive: true,
        email: id === "gus" ? null : "bate@gmail.com",
        guardianName: "Mrs Bate", guardianEmail: "bate@gmail.com", guardianPhone: phones[0].value,
      });
    } catch (err) { console.log(`       ${id}: ${err.message}`); saved--; }
  }
  check("all three children save with the same guardian email and phone", saved, 3);

  console.log("\n--- portal ---");
  const { code } = await portal.issueAccess({ schoolId: S, studentIds: ["eve", "fay", "gus"], label: "Mrs Bate" });
  const logins = [];
  for (let i = 1; i <= 3; i++) {
    const r = await portal.login({ schoolId: S, admissionNo: `BF-2026-00${i}`, code }).catch((e) => ({ error: e.message }));
    logins.push((r.children ?? []).map((c) => c.name));
  }
  check("one code, any child's admission number, the same three children to switch between",
    logins, [0, 1, 2].map(() => ["Eve Bate", "Fay Bate", "Gus Bate"]));

  console.log("\n--- fees ---");
  let n = 0;
  const charge = (studentId, amount, dueDate) => M("FeeCharge").create({
    schoolId: S, studentId, academicYear: YEAR, code: `C${++n}`, label: "Tuition", amount, dueDate,
  });
  await charge("eve", 60000, daysFrom(-10));
  await charge("fay", 50000, daysFrom(-10));
  await M("FeePayment").create({ schoolId: S, studentId: "fay", academicYear: YEAR, amount: 50000 });
  await charge("gus", 80000, daysFrom(-5));

  const overdue = await reminders.candidates({ schoolId: S, academicYear: YEAR, mode: "overdue", asOf: TODAY });
  check("overdue is per child: Eve and Gus, each with their own balance",
    overdue.map((r) => [r.studentId, r.balance]).sort(), [["eve", 60000], ["gus", 80000]]);
  check("both name the same guardian",
    overdue.map((r) => r.guardianName), ["Mrs Bate", "Mrs Bate"]);

  const items = await actionItemsFor({ schoolId: S, can: { marks: false, publish: false, fees: true }, asOf: TODAY });
  const fees  = items.find((i) => i.key === "overdueFees") ?? {};
  check("To do counts the two owing children and adds their balances", [fees.count, fees.amount], [2, 140000]);

  console.log("\n--- profile ---");
  const views = [];
  for (const [id] of KIDS) {
    const student = await M("Student").findById(id).lean();
    const o = await overviewFor({ schoolId: S, student, asOf: TODAY });
    views.push([o.guardian.name, o.guardian.phone, o.guardian.email, o.fees?.balance ?? null]);
  }
  check("each profile shows Mrs Bate and that child's own balance", views, [
    ["Mrs Bate", "+237677000001", "bate@gmail.com", 60000],
    ["Mrs Bate", "+237677000001", "bate@gmail.com", 0],
    ["Mrs Bate", "+237677000001", "bate@gmail.com", 80000],
  ]);

  console.log("\n--- reminders ---");
  const sent = await reminders.sendReminders({ schoolId: S, academicYear: YEAR, mode: "overdue", asOf: TODAY });
  const notes = await M("Notification").find({ schoolId: S, kind: "fee.reminder" }).lean();
  check("one reminder per owing child, none merged or skipped", [sent.queued, sent.skippedUnreachable], [2, 0]);
  check("each to Mrs Bate, each about its own child",
    notes.map((x) => [x.studentId, x.to]).sort(), [["eve", "bate@gmail.com"], ["gus", "bate@gmail.com"]]);

  // ── The routes: enrol, edit, approve ────────────────────────────────────────
  //
  // Everything above is service-level. The office reaches these records
  // through HTTP, and that is where a pupil email that is really the parent's
  // used to be refused: PATCH /students/:id answered 409 "Another student in
  // this school already uses that email address". A pupil logs in with their
  // own admission number, never the email, so nothing needs that address to be
  // unique across pupils.
  console.log("\n--- the routes: enrol, edit, approve ---");
  {
    const express = require("express");
    const jwt     = require("jsonwebtoken");
    const auth    = require(path.join(__dirname, "..", "middleware/auth"));
    process.env.NODE_ENV = process.env.NODE_ENV || "test";

    await M("User").create({ _id: "adm-bf", name: "Registrar", email: "registrar@bf.example.test",
      password: "check-only-password", role: "school_admin", schoolId: S, isActive: true });
    await M("Class").create({ _id: "bf-f1", schoolId: S, name: "Form 1" });

    const app = express(); app.use(express.json());
    app.use("/api/students", auth.authenticate, require(path.join(SRC, "routes/students.routes")));
    app.use("/api/admin",    auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    const server = app.listen(0);
    const API   = `http://127.0.0.1:${server.address().port}/api`;
    const token = jwt.sign({ id: "adm-bf", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const call  = async (method, url, body) => {
      const r = await fetch(`${API}${url}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    };
    const MUM = "bate@gmail.com";

    // Enrolled directly, three children, all on the parent's address.
    const enrolled = [];
    for (const [first] of [["Hal"], ["Ivy"], ["Jon"]]) {
      const r = await call("POST", "/students", {
        firstName: first, lastName: "Bate", classId: "bf-f1", schoolId: S,
        email: MUM, guardianName: "Mrs Bate", guardianEmail: MUM, guardianPhone: "677000001",
      });
      enrolled.push([r.status, r.body?.message ?? null]);
    }
    check("three children enrolled directly on the parent's email all succeed",
      enrolled.map(([s]) => s), [201, 201, 201]);
    const direct = await M("Student").find({ schoolId: S, lastName: "Bate", firstName: { $in: ["Hal", "Ivy", "Jon"] } }).lean();
    check("  each with its own record, admission number and login",
      [direct.length, new Set(direct.map((s) => s.enrollmentNo)).size, new Set(direct.map((s) => s.userId)).size,
       direct.every((s) => s.email === MUM)],
      [3, 3, 3, true]);

    // Edited: Gus had no email; the office sets the parent's, which Eve and Fay
    // already carry. Then Fay's is cleared and set back.
    let r = await call("PATCH", "/students/gus", { schoolId: S, email: MUM });
    check("editing a child to the email two siblings already carry succeeds",
      [r.status, r.body?.changed ?? null], [200, ["email"]]);
    r = await call("PATCH", "/students/fay", { schoolId: S, email: "" });
    const cleared = r.status;
    r = await call("PATCH", "/students/fay", { schoolId: S, email: "BATE@gmail.com " });
    check("  and clearing then re-setting it on another sibling succeeds too",
      [cleared, r.status], [200, 200]);
    check("  all three now carry it",
      (await M("Student").find({ _id: { $in: ["eve", "fay", "gus"] } }).sort({ _id: 1 }).lean()).map((s) => s.email),
      [MUM, MUM, MUM]);

    // Approved: two pending applications on the Student collection (the
    // students router), and one on StudentApplication (the admin router).
    for (const [id, name] of [["kim", "Kim Bate"], ["lea", "Lea Bate"]]) {
      await M("Student").create({ _id: id, schoolId: S, studentName: name, email: MUM,
        guardianName: "Mrs Bate", guardianEmail: MUM, status: "pending" });
    }
    await M("StudentApplication").create({ _id: "app-max", schoolId: S, studentName: "Max Bate",
      email: MUM, guardianName: "Mrs Bate", phone: "+237677000001", classId: "bf-f1", status: "pending" });
    const approvals = [
      (await call("POST", "/students/kim/approve", { classId: "bf-f1", schoolId: S })).status,
      (await call("POST", "/students/lea/approve", { classId: "bf-f1", schoolId: S })).status,
      (await call("PUT",  "/admin/students/app-max/approve", { classId: "bf-f1", schoolId: S })).status,
    ];
    check("three siblings sharing the parent's email are approved, every one", approvals, [200, 200, 200]);
    const approved = await M("Student").find({ schoolId: S, studentName: { $in: ["Kim Bate", "Lea Bate", "Max Bate"] } }).lean();
    check("  each approved with its own login and admission number",
      [approved.length, approved.every((s) => s.status === "approved"),
       new Set(approved.map((s) => String(s.userId))).size, new Set(approved.map((s) => s.enrollmentNo)).size],
      [3, true, 3, 3]);

    // A pupil account no record is linked to (legacy data) whose email is the
    // parent's. The resolver's last-resort email match used to hand it the
    // first sibling carrying that address — to read, and to edit as "their"
    // profile.
    await M("User").create({ _id: "stu-unlinked", name: "Unlinked", email: MUM, password: "check-only-password",
      role: "student", schoolId: S, isActive: true, enrollmentNo: "BF-LEGACY-1" });
    const stuToken = jwt.sign({ id: "stu-unlinked", role: "student", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const me = await fetch(`${API}/students/me`, { headers: { Authorization: `Bearer ${stuToken}` } });
    const meBody = await me.json().catch(() => ({}));
    const meName = meBody?.data?.studentName ?? meBody?.data?.name ?? meBody?.data?.student?.studentName ?? null;
    check("an unlinked pupil account on the parent's email is not handed a sibling's record",
      [me.status, /Bate/.test(String(meName ?? ""))], [200, false]);

    // Mrs Bate also teaches here. Her children's logins carry her address, and
    // that must not stop her own staff sign-in (or her profile keeping it).
    await M("User").create({ _id: "tea-bate", name: "Mrs Bate", email: MUM, password: "Teacher-pass-1",
      role: "teacher", schoolId: S, isActive: true });
    process.env.DISABLE_LOGIN_RATE_LIMIT = "1";
    const authApp = express(); authApp.use(express.json());
    authApp.use("/api/auth", require(path.join(SRC, "routes/auth.routes")));
    authApp.use("/api/teacher", auth.authenticate, require(path.join(SRC, "routes/teacher.routes")));
    const authServer = authApp.listen(0);
    const AUTH = `http://127.0.0.1:${authServer.address().port}/api`;
    const login = await fetch(`${AUTH}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: MUM, password: "Teacher-pass-1" }),
    });
    const loginBody = await login.json().catch(() => ({}));
    check("a teacher who is also the parent signs in with the address her children's logins carry",
      [login.status, loginBody?.user?.role ?? null, loginBody?.user?.id ?? null], [200, "teacher", "tea-bate"]);
    const teacherToken = jwt.sign({ id: "tea-bate", role: "teacher", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const prof = await fetch(`${AUTH}/teacher/profile`, {
      method: "PUT", headers: { Authorization: `Bearer ${teacherToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mrs Bate", email: MUM }),
    });
    check("  and keeps it on her profile (a pupil holding it is not a clash)", prof.status, 200);
    authServer.close();

    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
