// backend/scripts/check-interventions.js
"use strict";

/**
 * The intervention record: the one thing in the intelligence stack a human writes.
 *
 * ── Why this file is as long as it is ─────────────────────────────────────
 *
 * Everything else under services/intelligence is DERIVED. It is recomputed from
 * published marks on every request, it is owned by nobody, and getting it wrong
 * shows up as a wrong sentence on a screen. An Intervention is the opposite: a
 * row a teacher creates about a named child, which outlives the request, syncs
 * to a machine in an office, and says what the school did about a pupil who was
 * struggling. That is a permanent record with an audience.
 *
 * So the questions this has to answer are not "is the arithmetic right" but the
 * ones every persisted collection in this repository has to answer:
 *
 *   who may write one          teachers, for the classes they actually teach
 *   who may read one           the same, plus the office; never the bursar
 *   what crosses a school      nothing
 *   what happens on a replay   the offline outbox resends the same POST after a
 *                              dropped connection, and must not create a second
 *                              record about the same child
 *   what happens on a clash    two devices editing one row is answered, not
 *                              silently resolved in favour of whoever synced last
 *   what is written down       who moved the status, and when
 *
 * The state machine alone was already tested. It was the cheap half: a pure
 * function with no database, no token and no school. Every failure mode above
 * lives in the half that was not.
 *
 * ── What an intervention is NOT allowed to do ─────────────────────────────
 *
 * Change a grade, a result, a promotion or a piece of guidance. It is a record
 * OF a human decision, not an input to any calculation, and section 7 asserts
 * that structurally — the module cannot reach the grading services or the fee
 * ledger, so it cannot start to.
 *
 *   node scripts/check-interventions.js
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

const A = "68e0000000000000000000a1";   // Alpha Academy
const B = "68e0000000000000000000b2";   // Beta College

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the lifecycle, without a database ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const { transition, TRANSITIONS } =
    require(path.join(SRC, "services/intervention.service"));

  const item = { status: "planned", statusHistory: [] };
  transition(item, "active", "teach-a");
  check("planned may become active", item.status, "active");
  check("and the move is recorded with who made it",
    [item.statusHistory[0].from, item.statusHistory[0].to, item.statusHistory[0].by],
    ["planned", "active", "teach-a"]);
  check("and stamped", item.startedAt instanceof Date, true);

  transition(item, "completed", "teach-a");
  check("active may complete", item.status, "completed");
  check("and completion is stamped", item.completedAt instanceof Date, true);

  let threw = null;
  try { transition(item, "active", "teach-a"); } catch (e) { threw = e.message; }
  check("a completed record cannot be reopened", threw, "INVALID_INTERVENTION_TRANSITION");

  const cancelled = { status: "planned", statusHistory: [] };
  transition(cancelled, "cancelled", "teach-a");
  check("planned may be cancelled outright",
    [cancelled.status, cancelled.cancelledAt instanceof Date], ["cancelled", true]);

  const noop = { status: "active", statusHistory: [] };
  transition(noop, "active", "teach-a");
  check("setting the status it already has writes no history entry",
    [noop.status, noop.statusHistory.length], ["active", 0]);

  check("the lifecycle is the documented four states",
    Object.keys(TRANSITIONS).sort(), ["active", "cancelled", "completed", "planned"]);
  check("and the two end states are terminal",
    [TRANSITIONS.completed, TRANSITIONS.cancelled], [[], []]);

  // ═══════════════════════════════════════════════════════════════════════════
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School            = mongoose.model("School");
  const User              = mongoose.model("User");
  const Class             = mongoose.model("Class");
  const Subject           = mongoose.model("Subject");
  const Student           = mongoose.model("Student");
  const TeacherAssignment = mongoose.model("TeacherAssignment");
  const Intervention      = mongoose.model("Intervention");

  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test"  },
  ]);
  const mkUser = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`,
    password: "Check-only-passw0rd", role, schoolId, isActive: true,
  });
  await Promise.all([
    mkUser("teach-a",    "teacher",      A),
    mkUser("teach-a2",   "teacher",      A),
    mkUser("admin-a",    "school_admin", A),
    mkUser("bursar-a",   "bursar",       A),
    mkUser("teach-beta", "teacher",      B),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form4b", schoolId: A, name: "Form 4B" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);
  await Subject.create([{ _id: "maths", schoolId: A, name: "Mathematics", classId: "form3a" }]);
  // teach-a takes Form 3A and nothing else.
  await TeacherAssignment.create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
  ]);
  const pupil = (id, schoolId, classId, n) => ({
    _id: id, userId: `u-${id}`, schoolId, classId,
    studentName: `Pupil ${n}`, enrollmentNo: `${n}`, isActive: true, status: "approved",
  });
  await Student.create([
    pupil("st-a1", A, "form3a", "One"),
    pupil("st-a2", A, "form4b", "Two"),
    pupil("st-b1", B, "form1b", "Beta"),
  ]);

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/interventions", auth.authenticate,
    require(path.join(SRC, "routes/interventions.routes")));
  app.use("/api/sync", auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  app.use((err, _req, res, _next) =>
    res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const as = (id, role, schoolId) => {
    const token = jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const call = async (method, url, body) => {
      const res = await fetch(`${API}${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let out = {}; try { out = await res.json(); } catch { /* empty body */ }
      return { status: res.status, body: out };
    };
    return {
      get:   (url)       => call("GET", url),
      post:  (url, body) => call("POST", url, body),
      patch: (url, body) => call("PATCH", url, body),
    };
  };
  const teacher = as("teach-a",    "teacher",      A);
  const admin   = as("admin-a",    "school_admin", A);
  const bursar  = as("bursar-a",   "bursar",       A);
  const beta    = as("teach-beta", "teacher",      B);

  const action = (extra = {}) => ({
    studentId: "st-a1", actionCode: "TARGETED_PRACTICE", ...extra,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. who may write one ---");
  // ═══════════════════════════════════════════════════════════════════════════

  let r = await teacher.post("/interventions", action({ notes: "Extra algebra drills" }));
  check("a teacher records one for a pupil in a class they teach → 201",
    [r.status, r.body?.data?.status, r.body?.data?.classId],
    [201, "planned", "form3a"]);
  check("and it records who wrote it",
    [r.body?.data?.createdBy, r.body?.data?.version], ["teach-a", 1]);
  const created = r.body?.data?._id;

  r = await teacher.post("/interventions", action({ studentId: "st-a2" }));
  check("a pupil in a class they do not teach → 403 CLASS_NOT_ASSIGNED",
    [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);

  r = await teacher.post("/interventions", action({ studentId: "st-b1" }));
  check("a pupil in another school → 404, never a hint the id exists", r.status, 404);

  r = await beta.post("/interventions", action());
  check("and the reverse: Beta's teacher cannot reach Alpha's pupil → 404", r.status, 404);

  r = await bursar.post("/interventions", action());
  check("the bursar holds no intervention capability at all → 403", r.status, 403);

  r = await teacher.post("/interventions", { studentId: "st-a1" });
  check("a record with no action is refused → 400",
    [r.status, r.body?.code], [400, "INVALID_INTERVENTION"]);

  r = await teacher.post("/interventions",
    action({ sourceType: "guidance", sourceCode: null }));
  check("one that claims to come from guidance must say which guidance → 400",
    [r.status, r.body?.code], [400, "INVALID_INTERVENTION"]);

  r = await teacher.post("/interventions", action({ assignedTo: "teach-beta" }));
  check("it cannot be assigned to a teacher in another school → 400",
    [r.status, r.body?.code], [400, "INVALID_ASSIGNEE"]);

  r = await teacher.post("/interventions", action({ assignedTo: "admin-a" }));
  check("nor to somebody who is not a teacher → 400",
    [r.status, r.body?.code], [400, "INVALID_ASSIGNEE"]);

  r = await teacher.post("/interventions", action({ assignedTo: "teach-a2" }));
  check("a colleague in the same school is a valid assignee → 201",
    [r.status, r.body?.data?.assignedTo], [201, "teach-a2"]);

  r = await admin.post("/interventions", action({ studentId: "st-a2" }));
  check("the office may record one for any class in its own school → 201",
    r.status, 201);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. a replayed request is not a second record ---");
  // ═══════════════════════════════════════════════════════════════════════════

  /*
   * The desktop and the phone both write locally first and resend afterwards
   * through their durable outbox. A connection dropped AFTER the server wrote
   * the row and BEFORE the reply arrived is the ordinary case, not the rare
   * one, and the resend carries the same client-generated id. Two rows about
   * one child, both saying the school acted, is the failure that produces.
   */
  const replayId = "intervention-replay-0001";
  const first  = await teacher.post("/interventions", action({ _id: replayId }));
  const second = await teacher.post("/interventions", action({ _id: replayId, notes: "resent" }));
  check("the resend is accepted rather than rejected",
    [first.status, second.status], [201, 201]);
  check("and answers with the row that already exists",
    [first.body?.data?._id, second.body?.data?._id], [replayId, replayId]);
  check("one request, one record",
    await Intervention.countDocuments({ _id: replayId }), 1);
  check("and the replay did not overwrite what was stored",
    (await Intervention.findById(replayId).lean())?.notes, null);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. who may read one ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await teacher.get("/interventions/student/st-a1");
  check("a teacher reads their own pupil's record → 200, newest first",
    [r.status, Array.isArray(r.body?.data), r.body?.data?.length > 0], [200, true, true]);

  r = await teacher.get("/interventions/student/st-a2");
  check("a pupil in a class they do not teach → 403", r.status, 403);

  r = await teacher.get("/interventions/student/st-b1");
  check("a pupil in another school → 404", r.status, 404);

  r = await admin.get("/interventions/student/st-a2");
  check("the office reads any class in its own school → 200", r.status, 200);

  r = await bursar.get("/interventions/student/st-a1");
  check("the bursar cannot read them either → 403", r.status, 403);

  r = await beta.get("/interventions/student/st-a1");
  check("Beta cannot read Alpha's by id → 404", r.status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. changing one, and two devices changing one ---");
  // ═══════════════════════════════════════════════════════════════════════════

  r = await teacher.patch(`/interventions/${created}`, { status: "active", version: 1 });
  check("planned → active over the route → 200, version advances",
    [r.status, r.body?.data?.status, r.body?.data?.version], [200, "active", 2]);
  check("the move is written down with its actor",
    [r.body?.data?.statusHistory?.[0]?.from,
     r.body?.data?.statusHistory?.[0]?.to,
     r.body?.data?.statusHistory?.[0]?.by],
    ["planned", "active", "teach-a"]);
  check("and it is stamped", Boolean(r.body?.data?.startedAt), true);

  r = await teacher.patch(`/interventions/${created}`, { status: "completed", version: 1 });
  check("a second device holding the older version is told, not silently overruled",
    [r.status, r.body?.code], [409, "VERSION_CONFLICT"]);
  check("and the conflict reply carries the row it lost to, to resolve against",
    r.body?.data?.version, 2);

  r = await teacher.patch(`/interventions/${created}`, { status: "planned", version: 2 });
  check("a move the lifecycle does not allow → 409", r.status, 409);

  r = await teacher.patch(`/interventions/${created}`, {
    status: "completed", version: 2, outcomeCode: "improved",
    outcomeNotes: "Sat the next sequence and passed",
  });
  check("active → completed with a human-entered outcome → 200",
    [r.status, r.body?.data?.status, r.body?.data?.outcomeCode],
    [200, "completed", "improved"]);
  check("both moves are on the record",
    (r.body?.data?.statusHistory ?? []).map((h) => `${h.from}>${h.to}`),
    ["planned>active", "active>completed"]);

  r = await admin.patch(`/interventions/${created}`, { outcomeCode: "nonsense", version: 4 });
  check("an outcome outside the recorded vocabulary is refused",
    r.status >= 400, true);

  const othersRecord = await Intervention.findOne({ classId: "form4b" }).lean();
  r = await teacher.patch(`/interventions/${othersRecord._id}`, { notes: "not mine" });
  check("a teacher cannot edit a record belonging to a class they do not teach → 403",
    [r.status, r.body?.code], [403, "CLASS_NOT_ASSIGNED"]);

  r = await beta.patch(`/interventions/${created}`, { notes: "not my school" });
  check("and another school's record is simply not there → 404", r.status, 404);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. what a device is allowed to mirror ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const feed = require(path.join(SRC, "config/syncFeed"));
  const entry = feed.byCollection.get("intervention");
  check("the collection is classified in the sync feed", Boolean(entry), true);
  check("gated on the intervention capabilities, not a loosely related one",
    feed.required(entry), ["interventions.view", "interventions.viewTaught"]);
  check("and scoped, rather than mirroring the whole school to every device",
    typeof entry.scope, "function");

  r = await teacher.get("/sync/changes?collections=intervention");
  const mirrored = r.body?.collections?.intervention?.documents ?? [];
  check("a teacher mirrors only the classes they teach",
    [...new Set(mirrored.map((d) => d.classId))], ["form3a"]);
  check("and every row is their own school's",
    [...new Set(mirrored.map((d) => d.schoolId))], [A]);

  r = await bursar.get("/sync/changes?collections=intervention");
  check("the bursar's machine mirrors none of it",
    r.body?.collections?.intervention?.documents ?? [], []);

  r = await admin.get("/sync/changes?collections=intervention");
  const adminMirror = r.body?.collections?.intervention?.documents ?? [];
  check("the office mirrors the school, both classes included",
    [...new Set(adminMirror.map((d) => d.classId))].sort(), ["form3a", "form4b"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. what an intervention cannot touch ---");
  // ═══════════════════════════════════════════════════════════════════════════

  const graphOf = (entryPoint) => {
    const id = require.resolve(entryPoint);
    require(entryPoint);
    const seen = new Set();
    const walk = (moduleId) => {
      if (seen.has(moduleId)) return;
      seen.add(moduleId);
      for (const child of require.cache[moduleId]?.children ?? []) walk(child.id);
    };
    walk(id);
    return [...seen];
  };
  const MONEY   = /(fees|finance|financeReports|payroll|feeReminders)\.service\.js$/i;
  const GRADING = /(grading|results|termGrading|annualGrading|promotion)\.service\.js$/i;

  check("the intervention service cannot reach the fee ledger",
    graphOf(path.join(SRC, "services/intervention.service")).filter((f) => MONEY.test(f)), []);
  check("nor can the router that writes them",
    graphOf(path.join(SRC, "routes/interventions.routes")).filter((f) => MONEY.test(f)), []);
  check("and neither can reach the grading engine — a support note decides no mark",
    graphOf(path.join(SRC, "routes/interventions.routes")).filter((f) => GRADING.test(f)), []);

  const MONEY_WORD = /balance|fee|arrear|owed|owing|debt|invoice|receipt|payment|paid|charge|waive|amount|currency|xaf|cfa/i;
  const offending = (node, trail = "$") => {
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) return node.flatMap((v, i) => offending(v, `${trail}[${i}]`));
    if (typeof node === "object") {
      return Object.entries(node).flatMap(([k, v]) =>
        (MONEY_WORD.test(k) ? [`${trail}.${k}`] : []).concat(offending(v, `${trail}.${k}`)));
    }
    return typeof node === "string" && MONEY_WORD.test(node) ? [`${trail} = ${node}`] : [];
  };
  check("and no financial key or value reaches a teacher's payload",
    offending((await teacher.get("/interventions/student/st-a1")).body), []);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
