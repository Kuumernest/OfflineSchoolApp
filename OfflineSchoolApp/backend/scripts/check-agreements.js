// backend/scripts/check-agreements.js
"use strict";

/**
 * Individual fee agreements through the real routes (fees.routes /plans,
 * approvals.routes, services/agreements.service).
 *
 *   - the bursar proposes; it is PENDING and governs nothing — arrears, the
 *     ledger read and the gate still use the general schedule
 *   - the proposer cannot approve their own (four eyes); another admin can,
 *     and from then it governs
 *   - a change to an approved agreement waits for approval while the approved
 *     schedule keeps applying; approved, it replaces it; history keeps both
 *   - rejection cancels and frees the slot; withdrawal does too
 *   - instalments must add up to the year's fees or what is outstanding —
 *     never less (that is a waiver)
 *   - a "balance" agreement sets aside what was paid before it
 *   - cancelling closes the approval still open on it
 *   - a teacher (gate staff) can do none of it
 *
 *   node scripts/check-agreements.js
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

const DAY = 86_400_000;
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  // "One agreement per pupil, year and term" and "one pending request per
  // target" are unique indexes. On a fresh database they are built in the
  // background after the models load, so a request can beat them (it did in
  // CI): wait for them, as check-approvals does.
  await Promise.all(["PaymentPlan", "ApprovalRequest", "FeeCharge", "FeePayment"].map((n) => M(n).syncIndexes()));

  const S = "68c0000000000000000000c1";
  const YEAR = "2026/2027";
  await M("School").create({ _id: S, name: "Agreement Academy", code: "AGRE", email: "a@example.test", settings: { academicYear: YEAR } });
  const PASSWORD = "Check-only-passw0rd";
  for (const [id, role] of [["admin-1", "school_admin"], ["admin-2", "school_admin"], ["bursar-1", "bursar"], ["teacher-1", "teacher"]]) {
    await M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId: S, isActive: true });
  }
  await M("Class").create({ _id: "cls-1", schoolId: S, name: "Form 1" });
  const pupils = ["ada", "ben", "cy", "dee"];
  for (const p of pupils) {
    await M("Student").create({
      _id: p, userId: `u-${p}`, schoolId: S, classId: "cls-1", studentName: p.toUpperCase(),
      enrollmentNo: `F1-${p}`, isActive: true, status: "approved",
    });
    // The general structure: 75,000 (due 30 days ago) + 75,000 (in 60 days) + 50,000 (in 150).
    for (const [code, amount, due] of [["T1", 75000, -30], ["T2", 75000, 60], ["T3", 50000, 150]]) {
      await M("FeeCharge").create({ schoolId: S, studentId: p, academicYear: YEAR, code, label: code, amount, dueDate: day(due), classId: "cls-1" });
    }
  }
  // Ada paid term 1 in full; Cy paid 60,000 earlier; Ben and Dee nothing.
  await M("FeePayment").create({ schoolId: S, studentId: "ada", academicYear: YEAR, amount: 75000, receivedAt: new Date(Date.now() - 40 * DAY) });
  await M("FeePayment").create({ schoolId: S, studentId: "cy",  academicYear: YEAR, amount: 60000, receivedAt: new Date(Date.now() - 40 * DAY) });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/fees",      auth.authenticate, require(path.join(SRC, "routes/fees.routes")));
  app.use("/api/approvals", auth.authenticate, require(path.join(SRC, "routes/approvals.routes")));
  app.use("/api/gate",      auth.authenticate, require(path.join(SRC, "routes/gate.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const token = (id, role) => jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const T = {
    admin1: token("admin-1", "school_admin"), admin2: token("admin-2", "school_admin"),
    bursar: token("bursar-1", "bursar"), teacher: token("teacher-1", "teacher"),
  };
  const call = async (method, url, body, who = T.bursar) => {
    const res = await fetch(`${API}${url}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${who}` },
      body: body ? JSON.stringify({ schoolId: S, ...body }) : undefined,
    });
    let out = {}; try { out = await res.json(); } catch { /* none */ }
    if (res.status >= 500) console.log(`       (server ${res.status} for ${method} ${url}: ${out.message})`);
    return { status: res.status, body: out };
  };
  const verify = async (id) => (await call("GET", `/gate/verify/${id}?schoolId=${S}`, null, T.teacher)).body?.data?.compliance;
  const account = async (id) => (await call("GET", `/fees/students/${id}?schoolId=${S}&academicYear=${encodeURIComponent(YEAR)}`)).body?.data;
  const pendingRequestFor = async (planId) => M("ApprovalRequest").findOne({ targetId: planId, status: "pending" }).lean();

  // Ben's agreement: the year's 200,000 as 50,000 (due 30 days ago) + 50,000 (in 1 day) + 100,000.
  const benSchedule = [
    { amount: 50000, dueDate: day(-30) }, { amount: 50000, dueDate: day(1) }, { amount: 100000, dueDate: day(120) },
  ];

  console.log("--- proposing: pending, and governs nothing ---");
  let r = await call("POST", "/fees/plans", { studentId: "ben", academicYear: YEAR, reason: "Hardship", instalments: benSchedule, notes: "Signed form on file" });
  const benPlan = r.body.data;
  check("the bursar proposes an agreement over the whole 200,000", [r.status, benPlan?.approvalStatus, benPlan?.basis, benPlan?.agreedTotal], [201, "pending", "total", 200000]);
  check("  its history starts with who created it", [benPlan?.history?.length, benPlan?.history?.[0]?.action, benPlan?.history?.[0]?.by], [1, "created", "bursar-1"]);
  const benReq = await pendingRequestFor(benPlan?._id);
  check("  an approval request is waiting, of kind agreement", [benReq?.kind, benReq?.amount, benReq?.requestedBy], ["agreement", 200000, "bursar-1"]);
  let c = await verify("ben");
  check("  the gate still uses the general schedule (75,000 due), saying the agreement is pending",
    [c?.arrangement, c?.agreementState, c?.amountDue, c?.status], ["standard", "pending_approval", 75000, "non_compliant"]);
  let acc = await account("ben");
  check("  the ledger read shows the plan but does not apply it", [acc?.plan?.approvalStatus, acc?.planApplies, acc?.planStatus], ["pending", false, null]);

  console.log("\n--- four eyes ---");
  r = await call("POST", `/approvals/${benReq._id}/approve`, {}, T.bursar);
  check("the bursar cannot approve (approvals.decide is the administrators')", r.status, 403);
  // An admin who proposes cannot approve their own.
  r = await call("POST", "/fees/plans", { studentId: "dee", academicYear: YEAR, reason: "Admin proposed", instalments: benSchedule }, T.admin1);
  const deePlan = r.body.data;
  const deeReq = await pendingRequestFor(deePlan?._id);
  r = await call("POST", `/approvals/${deeReq._id}/approve`, {}, T.admin1);
  check("an administrator cannot approve an agreement they proposed", [r.status, r.body.code], [403, "SELF_APPROVAL"]);

  console.log("\n--- approved: it governs ---");
  r = await call("POST", `/approvals/${benReq._id}/approve`, { note: "Agreed with the head" }, T.admin2);
  check("another administrator approves", [r.status, r.body.data?.status], [200, "approved"]);
  let plan = await M("PaymentPlan").findById(benPlan._id).lean();
  check("  the agreement is approved, by whom, and in force from now", [plan.approvalStatus, plan.approvedBy, Boolean(plan.effectiveFrom)], ["approved", "admin-2", true]);
  check("  history: created → approved", plan.history.map((h) => h.action), ["created", "approved"]);
  c = await verify("ben");
  check("  the gate now measures 50,000 due by today, unpaid", [c?.arrangement, c?.amountDue, c?.outstandingDue, c?.status], ["agreement", 50000, 50000, "non_compliant"]);
  check("  the next instalment is due tomorrow", [c?.nextDueAmount, String(c?.nextDueDate).slice(0, 10)], [50000, day(1)]);
  acc = await account("ben");
  check("  the ledger read applies it", [acc?.planApplies, acc?.planStatus?.behindBy], [true, 50000]);
  const { arrearsFor } = require(path.join(SRC, "services/arrears.service"));
  const ar = (await arrearsFor({ schoolId: S, onlyStudentIds: ["ben"] })).rows[0];
  check("  arrears agree: 50,000 overdue on the agreement", [ar?.onPlan, ar?.overdue], [true, 50000]);

  console.log("\n--- a change waits for approval; the approved schedule keeps applying ---");
  const changed = [{ amount: 25000, dueDate: day(-30) }, { amount: 75000, dueDate: day(30) }, { amount: 100000, dueDate: day(120) }];
  r = await call("PATCH", `/fees/plans/${benPlan._id}`, { instalments: changed, reason: "Asked for a lighter first instalment" });
  check("the bursar proposes a change", [r.status, Boolean(r.body.data?.pendingChange)], [200, true]);
  c = await verify("ben");
  check("  until it is approved the gate still uses the approved 50,000", [c?.amountDue, c?.outstandingDue], [50000, 50000]);
  r = await call("PATCH", `/fees/plans/${benPlan._id}`, { instalments: changed, reason: "Again" });
  check("  a second change while one waits is refused", [r.status, r.body.code], [409, "CHANGE_PENDING"]);
  plan = await M("PaymentPlan").findById(benPlan._id).lean();
  const changeReq = await M("ApprovalRequest").findOne({ _id: plan.pendingChange.approvalRequestId }).lean();
  r = await call("POST", `/approvals/${changeReq._id}/approve`, {}, T.admin1);
  check("an administrator approves the change", r.status, 200);
  c = await verify("ben");
  check("  now 25,000 is due by today", [c?.amountDue, c?.outstandingDue], [25000, 25000]);
  plan = await M("PaymentPlan").findById(benPlan._id).lean();
  const last = plan.history[plan.history.length - 1];
  check("  history records the change with the instalments before and after",
    [last.action, last.by, last.before.instalments.map((i) => i.amount), last.after.instalments.map((i) => i.amount)],
    ["change_approved", "admin-1", [50000, 50000, 100000], [25000, 75000, 100000]]);
  check("  and who proposed it", plan.history.filter((h) => h.action === "change_proposed").map((h) => h.by), ["bursar-1"]);

  console.log("\n--- a rejected change leaves the approved schedule ---");
  await call("PATCH", `/fees/plans/${benPlan._id}`, { instalments: benSchedule, reason: "Back to the original" });
  plan = await M("PaymentPlan").findById(benPlan._id).lean();
  r = await call("POST", `/approvals/${plan.pendingChange.approvalRequestId}/reject`, { note: "No" }, T.admin2);
  check("rejecting a change", r.status, 200);
  plan = await M("PaymentPlan").findById(benPlan._id).lean();
  check("  drops it, keeps the approved schedule, and records the rejection",
    [plan.pendingChange, plan.instalments.map((i) => i.amount), plan.history[plan.history.length - 1].action],
    [null, [25000, 75000, 100000], "change_rejected"]);

  console.log("\n--- the totals rule ---");
  r = await call("POST", "/fees/plans", { studentId: "ada", academicYear: YEAR, reason: "Less", instalments: [{ amount: 50000, dueDate: day(10) }, { amount: 50000, dueDate: day(40) }] });
  check("instalments that add up to less than owed are refused (a waiver, not an agreement)", [r.status, r.body.code], [400, "PLAN_TOTAL_MISMATCH"]);
  r = await call("POST", "/fees/plans", { studentId: "ada", academicYear: YEAR, reason: "Backwards", instalments: [{ amount: 60000, dueDate: day(40) }, { amount: 65000, dueDate: day(10) }] });
  check("dates that go backwards are refused", [r.status, r.body.code], [400, "DATES_BACKWARDS"]);
  r = await call("POST", "/fees/plans", { studentId: "ada", academicYear: YEAR, reason: "", instalments: benSchedule });
  check("a reason is required", [r.status, r.body.code], [400, "REASON_REQUIRED"]);
  r = await call("POST", "/fees/plans", { studentId: "ada", academicYear: YEAR, reason: "Expires first", instalments: [{ amount: 60000, dueDate: day(10) }, { amount: 65000, dueDate: day(40) }], effectiveFrom: day(5), expiresAt: day(1) });
  check("an expiry before the start is refused", [r.status, r.body.code], [400, "INVALID_DATE"]);

  console.log("\n--- a 'balance' agreement: what was paid before is set aside ---");
  // Cy paid 60,000; 140,000 remains, rescheduled as 70,000 (due 5 days ago) + 70,000.
  r = await call("POST", "/fees/plans", { studentId: "cy", academicYear: YEAR, reason: "Remaining balance", instalments: [{ amount: 70000, dueDate: day(-5) }, { amount: 70000, dueDate: day(90) }] });
  const cyPlan = r.body.data;
  check("accepted against the outstanding balance, with the baseline recorded", [r.status, cyPlan?.basis, cyPlan?.baselinePaid], [201, "balance", 60000]);
  await call("POST", `/approvals/${(await pendingRequestFor(cyPlan._id))._id}/approve`, {}, T.admin1);
  c = await verify("cy");
  check("  the earlier 60,000 does not count toward the first 70,000 — all of it is outstanding",
    [c?.arrangement, c?.outstandingDue, c?.status], ["agreement", 70000, "non_compliant"]);

  console.log("\n--- rejection and withdrawal free the slot ---");
  r = await call("POST", `/approvals/${deeReq._id}/reject`, { note: "Not justified" }, T.admin2);
  plan = await M("PaymentPlan").findById(deePlan._id).lean();
  check("a rejected agreement is cancelled, with who and why", [plan.approvalStatus, plan.status, plan.rejectedBy, plan.rejectionReason], ["rejected", "cancelled", "admin-2", "Not justified"]);
  r = await call("POST", "/fees/plans", { studentId: "dee", academicYear: YEAR, reason: "Second try", instalments: benSchedule });
  const dee2 = r.body.data;
  check("  so a new one can be proposed", [r.status, dee2?.approvalStatus], [201, "pending"]);
  r = await call("POST", "/fees/plans", { studentId: "dee", academicYear: YEAR, reason: "Third", instalments: benSchedule });
  check("  but not two at once", [r.status, r.body.code], [409, "PLAN_EXISTS"]);
  const dee2Req = await pendingRequestFor(dee2._id);
  r = await call("POST", `/approvals/${dee2Req._id}/cancel`, {});
  plan = await M("PaymentPlan").findById(dee2._id).lean();
  check("the proposer withdraws it → the agreement is cancelled", [r.status, plan.status, plan.history.map((h) => h.action)], [200, "cancelled", ["created", "cancelled"]]);

  console.log("\n--- cancelling closes the request still open on it ---");
  r = await call("POST", "/fees/plans", { studentId: "dee", academicYear: YEAR, reason: "Fourth", instalments: benSchedule });
  const dee3 = r.body.data;
  r = await call("POST", `/fees/plans/${dee3._id}/cancel`, { reason: "Family left" });
  const dee3Req = await M("ApprovalRequest").findOne({ targetId: dee3._id }).lean();
  check("cancelled, and its approval request no longer waits", [r.status, dee3Req.status], [200, "cancelled"]);

  console.log("\n--- the gate staff can do none of it ---");
  for (const [label, method, url, body] of [
    ["propose an agreement", "POST", "/fees/plans", { studentId: "ada", academicYear: YEAR, reason: "x", instalments: benSchedule }],
    ["change an agreement", "PATCH", `/fees/plans/${benPlan._id}`, { instalments: changed, reason: "x" }],
    ["cancel an agreement", "POST", `/fees/plans/${benPlan._id}/cancel`, { reason: "x" }],
    ["record a payment", "POST", "/fees/payments", { studentId: "ada", academicYear: YEAR, amount: 1000 }],
    ["create a fee structure", "POST", "/fees/structures", { academicYear: YEAR, items: [{ code: "x", label: "x", amount: 1 }] }],
    ["waive a charge", "POST", "/fees/charges/x/waive", { amount: 1, reason: "x" }],
    ["approve a request", "POST", `/approvals/${dee3Req._id}/approve`, {}],
    ["issue a gate authorization", "POST", "/gate/authorizations", { studentId: "ada", validUntil: day(3), reason: "x" }],
  ]) {
    r = await call(method, url, body, T.teacher);
    check(`a teacher cannot ${label}`, r.status, 403);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
