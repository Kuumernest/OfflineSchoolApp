// backend/scripts/check-idempotency.js
"use strict";

/**
 * Assert that replaying a queued write does not do the work twice.
 *
 * ── Why this is the hinge of the whole offline story ──────────────────────
 *
 * A machine that has been offline comes back with a queue of requests, and a
 * request in that queue can be sent more than once: the commonest case is a
 * connection that dropped after the request arrived and before the response came
 * back, which from the client's side is indistinguishable from one that never
 * arrived at all.
 *
 * The first two endpoints made offline-writable survive that on their own,
 * because they accept a client-generated _id and answer a repeat with the row
 * they already hold. Almost nothing else does. POST /api/exams calls uuidv4()
 * itself, so a replay creates a SECOND exam — and there are around a hundred
 * writes still to mirror, most of them shaped like that one.
 *
 * middleware/idempotency.js is the general answer, and it was already here:
 * mounted across /api, it records the first attempt under an Idempotency-Key and
 * answers any repeat with the response it gave the first time. That turns every
 * write replay-safe without touching a hundred route handlers — so this file
 * pins the behaviour the desktop queue is now relying on, against the real
 * middleware and a real database rather than a description of them.
 *
 * ── The two properties that are easy to get wrong ─────────────────────────
 *
 *   the key must be STABLE     a fresh key per attempt is a fresh request, and
 *   across attempts            the mechanism does nothing at all
 *
 *   the key must be UNIQUE     stored responses are scoped by (key, userId) and
 *   per operation              NOT by path, so two operations sharing a key have
 *                              the second answered with the first's response —
 *                              a PUT receiving the POST's 201
 *
 * The second is asserted explicitly below, because it is a surprising property
 * of the middleware and it is the reason the desktop outbox generates its key
 * per operation instead of deriving it from the document.
 *
 *   node scripts/check-idempotency.js
 */

const path     = require("path");
const express  = require("express");
const mongoose = require("mongoose");

