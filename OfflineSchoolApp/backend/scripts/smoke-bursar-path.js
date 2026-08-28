// backend/scripts/smoke-bursar-path.js
"use strict";

/**
 * Walk the whole bursar journey, as a bursar, over HTTP.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The other suites each pin one thing: who may reach a route, what a reminder
 * decides, whether an account can be brought back. None of them walks the path
 * a person actually takes, and two things about this branch made that a gap
 * worth closing:
 *
 *   Publishing a fee structure now REQUIRES a due date. That is a change to an
 *   existing workflow, and the failure mode if a client does not send one is a
 *   400 on the first thing a school does at the start of a year.
 *
 *   The bursar role, its dashboard and its screens had never been exercised
 *   end to end. Every part had been checked; the sequence had not.
 *
 * So this signs in as a real bursar with a real token and does the year: price
 * list, bill the classes, take a payment, chase the arrears, add a late fee,
 * grant an instalment plan, and try three things a bursar must not be able to
 * do. It is a smoke test — it proves the path is walkable and the joins line
 * up, not that every branch inside each handler is right.
 *
 *   node scripts/smoke-bursar-path.js
 */

const express  = require("express");
const mongoose = require("mongoose");

const SCHOOL = "aaaaaaaaaaaaaaaaaaaaaaaa";
const YEAR   = "2026-2027";
const TEMP   = "Sm0ke-Temp-Pass1";
const CHOSEN = "Sm0ke-Chosen-Pass2";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
    console.log(`         got      ${JSON.stringify(actual)}`);
    console.log(`         expected ${JSON.stringify(expected)}`);
  }
};

/**
 * A date N days from now, as the API wants it.
 *
 * Relative to the real clock rather than a pinned constant, deliberately: the
 * reminder and late-fee services compare a due date against new Date(), so a
 * fixture pinned to a chosen day silently stops meaning "three weeks overdue"
 * the moment real time moves past it — and this suite would go from proving
 * something to proving nothing, while still passing.
 */
