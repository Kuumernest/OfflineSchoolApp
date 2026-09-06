// backend/scripts/check-duplicate-money.js
"use strict";

/**
 * Can the same payment be recorded twice?
 *
 * check-idempotency proves the middleware works. It does not prove that money
 * is protected by it, because the middleware is opt-in: it acts only when the
 * caller sends an Idempotency-Key, and returns next() otherwise. The mobile
 * and desktop outboxes send one. The web sends none — it has no outbox, so
 * nothing was ever built to.
 *
 * That leaves the case a bursar meets on a bad line: the request goes out, the
 * server records the payment, the reply never arrives, and they press the
 * button again. FeePayment carries a unique index on schoolId+receiptNo, which
 * sounds like protection and is not — the server mints a fresh receipt number
 * per request, so two attempts are two receipts and two payments, both valid.
 *
 * These assertions record exactly what happens, so that the answer is a
 * decision rather than a discovery after a parent is charged twice.
 *
 *   node scripts/check-duplicate-money.js
 */

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

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User       = mongoose.model("User");
  const Student    = mongoose.model("Student");
  const Class      = mongoose.model("Class");
  const FeePayment = mongoose.model("FeePayment");

  // The middleware detects a replay by letting the unique index on
  // key+userId raise E11000. Mongoose builds indexes in the background, so
  // without waiting the second create can land before the index exists and
  // simply succeed — the suite then reports that idempotency is broken when
  // what is actually broken is the suite. It passed for days and failed once
  // the run got fast enough, which is the worst way for a check to behave.
  await mongoose.model("IdempotencyKey").init();
  await mongoose.model("FeePayment").init();

  const S    = "school-a";
  const YEAR = "2026/2027";

  await User.create({
    _id: "bur-1", name: "A Bursar", email: "bursar@example.test",
    password: "check-only-password", role: "bursar", schoolId: S, isActive: true,
  });
  await Class.create({ _id: "cls-1", schoolId: S, name: "Form 1" });
  await Student.create({
    _id: "st-1", userId: "usr-st-1", schoolId: S, classId: "cls-1",
    studentName: "A Pupil", enrollmentNo: "E-1", isActive: true,
  });

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());
  // The global idempotency middleware sits on /api in server.js, before the
  // routers, and this reproduces that order exactly.
  app.use("/api", auth.authenticate, require(path.join(ROOT, "middleware/idempotency")));
  app.use("/api/fees", auth.authenticate, require(path.join(SRC, "routes/fees.routes")));

  const server = app.listen(0);
  const port   = server.address().port;
  const token  = jwt.sign({ id: "bur-1", role: "bursar", schoolId: S },
    process.env.JWT_SECRET, { expiresIn: "1h" });

  const pay = async (amount, key, clientId) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/fees/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify({
        ...(clientId ? { _id: clientId } : {}),
        schoolId: S, studentId: "st-1", academicYear: YEAR,
        amount, method: "cash",
      }),
    });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  const countFor = (amount) => FeePayment.countDocuments({ studentId: "st-1", amount });

  // ── With a key: the outbox case, mobile and desktop ───────────────────────
  console.log("\n--- the same payment sent twice, with an Idempotency-Key ---");

  const k = "idem-key-1";
  const a1 = await pay(5000, k);
  const a2 = await pay(5000, k);

  if (a1.status < 400) ok(`the first attempt is accepted (${a1.status})`);
  else bad("the first attempt is accepted", `${a1.status} ${JSON.stringify(a1.body).slice(0, 160)}`);

  const withKey = await countFor(5000);
  if (withKey === 1) ok("a replay with the same key records one payment, not two");
  else bad("a replay with the same key records one payment", `${withKey} payment(s) stored`);

  if (a2.status === a1.status) ok("and the replay is answered like the original");
  else bad("the replay is answered like the original", `${a1.status} then ${a2.status}`);

  // ── Without a key: the web, and any client that forgets ───────────────────
  console.log("\n--- the same payment sent twice, with no key at all ---");

  await pay(7000, null);
  await pay(7000, null);
  const noKey = await countFor(7000);

  // This is asserted as it is, rather than as one would wish it.
  //
  // Two identical payments a minute apart are not necessarily a mistake: a
  // parent can pay the same amount twice in a day, and a server that refused
  // the second would be wrong in a way nobody could work around. So the server
  // does record both, and the protection has to live where the intent is
  // known — in the client, which knows whether this is a new payment or the
  // same one being sent again.
  //
  // The assertion therefore pins the behaviour rather than calling it a bug.
  // If somebody later adds server-side de-duplication, this fails and tells
  // them to come and read this note before deciding it was an improvement.
  if (noKey === 2) {
    ok("a retry with no id of any kind records both, as designed — the client must supply one");
  } else {
    bad("a bare retry records both attempts",
      `${noKey} stored. If this is now 1, the server has started de-duplicating ` +
      "on payload; see the note here before keeping it.");
  }

  // ── With a client-chosen _id: what the web now sends ──────────────────
  console.log("\n--- the same payment sent twice, carrying a client _id ---");

  // useAttemptId derives this id from the payload, so a retry of an unchanged
  // form repeats the id and a corrected amount does not.
  await pay(9000, null, "pay-attempt-1");
  await pay(9000, null, "pay-attempt-1");
  const withId = await countFor(9000);

  if (withId === 1) ok("a repeat carrying the same _id records one payment");
  else bad("a repeat carrying the same _id records one payment", `${withId} stored`);

  // And a corrected figure must NOT be swallowed as a repeat.
  await pay(9500, null, "pay-attempt-2");
  const corrected = await countFor(9500);
  if (corrected === 1) ok("a corrected amount under a new id is its own payment");
  else bad("a corrected amount is its own payment", `${corrected} stored`);

  // What the money actually looks like afterwards, in the parent's ledger.
  const rows = await FeePayment.find({ studentId: "st-1" }).lean();
  const total = rows.reduce((n, r) => n + (r.amount ?? 0), 0);
  console.log(`       (ledger: ${rows.length} payment(s), ${total} total)`);

  // ── The clients are where the protection actually lives ──────────────────
  //
  // Everything above says the server behaves correctly given an id. None of it
  // says anybody sends one. That is the half that was missing, so it is checked
  // here rather than left to be true by assumption.
  console.log("\n--- every client that writes money supplies an id ---");

  const WEB = path.join(ROOT, "..", "web", "src");
  const read = (p) => { try { return require("fs").readFileSync(path.join(WEB, p), "utf8"); } catch { return null; } };

  for (const [file, what] of [
    ["pages/fees/student.tsx",    "the payment form"],
    ["pages/finance/expenses.tsx", "the expense form"],
  ]) {
    const text = read(file);
    if (text == null) { bad(`${what} can be read`, file); continue; }
    if (/useAttemptId\(\)/.test(text) && /_id:\s*attemptId\(/.test(text)) {
      ok(`${what} sends a client id derived from the payload`);
    } else {
      bad(`${what} sends a client id`,
        `${file} calls the server without an _id, so a retried submission is a ` +
        "second record. See web/src/hooks/useAttemptId.ts.");
    }
  }

  // The mobile and desktop outboxes take the other route — a header — and it
  // is the same protection, so a regression in either should be visible here.
  for (const [rel, what] of [
    ["../mobile/src/services/mutationQueue.service.js", "the mobile outbox"],
    ["../desktop/src/main/sync/client.js",              "the desktop sync client"],
  ]) {
    let text = null;
    try { text = require("fs").readFileSync(path.join(ROOT, "..", rel.replace(/^\.\.\//, "")), "utf8"); } catch {}
    if (text == null) { bad(`${what} can be read`, rel); continue; }
    if (/"Idempotency-Key"/.test(text)) ok(`${what} sends an Idempotency-Key`);
    else bad(`${what} sends an Idempotency-Key`, rel);
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
