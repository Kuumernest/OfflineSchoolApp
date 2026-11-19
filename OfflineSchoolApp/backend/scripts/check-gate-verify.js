// backend/scripts/check-gate-verify.js
"use strict";

/**
 * Gate verification through the real routes (gate.routes, gate.service,
 * compliance.service), plus the student photo path.
 *
 *   - the snapshot a gate device stores: every pupil on the register (with or
 *     without a card), photo path, class, and the fee facts the engine reads —
 *     and NOTHING else from the ledger (no receipt, method, reference,
 *     cashier, note, agreement reason or history)
 *   - a card scan answers with the pupil card and the server's compliance,
 *     and records what the device showed beside what the server computed
 *   - a forgotten card: a manual lookup records a passage too (method manual)
 *   - without gate.verify: passages still record, no money is shown
 *   - gate authorizations: issued by an administrator, Authorized at the
 *     gate, revoked back to the money; a teacher cannot issue one
 *   - history carries the status each verification showed
 *   - the photo: kept by the shared student shape, the sync shape and
 *     GET /admin/students/:id (the profile's source — it was dropped there)
 *
 *   node scripts/check-gate-verify.js
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

  const S = "68c0000000000000000000d1";
  const YEAR = "2026/2027";
  await M("School").create({
    _id: S, name: "Gate Academy", code: "GATE", email: "g@example.test",
    settings: { academicYear: YEAR, gateNotify: "off" },
  });
  const PASSWORD = "Check-only-passw0rd";
  for (const [id, role] of [["admin-1", "school_admin"], ["teacher-1", "teacher"], ["bursar-1", "bursar"]]) {
    await M("User").create({ _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId: S, isActive: true });
  }
  await M("Class").create({ _id: "cls-1", schoolId: S, name: "Form 2B" });
  const PHOTO = "/uploads/photos/ada-0123456789ab.jpg";
  await M("Student").create([
    { _id: "ada", userId: "u-ada", schoolId: S, classId: "cls-1", studentName: "Ada Fon",  enrollmentNo: "F2-001", isActive: true, status: "approved", gateToken: "TOKENADA00000001", photoUrl: PHOTO, guardianPhone: "+237600000001" },
    // Ada's brother: same guardian phone — siblings, not a duplicate (CLAUDE.md).
    { _id: "ben", userId: "u-ben", schoolId: S, classId: "cls-1", studentName: "Ben Fon",  enrollmentNo: "F2-002", isActive: true, status: "approved", guardianPhone: "+237600000001" },
    { _id: "gone", userId: "u-gone", schoolId: S, classId: "cls-1", studentName: "Left Early", enrollmentNo: "F2-003", isActive: false, status: "graduated", gateToken: "TOKENGONE0000001" },
  ]);
  for (const p of ["ada", "ben"]) {
    for (const [code, amount, due] of [["T1", 75000, -30], ["T2", 75000, 60], ["T3", 50000, 150]]) {
      await M("FeeCharge").create({ schoolId: S, studentId: p, academicYear: YEAR, code, label: code, amount, dueDate: day(due), classId: "cls-1" });
    }
  }
  // Ada paid term 1, by mobile money, with a reference and a receipt number;
  // Ben paid 50,000 of it.
  await M("FeePayment").create({
    schoolId: S, studentId: "ada", academicYear: YEAR, amount: 75000, method: "mobile_money",
    reference: "MOMO-SECRET-REF", receiptNo: "R-0001", receivedBy: "bursar-1", note: "paid by uncle",
    receivedAt: new Date(Date.now() - 40 * DAY),
  });
  await M("FeePayment").create({ schoolId: S, studentId: "ben", academicYear: YEAR, amount: 50000, receivedAt: new Date(Date.now() - 35 * DAY) });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/gate",  auth.authenticate, require(path.join(SRC, "routes/gate.routes")));
  app.use("/api/admin", auth.authenticate, require(path.join(SRC, "routes/admin.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const token = (id, role) => jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const T = { admin: token("admin-1", "school_admin"), teacher: token("teacher-1", "teacher"), bursar: token("bursar-1", "bursar") };
  const call = async (method, url, body, who = T.teacher) => {
    const res = await fetch(`${API}${url}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${who}` },
      body: body ? JSON.stringify({ schoolId: S, ...body }) : undefined,
    });
    let out = {}; try { out = await res.json(); } catch { /* none */ }
    if (res.status >= 500) console.log(`       (server ${res.status} for ${method} ${url}: ${out.message})`);
    return { status: res.status, body: out };
  };

  console.log("--- the snapshot a gate device stores ---");
  let r = await call("GET", `/gate/snapshot?schoolId=${S}`);
  const snap = r.body.data;
  check("a teacher on gate duty may pull it", [r.status, snap?.academicYear, Boolean(snap?.generatedAt)], [200, YEAR, true]);
  const byId = new Map((snap?.students ?? []).map((s) => [s.studentId, s]));
  check("every pupil on the register — the one without a card too — and nobody who left", [...byId.keys()].sort(), ["ada", "ben"]);
  const ada = byId.get("ada");
  check("  pupil card fields", [ada?.name, ada?.enrollmentNo, ada?.className, ada?.photoUrl, ada?.token], ["Ada Fon", "F2-001", "Form 2B", PHOTO, "TOKENADA00000001"]);
  check("  Ben has no card, and is still there to be found by name", byId.get("ben")?.token, null);
  check("  the fee facts the engine reads", [ada?.charges?.length, ada?.payments?.map((p) => p.amount)], [3, [75000]]);
  const blob = JSON.stringify(snap);
  check("  nothing else from the ledger leaks: no receipt, method, reference, cashier or note",
    ["R-0001", "mobile_money", "MOMO-SECRET-REF", "bursar-1", "paid by uncle"].filter((x) => blob.includes(x)), []);
  check("  payment rows carry id, amount and date only", Object.keys(ada.payments[0]).sort(), ["_id", "amount", "receivedAt"]);

  console.log("\n--- a card scan ---");
  const deviceShown = { status: "compliant", amountDue: 75000, totalPaid: 75000, outstandingDue: 0, remainingBalance: 125000, arrangement: "standard", stale: true, dataAsOf: new Date(Date.now() - 30 * 3600_000).toISOString(), pending: { amount: 0 } };
  r = await call("POST", "/gate/scan", { _id: "scan-ada-1", token: "TOKENADA00000001", station: "main", verification: deviceShown });
  check("answered with the pupil card", [r.status, r.body.student?.name, r.body.student?.className, r.body.student?.photoUrl, r.body.method], [200, "Ada Fon", "Form 2B", PHOTO, "card"]);
  check("  and the server's compliance", [r.body.compliance?.status, r.body.compliance?.amountDue, r.body.compliance?.totalPaid, r.body.compliance?.remainingBalance], ["compliant", 75000, 75000, 125000]);
  let ev = await M("GateEvent").findById("scan-ada-1").lean();
  check("  recorded with who, when, and how", [ev?.scannedBy, ev?.station, ev?.method, Boolean(ev?.receivedAt)], ["teacher-1", "main", "card", true]);
  check("  what the device showed (stale data) beside what the server computed",
    [ev?.verification?.computedOn, ev?.verification?.stale, ev?.serverVerification?.computedOn, ev?.serverVerification?.status],
    ["device", true, "server", "compliant"]);

  console.log("\n--- a forgotten card: manual lookup ---");
  r = await call("GET", `/gate/search?schoolId=${S}&q=ben`);
  check("found by name", r.body.data?.map((s) => s._id), ["ben"]);
  r = await call("GET", `/gate/search?schoolId=${S}&q=F2-00`);
  check("found by admission number, both siblings (same guardian is normal)", r.body.data?.map((s) => s._id).sort(), ["ada", "ben"]);
  r = await call("GET", `/gate/verify/ben?schoolId=${S}`);
  check("viewed without recording a passage", [r.status, r.body.data?.compliance?.status, r.body.data?.compliance?.outstandingDue, await M("GateEvent").countDocuments({ studentId: "ben" })], [200, "non_compliant", 25000, 0]);
  r = await call("POST", "/gate/scan", { _id: "scan-ben-1", studentId: "ben" });
  ev = await M("GateEvent").findById("scan-ben-1").lean();
  check("a manual passage records, marked manual", [r.status, r.body.direction, ev?.method, ev?.serverVerification?.status], [200, "in", "manual", "non_compliant"]);
  r = await call("POST", "/gate/scan", { studentId: "gone" });
  check("a pupil who has left is refused, by lookup as by card", [r.status, r.body.code], [409, "NOT_ENROLLED"]);

  console.log("\n--- authorizations ---");
  r = await call("POST", "/gate/authorizations", { studentId: "ben", validUntil: day(3), reason: "Exam week; payment promised" }, T.teacher);
  check("a teacher cannot authorize", r.status, 403);
  r = await call("POST", "/gate/authorizations", { studentId: "ben", reason: "No end" }, T.admin);
  check("an authorization without an end date is refused", [r.status, r.body.code], [400, "INVALID_DATE"]);
  r = await call("POST", "/gate/authorizations", { studentId: "ben", validUntil: day(3), reason: "Exam week; payment promised" }, T.admin);
  const passId = r.body.data?._id;
  check("an administrator authorizes Ben for three days", [r.status, r.body.data?.grantedBy], [201, "admin-1"]);
  r = await call("GET", `/gate/verify/ben?schoolId=${S}`);
  check("  the gate shows Authorized, with the reason — and what is still owed",
    [r.body.data?.compliance?.status, r.body.data?.compliance?.authorization?.reason, r.body.data?.compliance?.outstandingDue],
    ["authorized", "Exam week; payment promised", 25000]);
  check("  the snapshot carries the pass for offline devices",
    (await call("GET", `/gate/snapshot?schoolId=${S}`)).body.data.students.find((s) => s.studentId === "ben").authorizations.map((a) => a._id), [passId]);
  r = await call("POST", `/gate/authorizations/${passId}/revoke`, { reason: "Payment did not come" }, T.admin);
  check("revoked (never deleted)", [r.status, Boolean(r.body.data?.revokedAt), await M("GateAuthorization").countDocuments()], [200, true, 1]);
  r = await call("GET", `/gate/verify/ben?schoolId=${S}`);
  check("  back to non-compliant", r.body.data?.compliance?.status, "non_compliant");

  console.log("\n--- history ---");
  r = await call("GET", `/gate/history?schoolId=${S}&limit=10`);
  check("newest first, with the status each verification showed",
    r.body.data?.map((h) => [h.studentId, h.method, h.serverVerification?.status]),
    [["ben", "manual", "non_compliant"], ["ada", "card", "compliant"]]);

  console.log("\n--- without gate.verify: passages, no money ---");
  await M("School").collection.updateOne(
    { _id: new mongoose.Types.ObjectId(S) },
    { $set: { "settings.permissions.teacher.revoked": ["gate.verify"] } }
  ).then((x) => x.matchedCount ? x : M("School").collection.updateOne({ _id: S }, { $set: { "settings.permissions.teacher.revoked": ["gate.verify"] } }));
  require(path.join(SRC, "services/permissions.service")).invalidate(S);
  r = await call("GET", `/gate/snapshot?schoolId=${S}`);
  check("the snapshot is refused", r.status, 403);
  r = await call("GET", `/gate/verify/ada?schoolId=${S}`);
  check("so is a compliance lookup", r.status, 403);
  r = await call("POST", "/gate/scan", { _id: "scan-ada-2", token: "TOKENADA00000001", at: new Date(Date.now() + 2 * 3600_000).toISOString(), verification: deviceShown });
  ev = await M("GateEvent").findById("scan-ada-2").lean();
  check("a scan still records the passage, with no compliance in the answer or the record",
    [r.status, r.body.student?.name, "compliance" in r.body, ev?.verification, ev?.serverVerification], [200, "Ada Fon", false, null, null]);
  r = await call("GET", `/gate/history?schoolId=${S}&limit=1`);
  check("history without the fee status", [r.body.data?.[0]?.studentId, "serverVerification" in (r.body.data?.[0] ?? {})], ["ada", false]);

  console.log("\n--- the photo reaches the profile ---");
  const { normaliseStudentDoc } = require("../../shared/students");
  check("the shared student shape keeps photoUrl (it was dropped — the photo-holder bug)", normaliseStudentDoc({ _id: "x", photoUrl: PHOTO }).photoUrl, PHOTO);
  check("  and null when there is none", normaliseStudentDoc({ _id: "x" }).photoUrl, null);
  const { normaliseStudentForSync } = require(path.join(SRC, "controllers/sync.controller"));
  check("the sync shape carries it to phones", normaliseStudentForSync({ _id: "x", photoUrl: PHOTO }).photoUrl, PHOTO);
  r = await call("GET", "/admin/students/ada", null, T.admin);
  check("GET /admin/students/:id — the profile's source — returns it", [r.status, (r.body.data?.student ?? r.body.student)?.photoUrl], [200, PHOTO]);
  r = await call("GET", `/gate/roster?schoolId=${S}`, null, T.admin);
  check("the existing roster carries it too", r.body.data?.find((s) => s.studentId === "ada")?.photoUrl, PHOTO);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