const SCHOOL = "aaaaaaaaaaaaaaaaaaaaaaaa";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "idempotency" });

  const Exam           = require("../src/db/models/Exam");
  const IdempotencyKey = require("../src/db/models/IdempotencyKey");
  const { ROLES }      = require("../src/config/roles");

  // Who is asking. Injected rather than signed, because the middleware under
  // test reads req.user and nothing here is asserting how a token is verified.
  let actor = {
    _id: "admin-1", id: "admin-1", role: ROLES.SCHOOL_ADMIN,
    schoolId: SCHOOL, email: "head@schoola.com",
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; next(); });

  // Mounted exactly as src/server.js does it: across /api, ahead of the routes.
  app.use("/api", require("../middleware/idempotency"));
  app.use("/api/exams", require("../src/routes/exam.routes"));

  // A second path under the same middleware, so "the scope ignores the path"
  // can be demonstrated rather than asserted from reading the source.
  app.use("/api/echo", (req, res) => res.status(200).json({ where: "echo" }));

  /**
   * ── The index IS the mechanism ───────────────────────────────────────────
   *
   * middleware/idempotency.js detects a repeat by inserting and catching the
   * duplicate-key error, which only the unique index on (key, userId) can throw.
   * With the index absent, half the assertions below fail and the middleware
   * waves every replayed write through while looking perfectly correct.
   *
   * Nothing created it deliberately until ensureIdempotencyIndex() was added;
   * mongoose's background autoIndex pass was the only thing building it. So this
   * calls the PRODUCTION function rather than createIndexes() directly — the
   * boot path is the thing that has to work.
   */
  await require("../src/db/ensureStudentIndexes").ensureIdempotencyIndex();

  const server = app.listen(0);
  const port   = server.address().port;

  /** POST an exam, optionally with an idempotency key. */
  const create = async (name, key) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/exams`, {
      method:  "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify({ name, academicYear: "2026-2027", term: "term_1" }),
    });
    return { status: res.status, body: await res.json() };
  };

  const examCount = () => Exam.countDocuments({});

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a replayed write is answered, not repeated ---");

  const first = await create("Mock Maths", "op-1");
  check("the first attempt is created", first.status, 201);
  check("and there is one exam", await examCount(), 1);

  const replay = await create("Mock Maths", "op-1");
  check("the replay gets the same status", replay.status, first.status);
  check("and byte-for-byte the same body", replay.body, first.body);
  check("and it did NOT create a second exam", await examCount(), 1);

  // The point of returning the stored body rather than a bare 200: the desktop
  // takes the server's copy of the document out of this response, and a receipt
  // number or a server-assigned id has to survive the replay.
  check("so the id the client is told is stable",
    replay.body.serverId, first.body.serverId);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- it is the key doing the work, not the payload ---");

  const different = await create("Mock Maths", "op-2");
  check("the same body under a new key IS a new exam", different.status, 201);
  check("so there are two", await examCount(), 2);
  check("with different ids", different.body.serverId !== first.body.serverId, true);

  // Without a key the middleware steps aside entirely, which is what makes this
  // safe to mount globally — and why the desktop queue MUST send one. A write
  // replayed without the header is a duplicate record.
  const unkeyed  = await create("Mock Maths", null);
  const unkeyed2 = await create("Mock Maths", null);
  check("no key means no protection", await examCount(), 4);
  check("both attempts created something",
    [unkeyed.status, unkeyed2.status], [201, 201]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the scope is the person, not the path ---");

  /**
   * THE ASSERTION THAT JUSTIFIES THE DESKTOP KEY DESIGN.
   *
   * Stored responses are keyed by (key, userId). The path is recorded but not
   * part of the identity — so reusing a key on a different request does not just
   * fail to protect it, it returns the WRONG answer. The desktop outbox
   * originally derived its key from the document id, which would have had an
   * edit answered with its create's 201 while the edit was never applied.
   */
  const echo = await fetch(`http://127.0.0.1:${port}/api/echo`, {
    method:  "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "op-1" },
    body:    "{}",
  });
  const echoBody = await echo.json();
  check("a different path with a used key gets the FIRST path's response",
    echoBody.serverId, first.body.serverId);
  check("rather than reaching the route it was addressed to",
    echoBody.where, undefined);

  // Two people may of course use the same key as each other.
  actor = { ...actor, _id: "admin-2", id: "admin-2" };
  const otherPerson = await create("Mock Maths", "op-1");
  check("the same key as another user is a different request", otherPerson.status, 201);
  check("so it created its own exam", await examCount(), 5);
  actor = { ...actor, _id: "admin-1", id: "admin-1" };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a request still in flight is told to wait, not refused ---");

  /**
   * The middleware inserts a "processing" record before running the handler, so
   * a second attempt arriving while the first is still working gets 409 with
   * IDEMPOTENCY_IN_PROGRESS and a Retry-After.
   *
   * Simulated by leaving the record behind rather than by racing two requests:
   * a race that passes by luck is worse than no assertion.
   */
  await IdempotencyKey.create({
    key: "op-slow", userId: "admin-1", method: "POST",
    path: "/api/exams", state: "processing",
  });

  const inFlight = await fetch(`http://127.0.0.1:${port}/api/exams`, {
    method:  "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "op-slow" },
    body:    JSON.stringify({ name: "Slow", academicYear: "2026-2027", term: "term_1" }),
  });
  const inFlightBody = await inFlight.json();

  check("the status is 409", inFlight.status, 409);
  check("with a Retry-After", inFlight.headers.get("retry-after"), "2");
  check("and it did not run the handler", await examCount(), 5);

  /**
   * ── The contract between the two halves ──────────────────────────────────
   *
   * Every other 409 means the server refused, and the desktop queue STOPS on a
   * refusal and waits for a person. This one means "ask again shortly", and
   * treating it as a refusal blocked the queue on a request that was about to
   * succeed on its own.
   *
   * The two halves agree by way of one string, so this asserts against the
   * desktop's own function rather than repeating the literal here — a typo in
   * either file would otherwise silently strand queues in the field.
   */
  const { isRetryable } = require(
    path.join(__dirname, "..", "..", "desktop", "src", "main", "db", "outbox")
  );
  check("the code is the one the desktop queue looks for",
    isRetryable(inFlight.status, inFlightBody.code), true);
  check("while any other 409 still stops the queue",
    isRetryable(409, "RECEIPT_TAKEN"), false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a server error is not remembered as an answer ---");

  /**
   * If a 500 were stored, the retry that would have worked gets handed the
   * failure for the next fortnight, and the queue blocks on a write that has
   * nothing wrong with it. The middleware deletes the record instead.
   */
  app.use("/api/broken", (_req, res) => res.status(500).json({ message: "database unavailable" }));

  const brokenCall = () => fetch(`http://127.0.0.1:${port}/api/broken`, {
    method:  "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": "op-broken" },
    body:    "{}",
  });

  const broke = await brokenCall();
  check("the failure is reported", broke.status, 500);

  // The delete is fire-and-forget inside res.json, so it may land just after the
  // response. Waited for rather than slept on.
  for (let i = 0; i < 50; i++) {
    if (!(await IdempotencyKey.findOne({ key: "op-broken" }).lean())) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  check("and nothing was stored to poison the retry",
    await IdempotencyKey.findOne({ key: "op-broken" }).lean(), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a completed attempt keeps what it needs to answer with ---");

  const stored = await IdempotencyKey.find({ userId: "admin-1" }).lean();
  check("every completed attempt kept its status code",
    stored.filter((s) => s.state === "completed").every((s) => typeof s.statusCode === "number"),
    true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a missing index is restored, or said out loud ---");

  /**
   * ── Why this branch is worth a test of its own ───────────────────────────
   *
   * It is the branch nobody exercises. A school's server boots, prints its
   * usual "Indexes verified", and everything looks well — and if the index
   * could not be created, every offline write replayed from then on is a second
   * record. There is no symptom to notice, so the only protection is that the
   * boot said so, loudly, at the moment it happened.
   *
   * Both halves are checked: that an absent index is simply recreated, and that
   * an index which CANNOT be created produces the warning rather than silence.
   */
  const ensure = require("../src/db/ensureStudentIndexes").ensureIdempotencyIndex;
  const uniqueIndexPresent = async () =>
    (await IdempotencyKey.collection.indexes()).some(
      (ix) => ix.unique && ix.key?.key === 1 && ix.key?.userId === 1
    );

  await IdempotencyKey.collection.dropIndex("key_1_userId_1");
  check("the index really is gone", await uniqueIndexPresent(), false);

  await ensure();
  check("and a boot puts it back", await uniqueIndexPresent(), true);

  // Now make it impossible: duplicates in the collection, which is the state a
  // database is left in by having run without the index.
  await IdempotencyKey.collection.dropIndex("key_1_userId_1");
  await IdempotencyKey.collection.insertMany([
    { key: "clash", userId: "admin-1", method: "POST", path: "/api/exams", state: "completed", statusCode: 201, response: {}, createdAt: new Date(), updatedAt: new Date() },
    { key: "clash", userId: "admin-1", method: "POST", path: "/api/exams", state: "completed", statusCode: 201, response: {}, createdAt: new Date(), updatedAt: new Date() },
  ]);

  const said = [];
  const realError = console.error;
  console.error = (...args) => { said.push(args.join(" ")); };
  try {
    await ensure();
  } finally {
    console.error = realError;
  }

  const shouted = said.join("\n");
  check("the boot does not pass over it in silence", said.length > 0, true);
  check("it says what is actually wrong",
    shouted.includes("IDEMPOTENCY IS NOT BEING ENFORCED"), true);
  check("it counts the duplicates blocking the index",
    /groups already stored: 1\b/.test(shouted), true);
  check("and gives the command that fixes it",
    shouted.includes("createIndex({ key: 1, userId: 1 }, { unique: true })"), true);

  // Reported, NOT thrown: a fortnight of cached responses being unusable must
  // not stop a school from taking fees, so ensure() returns normally.
  check("while still letting the server come up", await uniqueIndexPresent(), false);

  await IdempotencyKey.collection.deleteMany({ key: "clash" });
  await ensure();
  check("once the duplicates are gone the index returns", await uniqueIndexPresent(), true);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongo.stop();

  console.log(`\n  ${pass} passed, ${fail} failed`);
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
