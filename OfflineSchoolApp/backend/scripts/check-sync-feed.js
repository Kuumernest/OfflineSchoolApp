// backend/scripts/check-sync-feed.js
"use strict";

/**
 * Assert that a device mirrors only what its user may read, and mirrors all of it.
 *
 * ── The two failures being guarded against ────────────────────────────────
 *
 * TOO MUCH. Whatever this endpoint sends is written to a SQLite file on a
 * machine in a school office and kept there. A collection reachable without the
 * capability that gates it elsewhere is not a leak of one response — it is a
 * permanent local copy. So every collection is requested as a role that should
 * not have it, and the refusal is checked.
 *
 * TOO LITTLE, which is the failure that gets shipped because it looks like
 * nothing. A collection whose cursor skips a page silently loses records: a
 * family's payment simply absent from the mirror, discovered when the arrears
 * list disagrees with the receipt book. The tie-breaking assertions below are
 * the important ones in this file, and they are written against documents that
 * deliberately share a timestamp — which is not contrived, since applying a fee
 * structure writes hundreds of charges inside the same millisecond.
 *
 *   node scripts/check-sync-feed.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const fs       = require("fs");
const path     = require("path");

const SCHOOL_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const SCHOOL_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

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
  const mongo = await MongoMemoryServer.create({
    // The default launch timeout is ten seconds, which is not enough on a
    // developer machine with a browser and an editor open — the suite failed
    // intermittently with "Instance failed to start within 10000ms" and the
    // failure looked like a broken test rather than a busy host.
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: "sync-feed" });
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const feed  = require("../src/config/syncFeed");
  const PERMS = require("../src/config/permissions");
  const { ROLES } = require("../src/config/roles");
  const { effectiveFor } = require("../src/services/permissions.service");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- every model is classified, one way or the other ---");

  // The boot check already threw if not, so requiring the module at all is
  // most of this. Restated as assertions so a failure reads as a failing
  // check rather than a crashing harness.
  const inFeed   = new Set(feed.FEED.map((e) => e.model));
  const excluded = new Set(Object.keys(feed.EXCLUDED));
  const models   = feed.modelNames();

  check("nothing is unclassified",
    models.filter((m) => !inFeed.has(m) && !excluded.has(m)), []);
  check("nothing is both",
    models.filter((m) => inFeed.has(m) && excluded.has(m)), []);
  check("every exclusion says why",
    Object.entries(feed.EXCLUDED).filter(([, why]) => !String(why ?? "").trim()).map(([m]) => m), []);
  check("every capability named by the feed exists",
    feed.FEED.filter((e) => !feed.required(e).every((k) => PERMS.isPermission(k)))
             .map((e) => `${e.collection} -> ${feed.required(e).join("|")}`), []);
  check("collection names are unique",
    feed.FEED.length, new Set(feed.FEED.map((e) => e.collection)).size);

  // ── And every model NAME is one Mongoose knows ──────────────────────────
  //
  // The boot check in syncFeed.js works from filenames, because it runs before
  // any model is registered. That leaves a hole: a file may register models
  // under names that are not its filename, and a feed entry naming something
  // unregistered does not throw. The endpoint answers
  // { error: "MODEL_NOT_REGISTERED" } for that collection and the client stores
  // nothing — so the collection is silently never mirrored, for ever.
  //
  // That is exactly what happened to attendance: Attendance.js registers
  // StudentAttendance and TeacherAttendance and nothing called "Attendance",
  // which the feed had asked for. Nothing failed; attendance simply never
  // arrived on any device.
  for (const file of fs.readdirSync(path.join(__dirname, "..", "src", "db", "models"))) {
    if (file.endsWith(".js")) require(path.join(__dirname, "..", "src", "db", "models", file));
  }
  const registered = new Set(Object.keys(mongoose.models));

  check("every model the feed names is registered with Mongoose",
    feed.FEED.filter((e) => !registered.has(e.model))
             .map((e) => `${e.collection} -> ${e.model}`), []);

  // Guards the guard: if loading the model files ever stopped working, the
  // check above would pass by comparing against an empty set.
  check("and the registry was actually populated", registered.size > 20, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- nothing carrying a credential is mirrored ---");

  // The specific one: a Notification's body is the RENDERED email, and for
  // adminWelcome and every password reset that includes the temporary password.
  check("Notification is excluded", excluded.has("Notification"), true);
  check("and the reason says why in those terms",
    /TEMPORARY PASSWORD/i.test(feed.EXCLUDED.Notification), true);
  check("the counters behind receipt numbers are excluded",
    excluded.has("Counter"), true);

  const users = feed.FEED.find((e) => e.model === "User");
  check("the staff directory omits the password hash",
    users.omit.includes("password"), true);
  // Worth naming separately: password is select:false on the schema and would
  // be omitted anyway, but tempPassword is NOT.
  check("and the temporary password, which the schema does not hide",
    users.omit.includes("tempPassword"), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the feed agrees with the roles about who may read what ---");

  // Each collection, requested by a role that lacks its capability, must be
  // refused. Computed from the same registry the routes read, so the two cannot
  // drift apart without this failing.
  const byRole = {};
  for (const role of [ROLES.SCHOOL_ADMIN, ROLES.BURSAR, ROLES.TEACHER, ROLES.STUDENT]) {
    byRole[role] = new Set(await effectiveFor(role, SCHOOL_A));
  }

  // Read off the capability registry rather than assumed. Two of these were
  // written the other way round first and the registry corrected them, which is
  // the point of computing from it: a teacher holds students.viewTaught and NOT
  // students.view, and a bursar does hold results.view.
  const expectations = [
    [ROLES.BURSAR,  "feeCharge",       true,  "the charges are their work"],
    [ROLES.BURSAR,  "feePayment",      true,  ""],
    [ROLES.BURSAR,  "payrollRun",      true,  "and the payroll they process"],
    [ROLES.BURSAR,  "salaryStructure", false, "but not what each colleague is paid"],
    [ROLES.BURSAR,  "user",            false, "nor the staff account directory"],
    [ROLES.BURSAR,  "subject",         false, "nor the academic structure"],
    [ROLES.BURSAR,  "homework",        false, ""],
    [ROLES.BURSAR,  "student",         true,  "the roster, because they bill it"],
    [ROLES.TEACHER, "student",         true,  "a teacher's pupils — via viewTaught"],
    [ROLES.TEACHER, "examScore",       true,  "and the marks they enter"],
    [ROLES.TEACHER, "studentAttendance", true, ""],
    // The staff register reads on attendance.view too — markStaff gates writing
    // it — so a bursar mirrors it, which matches what the route allows them.
    [ROLES.BURSAR,  "teacherAttendance", true, "the staff register reads on attendance.view"],
    [ROLES.TEACHER, "feeCharge",       false, "a teacher is not in the money"],
    [ROLES.TEACHER, "feePayment",      false, ""],
    [ROLES.TEACHER, "payrollRun",      false, ""],
    [ROLES.TEACHER, "user",            false, "nor the staff directory"],
    [ROLES.STUDENT, "student",         false, "a pupil mirrors nothing from here"],
    [ROLES.STUDENT, "feeCharge",       false, ""],
    [ROLES.STUDENT, "class",           false, ""],
  ];

  for (const [role, collection, allowed, note] of expectations) {
    const entry = feed.byCollection.get(collection);
    check(`${role} ${allowed ? "may" : "may NOT"} mirror ${collection}${note ? ` — ${note}` : ""}`,
      feed.satisfies(entry, byRole[role]), allowed);
  }

  // Recorded rather than asserted away. results.view includes the bursar in the
  // existing model, so this feed faithfully lets a bursar mirror every mark in
  // the school — which matters more offline than online, because offline it is a
  // permanent copy on the finance machine rather than a screen nobody visits.
  check("a bursar can mirror exam marks, which follows from results.view",
    feed.satisfies(feed.byCollection.get("examScore"), byRole[ROLES.BURSAR]), true);

  // And the gap in the other direction, written down in the feed itself.
  check("a teacher cannot mirror the class list, and that is documented",
    feed.KNOWN_GAPS.some((g) => g.who === "teacher" && g.collections.includes("class")), true);
  check("which the registry confirms rather than this suite asserting it",
    feed.satisfies(feed.byCollection.get("class"), byRole[ROLES.TEACHER]), false);

  // A student holds no feed capability at all, which is the honest summary of
  // the row above and worth stating once rather than per collection.
  check("a pupil can mirror no collection whatsoever",
    feed.FEED.filter((e) => byRole[ROLES.STUDENT].has(e.permission)).map((e) => e.collection),
    []);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and the endpoint enforces it, over HTTP ---");

  const Student   = require("../src/db/models/Student");
  const FeeCharge = require("../src/db/models/FeeCharge");

// Real accounts and real tokens, because /changes sits behind the real
  // authenticate middleware — a stub that stamps req.user before the router is
  // overwritten by it, which is what a first attempt at this did and why every
  // request came back 401.
  const User = require("../src/db/models/User");
  const jwt  = require("jsonwebtoken");

  const account = async (role, id) => {
    await User.collection.insertOne({
      _id: id, name: `Test ${role}`, email: `${id}@x.com`, role,
      schoolId: SCHOOL_A, isActive: true, password: "x", createdAt: new Date(), updatedAt: new Date(),
    });
    return jwt.sign({ id, role, schoolId: SCHOOL_A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  };

  const tokens = {
    bursar:   await account(ROLES.BURSAR,  "bursar-1"),
    teacher:  await account(ROLES.TEACHER, "teacher-1"),
    teacher2: await account(ROLES.TEACHER, "teacher-2"),
  };

  const app = express();
  app.use(express.json());
  app.use("/api/sync", require("../src/routes/sync.routes"));
  const server = app.listen(0);
  const port   = server.address().port;

  let token = tokens.bursar;
  const changes = async (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`http://127.0.0.1:${port}/api/sync/changes?${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: body ?? {} };
  };

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/sync/changes`);
  check("no token, no feed", unauthenticated.status, 401);
  // homework rather than examScore, since a bursar does hold results.view.
  const refusedRes = await changes({ collections: "homework,feeCharge" });
  check("the request succeeds", refusedRes.status, 200);
  check("the allowed collection is present",
    Object.keys(refusedRes.body.collections ?? {}), ["feeCharge"]);
  // Named, not omitted — so the desktop shows "not yours" rather than "empty".
  check("and the refused one is named, with the capability it needed",
    refusedRes.body.refused,
    [{ collection: "homework", reason: "FORBIDDEN", permission: "homework.view" }]);

  const unknown = await changes({ collections: "notAThing" });
  check("an unknown collection is reported rather than ignored",
    unknown.body.refused?.[0]?.reason, "UNKNOWN_COLLECTION");

  check("the server sends its own clock, so a wrong local one cannot mislead",
    typeof refusedRes.body.serverTime, "string");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- tenancy comes from the token, not the query string ---");

  await FeeCharge.collection.insertMany([
    { _id: "a1", schoolId: SCHOOL_A, studentId: "s1", amount: 1000, updatedAt: new Date("2026-01-01"), deletedAt: null },
    { _id: "b1", schoolId: SCHOOL_B, studentId: "s9", amount: 9999, updatedAt: new Date("2026-01-01"), deletedAt: null },
  ]);

  const crossTenant = await changes({ collections: "feeCharge", schoolId: SCHOOL_B });
  check("asking for another school's data returns this school's",
    crossTenant.body.collections.feeCharge.documents.map((d) => d._id), ["a1"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the cursor cannot skip or loop when timestamps collide ---");

  // THE ASSERTIONS THIS FILE EXISTS FOR.
  //
  // 700 charges sharing one millisecond, paged 100 at a time. A cursor of only
  // updatedAt either loses 600 of them or returns the first 100 for ever.
  await FeeCharge.deleteMany({});
  const collide = new Date("2026-03-01T09:00:00.000Z");
  await FeeCharge.collection.insertMany(
    Array.from({ length: 700 }, (_, i) => ({
      _id: `tie-${String(i).padStart(3, "0")}`,
      schoolId: SCHOOL_A, studentId: "s1", amount: 100,
      updatedAt: collide, deletedAt: null,
    }))
  );

  const seen = [];
  let cursor = null;
  let pages  = 0;

  while (pages < 20) {
    const params = { collections: "feeCharge", limit: "100" };
    if (cursor) params.cursors = JSON.stringify({ feeCharge: cursor });

    const page = await changes(params);
    const slice = page.body.collections.feeCharge;
    seen.push(...slice.documents.map((d) => d._id));
    pages++;

    // The cursor is kept BEFORE deciding whether to stop, and that ordering is
    // the point. Written the other way round first — break on !hasMore, then
    // advance — the last page never updated it, so the next sync re-fetched
    // those hundred rows and did so for ever. Harmless-looking, permanent, and
    // invisible except as a sync that is always slightly busy. The puller in
    // the desktop app has the same hazard.
    const previous = cursor;
    cursor = slice.cursor;

    if (!slice.hasMore) break;
    // A cursor that has not moved would loop for ever; the page ceiling above
    // stops the suite hanging, and this reports it instead.
    if (slice.cursor === previous) break;
  }

  check("it took the expected number of pages", pages, 7);
  check("every document arrived", seen.length, 700);
  check("each exactly once", new Set(seen).size, 700);
  check("and in a stable order",
    seen.slice(0, 3).concat(seen.slice(-1)),
    ["tie-000", "tie-001", "tie-002", "tie-699"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a cursor only advances over what has changed ---");

  const settled = await changes({
    collections: "feeCharge", limit: "100",
    cursors: JSON.stringify({ feeCharge: cursor }),
  });
  check("nothing new means an empty page", settled.body.collections.feeCharge.documents.length, 0);
  check("and no more to come", settled.body.collections.feeCharge.hasMore, false);
  // Keeping the client's cursor rather than answering null, which the client
  // would have to treat as "start again".
  check("and the cursor is preserved rather than reset",
    settled.body.collections.feeCharge.cursor, cursor);

  await FeeCharge.collection.insertOne({
    _id: "later-1", schoolId: SCHOOL_A, studentId: "s2", amount: 500,
    updatedAt: new Date("2026-04-01T00:00:00.000Z"), deletedAt: null,
  });

  const incremental = await changes({
    collections: "feeCharge", limit: "100",
    cursors: JSON.stringify({ feeCharge: cursor }),
  });
  check("a new document arrives on its own",
    incremental.body.collections.feeCharge.documents.map((d) => d._id), ["later-1"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- deletions reach the mirror ---");

  // Soft deletes are included deliberately. Filtering them would leave the
  // desktop showing a waived charge and chasing a family for it for ever.
  await FeeCharge.collection.updateOne(
    { _id: "later-1" },
    { $set: { deletedAt: new Date("2026-05-01T00:00:00.000Z"), updatedAt: new Date("2026-05-01T00:00:00.000Z") } }
  );

  const afterDelete = await changes({
    collections: "feeCharge", limit: "100",
    cursors: JSON.stringify({ feeCharge: incremental.body.collections.feeCharge.cursor }),
  });
  const deleted = afterDelete.body.collections.feeCharge.documents;
  check("the removal is delivered, not hidden", deleted.map((d) => d._id), ["later-1"]);
  check("carrying deletedAt so the client knows it is gone",
    Boolean(deleted[0]?.deletedAt), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a teacher mirrors only the pupils they teach ---");

  await Student.collection.insertMany([
    { _id: "p1", schoolId: SCHOOL_A, classId: "mine",   studentName: "Ada",     status: "approved", updatedAt: new Date("2026-01-01"), deletedAt: null },
    { _id: "p2", schoolId: SCHOOL_A, classId: "mine",   studentName: "Bertin",  status: "approved", updatedAt: new Date("2026-01-01"), deletedAt: null },
    { _id: "p3", schoolId: SCHOOL_A, classId: "theirs", studentName: "Chantal", status: "approved", updatedAt: new Date("2026-01-01"), deletedAt: null },
  ]);

  const TeacherAssignment = require("../src/db/models/TeacherAssignment");
  await TeacherAssignment.collection.insertOne({
    _id: "ta-1", schoolId: SCHOOL_A, teacherId: "teacher-1", classId: "mine",
    subjectId: "sub-1", updatedAt: new Date("2026-01-01"), deletedAt: null,
  });

  token = tokens.teacher;

  const forTeacher = await changes({ collections: "student" });
  check("only their own class's pupils",
    forTeacher.body.collections.student.documents.map((d) => d._id).sort(), ["p1", "p2"]);
  // The point of the scope: a whole-school mirror would carry every guardian's
  // name and phone number onto a teacher's machine.
  check("not the whole roster",
    forTeacher.body.collections.student.documents.some((d) => d._id === "p3"), false);

  token = tokens.teacher2;
  const forNobody = await changes({ collections: "student" });
  check("a teacher with no classes mirrors no pupils, rather than all of them",
    forNobody.body.collections.student.documents.length, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- limits are bounded ---");

  token = tokens.bursar;
  const huge = await changes({ collections: "feeCharge", limit: "999999" });
  check("an absurd limit is capped rather than honoured",
    huge.body.collections.feeCharge.documents.length <= 2000, true);

  const nonsense = await changes({ collections: "feeCharge", limit: "banana" });
  check("a non-numeric limit falls back to the default rather than erroring",
    nonsense.status, 200);

  // A malformed cursor must not be trusted into a query, and must not silently
  // mean "from the beginning" in a way that loses the client's place — it is
  // ignored, which restarts that collection safely.
  const badCursor = await changes({
    collections: "feeCharge", cursors: JSON.stringify({ feeCharge: "not-base64!!" }),
  });
  check("a malformed cursor is ignored, not obeyed", badCursor.status, 200);

  const halfCursor = Buffer.from(JSON.stringify({ at: "2026-01-01" })).toString("base64url");
  const { parseCursor } = require("../src/controllers/syncFeed.controller");
  // A cursor with only a timestamp IS the broken design; accepting one through
  // the query string would reintroduce it.
  check("a cursor missing its tie-breaker is rejected", parseCursor(halfCursor), null);

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
