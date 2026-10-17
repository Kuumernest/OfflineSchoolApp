// backend/scripts/check-idempotency-recovery.js
"use strict";

/**
 * Two ways a stored idempotency record went wrong (middleware/idempotency.js):
 *
 *   1. A record left "processing" — the process died mid-request, or the
 *      handler answered without res.json — answered every retry of its key
 *      with 409 IDEMPOTENCY_IN_PROGRESS for the key's 14-day life, holding a
 *      phone's or a desktop's queued change for as long. Once older than the
 *      longest a request may run, the next retry now takes it over, and of two
 *      racing retries exactly one runs.
 *   2. The stored response kept a temporary password in plain text for 14
 *      days. The live answer still carries it; the stored copy and a replay
 *      do not.
 *
 * The real middleware, on an in-memory MongoDB and a loopback port.
 *
 *   node scripts/check-idempotency-recovery.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");
const express  = require("express");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  const IdempotencyKey = require("../src/db/models/IdempotencyKey");
  await IdempotencyKey.createIndexes();
  const idempotency = require("../middleware/idempotency");

  let runs = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { _id: "user-1" }; next(); });
  app.use(idempotency);
  // Answers without res.json, as a download or an HTML render does.
  app.post("/stuck", (_req, res) => { runs++; res.status(200).send("done"); });
  app.post("/staff", (_req, res) => {
    runs++;
    res.status(201).json({ success: true, data: { user: { name: "Bursar" }, tempPassword: "Temp-1234" } });
  });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, key) => {
    const r = await fetch(url + path, { method: "POST", headers: { "Idempotency-Key": key } });
    const text = await r.text();
    let body = text; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body };
  };
  const age = (key, ms) => IdempotencyKey.collection.updateOne(
    { key }, { $set: { updatedAt: new Date(Date.now() - ms) } });

  // ── 1. an abandoned "processing" record ──────────────────────────────────
  console.log("--- a record left processing ---");
  let r = await post("/stuck", "k-stuck");
  check("answered without res.json: 200, and the record stays processing",
    [r.status, runs, (await IdempotencyKey.findOne({ key: "k-stuck" }).lean())?.state], [200, 1, "processing"]);
  r = await post("/stuck", "k-stuck");
  check("  a retry while it may still be running: 409 in progress, not run again",
    [r.status, r.body?.code, runs], [409, "IDEMPOTENCY_IN_PROGRESS", 1]);
  await age("k-stuck", idempotency.STALE_PROCESSING_MS - 60 * 1000);
  r = await post("/stuck", "k-stuck");
  check("  still 409 a minute short of the limit (the longest a request may run)",
    [r.status, runs], [409, 1]);
  await age("k-stuck", idempotency.STALE_PROCESSING_MS + 60 * 1000);
  r = await post("/stuck", "k-stuck");
  check("  past the limit: the retry takes it over and runs", [r.status, runs], [200, 2]);

  await age("k-stuck", idempotency.STALE_PROCESSING_MS + 60 * 1000);
  const both = await Promise.all([post("/stuck", "k-stuck"), post("/stuck", "k-stuck")]);
  check("  two retries racing for an abandoned record: exactly one runs, the other is told 409",
    [both.map((x) => x.status).sort(), runs], [[200, 409], 3]);

  // ── 2. a temporary password in a stored response ─────────────────────────
  console.log("--- a temporary password is not stored ---");
  r = await post("/staff", "k-staff");
  check("the live answer carries the temporary password",
    [r.status, r.body?.data?.tempPassword], [201, "Temp-1234"]);
  // Completion is written after the answer is sent.
  let stored = null;
  for (let i = 0; i < 50 && stored?.state !== "completed"; i++) {
    stored = await IdempotencyKey.findOne({ key: "k-staff" }).lean();
    if (stored?.state !== "completed") await new Promise((ok) => setTimeout(ok, 20));
  }
  check("  the stored copy keeps the rest of the answer, not the password",
    [stored?.state, stored?.response?.data?.user?.name, "tempPassword" in (stored?.response?.data ?? {}),
     JSON.stringify(stored).includes("Temp-1234")],
    ["completed", "Bursar", false, false]);
  r = await post("/staff", "k-staff");
  check("  a replay: the same status and answer, without the password, and nothing run again",
    [r.status, r.body?.data?.user?.name, r.body?.data?.tempPassword, runs], [201, "Bursar", undefined, 4]);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
