// backend/scripts/check-quiz-since.js
"use strict";

/**
 * GET /quiz/sync?since= never answers 500 on a bad date.
 *
 * `since` was handed straight to new Date() and into the queries: anything it
 * could not parse became Invalid Date, the queries threw, and the phone's quiz
 * sync failed with a 500 on every cycle. Now: absent → from the beginning; a
 * valid date (ISO, as the phone sends) → used; anything else → 400
 * INVALID_SINCE, for every role's branch. Real router.
 *
 *   node scripts/check-quiz-since.js
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
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "quiz-since" });
  require(path.join(SRC, "db/models"));
  const User = mongoose.model("User");
  const S = "5c0e2e0000000000000000f1";
  for (const [id, role] of [["adm", "school_admin"], ["tea", "teacher"], ["pup", "student"]]) {
    await User.create({ _id: id, name: id, email: `${id}@example.test`, password: "check-only-password", role, schoolId: S, isActive: true });
  }
  await mongoose.model("Student").create({ _id: "st-pup", userId: "pup", schoolId: S, classId: "c1", studentName: "Pup", enrollmentNo: "E1", status: "approved", isActive: true });

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express(); app.use(express.json());
  app.use("/api/quiz", auth.authenticate, require(path.join(SRC, "routes/quiz.routes")));
  // Anything the route lets escape is a 500 here, as in check-quiz-scope.js:
  // the route must refuse a bad `since` itself, not lean on the global
  // handler happening to map the CastError its queries throw.
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const port = server.address().port;
  const tok = (id, role) => jwt.sign({ id, role, schoolId: S }, process.env.JWT_SECRET);
  const get = async (who, role, qs) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/quiz/sync${qs}`, { headers: { Authorization: `Bearer ${tok(who, role)}` } });
    let body = {}; try { body = await r.json(); } catch {}
    return { status: r.status, code: body.code ?? null };
  };

  for (const [who, role] of [["adm", "school_admin"], ["tea", "teacher"], ["pup", "student"]]) {
    console.log(`--- ${role} ---`);
    check("no since: 200", (await get(who, role, "")).status, 200);
    check("an ISO since (what the phone sends): 200", (await get(who, role, "?since=2026-11-01T08:00:00.000Z")).status, 200);
    check("the epoch: 200", (await get(who, role, "?since=1970-01-01T00:00:00.000Z")).status, 200);
    check("garbage: 400 INVALID_SINCE, not 500", await get(who, role, "?since=not-a-date"), { status: 400, code: "INVALID_SINCE" });
    check("\"undefined\": 400, not 500", (await get(who, role, "?since=undefined")).status, 400);
    check("two values: 400, not 500", (await get(who, role, "?since=a&since=b")).status, 400);
  }

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