const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const TODAY = new Date();

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({
    // The default launch timeout is ten seconds, which is not enough on a
    // developer machine with a browser and an editor open — the suite failed
    // intermittently with "Instance failed to start within 10000ms" and the
    // failure looked like a broken test rather than a busy host.
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: "smoke-bursar" });

  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const User    = require("../src/db/models/User");
  const Student = require("../src/db/models/Student");
  const School  = require("../src/db/models/School");
  const { ROLES } = require("../src/config/roles");

  // Mounted exactly as src/server.js mounts them, authenticate included. The
  // token is a real one from a real sign-in, so req.user is built by the same
  // middleware production uses — which is the point of a smoke test: no stub
  // stands in for the thing being walked.
  const { authenticate } = require("../middleware/auth");

  const app = express();
  app.use(express.json());
  app.use("/api/auth",      require("../src/routes/auth.routes"));
  app.use("/api/fees",      authenticate, require("../src/routes/fees.routes"));
  app.use("/api/finance",   authenticate, require("../src/routes/finance.routes"));
  app.use("/api/approvals", authenticate, require("../src/routes/approvals.routes"));
  app.use("/api/admin",     authenticate, require("../src/routes/admin.routes"));

  const server = app.listen(0);
  const port   = server.address().port;

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json ?? {} };
  };

  // ── The school, one class, three pupils ─────────────────────────────────
  await School.create({
    _id: SCHOOL, name: "Smoke Test College", isActive: true,
  }).catch(async () => {
    // The School schema varies by branch; the routes only need the row to
    // exist for a name lookup and a permissions read.
    await School.collection.insertOne({ _id: SCHOOL, name: "Smoke Test College" });
  });

  // The third family has a phone number and no email address, which is the
  // ordinary case in a Cameroonian school and the one that exposed a real bug
  // when this walk was first run: the arrears preview called them reachable,
  // the send reported success, and nothing was ever sent to them.
  const CLASS = "class-form-one";
  const ROSTER = [
    { name: "Ada Nkeng",     guardianEmail: "ada.parent@example.com"     },
    { name: "Bertin Oyono",  guardianEmail: "bertin.parent@example.com"  },
    { name: "Chantal Fomba", guardianEmail: null                         },
  ];

  const pupils = [];
  for (const [i, row] of ROSTER.entries()) {
    const id = `pupil-${i + 1}`;
    await Student.collection.insertOne({
      _id: id, schoolId: SCHOOL, classId: CLASS,
      studentName: row.name, enrollmentNo: `SMK-00${i + 1}`,
      status: "approved", isActive: true, deletedAt: null,
      guardianPhone: `+2376700000${i + 1}`,
      guardianEmail: row.guardianEmail,
      createdAt: TODAY, updatedAt: TODAY,
    });
    pupils.push(id);
  }

  const head = await User.create({
    name: "Head Teacher", email: "head@smoke.com", role: ROLES.SCHOOL_ADMIN,
    schoolId: SCHOOL, isActive: true, password: "Head-Pass-123",
  });

  const login = async (email, password) => {
    const r = await call("POST", "/api/auth/login", { body: { email, password } });
    return { status: r.status, token: r.body?.token, user: r.body?.user };
  };

  const headSession = await login("head@smoke.com", "Head-Pass-123");
  check("the head can sign in", headSession.status, 200);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 1. The head appoints a bursar ──");

  const appointed = await call("POST", "/api/admin/settings/admins", {
    token: headSession.token,
    body: {
      name: "Grace Mbeki", email: "bursar@smoke.com",
      role: "bursar", schoolId: SCHOOL,
    },
  });
  check("the account is created", appointed.status, 201);
  check("as a bursar", appointed.body?.admin?.role, ROLES.BURSAR);
  // The whole point of the credentials panel: with mail misconfigured, this is
  // the only copy of the password.
  check("and the password comes back to be read out",
    typeof appointed.body?.tempPassword === "string" && appointed.body.tempPassword.length > 0,
    true);
  check("the response says whether the email went",
    typeof appointed.body?.emailSent, "boolean");

  // Substituted so the rest of the walk uses a known value. Exactly what the
  // reset endpoint does, and it is the path a school takes when the email
  // never arrives.
  const bursarDoc = await User.findOne({ email: "bursar@smoke.com" });
  bursarDoc.password = TEMP;
  await bursarDoc.save();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 2. The bursar signs in and must choose a password ──");

  const first = await login("bursar@smoke.com", TEMP);
  check("the temporary password works", first.status, 200);
  check("and the client is told to insist on a change",
    first.user?.mustResetPassword, true);
  check("with the capabilities the console draws with",
    ["fees.remind", "fees.penalize", "fees.plan"]
      .every((k) => (first.user?.permissions ?? []).includes(k)),
    true);

  const reuse = await call("POST", "/api/auth/change-password", {
    token: first.token,
    body:  { newPassword: TEMP, confirmPassword: TEMP },
  });
  check("the temporary password cannot be kept", reuse.status, 400);

  const chose = await call("POST", "/api/auth/change-password", {
    token: first.token,
    body:  { newPassword: CHOSEN, confirmPassword: CHOSEN },
  });
  check("a real choice is accepted", chose.status, 200);
  check("and clears the flag", chose.body?.user?.mustResetPassword, false);

  const session = await login("bursar@smoke.com", CHOSEN);
  check("the bursar signs in normally afterwards", session.status, 200);
  const T = session.token;

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 3. The price list, which now needs a due date ──");

  // THE BREAKING CHANGE. A client that predates it sends no dueDate, and the
  // refusal has to say what to do about it rather than reading as a fault.
  const noDate = await call("POST", "/api/fees/structures", {
    token: T,
    body: {
      schoolId: SCHOOL, academicYear: YEAR, classIds: [CLASS],
      items: [{ code: "TUITION", label: "Tuition", amount: 75000 }],
    },
  });
  check("publishing without a due date is refused", noDate.status, 400);
  check("by a named code the client can branch on",
    noDate.body?.code, "DUE_DATE_REQUIRED");
  check("and the message says why it is needed",
    /reminders and late fees/.test(noDate.body?.message ?? ""), true);

  const badDate = await call("POST", "/api/fees/structures", {
    token: T,
    body: {
      schoolId: SCHOOL, academicYear: YEAR, classIds: [CLASS],
      dueDate: "next Tuesday",
      items: [{ code: "TUITION", label: "Tuition", amount: 75000 }],
    },
  });
  check("and a date it cannot read is a different answer",
    badDate.body?.code, "INVALID_DATE");

  // Due three weeks ago, so the arrears work below has something to find.
  const published = await call("POST", "/api/fees/structures", {
    token: T,
    body: {
      schoolId: SCHOOL, academicYear: YEAR, classIds: [CLASS],
      dueDate: day(-21),
      penalty: { mode: "fixed", amount: 5000, graceDays: 7 },
      items: [
        { code: "TUITION", label: "Tuition",  amount: 75000 },
        { code: "PTA",     label: "PTA levy", amount:  5000 },
      ],
    },
  });
  check("with a due date it is published", published.status, 201);
  const structureId = published.body?.data?._id;
  check("the date is stored", String(published.body?.data?.dueDate ?? "").slice(0, 10), day(-21));
  check("and the late-fee rule with it",
    published.body?.data?.penalty?.amount, 5000);

  const dupe = await call("POST", "/api/fees/structures", {
    token: T,
    body: {
      schoolId: SCHOOL, academicYear: YEAR, classIds: [CLASS], dueDate: day(-21),
      items: [{ code: "TUITION", label: "Tuition", amount: 75000 }],
    },
  });
  check("a second active structure for the same class is refused",
    dupe.body?.code, "STRUCTURE_EXISTS");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 4. Bill the class ──");

  const applied = await call("POST", `/api/fees/structures/${structureId}/apply`, {
    token: T, body: { schoolId: SCHOOL },
  });
  check("the charges are raised", applied.status, 201);
  check("one per pupil per item", applied.body?.raised, pupils.length * 2);

  const again = await call("POST", `/api/fees/structures/${structureId}/apply`, {
    token: T, body: { schoolId: SCHOOL },
  });
  // Idempotent by design: a bursar who is not sure whether it worked can press
  // it again without double-billing a family.
  check("applying twice raises nothing new", again.body?.raised, 0);
  check("and says what it skipped", again.body?.skipped, pupils.length * 2);

  const ledger = await call("GET",
    `/api/fees/students/${pupils[0]}?schoolId=${SCHOOL}&academicYear=${YEAR}`,
    { token: T });
  check("a pupil's account opens", ledger.status, 200);
  const owed = ledger.body?.data?.totals;
  check("with a row per fee item", (ledger.body?.data?.charges ?? []).length, 2);
  check("owing the whole price list", owed?.balance, 80000);
  check("nothing paid yet", owed?.paid, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 5. Take a payment ──");

  const paid = await call("POST", "/api/fees/payments", {
    token: T,
    body: {
      schoolId: SCHOOL, studentId: pupils[0], academicYear: YEAR,
      amount: 30000, method: "cash", note: "Part payment",
    },
  });
  check("the payment is recorded", paid.status, 201);
  check("with a receipt number", Boolean(paid.body?.data?.receiptNo), true);

  const replay = await call("POST", "/api/fees/payments", {
    token: T,
    body: {
      _id: paid.body?.data?._id,
      schoolId: SCHOOL, studentId: pupils[0], academicYear: YEAR,
      amount: 30000, method: "cash",
    },
  });
  // The offline outbox retries; the same row must not become two payments.
  check("a replayed offline row is not a second payment", replay.body?.replay, true);

  const after = await call("GET",
    `/api/fees/students/${pupils[0]}?schoolId=${SCHOOL}&academicYear=${YEAR}`,
    { token: T });
  const rest = after.body?.data?.totals;
  check("the balance falls by what was paid", rest?.balance, 50000);
  check("and the payment is on the ledger",
    (after.body?.data?.payments ?? []).length, 1);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 6. Chase the arrears ──");

  const preview = await call("GET",
    `/api/fees/reminders?schoolId=${SCHOOL}&academicYear=${YEAR}&mode=overdue`,
    { token: T });
  check("the overdue list is offered", preview.status, 200);
  check("all three pupils are behind", preview.body?.count, 3);
  check("nobody has been chased yet",
    (preview.body?.data ?? []).every((r) => r.recentlyReminded === false), true);

  // Two of three, on the channel this school actually sends by. The preview
  // used to call all three reachable because it asked a more generous question
  // than the notification pipeline: "any contact detail" rather than "an
  // address the configured channel can use".
  check("and the preview is honest about who can be reached",
    (preview.body?.data ?? []).filter((r) => r.reachable).length, 2);

  const sent = await call("POST", "/api/fees/reminders", {
    token: T, body: { schoolId: SCHOOL, academicYear: YEAR, mode: "overdue" },
  });
  check("the reminders go out", sent.status, 200);
  check("to the two families that can receive one", sent.body?.queued, 2);
  check("and the third is reported, not counted as sent",
    sent.body?.skippedUnreachable, 1);
  // Named, because "nothing was sent to one family" is only useful with a WHO.
  check("by name", (sent.body?.unreachable ?? []).map((u) => u.name), ["Chantal Fomba"]);

  const secondPreview = await call("GET",
    `/api/fees/reminders?schoolId=${SCHOOL}&academicYear=${YEAR}&mode=overdue`,
    { token: T });
  // Greyed out in the preview rather than the bursar pressing send and being
  // told afterwards that nothing happened.
  check("the two who were chased now show as recently reminded",
    (secondPreview.body?.data ?? []).filter((r) => r.recentlyReminded).length, 2);
  check("and the unreachable one does not — nothing was sent to them",
    (secondPreview.body?.data ?? [])
      .find((r) => r.studentId === pupils[2])?.recentlyReminded, false);

  const resend = await call("POST", "/api/fees/reminders", {
    token: T, body: { schoolId: SCHOOL, academicYear: YEAR, mode: "overdue" },
  });
  check("a second send inside the cooldown sends nothing", resend.body?.queued, 0);
  check("holding back the two", resend.body?.skippedRecent, 2);
  check("and still reporting the one it cannot reach",
    resend.body?.skippedUnreachable, 1);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 7. Add the late fee ──");

  const penalties = await call("GET",
    `/api/fees/penalties?schoolId=${SCHOOL}&academicYear=${YEAR}`,
    { token: T });
  check("the late-fee preview lists who has earned one", penalties.body?.count, 3);
  check("at the rule's amount", penalties.body?.total, 15000);

  const charged = await call("POST", "/api/fees/penalties", {
    token: T, body: { schoolId: SCHOOL, academicYear: YEAR },
  });
  check("applying them succeeds", charged.status, 200);
  check("three late fees raised", charged.body?.raised, 3);

  const twice = await call("POST", "/api/fees/penalties", {
    token: T, body: { schoolId: SCHOOL, academicYear: YEAR },
  });
  // Harmless on purpose: the unique index means a second run can only collide
  // with the row the first one wrote.
  check("applying twice adds nothing", twice.body?.raised, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 8. Grant an instalment plan ──");

  const oneShot = await call("POST", "/api/fees/plans", {
    token: T,
    body: {
      schoolId: SCHOOL, studentId: pupils[1], academicYear: YEAR,
      reason: "Father's salary is paid quarterly",
      instalments: [{ amount: 80000, dueDate: day(30) }],
    },
  });
  check("one instalment is not a plan", oneShot.body?.code, "TOO_FEW_INSTALMENTS");

  const noReason = await call("POST", "/api/fees/plans", {
    token: T,
    body: {
      schoolId: SCHOOL, studentId: pupils[1], academicYear: YEAR,
      instalments: [
        { amount: 40000, dueDate: day(30) },
        { amount: 40000, dueDate: day(60) },
      ],
    },
  });
  // Asked because "why" is the question an auditor or the next bursar asks.
  check("and a plan without a reason is refused", noReason.body?.code, "REASON_REQUIRED");

  const plan = await call("POST", "/api/fees/plans", {
    token: T,
    body: {
      schoolId: SCHOOL, studentId: pupils[1], academicYear: YEAR,
      reason: "Father's salary is paid quarterly",
      instalments: [
        { amount: 40000, dueDate: day(30) },
        { amount: 45000, dueDate: day(60) },
      ],
    },
  });
  check("a real plan is granted", plan.status, 201);

  const plans = await call("GET",
    `/api/fees/plans?schoolId=${SCHOOL}&academicYear=${YEAR}`, { token: T });
  check("and appears on the list", (plans.body?.data ?? []).length, 1);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── 9. What a bursar must not be able to do ──");

  const refusals = [
    ["POST", "/api/admin/classes",            { name: "Form Two" }, "classes.manage"],
    ["POST", "/api/finance/salary-structures", { staffId: String(head._id), amount: 200000 }, "payroll.setSalary"],
  ];

  for (const [method, path, body, capability] of refusals) {
    const r = await call(method, path, { token: T, body: { schoolId: SCHOOL, ...body } });
    check(`${method} ${path} is refused`, r.status, 403);
    check(`  naming ${capability}`, r.body?.permission, capability);
  }

  // Reading the roster is fine — a bursar bills pupils, so they must be able
  // to see them. This is the line the role draws: see the pupil, not the mark.
  const roster = await call("GET", `/api/admin/students?schoolId=${SCHOOL}`, { token: T });
  check("but the pupil roster is readable", roster.status, 200);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
