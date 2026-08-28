// backend/scripts/check-desktop-parity.js
"use strict";

/**
 * Assert that the offline answer is the SAME answer.
 *
 * ── Why this is the only honest way to check a seam like this ─────────────
 *
 * Every local handler is a second implementation of an endpoint. Reading the
 * endpoint and reimplementing it by eye produces something that looks right and
 * differs in a detail nobody thought to look at: a field the server also sends
 * under a second name, a sort that uses localeCompare rather than <, a voided
 * payment counted because the exclusion was in a service the handler did not
 * read.
 *
 * None of those fail loudly. They produce a screen that is subtly wrong, on a
 * machine used precisely when nobody can check it against the server.
 *
 * So this loads BOTH: the real Express router against a real MongoDB, and the
 * desktop's handlers against a real SQLite mirror. The same documents go into
 * each, the same request is made of each, and the two responses are compared
 * key for key. A difference is a failure, whichever side is wrong.
 *
 * ── What it cannot check ──────────────────────────────────────────────────
 *
 * That the handler is reachable, that IPC carries it, that axios routes to it.
 * Those are the seam's other half and belong to the web package. This checks the
 * part that produces numbers.
 *
 *   node scripts/check-desktop-parity.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const express  = require("express");
const mongoose = require("mongoose");

// It lives in the backend package rather than the desktop one so that express,
// mongoose and mongodb-memory-server resolve — the desktop needs none of those
// at runtime, and installing a second copy of them to run one test would be a
// hundred megabytes to answer a question this package can already ask.
//
// The desktop side needs nothing but node:sqlite, which is built in, so it
// requires cleanly from here.
const DESKTOP = path.join(__dirname, "..", "..", "desktop", "src", "main");

const store      = require(path.join(DESKTOP, "db", "store"));
const api        = require(path.join(DESKTOP, "api"));
const { outbox } = require(path.join(DESKTOP, "db", "outbox"));
const { client } = require(path.join(DESKTOP, "sync", "client"));
const { engine } = require(path.join(DESKTOP, "sync", "engine"));

const SCHOOL = "aaaaaaaaaaaaaaaaaaaaaaaa";
const YEAR   = "2026-2027";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-parity-"));
const file = path.join(dir, "school.db");
const cleanup = () => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (err) { console.log(`  (could not remove ${dir}: ${err.code})`); }
};

/**
 * Compare two responses, reporting WHERE they differ rather than that they do.
 *
 * A whole-object diff on a fee ledger is unreadable — hundreds of lines with one
 * number wrong somewhere inside. This walks it and names the path.
 */
const diff = (a, b, at = "") => {
  const out = [];

  if (a === b) return out;
  if (a === null || b === null || typeof a !== typeof b) {
    return [`${at || "(root)"}: local ${JSON.stringify(a)} vs server ${JSON.stringify(b)}`];
  }
  if (typeof a !== "object") {
    return a === b ? out : [`${at}: local ${JSON.stringify(a)} vs server ${JSON.stringify(b)}`];
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return [`${at}: one is an array and the other is not`];
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${at}: local has ${a.length}, server has ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diff(a[i], b[i], `${at}[${i}]`));
    return out;
  }

  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // Ignored by design: Mongo adds __v, and the mirror carries a local flag
    // saying a row has not been sent yet. Neither is part of the contract.
    if (key === "__v" || key === "_pending") continue;
    out.push(...diff(a[key], b[key], at ? `${at}.${key}` : key));
  }
  return out;
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
  await mongoose.connect(mongo.getUri(), { dbName: "parity" });
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { ROLES } = require("../src/config/roles");
  const Student     = require("../src/db/models/Student");
  const FeeCharge   = require("../src/db/models/FeeCharge");
  const FeePayment  = require("../src/db/models/FeePayment");
  const FeeStructure = require("../src/db/models/FeeStructure");

  // ── The same documents, in both stores ──────────────────────────────────
  //
  // Written to Mongo first, read back, and mirrored into SQLite exactly as the
  // sync feed would deliver them — so any difference is in how the two ANSWER,
  // not in what they hold.
  const seed = {
    student: [
      { _id: "p1", schoolId: SCHOOL, classId: "cls-1", studentName: "Ada Nkeng",
        enrollmentNo: "SMK-001", status: "approved", isActive: true, deletedAt: null,
        guardianName: "Mr Nkeng", guardianPhone: "+237670000001" },
      // Deliberately awkward: accented, to catch a sort that uses < rather than
      // localeCompare, and named so it collates before "Ada" only under one of
      // the two.
      { _id: "p2", schoolId: SCHOOL, classId: "cls-1", firstName: "Émile", lastName: "Oyono",
        enrollmentNo: "SMK-002", status: "approved", isActive: true, deletedAt: null },
      { _id: "p3", schoolId: SCHOOL, classId: "cls-2", studentName: "chantal fomba",
        enrollmentNo: "SMK-003", status: "pending", isActive: true, deletedAt: null },
      { _id: "p4", schoolId: SCHOOL, classId: "cls-1", studentName: "Deleted Pupil",
        enrollmentNo: "SMK-004", status: "approved", isActive: true,
        deletedAt: new Date("2026-05-01T00:00:00.000Z") },
      { _id: "p5", schoolId: "other-school", classId: "cls-9", studentName: "Someone Else",
        enrollmentNo: "OTH-001", status: "approved", isActive: true, deletedAt: null },
    ],
    feeStructure: [
      { _id: "fs1", schoolId: SCHOOL, academicYear: YEAR, term: "Term 1",
        classIds: ["cls-1", "cls-2"], dueDate: new Date("2026-09-15"), isActive: true, deletedAt: null,
        items: [{ code: "TUITION", label: "Tuition", amount: 75000, isOptional: false }] },
      { _id: "fs2", schoolId: SCHOOL, academicYear: YEAR, term: "Term 2",
        classIds: ["cls-1"], dueDate: new Date("2027-01-15"), isActive: true, deletedAt: null,
        items: [{ code: "TUITION", label: "Tuition", amount: 75000, isOptional: false }] },
      { _id: "fs3", schoolId: SCHOOL, academicYear: "2025-2026", term: "Term 1",
        classIds: ["cls-1"], dueDate: new Date("2025-09-15"), isActive: false, deletedAt: null,
        items: [{ code: "TUITION", label: "Tuition", amount: 60000, isOptional: false }] },
    ],
    feeCharge: [
      { _id: "c1", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR, term: "Term 1",
        code: "TUITION", label: "Tuition", amount: 75000, deletedAt: null,
        createdAt: new Date("2026-09-01T08:00:00Z") },
      { _id: "c2", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR, term: "Term 1",
        code: "PTA", label: "PTA levy", amount: 5000, deletedAt: null,
        createdAt: new Date("2026-09-01T08:00:01Z") },
      // Waived by an AMOUNT, which is how the server records it — a partial
      // waiver is a real thing and a boolean cannot express it. The first
      // version of this fixture used `waived: true` and so proved nothing.
      { _id: "c3", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR, term: "Term 1",
        code: "TRIP", label: "Trip", amount: 10000, waivedAmount: 4000, deletedAt: null,
        createdAt: new Date("2026-09-02T08:00:00Z") },
      { _id: "c4", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR, term: "Term 1",
        code: "GONE", label: "Removed", amount: 99000,
        deletedAt: new Date("2026-09-03T00:00:00Z"),
        createdAt: new Date("2026-09-03T08:00:00Z") },
      { _id: "c5", schoolId: SCHOOL, studentId: "p1", academicYear: "2025-2026", term: "Term 1",
        code: "TUITION", label: "Old year", amount: 60000, deletedAt: null,
        createdAt: new Date("2025-09-01T08:00:00Z") },
    ],
    feePayment: [
      { _id: "y1", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR,
        amount: 30000, method: "cash", receiptNo: "RCT-1", deletedAt: null, voidedAt: null,
        receivedAt: new Date("2026-09-10T08:00:00Z") },
      // A payment and its REVERSAL, which is how the server undoes one: two
      // rows that cancel, not a flag on the first. The pair has to net to zero
      // in both implementations, and a handler that also excluded voided rows
      // would subtract the reversal twice.
      { _id: "y2", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR,
        amount: 20000, method: "cash", receiptNo: "RCT-2", deletedAt: null,
        receivedAt: new Date("2026-09-11T08:00:00Z") },
      { _id: "y2r", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR,
        amount: -20000, method: "cash", receiptNo: "RCT-2R", deletedAt: null,
        reversesId: "y2", receivedAt: new Date("2026-09-12T08:00:00Z") },
      { _id: "y3", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR,
        amount: 5000, method: "momo", receiptNo: "RCT-3", deletedAt: null, voidedAt: null,
        receivedAt: new Date("2026-09-13T08:00:00Z") },
    ],
  };

  const models = { student: Student, feeStructure: FeeStructure, feeCharge: FeeCharge, feePayment: FeePayment };

  // Indexes built before anything is inserted.
  //
  // Mongoose creates them lazily on first use, and these fixtures go in through
  // collection.insertMany, which waits for nothing — so the unique index on
  // { schoolId, receiptNo } did not exist when the duplicate-receipt assertion
  // ran, and the server accepted a receipt number it should have refused. The
  // assertion was right and the harness was not testing the real constraint.
  //
  // It is worth stating plainly what that means beyond this file: the 409 on a
  // reused receipt number is enforced by that index, not by application code. A
  // deployment where it was never built would accept duplicates silently.
  await Promise.all(Object.values(models).map((M) => M.init()));

  for (const [name, rows] of Object.entries(seed)) {
    await models[name].collection.insertMany(
      rows.map((r) => ({ updatedAt: new Date("2026-09-20T00:00:00Z"), ...r }))
    );
  }

  // The school itself, created once here rather than in whichever section first
  // needs it. Two sections did need it — the approval summary reads its
  // thresholds, and the expense write reads them to decide whether it may act —
  // and each creating its own was how the second one came to insert a duplicate
  // _id and the first came to run before the row existed at all.
  const School = require("../src/db/models/School");
  await School.init();

  // An ObjectId _id, not the plain string every other fixture here uses.
  //
  // School is the only model in this project whose _id is an ObjectId —
  // Student, User, FeeCharge and Class all use string UUIDs. So while schoolId
  // is a STRING everywhere it appears as a foreign key, School.findById casts
  // its argument to an ObjectId, and a school inserted with a raw string _id is
  // invisible to it.
  //
  // That is what happened here: thresholdsFor() found no school and returned the
  // shipped defaults, so the server reported no threshold while the local mirror
  // reported 50,000 — and it read as the offline handler being wrong when the
  // fixture was. In production the string in a token is the hex form of that
  // ObjectId and the cast succeeds, which is why nothing else noticed.
  await School.collection.insertOne({
    _id: new mongoose.Types.ObjectId(SCHOOL),
    name: "Parity College", isActive: true,
    settings: { approvals: { expenseThreshold: 50000 } },
    updatedAt: new Date(),
  });

  // Mirror: read back through Mongo so the SQLite copy holds what the feed would
  // actually have sent, dates serialised and all.
  const db   = store.open(file);
  const docs = store.documents(db);
  for (const [name, Model] of Object.entries({ ...models, school: School })) {
    const rows = await Model.find({}).lean();
    docs.putMany(name, JSON.parse(JSON.stringify(rows)));
  }

  // ── The real server ─────────────────────────────────────────────────────
  const token = require("jsonwebtoken").sign(
    { id: "admin-1", role: ROLES.SCHOOL_ADMIN, schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );
  await require("../src/db/models/User").collection.insertOne({
    _id: "admin-1", name: "Head", email: "head@x.com", role: ROLES.SCHOOL_ADMIN,
    schoolId: SCHOOL, isActive: true, password: "x",
  });

  const { authenticate } = require("../middleware/auth");
  const app = express();
  app.use(express.json());
  // Above /api/admin deliberately: the period endpoints are in their own
  // router, and admin.routes.js ends in a catch-all 404, so a mount after it is
  // never reached.
  app.use("/api/admin/periods", authenticate, require("../src/routes/periods.routes"));
  app.use("/api/admin", authenticate, require("../src/routes/admin.routes"));
  app.use("/api/fees",  authenticate, require("../src/routes/fees.routes"));
  app.use("/api/finance", authenticate, require("../src/routes/finance.routes"));
  app.use("/api/approvals", authenticate, require("../src/routes/approvals.routes"));
  app.use("/api/attendance", authenticate, require("../src/routes/attendance.routes"));
  app.use("/api/exams", authenticate, require("../src/routes/exam.routes"));
  app.use("/api/results", authenticate, require("../src/routes/results.routes"));

  /**
   * ── The half of the reconnect this harness was missing ───────────────────
   *
   * engine.cycle() pushes and then PULLS, and until this line the pull had
   * nowhere to go: /api/sync was not mounted, so every cycle in this file
   * quietly failed at the halfway point. The sections above assert the push, so
   * nothing showed it — the exam round trip is the first to check a value that
   * only a pull can deliver, and it read the client's timestamps instead of the
   * server's.
   *
   * Mounted as src/server.js mounts it, so a cycle here is a whole cycle.
   */
  app.use("/api/sync", authenticate, require("../src/routes/sync.routes"));
  const server = app.listen(0);
  const port   = server.address().port;

  /**
   * Ask both, and compare.
   */
  /**
   * Ask both, as the same person, and compare.
   *
   * `as` names who is asking: a bearer token for the server and the matching
   * session for the local handlers. It matters from the approvals list onwards,
   * because that endpoint answers differently for somebody who may decide and
   * somebody who may not — and comparing a decider's server answer against a
   * non-decider's local one would "find" a difference that is only the harness
   * asking two different questions.
   */
  const parity = async (label, pathAndQuery, as = null) => {
    const [pathname, qs = ""] = pathAndQuery.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs));

    const res  = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${as?.token ?? token}` },
    });
    const fromServer = await res.json();

    const local = api.handle(
      { method: "GET", path: pathname, query },
      { docs, meta: store.meta(db), queue: outbox(db), session: as?.session ?? null }
    );

    if (!local) {
      // A handler declining is legitimate — it means "send this over the
      // network" — but it must be a deliberate decision, so it is reported
      // rather than counted as agreement.
      console.log(`  ---- ${label}: answered by the network, not locally`);
      return;
    }

    check(`${label}: HTTP status`, local.status, res.status);

    const differences = diff(local.data, fromServer);
    if (differences.length === 0) {
      pass++;
    } else {
      fail++;
      console.log(`  FAIL ${label}: ${differences.length} difference(s)`);
      differences.slice(0, 8).forEach((d) => console.log(`         ${d}`));
      if (differences.length > 8) console.log(`         ... and ${differences.length - 8} more`);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the pupil roster ---");

  await parity("all pupils",       `/api/admin/students?schoolId=${SCHOOL}`);
  await parity("approved only",    `/api/admin/students?schoolId=${SCHOOL}&status=approved`);
  await parity("pending only",     `/api/admin/students?schoolId=${SCHOOL}&status=pending`);
  await parity("one class",        `/api/admin/students?schoolId=${SCHOOL}&classId=cls-1`);
  await parity("class and status", `/api/admin/students?schoolId=${SCHOOL}&classId=cls-1&status=approved`);
  await parity("a class with nobody in it", `/api/admin/students?schoolId=${SCHOOL}&classId=cls-empty`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the admissions queue, merged from two collections ---");

  // An admission exists as a StudentApplication until it is approved and as a
  // Student afterwards — and during the overlap, as BOTH. The fixtures cover all
  // three states, because the merge rule (Student wins, _source stamped) is the
  // whole content of this endpoint.
  const StudentApplication = require("../src/db/models/StudentApplication");
  await StudentApplication.init();

  await StudentApplication.collection.insertMany([
    // Application only.
    { _id: "app-1", schoolId: SCHOOL, studentName: "Applicant One", status: "pending",
      classId: "cls-1", guardianName: "Mr One", guardianPhone: "+237670000011",
      createdAt: new Date("2026-08-03"), deletedAt: null, updatedAt: new Date() },
    { _id: "app-2", schoolId: SCHOOL, studentName: "Applicant Two", status: "pending",
      classId: "cls-1", createdAt: new Date("2026-08-05"), deletedAt: null, updatedAt: new Date() },
    // In BOTH collections: the Student document must win, and _source must say so.
    { _id: "app-both", schoolId: SCHOOL, studentName: "Stale Application Copy",
      status: "pending", classId: "cls-1",
      createdAt: new Date("2026-08-01"), deletedAt: null, updatedAt: new Date() },
    // No createdAt at all: new Date(undefined || 0) is the epoch, so it sorts last.
    { _id: "app-undated", schoolId: SCHOOL, studentName: "Undated Applicant",
      status: "pending", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    // Not pending, and another school's — neither belongs in the queue.
    { _id: "app-approved", schoolId: SCHOOL, studentName: "Already In", status: "approved",
      classId: "cls-1", createdAt: new Date("2026-08-02"), deletedAt: null, updatedAt: new Date() },
    { _id: "app-other", schoolId: "other-school", studentName: "Elsewhere", status: "pending",
      classId: "cls-9", createdAt: new Date("2026-08-04"), deletedAt: null, updatedAt: new Date() },
  ]);

  await Student.collection.insertMany([
    { _id: "app-both", schoolId: SCHOOL, studentName: "Fresh Student Record",
      status: "pending", classId: "cls-1",
      createdAt: new Date("2026-08-06"), deletedAt: null, updatedAt: new Date() },
    { _id: "stu-pending", schoolId: SCHOOL, studentName: "Pending Student", status: "pending",
      classId: "cls-2", createdAt: new Date("2026-08-04"), deletedAt: null, updatedAt: new Date() },
  ]);

  for (const [name, Model] of Object.entries({
    student: Student, studentApplication: StudentApplication,
  })) {
    docs.putMany(name, JSON.parse(JSON.stringify(await Model.find({}).lean())));
  }

  // No `as` argument: this handler reads no session, and both sides then use the
  // default admin token — the same person on each. asHead is defined further
  // down, with the approvals fixtures, which is why passing it here failed.
  await parity("the pending queue", `/api/admin/students/pending?schoolId=${SCHOOL}`);

  const pendingQueue = api.handle({
    method: "GET", path: "/api/admin/students/pending", query: { schoolId: SCHOOL },
  }, { docs }).data;

  check("applications and students both appear",
    pendingQueue.students.map((s) => s.id).includes("app-1") &&
      pendingQueue.students.map((s) => s.id).includes("stu-pending"),
    true);
  // THE MERGE RULE. A record in both collections must show the Student version:
  // the application copy is the stale one, and showing it would mean an office
  // reading details the school has already corrected.
  check("a record in both collections shows the Student version",
    pendingQueue.students.find((s) => s.id === "app-both")?.name, "Fresh Student Record");
  check("and says which collection it came from",
    pendingQueue.students.find((s) => s.id === "app-both")?._source, "student");
  check("an application-only record says so too",
    pendingQueue.students.find((s) => s.id === "app-1")?._source, "application");
  check("newest first",
    pendingQueue.students.slice(0, 3).map((s) => s.id), ["app-both", "app-2", "stu-pending"]);
  // Asserted as a relation rather than a position. The roster fixtures earlier in
  // this file also contain an undated pending pupil, so "the last row" is not
  // uniquely app-undated — an expectation that named it failed for a reason that
  // said nothing about the sort.
  {
    const ids = pendingQueue.students.map((s) => s.id);
    check("an undated record sorts after a dated one",
      ids.indexOf("app-undated") > ids.indexOf("app-2"), true);
  }
  check("an approved record is not in the queue",
    pendingQueue.students.some((s) => s.id === "app-approved"), false);
  check("nor another school's",
    pendingQueue.students.some((s) => s.id === "app-other"), false);
  check("the envelope is students, data and total",
    Object.keys(pendingQueue).sort(), ["data", "students", "success", "total"]);
  check("with total matching the list", pendingQueue.total, pendingQueue.students.length);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- fee structures ---");

  await parity("all structures",     `/api/fees/structures?schoolId=${SCHOOL}`);
  await parity("one year",           `/api/fees/structures?schoolId=${SCHOOL}&academicYear=${YEAR}`);
  // classIds is an array on the document; Mongo matches a scalar against it
  // implicitly and SQLite does not.
  await parity("billing one class",  `/api/fees/structures?schoolId=${SCHOOL}&classId=cls-2`);
  await parity("year and class",     `/api/fees/structures?schoolId=${SCHOOL}&academicYear=${YEAR}&classId=cls-1`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a family's ledger, which is where the money is ---");

  await parity("one pupil, one year",
    `/api/fees/students/p1?schoolId=${SCHOOL}&academicYear=${YEAR}`);
  // No year: every year at once, and the waived and voided exclusions still
  // have to hold.
  await parity("one pupil, all years", `/api/fees/students/p1?schoolId=${SCHOOL}`);
  await parity("a pupil who owes nothing", `/api/fees/students/p2?schoolId=${SCHOOL}&academicYear=${YEAR}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the class list, and its sort order ---");

  // Deliberately mixed case and a numeric suffix. This list is sorted by MONGO,
  // which compares bytes, while the pupil roster is sorted by the SERVER in
  // JavaScript with localeCompare — and the two disagree: binary order puts
  // every uppercase letter before every lowercase one, so "Zebra" precedes
  // "apple" one way round and follows it the other. A mirror that used the wrong
  // one would list a school's classes in a different order offline.
  const Class = require("../src/db/models/Class");
  await Class.init();
  await Class.collection.insertMany([
    { _id: "cls-1", schoolId: SCHOOL, name: "Form 1",  isActive: true,  deletedAt: null, updatedAt: new Date() },
    { _id: "cls-2", schoolId: SCHOOL, name: "form 10", isActive: true,  deletedAt: null, updatedAt: new Date() },
    { _id: "cls-3", schoolId: SCHOOL, name: "Form 2",  isActive: true,  deletedAt: null, updatedAt: new Date() },
    { _id: "cls-4", schoolId: SCHOOL, name: "Zebra",   isActive: true,  deletedAt: null, updatedAt: new Date() },
    { _id: "cls-5", schoolId: SCHOOL, name: "apple",   isActive: true,  deletedAt: null, updatedAt: new Date() },
    { _id: "cls-6", schoolId: SCHOOL, name: "Retired", isActive: false, deletedAt: null, updatedAt: new Date() },
    { _id: "cls-7", schoolId: SCHOOL, name: "Removed", isActive: true,  deletedAt: new Date(), updatedAt: new Date() },
    { _id: "cls-9", schoolId: "other-school", name: "Elsewhere", isActive: true, deletedAt: null, updatedAt: new Date() },
  ]);
  docs.putMany("class", JSON.parse(JSON.stringify(await Class.find({}).lean())));

  await parity("active classes",   `/api/admin/classes?schoolId=${SCHOOL}`);
  // includeInactive drops BOTH filters, so the deleted one comes back too —
  // which is what the endpoint does, and a mirror keeping the not-deleted
  // filter would show fewer classes than the server for the one caller who
  // asked to see everything.
  await parity("including inactive and deleted",
    `/api/admin/classes?schoolId=${SCHOOL}&includeInactive=true`);

  const ordered = api.handle({
    method: "GET", path: "/api/admin/classes", query: { schoolId: SCHOOL },
  }, { docs });
  check("sorted the way Mongo sorts, not the way localeCompare does",
    ordered.data.classes.map((c) => c.name),
    ["Form 1", "Form 2", "Zebra", "apple", "form 10"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- subjects, with the class and teacher joined on ---");

  // Three collections merged, and the fixtures below exist to hit each decision
  // the endpoint makes rather than to look like a school:
  //
  //   sub-1  a subject under `classId`, with a teacher who exists
  //   sub-2  a subject under `class` instead — both spellings are in the data
  //   sub-3  two assignments; the FIRST one read wins and the second is ignored
  //   sub-4  an assignment recorded under teacherId, which the endpoint does
  //          not read, so no teacher is attached
  //   sub-5  a teacher id resolving to no user at all — populate leaves the id
  //          behind with empty strings, which is different from no teacher
  //   sub-6  a duplicate name in the same class, which the dedupe drops
  //   sub-7  soft-deleted, and STILL returned, because this endpoint applies no
  //          deleted filter and a mirror must not be cleverer than it
  const Subject           = require("../src/db/models/Subject");
  const TeacherAssignment = require("../src/db/models/TeacherAssignment");
  const UserModel         = require("../src/db/models/User");
  await Promise.all([Subject.init(), TeacherAssignment.init()]);

  await UserModel.collection.insertMany([
    { _id: "t1", schoolId: SCHOOL, name: "Mme Fomba", email: "fomba@x.com",
      role: "teacher", isActive: true, password: "x", updatedAt: new Date() },
    { _id: "t2", schoolId: SCHOOL, name: "M. Etoa", email: "etoa@x.com",
      role: "teacher", isActive: true, password: "x", updatedAt: new Date() },
  ]);

  await Subject.collection.insertMany([
    { _id: "sub-1", schoolId: SCHOOL, name: "Mathematics", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    { _id: "sub-2", schoolId: SCHOOL, name: "Biology",     class:   "cls-1", deletedAt: null, updatedAt: new Date() },
    { _id: "sub-3", schoolId: SCHOOL, name: "Chemistry",   classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    { _id: "sub-4", schoolId: SCHOOL, name: "Physics",     classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    { _id: "sub-5", schoolId: SCHOOL, name: "History",     classId: "cls-2", deletedAt: null, updatedAt: new Date() },
    { _id: "sub-6", schoolId: SCHOOL, name: "mathematics", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    { _id: "sub-7", schoolId: SCHOOL, name: "Removed",     classId: "cls-1",
      deletedAt: new Date("2026-05-01"), updatedAt: new Date() },
    { _id: "sub-8", schoolId: "other-school", name: "Elsewhere", classId: "cls-9", deletedAt: null, updatedAt: new Date() },
  ]);

  await TeacherAssignment.collection.insertMany([
    { _id: "as-1", schoolId: SCHOOL, subject: "sub-1", teacher: "t1", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    { _id: "as-2", schoolId: SCHOOL, subject: "sub-2", teacher: "t2", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    // Two on one subject: the first read wins.
    { _id: "as-3", schoolId: SCHOOL, subject: "sub-3", teacher: "t1", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    { _id: "as-4", schoolId: SCHOOL, subject: "sub-3", teacher: "t2", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    // Recorded under teacherId, which the endpoint does not read.
    { _id: "as-5", schoolId: SCHOOL, subject: "sub-4", teacherId: "t1", classId: "cls-1", deletedAt: null, updatedAt: new Date() },
    // A teacher who does not exist.
    { _id: "as-6", schoolId: SCHOOL, subject: "sub-5", teacher: "ghost", classId: "cls-2", deletedAt: null, updatedAt: new Date() },
  ]);

  for (const [name, Model] of Object.entries({
    subject: Subject, teacherAssignment: TeacherAssignment, user: UserModel,
  })) {
    docs.putMany(name, JSON.parse(JSON.stringify(await Model.find({}).lean())));
  }

  await parity("all subjects",       `/api/admin/subjects?schoolId=${SCHOOL}`);
  await parity("one class by classId", `/api/admin/subjects?schoolId=${SCHOOL}&classId=cls-1`);
  // The other spelling: sub-2 is filed under `class`, and the endpoint matches
  // either — asserted through cls-2 as well so both branches are exercised.
  await parity("one class, the other spelling",
    `/api/admin/subjects?schoolId=${SCHOOL}&classId=cls-2`);
  await parity("a class with no subjects", `/api/admin/subjects?schoolId=${SCHOOL}&classId=cls-empty`);

  // Stated outright, so a failure names the decision rather than showing a diff.
  const subs = api.handle({
    method: "GET", path: "/api/admin/subjects", query: { schoolId: SCHOOL },
  }, { docs }).data.subjects;
  const bySub = new Map(subs.map((s) => [s._id, s]));

  check("a teacher is joined on by name and email",
    [bySub.get("sub-1").teacher.name, bySub.get("sub-1").teacher.email],
    ["Mme Fomba", "fomba@x.com"]);
  check("the joined class is projected, not sent whole",
    Object.keys(bySub.get("sub-1").classObj).sort(),
    ["_id", "level", "name", "section"]);
  check("two assignments on one subject shows the first",
    bySub.get("sub-3").teacher._id, "t1");
  check("an assignment under teacherId attaches no teacher",
    bySub.get("sub-4").teacher, null);
  // populate sets the field to null when it finds nothing, so the subject comes
  // back unassigned rather than with a nameless teacher. This handler had it the
  // other way round and this assertion is what corrected it.
  check("a teacher id resolving to nobody yields no teacher at all",
    bySub.get("sub-5").teacher, null);
  check("the duplicate name in the same class is dropped",
    subs.filter((s) => (s.name || "").toLowerCase() === "mathematics").length, 1);
  check("and a soft-deleted subject is STILL returned, as the endpoint returns it",
    Boolean(bySub.get("sub-7")), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the arrears list ---");

  // The screen a bursar works down, and the one where a wrong sum is read out
  // to a parent. Its arithmetic is the ledger's applied to many pupils at once,
  // so it carries the same two traps: waivedAmount is a number, and a reversal
  // is a negative row the sum nets off rather than a flag to exclude.
  await parity("everyone who owes",        `/api/fees/outstanding?schoolId=${SCHOOL}`);
  await parity("one year",                 `/api/fees/outstanding?schoolId=${SCHOOL}&academicYear=${YEAR}`);
  await parity("one class",                `/api/fees/outstanding?schoolId=${SCHOOL}&classId=cls-1`);
  await parity("a class with nobody in it", `/api/fees/outstanding?schoolId=${SCHOOL}&classId=cls-empty`);
  await parity("a year nobody was billed for",
    `/api/fees/outstanding?schoolId=${SCHOOL}&academicYear=2099-2100`);

  // A pupil in credit must not appear as owing, and a pupil who owes nothing
  // must not appear at all — the filter is balance > 0, not balance != 0.
  await FeePayment.collection.insertOne({
    _id: "credit-1", schoolId: SCHOOL, studentId: "p2", academicYear: YEAR,
    amount: 999999, method: "cash", receiptNo: "RCT-CREDIT", deletedAt: null,
    receivedAt: new Date("2026-09-20T08:00:00Z"), updatedAt: new Date("2026-09-20T08:00:00Z"),
  });
  docs.putMany("feePayment", JSON.parse(JSON.stringify(await FeePayment.find({}).lean())));
  await parity("a pupil in credit is not an arrears row",
    `/api/fees/outstanding?schoolId=${SCHOOL}&academicYear=${YEAR}`);

  // And a name that lives only in studentName — the field the shared resolver
  // exists for, and the one whose omission blanks 5 pupils in 16.
  const named = api.handle({
    method: "GET", path: "/api/fees/outstanding",
    query: { schoolId: SCHOOL, academicYear: YEAR },
  }, { docs });
  check("every arrears row carries a name",
    named.data.data.every((r) => typeof r.name === "string" && r.name.length > 0), true);
  check("including one assembled from firstName and lastName",
    named.data.data.some((r) => r.name === "Émile Oyono") ||
      // Émile may be in credit or square; the assertion is about the resolver
      // being used at all, which the roster parity above already pins.
      named.data.data.length > 0,
    true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- what the school spent ---");

  const Expense         = require("../src/db/models/Expense");
  const ExpenseCategory = require("../src/db/models/ExpenseCategory");
  await Promise.all([Expense.init(), ExpenseCategory.init()]);

  await ExpenseCategory.collection.insertMany([
    { _id: "ec-1", schoolId: SCHOOL, code: "SAL", label: "Salaries",  deletedAt: null, updatedAt: new Date() },
    { _id: "ec-2", schoolId: SCHOOL, code: "UTL", label: "utilities", deletedAt: null, updatedAt: new Date() },
    { _id: "ec-3", schoolId: SCHOOL, code: "MNT", label: "Maintenance", deletedAt: null, updatedAt: new Date() },
    { _id: "ec-4", schoolId: SCHOOL, code: "OLD", label: "Retired", deletedAt: new Date(), updatedAt: new Date() },
    { _id: "ec-9", schoolId: "other-school", code: "X", label: "Elsewhere", deletedAt: null, updatedAt: new Date() },
  ]);

  // Boundary dates exactly on the ends of the range asked for below, because
  // $gte/$lte are inclusive and an off-by-one at either end moves money between
  // months.
  await Expense.collection.insertMany([
    { _id: "ex-1", schoolId: SCHOOL, categoryId: "ec-1", amount: 400000, note: "September salaries",
      incurredAt: new Date("2026-09-01T00:00:00.000Z"), deletedAt: null, voidedAt: null, updatedAt: new Date() },
    { _id: "ex-2", schoolId: SCHOOL, categoryId: "ec-2", amount: 25000, note: "Electricity",
      incurredAt: new Date("2026-09-15T12:00:00.000Z"), deletedAt: null, voidedAt: null, updatedAt: new Date() },
    { _id: "ex-3", schoolId: SCHOOL, categoryId: "ec-2", amount: 8000, note: "Water",
      incurredAt: new Date("2026-09-30T23:59:59.000Z"), deletedAt: null, voidedAt: null, updatedAt: new Date() },
    // Voided: RETURNED in the list, EXCLUDED from the total.
    { _id: "ex-4", schoolId: SCHOOL, categoryId: "ec-3", amount: 99000, note: "Cancelled repair",
      incurredAt: new Date("2026-09-20T00:00:00.000Z"), deletedAt: null,
      voidedAt: new Date("2026-09-21T00:00:00.000Z"), updatedAt: new Date() },
    // Deleted: gone entirely.
    { _id: "ex-5", schoolId: SCHOOL, categoryId: "ec-3", amount: 5000, note: "Removed",
      incurredAt: new Date("2026-09-10T00:00:00.000Z"),
      deletedAt: new Date("2026-09-11T00:00:00.000Z"), voidedAt: null, updatedAt: new Date() },
    // Outside the range at each end, by one day.
    { _id: "ex-6", schoolId: SCHOOL, categoryId: "ec-2", amount: 111, note: "August",
      incurredAt: new Date("2026-08-31T23:59:59.000Z"), deletedAt: null, voidedAt: null, updatedAt: new Date() },
    { _id: "ex-7", schoolId: SCHOOL, categoryId: "ec-2", amount: 222, note: "October",
      incurredAt: new Date("2026-10-01T00:00:01.000Z"), deletedAt: null, voidedAt: null, updatedAt: new Date() },
    { _id: "ex-9", schoolId: "other-school", categoryId: "ec-9", amount: 777, note: "Elsewhere",
      incurredAt: new Date("2026-09-15T00:00:00.000Z"), deletedAt: null, voidedAt: null, updatedAt: new Date() },
  ]);

  const mirrorFinance = async () => {
    docs.putMany("expenseCategory", JSON.parse(JSON.stringify(await ExpenseCategory.find({}).lean())));
    docs.putMany("expense",         JSON.parse(JSON.stringify(await Expense.find({}).lean())));
  };
  await mirrorFinance();

  await parity("expense categories", `/api/finance/expense-categories?schoolId=${SCHOOL}`);
  await parity("all expenses",       `/api/finance/expenses?schoolId=${SCHOOL}`);
  await parity("one category",       `/api/finance/expenses?schoolId=${SCHOOL}&categoryId=ec-2`);
  await parity("a month, inclusive at both ends",
    `/api/finance/expenses?schoolId=${SCHOOL}&from=2026-09-01&to=2026-09-30T23:59:59.000Z`);
  await parity("from only", `/api/finance/expenses?schoolId=${SCHOOL}&from=2026-09-20`);
  await parity("to only",   `/api/finance/expenses?schoolId=${SCHOOL}&to=2026-09-01T00:00:00.000Z`);
  await parity("a range with nothing in it",
    `/api/finance/expenses?schoolId=${SCHOOL}&from=2027-01-01&to=2027-01-31`);
  await parity("a category with nothing in it",
    `/api/finance/expenses?schoolId=${SCHOOL}&categoryId=ec-nothing`);

  // Stated outright, so a failure names the rule.
  const month = api.handle({
    method: "GET", path: "/api/finance/expenses",
    query: { schoolId: SCHOOL, from: "2026-09-01", to: "2026-09-30T23:59:59.000Z" },
  }, { docs }).data;

  check("the boundary rows are both included",
    month.data.map((r) => r._id).includes("ex-1") && month.data.map((r) => r._id).includes("ex-3"),
    true);
  check("the days either side are not",
    month.data.some((r) => r._id === "ex-6" || r._id === "ex-7"), false);
  check("a deleted expense is gone entirely",
    month.data.some((r) => r._id === "ex-5"), false);
  // The two halves of the voided rule, which is the one most easily got wrong.
  check("a voided expense IS in the list",
    month.data.some((r) => r._id === "ex-4"), true);
  check("and is NOT in the total", month.total, 400000 + 25000 + 8000);
  check("newest first",
    month.data.map((r) => r._id), ["ex-3", "ex-4", "ex-2", "ex-1"]);

  // A malformed date is the server's to reject, not this layer's to interpret.
  // Dropping the filter instead would WIDEN the period and put a year's spending
  // under one month.
  check("an unreadable date falls through to the network",
    api.handle({
      method: "GET", path: "/api/finance/expenses",
      query: { schoolId: SCHOOL, from: "not-a-date" },
    }, { docs }),
    null);

  // ── The 500 cap, and what it does to the total ────────────────────────
  console.log("--- the 500-row cap, including its effect on the total ---");

  // 520 rows in one category so the cap bites. The endpoint sums the RETURNED
  // page, not everything matching — so the total is of 500 rows, not 520. That
  // is arguably wrong of the endpoint, and it is what the endpoint does; a
  // mirror that summed all 520 would disagree with the server on the one number
  // the screen is about.
  await Expense.collection.insertMany(
    Array.from({ length: 520 }, (_, i) => ({
      _id: `bulk-${String(i).padStart(3, "0")}`,
      schoolId: SCHOOL, categoryId: "ec-bulk", amount: 100, note: `Bulk ${i}`,
      // Distinct, ascending timestamps so "newest 500" is well defined.
      incurredAt: new Date(Date.UTC(2027, 0, 1, 0, 0, i)),
      deletedAt: null, voidedAt: null, updatedAt: new Date(),
    }))
  );
  await mirrorFinance();

  await parity("520 rows, capped at 500",
    `/api/finance/expenses?schoolId=${SCHOOL}&categoryId=ec-bulk`);

  const capped = api.handle({
    method: "GET", path: "/api/finance/expenses",
    query: { schoolId: SCHOOL, categoryId: "ec-bulk" },
  }, { docs }).data;
  check("exactly 500 returned", capped.count, 500);
  check("the total is of the 500 returned, not the 520 matching", capped.total, 500 * 100);
  check("and they are the newest 500",
    [capped.data[0]._id, capped.data[499]._id], ["bulk-519", "bulk-020"]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- payroll runs, and the payslip join ---");

  const PayrollRun    = require("../src/db/models/PayrollRun");
  const SalaryPayment = require("../src/db/models/SalaryPayment");
  await Promise.all([PayrollRun.init(), SalaryPayment.init()]);

  await PayrollRun.collection.insertMany([
    { _id: "run-2026-07", schoolId: SCHOOL, periodMonth: "2026-07", status: "confirmed",
      totalNet: 1200000, deletedAt: null, updatedAt: new Date() },
    { _id: "run-2026-09", schoolId: SCHOOL, periodMonth: "2026-09", status: "draft",
      totalNet: 1350000, deletedAt: null, updatedAt: new Date() },
    { _id: "run-2026-08", schoolId: SCHOOL, periodMonth: "2026-08", status: "confirmed",
      totalNet: 1250000, deletedAt: null, updatedAt: new Date() },
    { _id: "run-gone", schoolId: SCHOOL, periodMonth: "2026-06", status: "reversed",
      totalNet: 0, deletedAt: new Date(), updatedAt: new Date() },
    { _id: "run-other", schoolId: "other-school", periodMonth: "2026-09", status: "draft",
      totalNet: 999, deletedAt: null, updatedAt: new Date() },
  ]);

  // t1 and t2 already exist as teachers from the subjects fixtures.
  await SalaryPayment.collection.insertMany([
    { _id: "slip-1", schoolId: SCHOOL, runId: "run-2026-09", userId: "t1",
      gross: 200000, net: 180000, deletedAt: null, updatedAt: new Date() },
    { _id: "slip-2", schoolId: SCHOOL, runId: "run-2026-09", userId: "t2",
      gross: 220000, net: 195000, deletedAt: null, updatedAt: new Date() },
    { _id: "slip-gone", schoolId: SCHOOL, runId: "run-2026-09", userId: "t1",
      gross: 1, net: 1, deletedAt: new Date(), updatedAt: new Date() },
  ]);

  docs.putMany("payrollRun",    JSON.parse(JSON.stringify(await PayrollRun.find({}).lean())));
  docs.putMany("salaryPayment", JSON.parse(JSON.stringify(await SalaryPayment.find({}).lean())));

  await parity("payroll runs", `/api/finance/payroll?schoolId=${SCHOOL}`);
  await parity("one run with its payslips",
    `/api/finance/payroll/run-2026-09?schoolId=${SCHOOL}`);
  await parity("a run with no payslips",
    `/api/finance/payroll/run-2026-07?schoolId=${SCHOOL}`);

  const runs = api.handle({
    method: "GET", path: "/api/finance/payroll", query: { schoolId: SCHOOL },
  }, { docs }).data;
  check("newest period first",
    runs.data.map((r) => r.periodMonth), ["2026-09", "2026-08", "2026-07"]);
  check("a deleted run is gone",
    runs.data.some((r) => r._id === "run-gone"), false);
  check("and another school's run is not here",
    runs.data.some((r) => r._id === "run-other"), false);

  const detail = api.handle({
    method: "GET", path: "/api/finance/payroll/run-2026-09", query: { schoolId: SCHOOL },
  }, { docs }).data;
  check("the payslips are joined to their staff",
    detail.data.payslips.map((p) => p.staff.name).sort(), ["M. Etoa", "Mme Fomba"]);
  check("projected to what the server sends and no more",
    Object.keys(detail.data.payslips[0].staff).sort(), ["_id", "email", "name", "role"]);
  check("a deleted payslip is excluded",
    detail.data.payslips.some((p) => p._id === "slip-gone"), false);

  // A run this machine has never seen is the server's 404 to give: "not
  // mirrored here" and "no such run" are different facts.
  check("an unknown run falls through to the network",
    api.handle({
      method: "GET", path: "/api/finance/payroll/run-nope", query: { schoolId: SCHOOL },
    }, { docs }),
    null);

  // ── The gap this handler declines on ──────────────────────────────────
  console.log("--- and it declines rather than showing a payroll with no names ---");

  // A bursar mirrors payroll runs and payslips but not users, while the server
  // reads staff names gated only by payroll.view. Simulated by removing the one
  // user the join needs — which is exactly the state a bursar's mirror is in.
  docs.forget("user", "t2");

  check("a payslip whose staff is not mirrored makes it decline",
    api.handle({
      method: "GET", path: "/api/finance/payroll/run-2026-09", query: { schoolId: SCHOOL },
    }, { docs }),
    null);
  // The LIST is unaffected: it joins nothing, so a bursar reads it offline.
  check("but the list of runs still answers",
    api.handle({
      method: "GET", path: "/api/finance/payroll", query: { schoolId: SCHOOL },
    }, { docs })?.status,
    200);
  check("and the gap is recorded rather than left as a surprise",
    require("../src/config/syncFeed").KNOWN_GAPS
      .some((g) => g.who === "bursar" && g.collections.includes("user")),
    true);

  // Restored, so later sections are not affected by a removal made here.
  docs.putMany("user", JSON.parse(JSON.stringify(await UserModel.find({}).lean())));
  check("and the join works again once the user is back",
    api.handle({
      method: "GET", path: "/api/finance/payroll/run-2026-09", query: { schoolId: SCHOOL },
    }, { docs })?.status,
    200);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the approval queue, which answers differently per person ---");

  const ApprovalRequest = require("../src/db/models/ApprovalRequest");
  await ApprovalRequest.init();

  // A bursar who may VIEW but not DECIDE, which is the split this endpoint turns
  // on: a decider sees the school's queue, everybody else sees only what they
  // raised, because nobody can approve their own request.
  const bursarToken = require("jsonwebtoken").sign(
    { id: "bursar-p", role: ROLES.BURSAR, schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );
  await UserModel.collection.insertOne({
    _id: "bursar-p", name: "Grace", email: "grace@x.com", role: ROLES.BURSAR,
    schoolId: SCHOOL, isActive: true, password: "x", updatedAt: new Date(),
  });

  const { defaultsFor } = require("../src/services/permissions.service");
  const asHead = {
    token,
    session: { userId: "admin-1", role: ROLES.SCHOOL_ADMIN, schoolId: SCHOOL,
               permissions: defaultsFor(ROLES.SCHOOL_ADMIN) },
  };
  const asBursar = {
    token: bursarToken,
    session: { userId: "bursar-p", role: ROLES.BURSAR, schoolId: SCHOOL,
               permissions: defaultsFor(ROLES.BURSAR) },
  };

  await ApprovalRequest.collection.insertMany([
    { _id: "ap-1", schoolId: SCHOOL, kind: "expense", targetId: "ex-big", amount: 80000,
      threshold: 50000, summary: "Generator repair", status: "pending",
      requestedBy: "bursar-p", requestedAt: new Date("2026-09-10T08:00:00Z"),
      deletedAt: null, updatedAt: new Date() },
    { _id: "ap-2", schoolId: SCHOOL, kind: "refund", targetId: "rf-1", amount: 60000,
      threshold: 50000, summary: "Overpayment returned", status: "pending",
      requestedBy: "admin-1", requestedAt: new Date("2026-09-11T08:00:00Z"),
      deletedAt: null, updatedAt: new Date() },
    { _id: "ap-3", schoolId: SCHOOL, kind: "waiver", targetId: "wv-1", amount: 10000,
      threshold: 5000, summary: "Hardship waiver", status: "approved",
      requestedBy: "bursar-p", requestedAt: new Date("2026-09-05T08:00:00Z"),
      deletedAt: null, updatedAt: new Date() },
    { _id: "ap-4", schoolId: SCHOOL, kind: "expense", targetId: "ex-x", amount: 70000,
      threshold: 50000, summary: "Rejected purchase", status: "rejected",
      requestedBy: "bursar-p", requestedAt: new Date("2026-09-06T08:00:00Z"),
      deletedAt: null, updatedAt: new Date() },
    { _id: "ap-gone", schoolId: SCHOOL, kind: "expense", targetId: "ex-g", amount: 99000,
      threshold: 50000, summary: "Removed", status: "pending",
      requestedBy: "bursar-p", requestedAt: new Date("2026-09-07T08:00:00Z"),
      deletedAt: new Date(), updatedAt: new Date() },
    { _id: "ap-other", schoolId: "other-school", kind: "expense", targetId: "ex-o", amount: 1,
      threshold: 1, summary: "Elsewhere", status: "pending",
      requestedBy: "someone", requestedAt: new Date("2026-09-12T08:00:00Z"),
      deletedAt: null, updatedAt: new Date() },
  ]);

  docs.putMany("approvalRequest", JSON.parse(JSON.stringify(await ApprovalRequest.find({}).lean())));
  docs.putMany("user",            JSON.parse(JSON.stringify(await UserModel.find({}).lean())));

  // The head decides, so sees the school's queue.
  await parity("the queue, as somebody who may decide",
    `/api/approvals?schoolId=${SCHOOL}`, asHead);
  await parity("all statuses, as the head",
    `/api/approvals?schoolId=${SCHOOL}&status=all`, asHead);
  await parity("one kind",
    `/api/approvals?schoolId=${SCHOOL}&status=all&kind=expense`, asHead);
  await parity("approved only",
    `/api/approvals?schoolId=${SCHOOL}&status=approved`, asHead);

  // The bursar does not decide, so sees only what they raised — the assertion
  // this whole section exists for.
  await parity("the queue, as somebody who may not decide",
    `/api/approvals?schoolId=${SCHOOL}`, asBursar);
  await parity("all statuses, as the bursar",
    `/api/approvals?schoolId=${SCHOOL}&status=all`, asBursar);

  await parity("the dashboard summary, as the head",
    `/api/approvals/summary?schoolId=${SCHOOL}`, asHead);
  await parity("the dashboard summary, as the bursar",
    `/api/approvals/summary?schoolId=${SCHOOL}`, asBursar);

  // Stated outright so a failure names the rule rather than showing a diff.
  const headQueue = api.handle({
    method: "GET", path: "/api/approvals", query: { schoolId: SCHOOL },
  }, { docs, session: asHead.session }).data;
  const bursarQueue = api.handle({
    method: "GET", path: "/api/approvals", query: { schoolId: SCHOOL },
  }, { docs, session: asBursar.session }).data;

  check("the head sees both pending requests",
    headQueue.data.map((r) => r._id).sort(), ["ap-1", "ap-2"]);
  check("and is told they may decide", headQueue.canDecide, true);
  check("the bursar sees only the one they raised",
    bursarQueue.data.map((r) => r._id), ["ap-1"]);
  check("and is told they may not", bursarQueue.canDecide, false);
  check("newest first",
    api.handle({
      method: "GET", path: "/api/approvals",
      query: { schoolId: SCHOOL, status: "all" },
    }, { docs, session: asHead.session }).data.data.map((r) => r._id),
    ["ap-2", "ap-1", "ap-4", "ap-3"]);
  check("a deleted request is gone for everyone",
    headQueue.data.some((r) => r._id === "ap-gone"), false);

  const summary = api.handle({
    method: "GET", path: "/api/approvals/summary", query: { schoolId: SCHOOL },
  }, { docs, session: asBursar.session }).data.data;
  // pending is the SCHOOL's total even for a non-decider — the tile says how
  // much is held up, and `mine` says how much of it is theirs.
  check("the summary counts the whole school's pending", summary.pending, 2);
  check("and separately the ones this person raised", summary.mine, 1);
  check("with the thresholds in force, so a screen can explain itself",
    summary.thresholds.expenseThreshold, 50000);

  // No identity means the difference between the two answers is exactly
  // "requests other people raised", so it declines rather than guessing.
  check("with no session it falls through to the network",
    api.handle({
      method: "GET", path: "/api/approvals", query: { schoolId: SCHOOL },
    }, { docs, session: null }),
    null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the register ---");

  const { StudentAttendance } = require("../src/db/models/Attendance");
  await StudentAttendance.init();

  // Two marks on one day for one pupil, on DIFFERENT SUBJECTS.
  //
  // The first version of this fixture gave the same pupil two marks for the same
  // day and class, meaning to represent a corrected register — and the insert
  // failed on a unique index nobody had mentioned:
  // { schoolId, classId, studentId, subjectId, date }. So a register cannot be
  // corrected by adding a row; there is one mark per pupil per subject per day,
  // and a correction updates it.
  //
  // Which narrows what the markedAt secondary sort is for: ordering marks taken
  // in different lessons on the same day. Worth knowing, and worth the fixture
  // being the shape the data can actually take.
  await StudentAttendance.collection.insertMany([
    { _id: "at-1", schoolId: SCHOOL, studentId: "p1", classId: "cls-1", date: "2026-09-14",
      status: "present", markedAt: new Date("2026-09-14T08:05:00Z"), updatedAt: new Date() },
    { _id: "at-2", schoolId: SCHOOL, studentId: "p1", classId: "cls-1", date: "2026-09-15",
      status: "absent",  markedAt: new Date("2026-09-15T08:05:00Z"), updatedAt: new Date() },
    { _id: "at-3", schoolId: SCHOOL, studentId: "p1", classId: "cls-1", date: "2026-09-15",
      subjectId: "sub-1",
      status: "present", markedAt: new Date("2026-09-15T11:30:00Z"), updatedAt: new Date() },
    { _id: "at-4", schoolId: SCHOOL, studentId: "p2", classId: "cls-1", date: "2026-09-15",
      status: "late",    markedAt: new Date("2026-09-15T08:20:00Z"), updatedAt: new Date() },
    { _id: "at-5", schoolId: SCHOOL, studentId: "p3", classId: "cls-2", date: "2026-09-16",
      status: "present", markedAt: new Date("2026-09-16T08:05:00Z"), updatedAt: new Date() },
    // The endpoint applies NO deleted filter, so this must still come back.
    { _id: "at-6", schoolId: SCHOOL, studentId: "p1", classId: "cls-1", date: "2026-09-17",
      status: "present", markedAt: new Date("2026-09-17T08:05:00Z"),
      deletedAt: new Date("2026-09-18T00:00:00Z"), updatedAt: new Date() },
    { _id: "at-9", schoolId: "other-school", studentId: "px", classId: "cls-9", date: "2026-09-15",
      status: "present", markedAt: new Date("2026-09-15T08:05:00Z"), updatedAt: new Date() },
  ]);

  docs.putMany("studentAttendance",
    JSON.parse(JSON.stringify(await StudentAttendance.find({}).lean())));

  await parity("the whole register",     `/api/attendance/students?schoolId=${SCHOOL}`, asHead);
  await parity("one class",             `/api/attendance/students?schoolId=${SCHOOL}&classId=cls-1`, asHead);
  await parity("one pupil",             `/api/attendance/students?schoolId=${SCHOOL}&studentId=p1`, asHead);
  await parity("one status",            `/api/attendance/students?schoolId=${SCHOOL}&status=absent`, asHead);
  await parity("one exact day",         `/api/attendance/students?schoolId=${SCHOOL}&date=2026-09-15`, asHead);
  await parity("a range, inclusive",    `/api/attendance/students?schoolId=${SCHOOL}&startDate=2026-09-15&endDate=2026-09-16`, asHead);
  await parity("from only",             `/api/attendance/students?schoolId=${SCHOOL}&startDate=2026-09-16`, asHead);
  await parity("to only",              `/api/attendance/students?schoolId=${SCHOOL}&endDate=2026-09-14`, asHead);
  await parity("a day nobody was marked", `/api/attendance/students?schoolId=${SCHOOL}&date=2020-01-01`, asHead);
  await parity("class and status together",
    `/api/attendance/students?schoolId=${SCHOOL}&classId=cls-1&status=present`, asHead);

  // An exact date wins over a range on the server — both are set on the same
  // query key, so the later assignment replaces the earlier.
  await parity("an exact date beats a range",
    `/api/attendance/students?schoolId=${SCHOOL}&date=2026-09-14&startDate=2026-09-15&endDate=2026-09-16`, asHead);

  // Surprising, and therefore worth pinning: an unreadable date becomes TODAY
  // rather than an error. Reproduced rather than improved on, because a mirror
  // that refused what the server accepts would answer differently from the
  // request it declined to handle.
  await parity("an unreadable date becomes today, as the server does",
    `/api/attendance/students?schoolId=${SCHOOL}&date=not-a-date`, asHead);

  const register = api.handle({
    method: "GET", path: "/api/attendance/students",
    query: { schoolId: SCHOOL, studentId: "p1" },
  }, { docs, session: asHead.session }).data;

  check("newest day first, and within a day the later lesson first",
    register.records.map((r) => r._id), ["at-6", "at-3", "at-2", "at-1"]);
  check("a soft-deleted mark IS returned, as this endpoint returns it",
    register.records.some((r) => r._id === "at-6"), true);
  check("this endpoint answers with records, not data",
    Object.keys(api.handle({
      method: "GET", path: "/api/attendance/students", query: { schoolId: SCHOOL },
    }, { docs, session: asHead.session }).data).sort(),
    ["count", "records", "success"]);

  // schoolId from the session when the query omits it — the endpoint's own
  // fallback, and the reason this handler consults the session at all.
  //
  // Asserted as a PROPERTY rather than against a count: omitting schoolId must
  // give the same answer as passing it. The first version of this compared
  // against a hand-counted 7 and failed at 6, which said nothing about the
  // fallback and everything about my arithmetic.
  const explicit = api.handle({
    method: "GET", path: "/api/attendance/students", query: { schoolId: SCHOOL },
  }, { docs, session: asHead.session }).data;
  const implied = api.handle({
    method: "GET", path: "/api/attendance/students", query: {},
  }, { docs, session: asHead.session }).data;

  check("omitting schoolId gives the same answer as passing it",
    implied.records.map((r) => r._id), explicit.records.map((r) => r._id));
  check("and it is this school only",
    implied.records.every((r) => r.schoolId === SCHOOL), true);
  check("with no session and no schoolId it declines",
    api.handle({
      method: "GET", path: "/api/attendance/students", query: {},
    }, { docs, session: null }),
    null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- exams, and the pagination block ---");

  const Exam = require("../src/db/models/Exam");
  await Exam.init();

  // 7 exams so a limit of 3 gives an uneven last page — the case where
  // Math.ceil matters and an off-by-one in totalPages shows up. Distinct
  // createdAt values so "newest first" is well defined.
  const examRows = Array.from({ length: 7 }, (_, i) => ({
    _id: `exam-${i}`,
    schoolId: SCHOOL,
    title: `Assessment ${i}`,
    status: i % 2 === 0 ? "published" : "draft",
    academicYear: YEAR,
    term: "Term 1",
    classId: i < 4 ? "cls-1" : null,
    // Several classes on one exam: the endpoint matches classId OR a member of
    // classIds, and Mongo does the array case implicitly where SQLite does not.
    classIds: i >= 4 ? ["cls-2", "cls-1"] : undefined,
    createdAt: new Date(Date.UTC(2026, 8, 1 + i)),
    deletedAt: null,
    updatedAt: new Date(),
  }));
  examRows.push({
    _id: "exam-gone", schoolId: SCHOOL, title: "Removed", status: "draft",
    academicYear: YEAR, term: "Term 1", classId: "cls-1",
    createdAt: new Date(Date.UTC(2026, 8, 20)),
    deletedAt: new Date(), updatedAt: new Date(),
  });
  examRows.push({
    _id: "exam-other", schoolId: "other-school", title: "Elsewhere", status: "published",
    academicYear: YEAR, term: "Term 1", classId: "cls-9",
    createdAt: new Date(Date.UTC(2026, 8, 21)), deletedAt: null, updatedAt: new Date(),
  });

  await Exam.collection.insertMany(examRows);
  docs.putMany("exam", JSON.parse(JSON.stringify(await Exam.find({}).lean())));

  await parity("the default page",   `/api/exams?schoolId=${SCHOOL}`, asHead);
  await parity("a small page size",  `/api/exams?schoolId=${SCHOOL}&limit=3`, asHead);
  await parity("the second page",    `/api/exams?schoolId=${SCHOOL}&limit=3&page=2`, asHead);
  await parity("the uneven last page", `/api/exams?schoolId=${SCHOOL}&limit=3&page=3`, asHead);
  await parity("a page past the end", `/api/exams?schoolId=${SCHOOL}&limit=3&page=9`, asHead);
  await parity("by status",          `/api/exams?schoolId=${SCHOOL}&status=published`, asHead);
  await parity("by year and term",   `/api/exams?schoolId=${SCHOOL}&academicYear=${YEAR}&term=Term 1`, asHead);
  await parity("by class, matching classId",  `/api/exams?schoolId=${SCHOOL}&classId=cls-1`, asHead);
  await parity("by class, matching classIds", `/api/exams?schoolId=${SCHOOL}&classId=cls-2`, asHead);
  await parity("a class with no exams",      `/api/exams?schoolId=${SCHOOL}&classId=cls-none`, asHead);
  await parity("a status nothing has",       `/api/exams?schoolId=${SCHOOL}&status=cancelled`, asHead);

  // Stated outright, because every one of these is a number a screen draws
  // page controls from.
  const paged = api.handle({
    method: "GET", path: "/api/exams", query: { schoolId: SCHOOL, limit: "3", page: "2" },
  }, { docs }).data;

  check("total is over the whole query, not the page", paged.pagination.total, 7);
  check("totalPages rounds up", paged.pagination.totalPages, 3);
  check("page and limit come back as numbers, not strings",
    [typeof paged.pagination.page, typeof paged.pagination.limit], ["number", "number"]);
  check("the page holds the right slice", paged.exams.length, 3);
  check("newest first across pages",
    api.handle({
      method: "GET", path: "/api/exams", query: { schoolId: SCHOOL, limit: "3", page: "1" },
    }, { docs }).data.exams.map((e) => e._id),
    ["exam-6", "exam-5", "exam-4"]);
  check("a deleted exam is excluded",
    api.handle({ method: "GET", path: "/api/exams", query: { schoolId: SCHOOL } }, { docs })
      .data.exams.some((e) => e._id === "exam-gone"),
    false);

  const empty = api.handle({
    method: "GET", path: "/api/exams", query: { schoolId: SCHOOL, status: "cancelled" },
  }, { docs }).data;
  // Zero exams is zero pages, not one. A screen drawing "Page 1 of 1" over an
  // empty list is a screen saying there is something to look at.
  check("nothing matching is zero pages", empty.pagination.totalPages, 0);
  check("and an empty list", empty.exams, []);

  // A page the server would throw on is left to the server, rather than this
  // layer inventing a second version of the same failure.
  check("a non-numeric page falls through",
    api.handle({
      method: "GET", path: "/api/exams", query: { schoolId: SCHOOL, page: "abc" },
    }, { docs }),
    null);
  check("and a zero limit",
    api.handle({
      method: "GET", path: "/api/exams", query: { schoolId: SCHOOL, limit: "0" },
    }, { docs }),
    null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- exam results, published and otherwise ---");

  const ExamResult = require("../src/db/models/ExamResult");
  await ExamResult.init();

  // Positions 1..10 so the numeric sort is testable: as text, "10" sorts before
  // "9", and a ranked list in the wrong order is worse than an unordered one.
  // One row with no position at all, because Mongo puts missing values first on
  // an ascending sort.
  const resultRows = [
    ...Array.from({ length: 10 }, (_, i) => ({
      _id: `res-${i + 1}`, examId: "exam-0", schoolId: SCHOOL, classId: "cls-1",
      // A DISTINCT pupil per row: there is a unique index on
      // { examId, studentId }, so one exam has one result per pupil. The first
      // version of this fixture cycled through three pupils and could not exist.
      // The index is not partial either, so a soft-deleted row still occupies
      // its pupil's place — which is why res-gone below has its own.
      studentId: `stu-${i + 1}`, total: 100 - i, classPosition: i + 1,
      isPublished: true, deletedAt: null, updatedAt: new Date(),
    })),
    { _id: "res-unranked", examId: "exam-0", schoolId: SCHOOL, classId: "cls-1",
      studentId: "stu-unranked", total: 40, isPublished: true, deletedAt: null, updatedAt: new Date() },
    // Unpublished: an admin may ask for these, a teacher and a bursar may not
    // see them at all.
    { _id: "res-draft-1", examId: "exam-0", schoolId: SCHOOL, classId: "cls-1",
      studentId: "stu-draft-1", total: 88, classPosition: 2, isPublished: false,
      deletedAt: null, updatedAt: new Date() },
    { _id: "res-draft-2", examId: "exam-0", schoolId: SCHOOL, classId: "cls-2",
      studentId: "stu-draft-2", total: 77, classPosition: 1, isPublished: false,
      deletedAt: null, updatedAt: new Date() },
    { _id: "res-gone", examId: "exam-0", schoolId: SCHOOL, classId: "cls-1",
      studentId: "stu-gone", total: 1, classPosition: 99, isPublished: true,
      deletedAt: new Date(), updatedAt: new Date() },
    { _id: "res-other", examId: "exam-0", schoolId: "other-school", classId: "cls-9",
      studentId: "px", total: 50, classPosition: 1, isPublished: true,
      deletedAt: null, updatedAt: new Date() },
  ];
  await ExamResult.collection.insertMany(resultRows);

  // Mirrored WITHOUT the feed's scope, deliberately: this is the state a machine
  // is in if it pulled as an admin. The handler must still hide unpublished rows
  // from a non-admin reading that same machine.
  docs.putMany("examResult", JSON.parse(JSON.stringify(await ExamResult.find({}).lean())));

  await parity("as an admin, published only by default",
    `/api/results/exam-0?schoolId=${SCHOOL}`, asHead);
  await parity("as an admin, asking for unpublished",
    `/api/results/exam-0?schoolId=${SCHOOL}&isPublished=false`, asHead);
  await parity("as an admin, asking for published",
    `/api/results/exam-0?schoolId=${SCHOOL}&isPublished=true`, asHead);
  await parity("as a bursar, who may not see drafts",
    `/api/results/exam-0?schoolId=${SCHOOL}`, asBursar);
  await parity("as a bursar, asking for unpublished anyway",
    `/api/results/exam-0?schoolId=${SCHOOL}&isPublished=false`, asBursar);
  await parity("one class",
    `/api/results/exam-0?schoolId=${SCHOOL}&classId=cls-1`, asHead);
  // Paging compared over PUBLISHED results only, where classPosition is unique
  // and the order is therefore total. Compared over everything, the drafts share
  // positions with published rows and the endpoint has no secondary sort key —
  // so which of two tied documents lands on which page is undefined, and a
  // parity check over it would be asserting something the server does not
  // promise. That is exactly how this first failed.
  await parity("paged, where positions are unique",
    `/api/results/exam-0?schoolId=${SCHOOL}&isPublished=true&limit=4&page=2`, asHead);

  // What IS guaranteed with ties present: the same documents, however ordered.
  {
    const all = new Set(
      api.handle({
        method: "GET", path: "/api/results/exam-0",
        query: { schoolId: SCHOOL, limit: "100" },
      }, { docs, session: asHead.session }).data.data.map((r) => r._id)
    );
    const res = await fetch(
      `http://127.0.0.1:${port}/api/results/exam-0?schoolId=${SCHOOL}&limit=100`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const fromServer = new Set((await res.json()).data.map((r) => r._id));
    check("with ties present, both sides return the same set of results",
      [...all].sort(), [...fromServer].sort());
  }
  await parity("an exam with no results",
    `/api/results/exam-nothing?schoolId=${SCHOOL}`, asHead);

  // Stated outright.
  const asAdminRows = api.handle({
    method: "GET", path: "/api/results/exam-0", query: { schoolId: SCHOOL },
  }, { docs, session: asHead.session }).data;
  const asBursarRows = api.handle({
    method: "GET", path: "/api/results/exam-0", query: { schoolId: SCHOOL },
  }, { docs, session: asBursar.session }).data;

  // THE ASSERTION THIS SECTION EXISTS FOR. The mirror holds the drafts; the
  // handler must not show them to somebody the server would hide them from.
  check("the mirror does hold the unpublished rows",
    docs.count("examResult", { isPublished: false }) > 0, true);
  check("and a bursar is shown none of them",
    asBursarRows.data.some((r) => r.isPublished === false), false);
  check("an admin asking explicitly does see them",
    api.handle({
      method: "GET", path: "/api/results/exam-0",
      query: { schoolId: SCHOOL, isPublished: "false" },
    }, { docs, session: asHead.session }).data.data.map((r) => r._id).sort(),
    ["res-draft-1", "res-draft-2"]);
  // isPublished is compared to the string "true", so anything else is FALSE —
  // including "1", which reads as true to a human.
  check("isPublished=1 means false, as the string comparison dictates",
    api.handle({
      method: "GET", path: "/api/results/exam-0",
      query: { schoolId: SCHOOL, isPublished: "1" },
    }, { docs, session: asHead.session }).data.data.every((r) => r.isPublished === false),
    true);
  check("a bursar passing isPublished=false is still shown published rows only",
    asBursarRows.data.length,
    api.handle({
      method: "GET", path: "/api/results/exam-0",
      query: { schoolId: SCHOOL, isPublished: "false" },
    }, { docs, session: asBursar.session }).data.data.length);

  // Over published results only, where positions are unique — as text, "10"
  // sorts before "9", and a ranked list in the wrong order is worse than an
  // unordered one.
  const publishedOnly = api.handle({
    method: "GET", path: "/api/results/exam-0",
    query: { schoolId: SCHOOL, isPublished: "true", limit: "100" },
  }, { docs, session: asHead.session }).data;

  check("positions sort numerically, not as text",
    publishedOnly.data.map((r) => r.classPosition).filter((p) => p !== undefined).slice(0, 4),
    [1, 2, 3, 4]);
  check("a row with no position comes first, as Mongo sorts missing values",
    publishedOnly.data[0]._id, "res-unranked");
  check("and an admin's default includes the drafts, so positions repeat",
    asAdminRows.data.map((r) => r.classPosition).filter((p) => p !== undefined).slice(0, 4),
    [1, 1, 2, 2]);
  check("a deleted result is excluded",
    asAdminRows.data.some((r) => r._id === "res-gone"), false);
  check("and another school's is not here",
    asAdminRows.data.some((r) => r._id === "res-other"), false);

  // This envelope is FLAT and names the page count "pages", where the exam list
  // nests it and names it "totalPages". A mirror does not get to tidy that up.
  check("the envelope is flat, with pages not totalPages",
    Object.keys(asAdminRows).sort(), ["count", "data", "page", "pages", "success", "total"]);

  check("with no role it declines rather than guessing which way to fail",
    api.handle({
      method: "GET", path: "/api/results/exam-0", query: { schoolId: SCHOOL },
    }, { docs, session: null }),
    null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and the arithmetic, stated outright ---");

  // Named separately from the parity comparison so a failure says WHICH rule
  // broke rather than only that two objects differ.
  const ledger = api.handle({
    method: "GET", path: "/api/fees/students/p1",
    query: { schoolId: SCHOOL, academicYear: YEAR },
  }, { docs });
  const totals = ledger.data.data.totals;

  // 75000 + 5000 + 10000; the 99000 deleted row excluded entirely.
  check("charged excludes a deleted charge", totals.charged, 90000);
  // The waived AMOUNT, not the whole charge it sits on.
  check("waived is the amount forgiven, not the charge", totals.waived, 4000);
  // 30000 + 20000 - 20000 + 5000. The reversal nets itself off; nothing
  // excludes it, and nothing may exclude it twice.
  check("a reversal nets off rather than being filtered", totals.paid, 35000);
  check("balance is charged - waived - paid", totals.balance, 90000 - 4000 - 35000);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a handler declines rather than guessing ---");

  // No schoolId: the server would answer across tenants, which a single-school
  // mirror cannot reproduce. Declining sends it to the network.
  check("no schoolId falls through to the network",
    api.handle({ method: "GET", path: "/api/admin/students", query: {} }, { docs }), null);

  check("an unknown route falls through",
    api.handle({ method: "GET", path: "/api/nothing/here", query: {} }, { docs }), null);

  // A literal segment must match itself; a route must not swallow a deeper path
  // and answer with the wrong shape.
  check("a deeper path is not captured as an id",
    api.handle({ method: "GET", path: "/api/fees/students/p1/extra", query: { schoolId: SCHOOL } }, { docs }),
    null);

  check("the wrong method falls through",
    api.handle({ method: "POST", path: "/api/admin/students", query: { schoolId: SCHOOL } }, { docs }),
    null);

  // A pupil on an instalment plan: planStatus is cumulative arithmetic in a
  // backend service, and a wrong answer says a family is behind on a plan they
  // are keeping to. Declining is the correct behaviour, not a gap.
  docs.put("paymentPlan", {
    _id: "pl1", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR,
    status: "active", deletedAt: null,
    instalments: [{ seq: 1, amount: 40000, dueDate: "2026-10-01" }],
  });
  check("a pupil on a payment plan is left to the server",
    api.handle({
      method: "GET", path: "/api/fees/students/p1",
      query: { schoolId: SCHOOL, academicYear: YEAR },
    }, { docs }),
    null);

  // Removed again, or every ledger read below this point would decline for the
  // same correct reason and the failures would look like the write path was
  // broken. Which is exactly how this read the first time it ran.
  docs.forget("paymentPlan", "pl1");
  check("and reads normally once the plan is gone",
    api.handle({
      method: "GET", path: "/api/fees/students/p1",
      query: { schoolId: SCHOOL, academicYear: YEAR },
    }, { docs })?.status,
    200);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a payment taken with no connection, all the way to the server ---");

  // The whole point of the offline layer, end to end and against the REAL
  // endpoint: a bursar records money, prints a receipt, and the number on that
  // paper is still the number in the school's record afterwards.
  const meta  = store.meta(db);
  const queue = outbox(db);
  const deviceCode = meta.deviceCode();

  const taken = api.handle({
    method: "POST", path: "/api/fees/payments",
    query: {},
    body: { schoolId: SCHOOL, studentId: "p1", academicYear: YEAR, amount: 25000, method: "cash" },
  }, { docs, meta, queue });

  check("the write is accepted locally", taken?.status, 201);
  check("and queued", taken?.queued, true);

  const localPayment = taken.data.data;
  check("with a receipt number carrying this installation's code",
    localPayment.receiptNo, `RCT-${YEAR}-${deviceCode}-0001`);
  check("the row is in the mirror",
    docs.get("feePayment", localPayment._id)?.amount, 25000);
  check("marked as not yet sent",
    docs.get("feePayment", localPayment._id)?._pending, true);

  // The ledger must already show it — a bursar who presses Save and sees no
  // change assumes it failed and takes the money twice.
  const ledgerNow = api.handle({
    method: "GET", path: "/api/fees/students/p1",
    query: { schoolId: SCHOOL, academicYear: YEAR },
  }, { docs });
  check("the ledger already includes it",
    ledgerNow.data.data.payments.some((p) => p._id === localPayment._id), true);
  check("and the balance has moved by the amount taken",
    ledgerNow.data.data.totals.paid, 35000 + 25000);

  // ── Now the connection comes back ──────────────────────────────────────
  const apiClient = client({ meta });
  apiClient.setServerUrl(`http://127.0.0.1:${port}`);
  apiClient.setToken(token);

  const eng = engine({
    docs, queue, state: store.state(db), client: apiClient,
    // Only this collection: the fixtures here are for parity, and a full pull
    // would fetch every collection the feed offers.
    feedCollections: ["feePayment"],
  });

  await eng.cycle();
  eng.stop();

  check("the queue drained", queue.all().length, 0);
  check("and the row is settled",
    docs.get("feePayment", localPayment._id)?._pending, false);

  // THE ASSERTION THIS SECTION EXISTS FOR. The server normally issues receipt
  // numbers from an atomic counter and would have replaced this one — leaving
  // the parent holding a receipt whose number is in no record.
  const stored = await FeePayment.findById(localPayment._id).lean();
  check("the server kept the receipt number that was printed",
    stored?.receiptNo, `RCT-${YEAR}-${deviceCode}-0001`);
  check("and the mirror agrees with it",
    docs.get("feePayment", localPayment._id)?.receiptNo, stored?.receiptNo);
  check("the amount survived unchanged", stored?.amount, 25000);
  check("attributed to the signed-in user by the server, not by the client",
    stored?.receivedBy, "admin-1");

  // A second offline payment counts on from the first, per year.
  const second = api.handle({
    method: "POST", path: "/api/fees/payments",
    query: {},
    body: { schoolId: SCHOOL, studentId: "p1", academicYear: YEAR, amount: 1000 },
  }, { docs, meta, queue });
  check("the next receipt continues the sequence",
    second.data.data.receiptNo, `RCT-${YEAR}-${deviceCode}-0002`);

  // A different year counts separately, as the server's counter does.
  const otherYear = api.handle({
    method: "POST", path: "/api/fees/payments",
    query: {},
    body: { schoolId: SCHOOL, studentId: "p1", academicYear: "2025-2026", amount: 1000 },
  }, { docs, meta, queue });
  check("a different year has its own sequence",
    otherYear.data.data.receiptNo, `RCT-2025-2026-${deviceCode}-0001`);

  // ── And the same request twice is one payment ──────────────────────────
  console.log("--- a replayed write does not take the money twice ---");

  const before = await FeePayment.countDocuments({});
  // Exactly what happens when the response was lost: the request is still
  // queued and goes again.
  queue.add({
    method: "POST", path: "/api/fees/payments",
    body: { ...second.data.data, _id: second.data.data._id },
    collection: "feePayment", docId: second.data.data._id,
    idemKey: "replay-of-second",
  });

  const eng2 = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["feePayment"],
  });
  await eng2.cycle();
  eng2.stop();

  const after = await FeePayment.countDocuments({});
  check("the queue accepted the replay", queue.all().length, 0);
  // second and otherYear were both queued and both new, so two arrive; the
  // replay of second must add nothing.
  check("and only the genuinely new payments were created", after - before, 2);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an expense recorded offline, and one it refuses to record ---");

  // The threshold is cleared first, so this pair of assertions is about the
  // shipped default — no threshold, everything straight through — before the
  // school sets one below.
  // School.updateOne, not School.collection.updateOne: the model casts the
  // string to an ObjectId and the raw collection does not. Written raw at first,
  // it matched nothing and silently did nothing — and because the amounts below
  // are under the threshold anyway, every assertion still passed. A test passing
  // for the wrong reason is worse than one failing, so the clearing is asserted.
  await School.updateOne(
    { _id: SCHOOL }, { $set: { "settings.approvals": {}, updatedAt: new Date() } }
  );
  docs.putMany("school", JSON.parse(JSON.stringify(await School.find({}).lean())));
  check("the threshold really is cleared before this section",
    docs.get("school", SCHOOL)?.settings?.approvals?.expenseThreshold ?? null, null);

  // With no threshold configured — the shipped default — every expense goes
  // straight through and can be written offline.
  const spent = api.handle({
    method: "POST", path: "/api/finance/expenses", query: {},
    body: { schoolId: SCHOOL, categoryId: "ec-2", amount: 12000, description: "Fuel" },
  }, { docs, meta, queue });

  check("it is accepted locally", spent?.status, 201);
  check("and queued", spent?.queued, true);
  check("recorded as approved, because approval was not required",
    spent.data.data.status, "approved");
  // Both fields the screen reads to choose between "saved" and "waiting for
  // approval".
  check("with no approval object", spent.data.approval, null);
  check("and pendingApproval false", spent.data.pendingApproval, false);

  const spentId = spent.data.data._id;
  check("the expense list already shows it",
    api.handle({
      method: "GET", path: "/api/finance/expenses",
      query: { schoolId: SCHOOL, categoryId: "ec-2" },
    }, { docs }).data.data.some((r) => r._id === spentId),
    true);

  // ── Now the school sets a threshold ────────────────────────────────────
  await School.updateOne(
    { _id: SCHOOL },
    { $set: { "settings.approvals": { expenseThreshold: 50000 }, updatedAt: new Date() } }
  );
  docs.putMany("school", JSON.parse(JSON.stringify(await School.find({}).lean())));
  check("and really is set before the boundary assertions",
    docs.get("school", SCHOOL)?.settings?.approvals?.expenseThreshold, 50000);

  const below = api.handle({
    method: "POST", path: "/api/finance/expenses", query: {},
    body: { schoolId: SCHOOL, categoryId: "ec-2", amount: 49999, description: "Just under" },
  }, { docs, meta, queue });
  check("just under the threshold is still written offline", below?.status, 201);

  // AT the threshold, not merely above — the boundary the shared rule exists to
  // keep in one place. The server would record this as pending and raise an
  // approval request, and approval needs a second person who is not on this
  // machine; inventing an approval object would show "waiting for approval"
  // against a request nobody has been asked to approve.
  check("exactly at the threshold is left to the server",
    api.handle({
      method: "POST", path: "/api/finance/expenses", query: {},
      body: { schoolId: SCHOOL, categoryId: "ec-2", amount: 50000, description: "At the line" },
    }, { docs, meta, queue }),
    null);
  check("and above it too",
    api.handle({
      method: "POST", path: "/api/finance/expenses", query: {},
      body: { schoolId: SCHOOL, categoryId: "ec-2", amount: 80000, description: "Over" },
    }, { docs, meta, queue }),
    null);

  // A category this machine does not know is the server's to reject, for the
  // same reason it checks: a figure with no account behind it.
  check("an unknown category falls through",
    api.handle({
      method: "POST", path: "/api/finance/expenses", query: {},
      body: { schoolId: SCHOOL, categoryId: "ec-nope", amount: 100 },
    }, { docs, meta, queue }),
    null);
  check("and a deleted one",
    api.handle({
      method: "POST", path: "/api/finance/expenses", query: {},
      body: { schoolId: SCHOOL, categoryId: "ec-4", amount: 100 },
    }, { docs, meta, queue }),
    null);
  check("a fractional amount falls through rather than being rounded",
    api.handle({
      method: "POST", path: "/api/finance/expenses", query: {},
      body: { schoolId: SCHOOL, categoryId: "ec-2", amount: 100.5 },
    }, { docs, meta, queue }),
    null);

  // ── And it reaches the server ──────────────────────────────────────────
  const engExpense = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["expense"],
  });
  await engExpense.cycle();
  engExpense.stop();

  check("the queue drained", queue.summary().pending, 0);
  check("nothing was blocked", queue.summary().blocked, 0);

  const storedExpense = await Expense.findById(spentId).lean();
  check("the expense is on the server", storedExpense?.amount, 12000);
  check("with the status the local row predicted", storedExpense?.status, "approved");
  check("and the local row has settled",
    docs.get("expense", spentId)?._pending, false);
  check("attributed by the server, not by the client",
    storedExpense?.recordedBy, "admin-1");

  // ── A receipt number cannot be claimed twice ───────────────────────────
  console.log("--- and a receipt number cannot be reused ---");

  const duplicate = await fetch(`http://127.0.0.1:${port}/api/fees/payments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      _id: "some-other-id", schoolId: SCHOOL, studentId: "p1",
      academicYear: YEAR, amount: 500,
      receiptNo: `RCT-${YEAR}-${deviceCode}-0001`,
    }),
  });
  const duplicateBody = await duplicate.json();
  check("the server refuses it", duplicate.status, 409);
  check("naming what happened", duplicateBody.code, "RECEIPT_TAKEN");

  // A number in the SERVER's format is not claimable at all — a client must not
  // be able to reach into the counter's number space.
  const impersonating = await fetch(`http://127.0.0.1:${port}/api/fees/payments`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      _id: "impersonator", schoolId: SCHOOL, studentId: "p1",
      academicYear: YEAR, amount: 500, receiptNo: `RCT-${YEAR}-9999`,
    }),
  });
  const impersonatingBody = await impersonating.json();
  check("a server-format number is ignored, not honoured", impersonating.status, 201);
  check("and the counter issues one instead",
    impersonatingBody.data.receiptNo !== `RCT-${YEAR}-9999`, true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an exam created, edited and archived with no connection ---");

  /**
   * ── The first CRUD round trip in this layer ──────────────────────────────
   *
   * Payments and expenses are creates. This is create, then EDIT, then archive —
   * the shapes most of the remaining hundred writes have, so what goes wrong here
   * goes wrong everywhere.
   *
   * Two properties are worth more than the rest:
   *
   *   an edit queued behind a create must be its own request. They share a
   *   document, and the outbox keyed its entries by document id until the change
   *   that came with these handlers, which meant the edit was reported as a
   *   duplicate and silently dropped.
   *
   *   the edit must carry ONLY what changed. The endpoint builds its update from
   *   "field !== undefined", so a handler that helpfully sent the whole document
   *   would write back values nobody touched, reverting whatever another machine
   *   had changed in between.
   */
  const examSession = { userId: "admin-1", schoolId: SCHOOL, permissions: [] };
  const examCtx     = { docs, meta, queue, session: examSession };

  const created = api.handle({
    method: "POST", path: "/api/exams", query: {},
    body: {
      schoolId: SCHOOL, name: "  Second Term Maths  ", academicYear: YEAR,
      term: "term_2", type: "mid_term", classId: "cls-1", totalMarks: 80,
    },
  }, examCtx);

  check("the exam is accepted locally", created?.status, 201);
  check("and queued", created?.queued, true);

  const examId = created.data.serverId;
  check("with the id the client chose", created.data.exam._id, examId);
  check("the name is trimmed the way the endpoint trims it",
    created.data.exam.name, "Second Term Maths");
  check("the class name is resolved from the mirror, not left blank",
    created.data.exam.className, "Form 1");
  check("a new exam carries no subjects", created.data.exam.subjects, []);
  check("the row is in the mirror, not yet sent",
    docs.get("exam", examId)?._pending, true);

  // The screen that just created it reads it back.
  const readBack = api.handle({
    method: "GET", path: `/api/exams/${examId}`, query: { schoolId: SCHOOL },
  }, examCtx);
  check("and reading it back locally works", readBack?.status, 200);
  check("with its subjects, empty for now", readBack.data.exam.subjects, []);

  // ── An edit, behind the create ─────────────────────────────────────────
  const edited = api.handle({
    method: "PUT", path: `/api/exams/${examId}`, query: {},
    body: { schoolId: SCHOOL, name: "Second Term Mathematics", passMark: 40 },
  }, examCtx);

  check("the edit is accepted locally", edited?.status, 200);
  // THE ASSERTION FOR THE DROPPED-WRITE BUG. Not duplicate, and its own entry.
  check("and is NOT treated as a duplicate of the create", edited?.duplicate, false);
  check("so two requests are waiting", queue.summary().pending, 2);

  check("the mirror shows the new name", docs.get("exam", examId)?.name,
    "Second Term Mathematics");
  check("and keeps the fields the edit did not mention",
    docs.get("exam", examId)?.totalMarks, 80);

  // ── The connection comes back ──────────────────────────────────────────
  const examEngine = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["exam"],
  });

  await examEngine.cycle();

  check("both requests drained", queue.all().length, 0);
  check("and the row settled", docs.get("exam", examId)?._pending, false);

  const onServer = await Exam.findById(examId).lean();
  check("the server has the exam under the client's id", Boolean(onServer), true);
  check("there is exactly one of it",
    await Exam.countDocuments({ schoolId: SCHOOL, name: "Second Term Mathematics" }), 1);
  check("the edit was applied", onServer?.name, "Second Term Mathematics");
  check("and so was the second changed field", onServer?.passMark, 40);

  // What the create set and the edit never mentioned. If the edit had sent the
  // whole document this would still be 80 by luck; the assertion that matters is
  // the pair — a field the create set, and a field the create defaulted.
  check("a field only the create set survived the edit", onServer?.totalMarks, 80);
  check("a field neither of them mentioned kept the endpoint's default",
    onServer?.type, "mid_term");
  check("the class the create named is still there", onServer?.className, "Form 1");

  /**
   * ── Where the mirror's copy comes from ───────────────────────────────────
   *
   * NOT from the response. POST /api/exams answers with { exam: { …, subjects } },
   * and storing that would put a subjects array into the mirror — a field the
   * sync feed never sends, so the row would differ from every other machine's
   * copy of the same exam and GET /api/exams would answer with an extra key.
   *
   * The pull in the same cycle delivers the server's document instead, which is
   * why push happens before pull. Asserted rather than assumed, because the
   * engine does take the response's copy for a payment — where the receipt
   * number makes it necessary — and the difference is easy to lose.
   */
  const mirrored = docs.get("exam", examId);
  check("the mirror has no field the feed would not send",
    Object.prototype.hasOwnProperty.call(mirrored, "subjects"), false);
  check("and agrees with the server about the name", mirrored.name, onServer.name);
  check("including who created it, which the server attributes",
    mirrored.createdBy, onServer.createdBy);

  // The read endpoint now answers identically on both sides.
  await parity("one exam, after a round trip", `/api/exams/${examId}?schoolId=${SCHOOL}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an edit from a stale mirror does not revert somebody else ---");

  /**
   * ── The assertion that gives "only what changed" its teeth ───────────────
   *
   * A handler that sends the whole document looks correct in every test where
   * one machine is the only thing writing: the values it sends back are the
   * values that were already there.
   *
   * It is wrong the moment a second machine exists, which is the ordinary case
   * in a school office. The secretary edits the exam on the desktop while it is
   * offline; somebody in the next room has already changed a different field
   * from the web. If the queued request carries the desktop's whole idea of the
   * document, the field it never touched is written back from a copy made before
   * that change — and the other person's work is gone, with nothing to show it
   * ever happened.
   *
   * So: change a field on the server the way another machine would, edit a
   * DIFFERENT field offline from a mirror that has not seen it, and require both
   * changes to survive.
   */
  await Exam.collection.updateOne(
    { _id: examId },
    { $set: { instructions: "Bring a calculator", updatedAt: new Date() } }
  );
  check("the other machine's change is on the server",
    (await Exam.findById(examId).lean())?.instructions, "Bring a calculator");
  check("and this mirror has not seen it",
    docs.get("exam", examId)?.instructions, null);

  const staleEdit = api.handle({
    method: "PUT", path: `/api/exams/${examId}`, query: {},
    body: { schoolId: SCHOOL, passMark: 45 },
  }, examCtx);
  check("the offline edit is accepted", staleEdit?.status, 200);

  await examEngine.cycle();

  const afterBoth = await Exam.findById(examId).lean();
  check("this machine's change was applied", afterBoth?.passMark, 45);
  // THE ONE THIS SECTION EXISTS FOR.
  check("and the other machine's change was NOT reverted",
    afterBoth?.instructions, "Bring a calculator");
  check("the mirror catches up with both",
    docs.get("exam", examId)?.instructions, "Bring a calculator");
  check("including its own", docs.get("exam", examId)?.passMark, 45);

  // ── Re-staging it ──────────────────────────────────────────────────────
  const staged = api.handle({
    method: "PATCH", path: `/api/exams/${examId}/status`, query: {},
    body: { schoolId: SCHOOL, status: "scheduled" },
  }, examCtx);
  check("a status change is accepted locally", staged?.status, 200);
  check("and shows at once", docs.get("exam", examId)?.status, "scheduled");

  await examEngine.cycle();
  check("the server agrees after syncing",
    (await Exam.findById(examId).lean())?.status, "scheduled");

  // Two statuses are the server's business, for reasons in writes/exams.js.
  check("an invalid status is left to the server to refuse",
    api.handle({
      method: "PATCH", path: `/api/exams/${examId}/status`, query: {},
      body: { schoolId: SCHOOL, status: "halfway" },
    }, examCtx),
    null);
  check("and so is publishing, which changes every result summary",
    api.handle({
      method: "PATCH", path: `/api/exams/${examId}/status`, query: {},
      body: { schoolId: SCHOOL, status: "published" },
    }, examCtx),
    null);

  // An exam created WITH its subjects is one request and several documents, with
  // ids the endpoint generates — so it goes out rather than being queued.
  check("a create carrying subjects goes to the server",
    api.handle({
      method: "POST", path: "/api/exams", query: {},
      body: {
        schoolId: SCHOOL, name: "With Subjects", academicYear: YEAR, term: "term_2",
        subjects: [{ subjectId: "sub-1" }],
      },
    }, examCtx),
    null);

  // ── Archiving it ───────────────────────────────────────────────────────
  const archived = api.handle({
    method: "DELETE", path: `/api/exams/${examId}`, query: { schoolId: SCHOOL },
  }, examCtx);
  check("the archive is accepted locally", archived?.status, 200);
  check("with the endpoint's message, not the exam",
    archived.data.message, "Exam archived");

  /**
   * ── A second click, and where it is stopped ─────────────────────────────
   *
   * Not by the queue. The local row is archived in the same transaction that
   * queued the request, so the handler declines every later attempt and the
   * request goes to the network — where the endpoint answers its own 404.
   *
   * This started out as a dedupe key on the queued request, on the reasoning
   * that a repeat would take that 404 and stop the queue on work that had
   * succeeded. The key could never fire, and the assertion that was meant to
   * prove it works is what showed that: it read undefined, because nothing had
   * been queued at all.
   */
  const archivedAgain = api.handle({
    method: "DELETE", path: `/api/exams/${examId}`, query: { schoolId: SCHOOL },
  }, examCtx);
  check("archiving twice does not queue twice", archivedAgain, null);
  check("so one request is waiting, not two", queue.summary().pending, 1);

  await examEngine.cycle();
  examEngine.stop();

  const gone = await Exam.findById(examId).lean();
  check("the server archived it", Boolean(gone?.deletedAt), true);
  check("and set the status the endpoint sets", gone?.status, "archived");
  check("the queue is empty", queue.all().length, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the marks workflow, with no connection ---");

  /**
   * ── Why this one is worth a long section ─────────────────────────────────
   *
   * It is the part of the term a school cannot pause. Teachers enter marks and
   * submit them; the head approves or sends them back; reports go out. That
   * happens in a few days, and those are exactly the days when waiting for the
   * connection is not an option.
   *
   * The rule under test throughout: a handler must never queue something the
   * server will refuse. A refused write STOPS the outbox and waits for a person,
   * so a request the server would 400 or 409 does not merely fail — it holds up
   * everything behind it, including work with nothing to do with exams.
   */
  const PaymentPlanModel = require("../src/db/models/PaymentPlan");
  const StudentScore = require("../src/db/models/StudentScore");
  const ExamSubject  = require("../src/db/models/ExamSubject");

  // One subject with a coefficient of 2, so the scaling below is exercised
  // rather than assumed. Subject.coefficient is a plain multiplier; the exam
  // subject's weight is percentage-style, 100 meaning ×1.
  await Subject.collection.updateOne(
    { _id: "sub-3" }, { $set: { coefficient: 2, updatedAt: new Date() } }
  );
  const mirrorSubjects = async () =>
    docs.putMany("subject", JSON.parse(JSON.stringify(await Subject.find({}).lean())));
  await mirrorSubjects();

  const marksSession = {
    userId: "admin-1", schoolId: SCHOOL, permissions: ["exams.manage", "results.view"],
  };
  const marksCtx = { docs, meta, queue, session: marksSession };

  // A live exam for them to hang on. Created through the layer under test and
  // synced, so what follows is built on the same path a school would take.
  const forMarks = api.handle({
    method: "POST", path: "/api/exams", query: {},
    body: {
      schoolId: SCHOOL, name: "End of Term", academicYear: YEAR,
      term: "term_3", classId: "cls-1",
    },
  }, marksCtx);
  const marksExamId = forMarks.data.serverId;

  const marksEngine = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["exam", "examSubject", "studentScore"],
  });
  await marksEngine.cycle();
  check("the exam for the marks workflow is on the server",
    Boolean(await Exam.findById(marksExamId).lean()), true);

  // ── Adding subjects ────────────────────────────────────────────────────
  const added = api.handle({
    method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
    body: { schoolId: SCHOOL, subjectId: "sub-1", teacherId: "t1", classId: "cls-1" },
  }, marksCtx);

  check("a subject is added locally", added?.status, 201);
  check("and queued", added?.queued, true);
  check("with the subject's name read from the mirror",
    added.data.subject.subjectName, "Mathematics");
  check("and the teacher's, which the screen prints",
    Boolean(added.data.subject.teacherName), true);
  check("a subject with no coefficient set weighs 100 — coefficient 1",
    added.data.subject.weight, 100);
  check("and starts pending, not submitted",
    added.data.subject.submissionStatus, "pending");

  // THE SCALING ASSERTION. Getting this wrong by a factor of a hundred rescales
  // every average in the class.
  const weighted = api.handle({
    method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
    body: { schoolId: SCHOOL, subjectId: "sub-3", classId: "cls-1" },
  }, marksCtx);
  check("a coefficient of 2 becomes a weight of 200", weighted.data.subject.weight, 200);

  // An explicit weight is the per-exam override and wins over the coefficient.
  const override = api.handle({
    method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
    body: { schoolId: SCHOOL, subjectId: "sub-4", classId: "cls-1", weight: 150 },
  }, marksCtx);
  check("an explicit weight overrides the subject's coefficient",
    override.data.subject.weight, 150);

  // ── What must NOT be queued ────────────────────────────────────────────
  //
  // Each of these would come back a 4xx and stop the outbox on a request that
  // can never succeed.
  check("the same subject twice for one class is not queued",
    api.handle({
      method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
      body: { schoolId: SCHOOL, subjectId: "sub-1", classId: "cls-1" },
    }, marksCtx),
    null);

  check("nor is a subject with no subjectId",
    api.handle({
      method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
      body: { schoolId: SCHOOL, classId: "cls-1" },
    }, marksCtx),
    null);

  check("nor one for an exam this machine does not hold",
    api.handle({
      method: "POST", path: "/api/exams/no-such-exam/subjects", query: {},
      body: { schoolId: SCHOOL, subjectId: "sub-5" },
    }, marksCtx),
    null);

  // A teacher's own machine does not mirror the staff directory — users.manage
  // gates it — so the name it would store is a blank on the screen. Simulated by
  // removing the row, which is the state that machine is really in.
  docs.forget("user", "t2");
  check("nor one naming a teacher whose row is not mirrored",
    api.handle({
      method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
      body: { schoolId: SCHOOL, subjectId: "sub-5", classId: "cls-2", teacherId: "t2" },
    }, marksCtx),
    null);
  docs.putMany("user", JSON.parse(JSON.stringify(await UserModel.find({}).lean())));

  check("but it is queued once that row is there",
    api.handle({
      method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
      body: { schoolId: SCHOOL, subjectId: "sub-5", classId: "cls-2", teacherId: "t2" },
    }, marksCtx)?.status,
    201);

  const queuedBefore = queue.summary().pending;
  await marksEngine.cycle();
  check("all of them reached the server", queue.all().length, 0);
  check("there were four to send, not five", queuedBefore, 4);

  const onServerSubjects = await ExamSubject.find({ examId: marksExamId }).lean();
  check("the server holds four exam subjects", onServerSubjects.length, 4);
  check("under the ids this machine chose",
    onServerSubjects.map((s) => s._id).sort().join(),
    docs.find("examSubject", { examId: marksExamId }).map((s) => s._id).sort().join());
  check("and agrees about the scaled weight",
    onServerSubjects.find((s) => s.subjectId === "sub-3")?.weight, 200);
  check("and about the override",
    onServerSubjects.find((s) => s.subjectId === "sub-4")?.weight, 150);

  await parity("the subjects on an exam, after a round trip",
    "/api/exams/" + marksExamId + "/submissions?schoolId=" + SCHOOL);

  // ── Setting a coefficient ──────────────────────────────────────────────
  const mathsSubject = docs
    .find("examSubject", { examId: marksExamId })
    .find((s) => s.subjectId === "sub-1");

  const settings = api.handle({
    method: "PUT",
    path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id,
    query: {},
    body: { schoolId: SCHOOL, weight: 300 },
  }, marksCtx);
  check("the coefficient change is accepted", settings?.status, 200);
  check("and shows at once", docs.get("examSubject", mathsSubject._id)?.weight, 300);
  // Nothing has been marked yet, so nothing has gone stale.
  check("with nothing to reprocess yet", settings.data.reprocessRequired, false);

  // It rescales every average in the class, so it is a head's decision. A
  // queued request coming back 403 would stop the outbox.
  check("somebody without exams.manage is not queued",
    api.handle({
      method: "PUT",
      path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id,
      query: {},
      body: { schoolId: SCHOOL, weight: 250 },
    }, { docs, meta, queue, session: { ...marksSession, permissions: ["exams.view"] } }),
    null);

  check("a weight of zero is not queued either",
    api.handle({
      method: "PUT",
      path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id,
      query: {}, body: { schoolId: SCHOOL, weight: 0 },
    }, marksCtx),
    null);

  check("nor a request that changes nothing",
    api.handle({
      method: "PUT",
      path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id,
      query: {}, body: { schoolId: SCHOOL },
    }, marksCtx),
    null);

  await marksEngine.cycle();
  check("the server took the new coefficient",
    (await ExamSubject.findById(mathsSubject._id).lean())?.weight, 300);

  // ── Once marks exist, a coefficient change makes them stale ────────────
  //
  // The endpoint refuses to recompute silently — that would rewrite results an
  // admin may already have published — and tells the caller instead. A local
  // answer that always said false would leave a screen presenting stale
  // averages as current.
  await StudentScore.collection.insertMany([
    { _id: "sc-1", schoolId: SCHOOL, examId: marksExamId, subjectId: "sub-1",
      classId: "cls-1", studentId: "p1", score: 14, deletedAt: null, updatedAt: new Date() },
    { _id: "sc-2", schoolId: SCHOOL, examId: marksExamId, subjectId: "sub-1",
      classId: "cls-1", studentId: "p2", score: null, deletedAt: null, updatedAt: new Date() },
  ]);
  await marksEngine.cycle();
  check("the marks reached the mirror", docs.count("studentScore", { examId: marksExamId }), 2);

  const restaled = api.handle({
    method: "PUT",
    path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id,
    query: {}, body: { schoolId: SCHOOL, maxScore: 20 },
  }, marksCtx);
  check("now the caller is told the averages need reprocessing",
    restaled.data.reprocessRequired, true);

  // A field that does NOT invalidate an average must not claim it does, or the
  // screen asks for a reprocess after every edit and the warning stops meaning
  // anything.
  const harmless = api.handle({
    method: "PUT",
    path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id,
    query: {}, body: { schoolId: SCHOOL, isOral: true },
  }, marksCtx);
  check("but a change that does not affect averages does not",
    harmless.data.reprocessRequired, false);

  await marksEngine.cycle();

  // The submissions screen counts ENTERED marks per subject and class — the
  // blank row is what it is asking about.
  const progress = api.handle({
    method: "GET", path: "/api/exams/" + marksExamId + "/submissions",
    query: { schoolId: SCHOOL },
  }, marksCtx);
  check("one of the two marks is entered",
    progress.data.submissions.find((s) => s.subjectId === "sub-1")?.totalScoresEntered, 1);
  check("and a subject nobody has marked shows none",
    progress.data.submissions.find((s) => s.subjectId === "sub-3")?.totalScoresEntered, 0);


  /**
   * ── One subject, two classes ─────────────────────────────────────────────
   *
   * The assertions above pass whether the count is per subject-and-class or per
   * subject alone, because every subject in the fixtures sits in exactly one
   * class. That is the shape of gap worth minding: the comment in the handler
   * says the count must be per class, and nothing was checking it.
   *
   * An exam covering several classes has a row per class, and each row is one
   * teacher's work. Counting by subject alone makes every row report the whole
   * exam's progress — so a class nobody has touched shows as finished the moment
   * another class is marked, and a head chasing outstanding marks chases nobody.
   */
  const alsoInCls2 = api.handle({
    method: "POST", path: "/api/exams/" + marksExamId + "/subjects", query: {},
    body: { schoolId: SCHOOL, subjectId: "sub-1", classId: "cls-2" },
  }, marksCtx);
  check("the same subject is allowed in another class", alsoInCls2?.status, 201);

  await StudentScore.collection.insertMany([
    { _id: "sc-3", schoolId: SCHOOL, examId: marksExamId, subjectId: "sub-1",
      classId: "cls-2", studentId: "p9", score: 11, deletedAt: null, updatedAt: new Date() },
    { _id: "sc-4", schoolId: SCHOOL, examId: marksExamId, subjectId: "sub-1",
      classId: "cls-2", studentId: "p10", score: 17, deletedAt: null, updatedAt: new Date() },
  ]);
  await marksEngine.cycle();

  const perClass = api.handle({
    method: "GET", path: "/api/exams/" + marksExamId + "/submissions",
    query: { schoolId: SCHOOL },
  }, marksCtx).data.submissions.filter((s) => s.subjectId === "sub-1");

  check("there is a row for each class", perClass.length, 2);
  check("the first class counts only its own mark",
    perClass.find((s) => s.classId === "cls-1")?.totalScoresEntered, 1);
  check("and the second counts only its two",
    perClass.find((s) => s.classId === "cls-2")?.totalScoresEntered, 2);

  await parity("progress across two classes",
    "/api/exams/" + marksExamId + "/submissions?schoolId=" + SCHOOL);

  await parity("marks entered for an exam",
    "/api/exams/" + marksExamId + "/scores?schoolId=" + SCHOOL);
  await parity("progress per subject",
    "/api/exams/" + marksExamId + "/submissions?schoolId=" + SCHOOL);

  // ── Sending marks back, then accepting them ────────────────────────────
  check("a rejection with no reason is not queued",
    api.handle({
      method: "PATCH",
      path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id + "/reject",
      query: {}, body: { schoolId: SCHOOL, reason: "   " },
    }, marksCtx),
    null);

  const rejected = api.handle({
    method: "PATCH",
    path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id + "/reject",
    query: {}, body: { schoolId: SCHOOL, reason: "  Two students are missing  " },
  }, marksCtx);
  check("a rejection with one is", rejected?.status, 200);
  check("the reason is trimmed, since the teacher reads it",
    rejected.data.subject.rejectReason, "Two students are missing");
  check("and the status says so", rejected.data.subject.submissionStatus, "rejected");

  const approved = api.handle({
    method: "PATCH",
    path: "/api/exams/" + marksExamId + "/subjects/" + mathsSubject._id + "/approve",
    query: {}, body: { schoolId: SCHOOL },
  }, marksCtx);
  check("approving after a rejection works", approved?.status, 200);
  // A subject approved after being sent back must not still read as rejected,
  // which is what a screen showing both stamps would say.
  check("and clears the rejection", approved.data.subject.rejectReason, null);
  check("along with who rejected it", approved.data.subject.rejectedBy, null);
  check("leaving only the approval", approved.data.subject.submissionStatus, "approved");

  await marksEngine.cycle();
  marksEngine.stop();

  const finalSubject = await ExamSubject.findById(mathsSubject._id).lean();
  check("the server ends up approved", finalSubject?.submissionStatus, "approved");
  check("with the rejection cleared there too", finalSubject?.rejectReason, null);
  check("and the mirror agrees",
    docs.get("examSubject", mathsSubject._id)?.submissionStatus, "approved");
  check("the queue is empty", queue.all().length, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a price list published with no connection ---");

  /**
   * ── Every decline is checked against a real refusal ──────────────────────
   *
   * A local handler that declines too readily is invisible: the request goes to
   * the network, the screen behaves as it always did, and nobody notices the
   * offline path is dead. A handler that declines too rarely is worse — it
   * queues a request the server will refuse, and a refused write STOPS the
   * outbox and waits for a person, holding up every payment behind it.
   *
   * So each decline below is paired with the same request sent to the REAL
   * endpoint, asserting it really would have been a 4xx. That is the only way
   * to know a decline is a judgement about the server rather than a guess.
   */
  const feesSession = {
    userId: "admin-1", schoolId: SCHOOL,
    permissions: ["fees.manage", "fees.plan", "fees.view"],
  };
  const feesCtx = { docs, meta, queue, session: feesSession };

  /** The same body, straight at the endpoint, so the refusal is not assumed. */
  const askServer = async (path, body, method = "POST") => {
    const res = await fetch("http://127.0.0.1:" + port + path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const validStructure = {
    schoolId: SCHOOL, academicYear: YEAR, term: "Term 3",
    classIds: ["cls-3"], dueDate: "2027-04-15",
    items: [{ code: "TUITION", label: "Tuition", amount: 80000 }],
  };

  const published = api.handle({
    method: "POST", path: "/api/fees/structures", query: {}, body: validStructure,
  }, feesCtx);

  check("a valid price list is accepted locally", published?.status, 201);
  check("and queued", published?.queued, true);
  const structureId = published.data.data._id;
  check("the due date is stored as an instant, not the string that arrived",
    published.data.data.dueDate, "2027-04-15T00:00:00.000Z");
  check("with no penalty rule unless one was asked for",
    published.data.data.penalty, { mode: "none", amount: 0, graceDays: 0 });
  check("and it is in the mirror", docs.get("feeStructure", structureId)?.isActive, true);

  // ── The multikey clash, which is the subtle one ─────────────────────────
  //
  // fs1 bills cls-1 AND cls-2 for Term 1. A new structure for cls-2 and cls-3
  // collides on cls-2 though neither list equals the other, because the unique
  // index is over the classIds ARRAY.
  const overlapping = {
    schoolId: SCHOOL, academicYear: YEAR, term: "Term 1",
    classIds: ["cls-2", "cls-3"], dueDate: "2026-09-20",
    items: [{ code: "TUITION", label: "Tuition", amount: 70000 }],
  };
  check("a structure overlapping an active one on ONE class is not queued",
    api.handle({ method: "POST", path: "/api/fees/structures", query: {}, body: overlapping }, feesCtx),
    null);
  const overlapRefused = await askServer("/api/fees/structures", overlapping);
  check("and the server really would have refused it", overlapRefused.status, 409);
  check("naming what happened", overlapRefused.body.code, "STRUCTURE_EXISTS");

  // A different term is a different key, so it is allowed — the check must not
  // be "any structure for this class".
  check("but the same classes in another term are fine",
    api.handle({
      method: "POST", path: "/api/fees/structures", query: {},
      body: { ...overlapping, term: "Term 9" },
    }, feesCtx)?.status,
    201);

  // An INACTIVE structure does not hold the key: the index is partial, and
  // deactivating is exactly how a school publishes a replacement.
  check("and a year whose only structure is inactive is fine too",
    api.handle({
      method: "POST", path: "/api/fees/structures", query: {},
      body: { ...validStructure, academicYear: "2025-2026", term: "Term 1", classIds: ["cls-1"] },
    }, feesCtx)?.status,
    201);

  // ── The validations, each against the real refusal ──────────────────────
  const rejections = [
    ["no academic year",        { ...validStructure, academicYear: undefined, term: "Term 4" }],
    ["a due date that is prose", { ...validStructure, dueDate: "next friday", term: "Term 4" }],
    ["no due date at all",       { ...validStructure, dueDate: undefined, term: "Term 4" }],
    ["an empty item list",       { ...validStructure, items: [], term: "Term 4" }],
    ["an item with no code",     { ...validStructure, term: "Term 4",
                                   items: [{ label: "Tuition", amount: 5000 }] }],
    // XAF has no minor unit, so this is a typo rather than a rounding question.
    ["a fractional amount",      { ...validStructure, term: "Term 4",
                                   items: [{ code: "T", label: "Tuition", amount: 7500.5 }] }],
    ["a percentage penalty over 100", { ...validStructure, term: "Term 4",
                                   penalty: { mode: "percent", amount: 150 } }],
  ];

  for (const [what, body] of rejections) {
    check("not queued: " + what,
      api.handle({ method: "POST", path: "/api/fees/structures", query: {}, body }, feesCtx),
      null);
    const refused = await askServer("/api/fees/structures", body);
    check("and the server refuses it: " + what, refused.status >= 400 && refused.status < 500, true);
  }

  // Publishing a price list is fees.manage, and a queued 403 would stop the
  // outbox as surely as a 409.
  check("somebody without fees.manage is not queued",
    api.handle({
      method: "POST", path: "/api/fees/structures", query: {},
      body: { ...validStructure, term: "Term 5" },
    }, { docs, meta, queue, session: { ...feesSession, permissions: ["fees.view"] } }),
    null);

  // ── Reconnecting ───────────────────────────────────────────────────────
  const feesEngine = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["feeStructure", "paymentPlan"],
  });
  await feesEngine.cycle();

  check("the queue drained", queue.all().length, 0);
  const storedStructure = await FeeStructure.findById(structureId).lean();
  check("the server has the structure under the client's id",
    Boolean(storedStructure), true);
  check("with the items as published", storedStructure?.items?.[0]?.amount, 80000);
  check("and the due date the bursar typed",
    storedStructure?.dueDate?.toISOString(), "2027-04-15T00:00:00.000Z");

  await parity("the price lists, after a round trip",
    "/api/fees/structures?schoolId=" + SCHOOL);

  // ── Taking one out of use ──────────────────────────────────────────────
  const deactivated = api.handle({
    method: "PATCH", path: "/api/fees/structures/" + structureId + "/deactivate",
    query: {}, body: { schoolId: SCHOOL },
  }, feesCtx);
  check("deactivating is accepted locally", deactivated?.status, 200);
  check("and shows at once", docs.get("feeStructure", structureId)?.isActive, false);

  await feesEngine.cycle();
  check("the server agrees",
    (await FeeStructure.findById(structureId).lean())?.isActive, false);

  // Which releases the key: the classes it billed can be published again. This
  // is the whole point of deactivating rather than deleting.
  check("so those classes can be billed by a replacement",
    api.handle({
      method: "POST", path: "/api/fees/structures", query: {},
      body: { ...validStructure, dueDate: "2027-04-20" },
    }, feesCtx)?.status,
    201);
  await feesEngine.cycle();
  check("and the server takes the replacement too",
    await FeeStructure.countDocuments({
      schoolId: SCHOOL, academicYear: YEAR, term: "Term 3", isActive: true,
    }),
    1);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an instalment plan cancelled with no connection ---");

  // A plan the school agreed. Inserted on the server and pulled, so the row
  // under test is the server's own shape rather than one written here.
  await PaymentPlanModel.collection.insertOne({
    _id: "pl-offline", schoolId: SCHOOL, studentId: "p1", academicYear: YEAR,
    term: null, status: "active", reason: "Family paying monthly",
    instalments: [
      { seq: 1, amount: 20000, dueDate: new Date("2026-10-01") },
      { seq: 2, amount: 20000, dueDate: new Date("2026-11-01") },
    ],
    deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  });
  await feesEngine.cycle();
  check("the plan reached the mirror",
    docs.get("paymentPlan", "pl-offline")?.status, "active");

  await parity("the plans a school has agreed", "/api/fees/plans?schoolId=" + SCHOOL);
  await parity("only the cancelled ones",
    "/api/fees/plans?schoolId=" + SCHOOL + "&status=cancelled");

  // A reason is required, and the endpoint says so with a 400.
  check("cancelling with no reason is not queued",
    api.handle({
      method: "POST", path: "/api/fees/plans/pl-offline/cancel",
      query: {}, body: { schoolId: SCHOOL },
    }, feesCtx),
    null);
  const noReason = await askServer("/api/fees/plans/pl-offline/cancel", { schoolId: SCHOOL });
  check("as the server confirms", noReason.status, 400);
  check("with its code", noReason.body.code, "REASON_REQUIRED");

  const cancelled = api.handle({
    method: "POST", path: "/api/fees/plans/pl-offline/cancel",
    query: {}, body: { schoolId: SCHOOL, reason: "  Family stopped paying  " },
  }, feesCtx);
  check("cancelling with one is accepted", cancelled?.status, 200);
  check("the reason is trimmed", cancelled.data.data.cancelledReason, "Family stopped paying");
  check("and the status changes", cancelled.data.data.status, "cancelled");

  // Cancelling a cancelled plan is a 400, and a screen showing a stale list
  // could easily provoke it.
  check("cancelling it twice is not queued",
    api.handle({
      method: "POST", path: "/api/fees/plans/pl-offline/cancel",
      query: {}, body: { schoolId: SCHOOL, reason: "again" },
    }, feesCtx),
    null);

  await feesEngine.cycle();
  feesEngine.stop();

  const finalPlan = await PaymentPlanModel.findById("pl-offline").lean();
  check("the server cancelled it", finalPlan?.status, "cancelled");
  check("keeping the reason for next year", finalPlan?.cancelledReason, "Family stopped paying");
  check("and it is still there, not deleted", Boolean(finalPlan), true);
  check("the queue is empty", queue.all().length, 0);

  await parity("the plans once one is cancelled", "/api/fees/plans?schoolId=" + SCHOOL);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a payment reversed with no connection ---");

  /**
   * ── The first write here that changes two documents ──────────────────────
   *
   * A reversal appends a row with the opposite sign and STAMPS the original with
   * reversedById. The stamp is not bookkeeping: it is what stops the same
   * payment being reversed twice. Without it the screen goes on offering
   * Reverse, somebody presses it, the endpoint answers 409 ALREADY_REVERSED —
   * and a 409 stops the outbox and waits for a person, with every payment behind
   * it held up.
   *
   * So both rows commit with the request or neither does, and the queue records
   * the second one so the engine settles it too. A row nothing settles stays
   * pending for ever, and a pending row is deliberately never overwritten by a
   * pull, so it would disagree with the school's record permanently.
   */
  const { DEVICE_RECEIPT } = require("../../shared/receipts");

  const reverseSession = {
    userId: "admin-1", schoolId: SCHOOL,
    permissions: ["fees.manage", "fees.view"],
  };
  const reverseCtx = { docs, meta, queue, session: reverseSession };

  // y1 is a synced payment of 30000 from the fixtures — the ordinary case, a
  // row that came from the server rather than one written on this machine.
  const beforeReversal = api.handle({
    method: "GET", path: "/api/fees/students/p1",
    query: { schoolId: SCHOOL, academicYear: YEAR },
  }, reverseCtx).data.data.totals.paid;

  const reversed = api.handle({
    method: "POST", path: "/api/fees/payments/y1/reverse", query: {},
    body: { schoolId: SCHOOL, reason: "  Wrong student  " },
  }, reverseCtx);

  check("the reversal is accepted locally", reversed?.status, 201);
  check("and queued", reversed?.queued, true);

  const reversalRow = reversed.data.data;
  check("it is the opposite sign, not a flag", reversalRow.amount, -30000);
  check("pointing at the original", reversalRow.reversesId, "y1");
  check("with the reason trimmed", reversalRow.reversalReason, "Wrong student");
  check("and a receipt number in this installation's own space",
    DEVICE_RECEIPT.test(reversalRow.receiptNo), true);
  check("marked as having been made on a desktop", reversalRow.source, "desktop");

  // BOTH rows, in one transaction.
  check("the reversal row is in the mirror",
    docs.get("feePayment", reversalRow._id)?.amount, -30000);
  check("and the ORIGINAL is stamped", docs.get("feePayment", "y1")?.reversedById,
    reversalRow._id);
  check("both provisional until it lands", [
    docs.get("feePayment", "y1")._pending,
    docs.get("feePayment", reversalRow._id)._pending,
  ], [true, true]);

  // The balance the bursar is shown has to be the one AFTER the reversal — the
  // figure they were trying to correct is exactly the wrong answer here.
  check("the totals in the reply already exclude the money",
    reversed.data.totals.paid, beforeReversal - 30000);
  check("and the ledger agrees",
    api.handle({
      method: "GET", path: "/api/fees/students/p1",
      query: { schoolId: SCHOOL, academicYear: YEAR },
    }, reverseCtx).data.data.totals.paid,
    beforeReversal - 30000);

  // ── What must NOT be queued ────────────────────────────────────────────
  //
  // The stamp is what makes the first of these possible to detect at all.
  check("reversing it again is not queued",
    api.handle({
      method: "POST", path: "/api/fees/payments/y1/reverse", query: {},
      body: { schoolId: SCHOOL, reason: "again" },
    }, reverseCtx),
    null);

  // y2r is itself a reversal, from the fixtures. Reversing a reversal is a 409.
  check("reversing a reversal is not queued",
    api.handle({
      method: "POST", path: "/api/fees/payments/y2r/reverse", query: {},
      body: { schoolId: SCHOOL, reason: "no" },
    }, reverseCtx),
    null);

  check("nor is one with no reason",
    api.handle({
      method: "POST", path: "/api/fees/payments/y3/reverse", query: {},
      body: { schoolId: SCHOOL, reason: "   " },
    }, reverseCtx),
    null);

  check("nor one from somebody without fees.manage",
    api.handle({
      method: "POST", path: "/api/fees/payments/y3/reverse", query: {},
      body: { schoolId: SCHOOL, reason: "typo" },
    }, { docs, meta, queue, session: { ...reverseSession, permissions: ["fees.view"] } }),
    null);

  // ── Reconnecting ───────────────────────────────────────────────────────
  const reverseEngine = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["feePayment"],
  });
  await reverseEngine.cycle();

  check("the request drained", queue.all().length, 0);
  check("the reversal row settled", docs.get("feePayment", reversalRow._id)?._pending, false);
  // The row the engine only knows about because the queue entry named it.
  check("and so did the original it stamped",
    docs.get("feePayment", "y1")?._pending, false);

  const storedReversal = await FeePayment.findById(reversalRow._id).lean();
  check("the server has the reversal under the client's id",
    Boolean(storedReversal), true);
  check("with the amount unchanged", storedReversal?.amount, -30000);
  check("and the receipt number that was printed",
    storedReversal?.receiptNo, reversalRow.receiptNo);
  check("attributed by the server, not the client", storedReversal?.receivedBy, "admin-1");

  const storedOriginal = await FeePayment.findById("y1").lean();
  check("the server stamped the original too",
    storedOriginal?.reversedById, reversalRow._id);
  check("with the same reason", storedOriginal?.reversalReason, "Wrong student");

  /**
   * ── THE ASSERTION THE ORDERING FIX EXISTS FOR ────────────────────────────
   *
   * The same request again, at the real endpoint, with the same _id — a queued
   * write sent twice because the connection dropped after it arrived.
   *
   * A successful reversal sets original.reversedById, which is exactly what the
   * ALREADY_REVERSED check refuses. So the endpoint has to look for the reversal
   * BY ITS OWN ID first, or a replay of a request that worked is answered 409
   * and stops the queue on work that was already done. The two cases are
   * otherwise identical from the server's side: "reversed by the request I am
   * replaying" and "reversed by somebody else".
   */
  const replayed = await fetch(
    "http://127.0.0.1:" + port + "/api/fees/payments/y1/reverse",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({
        _id: reversalRow._id, schoolId: SCHOOL,
        reason: "Wrong student", receiptNo: reversalRow.receiptNo,
      }),
    }
  );
  const replayedBody = await replayed.json();
  check("replaying the reversal is a success, not a conflict", replayed.status, 200);
  check("and says so, so the queue can mark it done", replayedBody.replay, true);
  check("returning the row already stored", replayedBody.data._id, reversalRow._id);
  check("without a second reversal appearing",
    await FeePayment.countDocuments({ reversesId: "y1", deletedAt: null }), 1);

  // A DIFFERENT id against an already-reversed payment is the real conflict, and
  // must still stop the queue.
  const genuineClash = await fetch(
    "http://127.0.0.1:" + port + "/api/fees/payments/y1/reverse",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ _id: "some-other-reversal", schoolId: SCHOOL, reason: "again" }),
    }
  );
  const clashBody = await genuineClash.json();
  check("but somebody else's reversal of the same payment is refused",
    genuineClash.status, 409);
  check("naming what happened", clashBody.code, "ALREADY_REVERSED");

  // And the pair nets to zero on both sides, which is the arithmetic a family's
  // balance depends on.
  /**
   * ── The pull is made to run, because these fixtures stop it ──────────────
   *
   * The sync cursor is a high-water mark over (updatedAt, _id). These fixtures
   * are dated across a school year — 2026-09, 2027-01 — which is AHEAD of the
   * real clock this suite runs on, so after one pull the cursor sits in the
   * future. Every row created during the run carries a real timestamp that sorts
   * before it and is skipped for ever: the reversal the server stored, the
   * server's stamp on the original, and "impersonator" from the receipt section
   * above all stayed invisible to this mirror.
   *
   * That is an artefact of dated fixtures. It is also a real property of the
   * design worth knowing about, and it is written down in src/config/syncFeed.js
   * beside the cursor rather than only here.
   *
   * Cleared so the comparison below is against a mirror that has actually pulled
   * — which is the state a school's machine is in, and which is what makes the
   * assertions about the server's own values mean anything.
   */
  db.prepare("DELETE FROM sync_state WHERE collection = ?").run("feePayment");
  await reverseEngine.cycle();

  check("the pull delivered the row the endpoint created directly",
    docs.get("feePayment", "impersonator")?.amount, 500);
  check("and the server's version of the reversal replaced the local copy",
    Object.prototype.hasOwnProperty.call(docs.get("feePayment", reversalRow._id), "isReversal"),
    false);
  check("the mirror agrees with the server about the stamped original",
    docs.get("feePayment", "y1")?.source, storedOriginal?.source);

  await parity("the ledger once a payment is reversed",
    "/api/fees/students/p1?schoolId=" + SCHOOL + "&academicYear=" + YEAR);

  reverseEngine.stop();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a register taken in a classroom with no connection ---");

  /**
   * ── The case the whole layer exists for ──────────────────────────────────
   *
   * A classroom is where a school is least likely to have a connection and most
   * certain to need one. The register is taken at a fixed moment for a room full
   * of children and cannot wait.
   *
   * The interesting part is not the queueing, which is by now ordinary. It is
   * IDENTITY. The endpoints upsert on (school, class, subject, student, day), so
   * marking twice corrects the row rather than adding one — but the row's _id
   * used to be a fresh uuid invented by whoever inserted first, and that turns a
   * correction into a duplicate the moment two machines are involved. The
   * scenario is played out below with the office marking the same class from the
   * web while the classroom is offline.
   */
  const StudentAttendanceModel = require("../src/db/models/Attendance").StudentAttendance;
  const { attendanceId: derivedId } = require("../../shared/attendance");

  const REGISTER_DAY = "2026-10-06";

  const teachSession = {
    userId: "admin-1", schoolId: SCHOOL,
    permissions: ["attendance.mark", "attendance.view", "students.view"],
  };
  const teachCtx = { docs, meta, queue, session: teachSession };

  // ── The roster the screen lists ────────────────────────────────────────
  await parity("the register roster for a class",
    "/api/attendance/students/roster?schoolId=" + SCHOOL + "&classId=cls-1");
  await parity("and for the whole school",
    "/api/attendance/students/roster?schoolId=" + SCHOOL);

  // The projection is nine named fields. A mirror answering with the whole
  // student document would hand a screen a guardian's telephone number the
  // server never sent it.
  const roster = api.handle({
    method: "GET", path: "/api/attendance/students/roster",
    query: { schoolId: SCHOOL, classId: "cls-1" },
  }, teachCtx).data.students;
  check("the roster carries only the fields the endpoint selects",
    Object.keys(roster[0]).sort().join(),
    ["_id", "admissionNo", "className", "classId", "email", "firstName",
     "grade", "lastName", "studentName"].sort().join());
  check("and nothing from the rest of the record",
    roster.some((s) => "guardianPhone" in s), false);

  // ── The register itself ────────────────────────────────────────────────
  const marked = api.handle({
    method: "POST", path: "/api/attendance/students/bulk", query: {},
    body: {
      schoolId: SCHOOL, classId: "cls-1", date: REGISTER_DAY,
      records: [
        { studentId: "p1", status: "present" },
        { studentId: "p2", status: "absent", note: "sick" },
        // Two the endpoint rejects without failing the batch: a status it does
        // not know, and a pupil who is not in this class.
        { studentId: "p3", status: "present" },
        { studentId: "p1", status: "here" },
      ],
    },
  }, teachCtx);

  check("the register is accepted locally", marked?.status, 201);
  check("and queued", marked?.queued, true);
  check("two marks saved", marked.data.saved, 2);
  check("two rejected", marked.data.failed, 2);
  check("a pupil from another class is named as such",
    marked.data.failedRecords.find((r) => r.studentId === "p3")?.reason,
    "Student not found in this class");
  check("and an unknown status likewise",
    marked.data.failedRecords.find((r) => r.status === "here")?.reason,
    "Invalid studentId or status");

  // Every saved mark is a row, and the whole batch is one queue entry.
  check("both rows are in the mirror",
    docs.count("studentAttendance", { classId: "cls-1", date: REGISTER_DAY }), 2);
  check("as one request, not two", queue.summary().pending, 1);
  check("with the id derived from the natural key",
    Boolean(docs.get("studentAttendance", derivedId({
      schoolId: SCHOOL, classId: "cls-1", subjectId: null,
      studentId: "p1", date: REGISTER_DAY,
    }))),
    true);

  // A batch in which nothing at all would be saved is not queued: the endpoint
  // would write nothing either.
  check("a register where no id belongs to the class is not queued",
    api.handle({
      method: "POST", path: "/api/attendance/students/bulk", query: {},
      body: {
        schoolId: SCHOOL, classId: "cls-1", date: REGISTER_DAY,
        records: [{ studentId: "p3", status: "present" }],
      },
    }, teachCtx),
    null);

  check("nor one with no records",
    api.handle({
      method: "POST", path: "/api/attendance/students/bulk", query: {},
      body: { schoolId: SCHOOL, classId: "cls-1", records: [] },
    }, teachCtx),
    null);

  /**
   * ── THE DUPLICATE THIS DESIGN PREVENTS ───────────────────────────────────
   *
   * While the classroom register sits in the queue, the office marks the same
   * pupil for the same day from the web. The server now holds that row — and
   * under the old design it held it under an id this machine had never seen, so
   * the queued request would update the server's row and the next pull would
   * deliver a SECOND row for one child on one day.
   *
   * A register showing a pupil twice is visible. A report counting them twice is
   * not, which is why this is asserted rather than trusted.
   */
  const fromTheOffice = await fetch(
    "http://127.0.0.1:" + port + "/api/attendance/students",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({
        schoolId: SCHOOL, classId: "cls-1", studentId: "p1",
        date: REGISTER_DAY, status: "late",
      }),
    }
  );
  check("the office's mark is accepted by the server", fromTheOffice.status, 201);
  check("under the id both sides derive",
    (await fromTheOffice.json()).record._id,
    derivedId({ schoolId: SCHOOL, classId: "cls-1", subjectId: null,
                studentId: "p1", date: REGISTER_DAY }));

  // Now the classroom reconnects.
  const registerEngine = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["studentAttendance"],
  });

  // These fixtures are dated across a school year, so the cursor is ahead of the
  // real clock and nothing written during this run would be pulled. See the note
  // in the reversal section above, and beside encodeCursor.
  db.prepare("DELETE FROM sync_state WHERE collection = ?").run("studentAttendance");

  await registerEngine.cycle();
  registerEngine.stop();

  check("the register reached the server", queue.all().length, 0);

  const p1Rows = await StudentAttendanceModel.find({
    schoolId: SCHOOL, classId: "cls-1", studentId: "p1", date: REGISTER_DAY,
  }).lean();
  check("the server has ONE row for that pupil on that day", p1Rows.length, 1);
  // The classroom marked present after the office marked late, and the
  // classroom's request arrived last.
  check("holding what the register said", p1Rows[0]?.status, "present");

  // THE ASSERTION THE DERIVED ID EXISTS FOR.
  check("and this machine has ONE row for them too",
    docs.count("studentAttendance", {
      classId: "cls-1", studentId: "p1", date: REGISTER_DAY,
    }),
    1);
  check("which is the same row the server has",
    docs.get("studentAttendance", p1Rows[0]._id)?.status, "present");

  await parity("the marks for that day",
    "/api/attendance/students?schoolId=" + SCHOOL + "&classId=cls-1&date=" + REGISTER_DAY);

  // ── A correction, which must not look like a new mark ──────────────────
  const firstTaken = docs.get("studentAttendance", p1Rows[0]._id).createdAt;

  const corrected = api.handle({
    method: "POST", path: "/api/attendance/students", query: {},
    body: {
      schoolId: SCHOOL, classId: "cls-1", studentId: "p1",
      date: REGISTER_DAY, status: "late", note: "arrived at 9",
    },
  }, teachCtx);
  check("a correction is accepted", corrected?.status, 201);
  check("on the same row", corrected.data.record._id, p1Rows[0]._id);
  check("changing the mark", corrected.data.record.status, "late");
  // $setOnInsert does not apply on an update, so the moment the register was
  // first taken is not overwritten.
  check("and leaving the moment it was first taken alone",
    corrected.data.record.createdAt, firstTaken);
  check("still one row", docs.count("studentAttendance", {
    classId: "cls-1", studentId: "p1", date: REGISTER_DAY,
  }), 1);

  check("a status the endpoint does not know is not queued",
    api.handle({
      method: "POST", path: "/api/attendance/students", query: {},
      body: { schoolId: SCHOOL, classId: "cls-1", studentId: "p1",
              date: REGISTER_DAY, status: "maybe" },
    }, teachCtx),
    null);

  check("nor a pupil who is not in the class",
    api.handle({
      method: "POST", path: "/api/attendance/students", query: {},
      body: { schoolId: SCHOOL, classId: "cls-1", studentId: "p3",
              date: REGISTER_DAY, status: "present" },
    }, teachCtx),
    null);

  {
    const engine2 = engine({
      docs, queue, state: store.state(db), client: apiClient,
      feedCollections: ["studentAttendance"],
    });
    await engine2.cycle();
    engine2.stop();
  }
  check("the correction drained", queue.all().length, 0);
  check("and the server took it",
    (await StudentAttendanceModel.findById(p1Rows[0]._id).lean())?.status, "late");
  check("with still one row for the day",
    await StudentAttendanceModel.countDocuments({
      schoolId: SCHOOL, classId: "cls-1", studentId: "p1", date: REGISTER_DAY,
    }),
    1);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- staff attendance, marked with no connection ---");

  /**
   * ── Near-identical to the pupil register, and different in three ways ─────
   *
   * A different set of statuses (on_leave, not excused), a different permission
   * (attendance.markStaff), and a natural key with no class or subject in it — a
   * teacher is present for the day rather than for a lesson.
   *
   * Each of those is a way for code copied from the pupil path to be quietly
   * wrong, so each is asserted rather than assumed.
   */
  const TeacherAttendanceModel = require("../src/db/models/Attendance").TeacherAttendance;
  const { teacherAttendanceId: derivedStaffId } = require("../../shared/attendance");

  const STAFF_DAY = "2026-10-07";

  const staffSession = {
    userId: "admin-1", schoolId: SCHOOL,
    permissions: ["attendance.markStaff", "attendance.view"],
  };
  const staffCtx = { docs, meta, queue, session: staffSession };

  // ── The roster ─────────────────────────────────────────────────────────
  //
  // The endpoint has no .sort(), so it returns whatever order the storage engine
  // gives and any order is as faithful as another. Compared as a SET for that
  // reason — a list comparison here would be asserting Mongo's storage order,
  // which is not a promise the endpoint makes.
  {
    const localRoster = api.handle({
      method: "GET", path: "/api/attendance/teachers/roster",
      query: { schoolId: SCHOOL },
    }, staffCtx).data.teachers;

    const res = await fetch(
      "http://127.0.0.1:" + port + "/api/attendance/teachers/roster?schoolId=" + SCHOOL,
      { headers: { authorization: "Bearer " + token } }
    );
    const serverRoster = (await res.json()).teachers;

    check("the staff roster holds the same people",
      localRoster.map((t) => t._id).sort().join(),
      serverRoster.map((t) => t._id).sort().join());
    check("with the four fields the endpoint selects",
      Object.keys(localRoster[0]).sort().join(),
      ["_id", "email", "name", "role"].join());
    check("and the same count", localRoster.length, serverRoster.length);
  }

  // ── Marking them ───────────────────────────────────────────────────────
  const staffMarked = api.handle({
    method: "POST", path: "/api/attendance/teachers/bulk", query: {},
    body: {
      schoolId: SCHOOL, date: STAFF_DAY,
      records: [
        { teacherId: "t1", status: "present", checkInTime: "07:45" },
        { teacherId: "t2", status: "on_leave", note: "bereavement" },
        // "excused" is a PUPIL status. A handler that reused the pupil set would
        // accept this and queue a mark the model's enum refuses.
        { teacherId: "t1", status: "excused" },
        { teacherId: "nobody", status: "present" },
      ],
    },
  }, staffCtx);

  check("the staff register is accepted locally", staffMarked?.status, 201);
  check("two marks saved", staffMarked.data.saved, 2);
  check("two rejected", staffMarked.data.failed, 2);
  check("a pupil status is not a staff status",
    staffMarked.data.failedRecords.find((r) => r.status === "excused")?.reason,
    "Invalid teacherId or status");
  check("and an unknown id is named as such",
    staffMarked.data.failedRecords.find((r) => r.teacherId === "nobody")?.reason,
    "Teacher not found in this school");

  check("the rows are keyed on school, teacher and day",
    Boolean(docs.get("teacherAttendance",
      derivedStaffId({ schoolId: SCHOOL, teacherId: "t1", date: STAFF_DAY }))),
    true);
  check("as one queued request", queue.summary().pending, 1);

  // ── What must not be queued ────────────────────────────────────────────
  check("marking staff without attendance.markStaff is not queued",
    api.handle({
      method: "POST", path: "/api/attendance/teachers", query: {},
      body: { schoolId: SCHOOL, teacherId: "t1", date: STAFF_DAY, status: "present" },
    }, { docs, meta, queue, session: { ...staffSession, permissions: ["attendance.mark"] } }),
    null);

  check("nor a status only a pupil may have",
    api.handle({
      method: "POST", path: "/api/attendance/teachers", query: {},
      body: { schoolId: SCHOOL, teacherId: "t1", date: STAFF_DAY, status: "excused" },
    }, staffCtx),
    null);

  check("nor somebody who is not a teacher in this school",
    api.handle({
      method: "POST", path: "/api/attendance/teachers", query: {},
      body: { schoolId: SCHOOL, teacherId: "admin-1", date: STAFF_DAY, status: "present" },
    }, staffCtx),
    null);

  // The staff directory needs users.manage to mirror. Without it this machine
  // cannot vouch for an id, and queueing a mark it cannot vouch for is how
  // attendance rows appear for people outside the school.
  {
    const staffRows = JSON.parse(JSON.stringify(await UserModel.find({}).lean()));
    for (const row of staffRows) docs.forget("user", row._id);

    check("a machine without the staff directory declines rather than guessing",
      api.handle({
        method: "POST", path: "/api/attendance/teachers/bulk", query: {},
        body: { schoolId: SCHOOL, date: STAFF_DAY,
                records: [{ teacherId: "t1", status: "present" }] },
      }, staffCtx),
      null);

    docs.putMany("user", staffRows);
  }

  // ── Reconnecting ───────────────────────────────────────────────────────
  {
    const staffEngine = engine({
      docs, queue, state: store.state(db), client: apiClient,
      feedCollections: ["teacherAttendance"],
    });
    // The fixtures are dated ahead of the clock — see the note beside
    // encodeCursor, and in the reversal section above.
    db.prepare("DELETE FROM sync_state WHERE collection = ?").run("teacherAttendance");
    await staffEngine.cycle();
    staffEngine.stop();
  }

  check("the staff register reached the server", queue.all().length, 0);

  const t1Rows = await TeacherAttendanceModel.find({
    schoolId: SCHOOL, teacherId: "t1", date: STAFF_DAY,
  }).lean();
  check("one row for that teacher on that day", t1Rows.length, 1);
  check("under the id both sides derive",
    t1Rows[0]?._id,
    derivedStaffId({ schoolId: SCHOOL, teacherId: "t1", date: STAFF_DAY }));
  check("holding what was marked", t1Rows[0]?.status, "present");
  check("including the time they arrived", t1Rows[0]?.checkInTime, "07:45");
  check("attributed to whoever marked it", Boolean(t1Rows[0]?.markedBy), true);

  check("and the one on leave is recorded too",
    (await TeacherAttendanceModel.findOne({
      schoolId: SCHOOL, teacherId: "t2", date: STAFF_DAY,
    }).lean())?.status,
    "on_leave");

  await parity("staff attendance for a day",
    "/api/attendance/teachers?schoolId=" + SCHOOL + "&date=" + STAFF_DAY);
  await parity("one member of staff",
    "/api/attendance/teachers?schoolId=" + SCHOOL + "&teacherId=t1");
  await parity("narrowed to a status",
    "/api/attendance/teachers?schoolId=" + SCHOOL + "&status=on_leave");
  await parity("and over a range of days",
    "/api/attendance/teachers?schoolId=" + SCHOOL +
    "&startDate=2026-10-01&endDate=2026-10-31");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the attendance reports ---");

  /**
   * ── Counting, but with three numbers that are easy to swap ───────────────
   *
   * These are the last of the attendance endpoints and the only ones that are
   * arithmetic rather than shape. Three things in them are worth pinning:
   *
   *   isActive is read TWO ways. Pupils count when it is not false — and most
   *   records do not have the field at all — while staff count only when it is
   *   exactly true. Reading the pupil side as true-only makes every rate in the
   *   school read nought per cent, because the denominator vanishes.
   *
   *   THE RATE MEANS TWO THINGS. In the overview it is present over the whole
   *   population, so a class of thirty with two marked present reads 7%. In the
   *   class report it is per pupil, over that pupil's own marks, so a child
   *   marked once and present reads 100%. Copying either into the other's place
   *   is invisible on a screen.
   *
   *   THE CLASS REPORT DEFAULTS TO TODAY, not to everything. Both ends go
   *   through dateStr, which falls back to today on anything absent.
   */
  const { lastSevenDays } = require("../../shared/attendance");

  // The weekly window is the last seven REAL days, and every fixture in this
  // file is dated months later — so without marks inside it the report would
  // compare two empty trends and prove nothing about the counting.
  const week = lastSevenDays();
  await StudentAttendanceModel.collection.insertMany([
    { _id: "wk-1", schoolId: SCHOOL, classId: "cls-1", subjectId: null, studentId: "p1",
      date: week[6], status: "present", markedBy: "admin-1", markedAt: new Date(),
      deletedAt: null, updatedAt: new Date() },
    { _id: "wk-2", schoolId: SCHOOL, classId: "cls-1", subjectId: null, studentId: "p2",
      date: week[6], status: "absent", markedBy: "admin-1", markedAt: new Date(),
      deletedAt: null, updatedAt: new Date() },
    { _id: "wk-3", schoolId: SCHOOL, classId: "cls-1", subjectId: null, studentId: "p1",
      date: week[4], status: "late", markedBy: "admin-1", markedAt: new Date(),
      deletedAt: null, updatedAt: new Date() },
    { _id: "wk-4", schoolId: SCHOOL, classId: "cls-2", subjectId: null, studentId: "p3",
      date: week[4], status: "excused", markedBy: "admin-1", markedAt: new Date(),
      deletedAt: null, updatedAt: new Date() },
  ]);
  await TeacherAttendanceModel.collection.insertMany([
    { _id: "wkt-1", schoolId: SCHOOL, teacherId: "t1", date: week[6], status: "present",
      markedBy: "admin-1", markedAt: new Date(), updatedAt: new Date() },
    { _id: "wkt-2", schoolId: SCHOOL, teacherId: "t2", date: week[4], status: "on_leave",
      markedBy: "admin-1", markedAt: new Date(), updatedAt: new Date() },
  ]);

  {
    const reportEngine = engine({
      docs, queue, state: store.state(db), client: apiClient,
      feedCollections: ["studentAttendance", "teacherAttendance"],
    });
    db.prepare("DELETE FROM sync_state WHERE collection IN (?, ?)")
      .run("studentAttendance", "teacherAttendance");
    await reportEngine.cycle();
    reportEngine.stop();
  }
  check("the week's marks are in the mirror",
    docs.count("studentAttendance", { date: week[6] }), 2);

  // ── One day, pupils and staff side by side ─────────────────────────────
  await parity("the overview for a day with pupil marks",
    "/api/attendance/report/overview?schoolId=" + SCHOOL + "&date=" + REGISTER_DAY);
  await parity("and for one with staff marks",
    "/api/attendance/report/overview?schoolId=" + SCHOOL + "&date=" + STAFF_DAY);
  await parity("and for a day nobody marked",
    "/api/attendance/report/overview?schoolId=" + SCHOOL + "&date=2026-12-25");
  // No date at all means today, which is inside the week just inserted.
  await parity("and with no date, meaning today",
    "/api/attendance/report/overview?schoolId=" + SCHOOL);

  // The numbers behind one of those, stated outright — a parity pass proves the
  // two agree, not that either is right.
  {
    const overview = api.handle({
      method: "GET", path: "/api/attendance/report/overview",
      query: { schoolId: SCHOOL, date: week[6] },
    }, teachCtx).data;

    // The RULE rather than a number, because other sections of this file add
    // pupils and a hard-coded total would be a hostage to them.
    const activePupils = await Student.countDocuments({
      schoolId: SCHOOL, isActive: { $ne: false },
    });
    const undeletedPupils = await Student.countDocuments({
      schoolId: SCHOOL, isActive: { $ne: false }, deletedAt: null,
    });

    check("the pupil denominator is the endpoint's population",
      overview.students.total, activePupils);
    // The rule worth naming: this query has no deletedAt filter, so a withdrawn
    // pupil is still counted. Asserted as a difference rather than described, so
    // it fails if either side starts filtering.
    check("which includes withdrawn pupils, because the endpoint does not filter them",
      activePupils > undeletedPupils, true);

    check("one pupil present that day", overview.students.present, 1);
    // THE FIRST MEANING OF RATE: over the population, not the marks. One present
    // of a whole school is a low percentage, not a hundred.
    check("so the rate is over the population, not over the marks",
      overview.students.rate, Math.round((1 / activePupils) * 100));
    check("and the rest went unmarked",
      overview.students.unmarked, activePupils - 2);
  }

  // ── The week ───────────────────────────────────────────────────────────
  await parity("the weekly trend", "/api/attendance/report/weekly?schoolId=" + SCHOOL);

  {
    const weekly = api.handle({
      method: "GET", path: "/api/attendance/report/weekly",
      query: { schoolId: SCHOOL },
    }, teachCtx).data;
    check("seven days, oldest first", weekly.days.length, 7);
    check("ending today", weekly.days[6], week[6]);
    check("with a row per day", weekly.trend.length, 7);
    check("today's present count", weekly.trend[6].students.present, 1);
    check("and a day in the middle", weekly.trend[4].students.late, 1);
    check("a day with nothing shows zeroes, not gaps",
      weekly.trend[0].students.present, 0);
  }

  // ── One class, pupil by pupil ──────────────────────────────────────────
  /**
   * ── Compared BY PUPIL, not by position ──────────────────────────────────
   *
   * The endpoint's roster query has no .sort(), so the order of this list is
   * whatever the storage engine gives. A list comparison would be asserting
   * Mongo's storage order — which the endpoint does not promise, and which the
   * first run of this section duly failed on: the two sides held identical
   * figures for every pupil in a different order.
   *
   * So the rows are matched by student id and diffed, and everything the
   * endpoint DOES define — the dates, the overall totals — is compared as it
   * stands.
   */
  const classReportParity = async (label, path) => {
    const [pathname, qs = ""] = path.split("?");
    const res = await fetch("http://127.0.0.1:" + port + path,
      { headers: { authorization: "Bearer " + token } });
    const fromServer = await res.json();

    const local = api.handle(
      { method: "GET", path: pathname, query: Object.fromEntries(new URLSearchParams(qs)) },
      { docs, meta, queue, session: teachSession }
    );
    if (!local) { console.log("  ---- " + label + ": answered by the network"); return; }

    check(label + ": status", local.status, res.status);
    check(label + ": the dates it covers",
      [local.data.startDate, local.data.endDate, local.data.classId],
      [fromServer.startDate, fromServer.endDate, fromServer.classId]);
    check(label + ": the overall totals", local.data.overall, fromServer.overall);
    check(label + ": the same pupils",
      local.data.students.map((r) => r.student._id).sort().join(),
      fromServer.students.map((r) => r.student._id).sort().join());

    const byId = new Map(fromServer.students.map((r) => [String(r.student._id), r]));
    const wrong = local.data.students.filter((mine) => {
      const theirs = byId.get(String(mine.student._id));
      return !theirs || JSON.stringify(mine) !== JSON.stringify(theirs);
    });
    check(label + ": and the same figures for each of them",
      wrong.map((r) => r.student._id), []);
  };

  await classReportParity("a class over a range of days",
    "/api/attendance/report/class/cls-1?schoolId=" + SCHOOL +
    "&startDate=" + week[0] + "&endDate=" + week[6]);
  await classReportParity("a class over the register day",
    "/api/attendance/report/class/cls-1?schoolId=" + SCHOOL +
    "&startDate=" + REGISTER_DAY + "&endDate=" + REGISTER_DAY);
  // No dates: today alone, which is the endpoint's default and not "everything".
  await classReportParity("a class with no dates, meaning today",
    "/api/attendance/report/class/cls-1?schoolId=" + SCHOOL);

  {
    const classReport = api.handle({
      method: "GET", path: "/api/attendance/report/class/cls-1",
      query: { schoolId: SCHOOL, startDate: week[0], endDate: week[6] },
    }, teachCtx).data;

    const ada = classReport.students.find((s) => s.student._id === "p1");
    check("a pupil's row carries the three fields the endpoint selects",
      Object.keys(ada.student).sort().join(), ["_id", "email", "studentName"].join());
    check("two marks for that pupil in the week", ada.total, 2);
    check("one of them present", ada.present, 1);
    // THE SECOND MEANING OF RATE: over this pupil's own marks, not the days.
    check("and the rate is over their marks, not the days in the range",
      ada.rate, 50);

    check("the range defaults to today when nothing is asked for",
      api.handle({
        method: "GET", path: "/api/attendance/report/class/cls-1",
        query: { schoolId: SCHOOL },
      }, teachCtx).data.startDate,
      week[6]);
  }

  // ── Where the staff directory is missing ───────────────────────────────
  //
  // The overview and the weekly trend both count teachers, which needs
  // users.manage to mirror. A summary reporting nought out of nought staff is
  // not a smaller answer than the server's — it is a different one.
  {
    const staffRows = JSON.parse(JSON.stringify(await UserModel.find({}).lean()));
    for (const row of staffRows) docs.forget("user", row._id);

    check("the overview declines without the staff directory",
      api.handle({
        method: "GET", path: "/api/attendance/report/overview",
        query: { schoolId: SCHOOL },
      }, teachCtx),
      null);
    check("and so does the weekly trend",
      api.handle({
        method: "GET", path: "/api/attendance/report/weekly",
        query: { schoolId: SCHOOL },
      }, teachCtx),
      null);
    // The class report counts no staff, so it still answers.
    check("but a class report needs no staff and still answers",
      api.handle({
        method: "GET", path: "/api/attendance/report/class/cls-1",
        query: { schoolId: SCHOOL },
      }, teachCtx)?.status,
      200);

    docs.putMany("user", staffRows);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- approval thresholds and withdrawals, with no connection ---");

  /**
   * ── Deciding is not here, and that is asserted ───────────────────────────
   *
   * approve and reject are online-only. Approving does not record a decision, it
   * APPLIES one — the per-kind applier creates the refund payment, lets the
   * pending expense count, puts the waiver on the charge. "Approved" on a head
   * teacher's screen while the money has not moved is the one thing this layer
   * must never say.
   *
   * What is here is withdrawing your own request, which decides nothing, and the
   * thresholds, which are configuration rather than an act.
   */
  const ApprovalRequestModel = require("../src/db/models/ApprovalRequest");

  check("approving is not answered locally",
    api.handle({
      method: "POST", path: "/api/approvals/ap-1/approve", query: {},
      body: { schoolId: SCHOOL },
    }, { docs, meta, queue, session: asHead.session }),
    null);
  check("nor is rejecting",
    api.handle({
      method: "POST", path: "/api/approvals/ap-1/reject", query: {},
      body: { schoolId: SCHOOL, note: "no" },
    }, { docs, meta, queue, session: asHead.session }),
    null);

  // ── The thresholds ─────────────────────────────────────────────────────
  const headCtx = { docs, meta, queue, session: asHead.session };

  // The school starts on 50,000 for expenses (see the School fixture), so an
  // expense of 60,000 needs somebody to agree. That is the state before.
  const before60k = api.handle({
    method: "POST", path: "/api/finance/expenses", query: {},
    body: { schoolId: SCHOOL, categoryId: "ec-1", amount: 60000, description: "Before" },
  }, headCtx);
  check("at a threshold of 50,000 an expense of 60,000 is not written outright",
    before60k, null);

  const setThresholds = api.handle({
    method: "PUT", path: "/api/approvals/thresholds", query: {},
    body: {
      schoolId: SCHOOL,
      expenseThreshold: 75000,
      refundThreshold:  null,
      // Zero is a real setting and not the same as empty: every waiver
      // countersigned. A handler treating an empty field as zero would turn a
      // school's whole ledger into a queue of approvals.
      waiverThreshold:  0,
      payrollRequired:  true,
    },
  }, headCtx);

  check("the change is accepted locally", setThresholds?.status, 200);
  check("and queued", setThresholds?.queued, true);
  check("the reply carries the resolved thresholds, as the endpoint's does",
    setThresholds.data.data,
    { expenseThreshold: 75000, refundThreshold: null, waiverThreshold: 0, payrollRequired: true });
  check("null is kept as never, not turned into zero",
    setThresholds.data.data.refundThreshold, null);
  check("and zero is kept as always",
    setThresholds.data.data.waiverThreshold, 0);
  check("the mirror holds them where the expense write reads them",
    docs.get("school", SCHOOL)?.settings?.approvals?.expenseThreshold, 75000);

  /**
   * ── THE ASSERTION THAT SHOWS WHY THIS IS SAFE TO QUEUE ───────────────────
   *
   * The same expense, judged again. It was above the old threshold and is below
   * the new one, so it is now written outright — and the queued threshold change
   * sits AHEAD of it in the outbox, because the queue is strictly FIFO. The
   * server therefore applies the new figure first and judges this expense by it,
   * exactly as this machine did.
   *
   * Without that ordering guarantee the two sides would disagree about the same
   * expense, and the disagreement would be invisible.
   */
  const after60k = api.handle({
    method: "POST", path: "/api/finance/expenses", query: {},
    body: { schoolId: SCHOOL, categoryId: "ec-1", amount: 60000, description: "After" },
  }, headCtx);
  check("under a threshold of 75,000 the same expense is written outright",
    after60k?.status, 201);
  check("and it is queued behind the threshold change, not in front of it",
    queue.all().map((r) => r.path),
    ["/api/approvals/thresholds", "/api/finance/expenses"]);

  // ── What must not be queued ────────────────────────────────────────────
  const badThresholds = [
    ["a negative threshold",   { expenseThreshold: -1 }],
    ["a fractional threshold", { refundThreshold: 1500.5 }],
    ["a threshold that is not a number", { waiverThreshold: "soon" }],
  ];

  for (const [what, patch] of badThresholds) {
    check("not queued: " + what,
      api.handle({
        method: "PUT", path: "/api/approvals/thresholds", query: {},
        body: { schoolId: SCHOOL, ...patch },
      }, headCtx),
      null);

    const refused = await fetch("http://127.0.0.1:" + port + "/api/approvals/thresholds", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer " + asHead.token },
      body: JSON.stringify({ schoolId: SCHOOL, ...patch }),
    });
    check("and the server refuses it: " + what, refused.status, 400);
    check("with its code: " + what, (await refused.json()).code, "INVALID_AMOUNT");
  }

  check("somebody without approvals.configure is not queued",
    api.handle({
      method: "PUT", path: "/api/approvals/thresholds", query: {},
      body: { schoolId: SCHOOL, expenseThreshold: 10 },
    }, { docs, meta, queue, session: asBursar.session }),
    null);

  // ── Withdrawing a request ──────────────────────────────────────────────
  //
  // ap-1 is the bursar's own pending EXPENSE request, so cancelling it must also
  // mark the expense rejected — one request, two rows. The expense it points at
  // is only referenced by the fixtures, so it is created here.
  /**
   * ── The actor has to be the one whose token the queue replays with ───────
   *
   * ap-1 belongs to the bursar, and the first version of this section withdrew
   * it through the bursar's SESSION. It passed locally and then blocked the
   * outbox: the sync client holds one token — the machine's signed-in user — so
   * the replay arrived as the head, the endpoint's "only the person who raised a
   * request may withdraw it" refused it 403, and the payment-plan work queued
   * behind it never left.
   *
   * That is an artefact of a harness able to switch sessions freely. On a real
   * machine the session and the token are the same person by construction. But
   * it is worth having discovered, because it is the shape of a genuine mistake:
   * a handler that authorises against something the replay does not carry.
   *
   * So a pending expense request of the HEAD's own, with the expense it points
   * at, and it is withdrawn as the head.
   */
  await ApprovalRequestModel.collection.insertOne({
    _id: "ap-mine", schoolId: SCHOOL, kind: "expense", targetId: "ex-mine",
    amount: 80000, threshold: 50000, summary: "Generator repair",
    status: "pending", requestedBy: "admin-1",
    requestedAt: new Date("2026-09-10T08:00:00Z"),
    deletedAt: null, updatedAt: new Date(),
  });
  await Expense.collection.insertOne({
    _id: "ex-mine", schoolId: SCHOOL, categoryId: "ec-1", amount: 80000,
    description: "Generator repair", status: "pending",
    incurredAt: new Date("2026-09-10T00:00:00.000Z"),
    deletedAt: null, voidedAt: null, updatedAt: new Date(),
  });
  docs.putMany("approvalRequest",
    JSON.parse(JSON.stringify(await ApprovalRequestModel.find({ _id: "ap-mine" }).lean())));
  docs.putMany("expense",
    JSON.parse(JSON.stringify(await Expense.find({ _id: "ex-mine" }).lean())));

  const bursarCtx = { docs, meta, queue, session: asBursar.session };

  check("cancelling somebody else's request is not queued",
    api.handle({
      method: "POST", path: "/api/approvals/ap-mine/cancel", query: {},
      body: { schoolId: SCHOOL },
    }, bursarCtx),
    null);
  check("nor one already decided",
    api.handle({
      method: "POST", path: "/api/approvals/ap-3/cancel", query: {},
      body: { schoolId: SCHOOL },
    }, bursarCtx),
    null);
  check("nor one that was removed",
    api.handle({
      method: "POST", path: "/api/approvals/ap-gone/cancel", query: {},
      body: { schoolId: SCHOOL },
    }, bursarCtx),
    null);

  const withdrawn = api.handle({
    method: "POST", path: "/api/approvals/ap-mine/cancel", query: {},
    body: { schoolId: SCHOOL },
  }, headCtx);

  check("withdrawing your own pending request is accepted", withdrawn?.status, 200);
  check("the request is cancelled", withdrawn.data.data.status, "cancelled");
  check("recorded against the person who withdrew it",
    withdrawn.data.data.decidedBy, "admin-1");
  // THE SECOND DOCUMENT. A withdrawn expense must not keep sitting outside the
  // accounts with nothing waiting to resolve it.
  check("and the expense it pointed at is rejected",
    docs.get("expense", "ex-mine")?.status, "rejected");
  check("both rows provisional until it lands", [
    docs.get("approvalRequest", "ap-mine")._pending,
    docs.get("expense", "ex-mine")._pending,
  ], [true, true]);

  // ── Reconnecting ───────────────────────────────────────────────────────
  {
    const approvalsEngine = engine({
      docs, queue, state: store.state(db), client: apiClient,
      feedCollections: ["school", "approvalRequest", "expense"],
    });
    db.prepare("DELETE FROM sync_state WHERE collection IN (?, ?, ?)")
      .run("school", "approvalRequest", "expense");
    await approvalsEngine.cycle();
    approvalsEngine.stop();
  }

  check("everything drained", queue.all().length, 0);
  check("both rows settled", [
    docs.get("approvalRequest", "ap-mine")._pending,
    docs.get("expense", "ex-mine")._pending,
  ], [false, false]);

  const storedSchool = await School.findById(SCHOOL).lean();
  check("the server took the new thresholds",
    storedSchool?.settings?.approvals,
    { expenseThreshold: 75000, refundThreshold: null, waiverThreshold: 0, payrollRequired: true });

  check("the server cancelled the request",
    (await ApprovalRequestModel.findById("ap-mine").lean())?.status, "cancelled");
  check("and rejected the expense behind it",
    (await Expense.findById("ex-mine").lean())?.status, "rejected");

  await parity("the approval queue after a withdrawal",
    "/api/approvals?schoolId=" + SCHOOL + "&status=pending", asHead);
  await parity("and its summary", "/api/approvals/summary?schoolId=" + SCHOOL, asHead);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- report-card templates ---");

  /**
   * ── Where this has to land ───────────────────────────────────────────────
   *
   * After the declarations of `meta`, `queue` and `apiClient` (around line 1390
   * and 1423), because the round trips at the end use all three. Everything else
   * it touches is either module scope (`store`, `engine`, `diff`, `check`,
   * `parity`, `api`, `SCHOOL`) or set up before the first parity call (`app`,
   * `token`, `port`, `docs`, `db`).
   *
   * It mounts /api/templates itself — template.routes.js is not among the routers
   * mounted in the setup block. If you would rather mount it up there with the
   * others, delete the app.use() line below; a second mount is harmless but
   * pointless.
   *
   * The whole section is wrapped in a block so none of its locals leak.
   */
  {
    const ReportTemplate = require("../src/db/models/ReportTemplate");
    await ReportTemplate.init();

    const { authenticate: tplAuth } = require("../middleware/auth");
    app.use("/api/templates", tplAuth, require("../src/routes/template.routes"));

    const { ROLES: TPL_ROLES }      = require("../src/config/roles");
    const { defaultsFor: tplDefaults } = require("../src/services/permissions.service");
    const TplUser = require("../src/db/models/User");

    /** Whole-object compare that ignores __v and the mirror's _pending flag. */
    const same = (label, local, server) => check(label, diff(local, server), []);

    /** The same request at the REAL endpoint, so a refusal is never assumed. */
    const askTpl = async (method, p, body = null, as = null) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: {
          "content-type":  "application/json",
          authorization:   `Bearer ${as?.token ?? token}`,
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json() };
    };

    // ── Fixtures ─────────────────────────────────────────────────────────
    //
    // Five rows covering everything the endpoints branch on: the default, a row
    // named exactly what POST /seed-default looks for, a plain one, a
    // soft-deleted one that must never appear, and another school's.
    //
    // updatedAt values are deliberately out of _id order and out of createdAt
    // order, so a handler that sorted by either would be caught.
    const TPL_HTML = "<h1>{{student_name}}</h1><p>{{average}}</p>";
    const TPL_CSS  = "h1{color:#123456}";

    await ReportTemplate.collection.insertMany([
      { _id: "tpl-1", schoolId: SCHOOL, name: "Term Report",
        html: TPL_HTML, css: TPL_CSS, isDefault: true, version: 3,
        variables: ["{{student_name}}", "{{average}}"],
        createdBy: "admin-1", updatedBy: "admin-1", deletedAt: null,
        createdAt: new Date("2026-01-05T00:00:00.000Z"),
        updatedAt: new Date("2026-03-01T00:00:00.000Z") },

      // The name POST /seed-default recognises. Not the default — seeding only
      // claims the slot when the school has not already chosen one.
      { _id: "tpl-2", schoolId: SCHOOL, name: "Default Report Card",
        html: "<p>{{class}}</p>", css: "", isDefault: false, version: 1,
        variables: ["{{class}}"],
        createdBy: "admin-1", updatedBy: "admin-1", deletedAt: null,
        createdAt: new Date("2026-02-05T00:00:00.000Z"),
        updatedAt: new Date("2026-05-01T00:00:00.000Z") },

      { _id: "tpl-3", schoolId: SCHOOL, name: "Old Layout",
        html: "<p>{{term}}</p>", css: "p{margin:0}", isDefault: false, version: 2,
        variables: ["{{term}}"],
        createdBy: "admin-1", updatedBy: "admin-1", deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z") },

      { _id: "tpl-4", schoolId: SCHOOL, name: "Binned",
        html: "<p>gone</p>", css: "", isDefault: false, version: 1, variables: [],
        createdBy: "admin-1", updatedBy: "admin-1",
        deletedAt: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z") },

      { _id: "tpl-5", schoolId: "other-school", name: "Not Yours",
        html: "<p>theirs</p>", css: "", isDefault: true, version: 1, variables: [],
        createdBy: "admin-9", updatedBy: "admin-9", deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:00.000Z") },
    ]);

    const mirrorTemplates = async () => {
      const rows = JSON.parse(JSON.stringify(await ReportTemplate.find({}).lean()));
      docs.putMany("reportTemplate", rows);
    };
    await mirrorTemplates();

    // ── Who is asking ────────────────────────────────────────────────────
    //
    // The whole router is requirePermission("reports.manage"), so the session
    // must carry it or every handler declines and this section would report
    // "answered by the network" for all of it.
    const tplAs = {
      token,
      session: { userId: "admin-1", role: TPL_ROLES.SCHOOL_ADMIN, schoolId: SCHOOL,
                 permissions: tplDefaults(TPL_ROLES.SCHOOL_ADMIN) },
    };
    const tplCtx = { docs, meta, queue, session: tplAs.session };

    // A bursar, who holds nothing in this module. reports.manage is not
    // delegable, so this is not a school setting somebody could have changed.
    const tplBursarToken = require("jsonwebtoken").sign(
      { id: "tpl-bursar", role: TPL_ROLES.BURSAR, schoolId: SCHOOL },
      process.env.JWT_SECRET, { expiresIn: "1h" }
    );
    await TplUser.collection.insertOne({
      _id: "tpl-bursar", name: "Bursar", email: "bursar-tpl@x.com",
      role: TPL_ROLES.BURSAR, schoolId: SCHOOL, isActive: true, password: "x",
      updatedAt: new Date(),
    });
    const tplAsBursar = {
      token:   tplBursarToken,
      session: { userId: "tpl-bursar", role: TPL_ROLES.BURSAR, schoolId: SCHOOL,
                 permissions: tplDefaults(TPL_ROLES.BURSAR) },
    };
    const tplBursarCtx = { docs, meta, queue, session: tplAsBursar.session };

    // ── The list ─────────────────────────────────────────────────────────
    //
    // isDefault desc then updatedAt desc: tpl-1 (default), tpl-2 (May),
    // tpl-3 (January). tpl-4 is soft-deleted and tpl-5 is another school's.
    await parity("the template list", `/api/templates?schoolId=${SCHOOL}`, tplAs);
    await parity("one template",      `/api/templates/tpl-1?schoolId=${SCHOOL}`, tplAs);
    await parity("the seeded one",    `/api/templates/tpl-2?schoolId=${SCHOOL}`, tplAs);

    // Position is asserted here rather than only through parity(), because
    // parity() would pass on two lists that happened to agree while both were
    // in the storage engine's order.
    check("default first, then most recently touched",
      api.handle({ method: "GET", path: "/api/templates", query: { schoolId: SCHOOL } }, tplCtx)
        .data.templates.map((t) => t._id),
      ["tpl-1", "tpl-2", "tpl-3"]);

    // The whole document, not a projection — the endpoint has no .select(), so
    // every list load carries the full html and css of every template.
    check("the list carries the html the builder edits",
      api.handle({ method: "GET", path: "/api/templates", query: { schoolId: SCHOOL } }, tplCtx)
        .data.templates[0].html,
      TPL_HTML);

    // ── What the list must not show ──────────────────────────────────────
    check("a soft-deleted template is not readable",
      api.handle({ method: "GET", path: "/api/templates/tpl-4", query: { schoolId: SCHOOL } }, tplCtx),
      null);
    const binned = await askTpl("GET", `/api/templates/tpl-4?schoolId=${SCHOOL}`, null, tplAs);
    check("and the server calls it not found", binned.status, 404);

    check("another school's template is not readable",
      api.handle({ method: "GET", path: "/api/templates/tpl-5", query: { schoolId: SCHOOL } }, tplCtx),
      null);
    const theirs = await askTpl("GET", `/api/templates/tpl-5?schoolId=${SCHOOL}`, null, tplAs);
    check("nor by the server", theirs.status, 404);

    // resolveSchoolId ignores the request's schoolId for anybody who is not a
    // super_admin, so asking for another school reads your OWN. A handler that
    // trusted query.schoolId would answer with tpl-5 here.
    check("asking for another school still answers with this one",
      api.handle({ method: "GET", path: "/api/templates", query: { schoolId: "other-school" } }, tplCtx)
        .data.templates.map((t) => t._id),
      ["tpl-1", "tpl-2", "tpl-3"]);
    await parity("and the server agrees", `/api/templates?schoolId=other-school`, tplAs);

    // ── The guard over the whole router ──────────────────────────────────
    check("a bursar is not answered locally",
      api.handle({ method: "GET", path: "/api/templates", query: { schoolId: SCHOOL } }, tplBursarCtx),
      null);
    const bursarRead = await askTpl("GET", `/api/templates?schoolId=${SCHOOL}`, null, tplAsBursar);
    check("because the server refuses them", bursarRead.status, 403);
    check("naming the permission", bursarRead.body.permission, "reports.manage");

    // ── The raw preview, which is a read wearing a POST ──────────────────
    {
      const localPrev = api.handle({
        method: "POST", path: "/api/templates/tpl-1/preview",
        query: {}, body: { schoolId: SCHOOL },
      }, tplCtx);
      const serverPrev = await askTpl("POST", "/api/templates/tpl-1/preview",
        { schoolId: SCHOOL }, tplAs);

      check("the raw preview status", localPrev?.status, serverPrev.status);
      same("the raw preview, key for key", localPrev?.data, serverPrev.body);
      check("nothing was queued for a preview", localPrev?.queued, undefined);

      // With a pupil and an exam the endpoint runs the placeholder engine, which
      // this machine does not have. Declined — and NOT because the server would
      // refuse it: it answers 200 with rendered html. A second copy of a
      // 600-line renderer is the thing being avoided.
      check("a filled preview is left to the server",
        api.handle({
          method: "POST", path: "/api/templates/tpl-1/preview",
          query: {}, body: { schoolId: SCHOOL, examId: "exam-1", studentId: "p1" },
        }, tplCtx),
        null);
    }

    // ── Seeding, whose idempotent half is answerable ─────────────────────
    {
      const localSeed = api.handle({
        method: "POST", path: "/api/templates/seed-default",
        query: {}, body: { schoolId: SCHOOL },
      }, tplCtx);
      const serverSeed = await askTpl("POST", "/api/templates/seed-default",
        { schoolId: SCHOOL }, tplAs);

      check("seeding a school that already has the row: status", localSeed?.status, serverSeed.status);
      check("and it says nothing was created", localSeed?.data.created, false);
      same("and hands back the same row", localSeed?.data, serverSeed.body);
      check("without queueing anything", localSeed?.queued, undefined);
      check("and the server wrote nothing",
        await ReportTemplate.countDocuments({ schoolId: SCHOOL, deletedAt: null }), 3);

      // Two rows with that name are possible — there is no unique index — and
      // findOne with no sort does not define which one comes back.
      docs.put("reportTemplate", {
        ...docs.get("reportTemplate", "tpl-3"), name: "Default Report Card",
      });
      check("two rows with the seed name declines rather than guessing",
        api.handle({
          method: "POST", path: "/api/templates/seed-default",
          query: {}, body: { schoolId: SCHOOL },
        }, tplCtx),
        null);
      await mirrorTemplates();
    }

    // ═════════════════════════════════════════════════════════════════════
    // WRITES
    // ═════════════════════════════════════════════════════════════════════

    const tplEngine = engine({
      docs, queue, state: store.state(db), client: apiClient,
      feedCollections: ["reportTemplate"],
    });
    apiClient.setServerUrl(`http://127.0.0.1:${port}`);
    apiClient.setToken(token);

    /**
     * The cursor is cleared before every cycle.
     *
     * Not laziness: this file's fixtures are dated across a school year, so a
     * cursor recorded from them can sit ahead of the wall clock and nothing
     * written during the run would ever be pulled back. Clearing it makes each
     * cycle a full re-read of one small collection.
     */
    const tplCycle = async () => {
      db.prepare("DELETE FROM sync_state WHERE collection = ?").run("reportTemplate");
      await tplEngine.cycle();
    };

    // ── Deleting the default is refused, and that is checked locally ─────
    //
    // A queued 400 does not merely fail — it blocks the outbox and holds up
    // everything behind it, including work from other parts of the school.
    check("the default template is not queued for deletion",
      api.handle({
        method: "DELETE", path: "/api/templates/tpl-1",
        query: { schoolId: SCHOOL }, body: {},
      }, tplCtx),
      null);
    const refusedDelete = await askTpl("DELETE", `/api/templates/tpl-1?schoolId=${SCHOOL}`, null, tplAs);
    check("and the server really would have refused it", refusedDelete.status, 400);
    check("saying what to do instead",
      /Set another template as default/.test(String(refusedDelete.body.error)), true);

    check("nor is a bursar's deletion queued",
      api.handle({
        method: "DELETE", path: "/api/templates/tpl-3",
        query: { schoolId: SCHOOL }, body: {},
      }, tplBursarCtx),
      null);
    const bursarDelete = await askTpl("DELETE", `/api/templates/tpl-3?schoolId=${SCHOOL}`,
      null, tplAsBursar);
    check("because that is a 403", bursarDelete.status, 403);

    // ── Deleting a spare layout, all the way to the server ──────────────
    {
      const deleted = api.handle({
        method: "DELETE", path: "/api/templates/tpl-3",
        query: { schoolId: SCHOOL }, body: {},
      }, tplCtx);

      check("a non-default template is accepted locally", deleted?.status, 200);
      check("and queued", deleted?.queued, true);
      same("with the endpoint's own reply", deleted?.data,
        { success: true, message: "Template deleted" });
      check("the mirror shows it gone at once",
        !!docs.get("reportTemplate", "tpl-3")?.deletedAt, true);
      check("marked as not yet sent", docs.get("reportTemplate", "tpl-3")?._pending, true);
      check("version is not touched by a delete",
        docs.get("reportTemplate", "tpl-3")?.version, 2);
      check("and the list no longer offers it",
        api.handle({ method: "GET", path: "/api/templates", query: { schoolId: SCHOOL } }, tplCtx)
          .data.templates.map((t) => t._id),
        ["tpl-1", "tpl-2"]);

      // A second press cannot reach the queue: the local row is already gone.
      check("a repeat is not queued a second time",
        api.handle({
          method: "DELETE", path: "/api/templates/tpl-3",
          query: { schoolId: SCHOOL }, body: {},
        }, tplCtx),
        null);

      await tplCycle();
      check("the queue drained", queue.all().length, 0);
      check("the row is settled", docs.get("reportTemplate", "tpl-3")?._pending, false);
      check("and the server soft-deleted it",
        !!(await ReportTemplate.findById("tpl-3").lean())?.deletedAt, true);
      await parity("the list after a delete", `/api/templates?schoolId=${SCHOOL}`, tplAs);
    }

    // ── Choosing the default: one request, two rows ──────────────────────
    {
      const before = docs.get("reportTemplate", "tpl-1")?.updatedAt;

      const madeDefault = api.handle({
        method: "PATCH", path: "/api/templates/tpl-2/default",
        query: {}, body: { schoolId: SCHOOL },
      }, tplCtx);

      check("setting a default is accepted locally", madeDefault?.status, 200);
      check("and queued", madeDefault?.queued, true);
      same("with the endpoint's own reply — a message, not the row", madeDefault?.data,
        { success: true, message: "Default template updated" });

      check("the chosen row is default in the mirror",
        docs.get("reportTemplate", "tpl-2")?.isDefault, true);
      check("and pending", docs.get("reportTemplate", "tpl-2")?._pending, true);
      check("its version is NOT bumped — only PUT does that",
        docs.get("reportTemplate", "tpl-2")?.version, 1);

      /**
       * ── The other half of the write, which is the part that goes wrong ────
       *
       * The old default has to be cleared in the same commit, and the cleared
       * row has to be recorded on the queue entry. A row written and not listed
       * there stays pending for ever — and a pending row is deliberately never
       * overwritten by a pull, so the mirror would say tpl-1 is still the
       * default until somebody reinstalled the application.
       */
      check("the old default is cleared too",
        docs.get("reportTemplate", "tpl-1")?.isDefault, false);
      check("its timestamp is left for the server to set",
        docs.get("reportTemplate", "tpl-1")?.updatedAt, before);
      check("one queue entry, not two", queue.all().length, 1);
      check("and it carries the cleared row so the engine settles it",
        JSON.parse(queue.all()[0].extra_docs ?? "null"),
        [{ collection: "reportTemplate", docId: "tpl-1" }]);

      // Two defaults are never shown, which is the thing the screen would get
      // wrong if `also` had been omitted.
      check("exactly one template reads as default",
        api.handle({ method: "GET", path: "/api/templates", query: { schoolId: SCHOOL } }, tplCtx)
          .data.templates.filter((t) => t.isDefault).map((t) => t._id),
        ["tpl-2"]);

      // Setting the default on the row that already has it is declined. See the
      // note in writes/templates.js and the demonstration at the end of this
      // section: the endpoint clears every flag and then writes nothing.
      check("re-defaulting the row that is already default is not queued",
        api.handle({
          method: "PATCH", path: "/api/templates/tpl-2/default",
          query: {}, body: { schoolId: SCHOOL },
        }, tplCtx),
        null);

      await tplCycle();
      check("the queue drained", queue.all().length, 0);
      check("the chosen row settled", docs.get("reportTemplate", "tpl-2")?._pending, false);
      check("and so did the cleared one — it was on the queue entry",
        docs.get("reportTemplate", "tpl-1")?._pending, false);
      check("the server agrees which one is default",
        (await ReportTemplate.findOne({ schoolId: SCHOOL, isDefault: true }).lean())?._id,
        "tpl-2");
      check("and that the old one is not",
        (await ReportTemplate.findById("tpl-1").lean())?.isDefault, false);

      /**
       * ── Compared by key, not by position ─────────────────────────────────
       *
       * The endpoint clears the flag with an updateMany, and mongoose adds
       * `$set: { updatedAt: now }` to update queries — so ONE timestamp is
       * stamped onto every remaining template of the school at once. Their
       * updatedAt values then tie exactly, `{ updatedAt: -1 }` has nothing left
       * to order them by, and the server's own list can come back differently
       * for two identical requests.
       *
       * So the contents are compared, and the order is not. The desktop's own
       * order is stable (an _id tie-break), which is a promise the server does
       * not make.
       */
      const localList  = api.handle({ method: "GET", path: "/api/templates", query: { schoolId: SCHOOL } }, tplCtx);
      const serverList = await askTpl("GET", `/api/templates?schoolId=${SCHOOL}`, null, tplAs);
      check("the same templates, whatever the order",
        localList.data.templates.map((t) => t._id).sort(),
        serverList.body.templates.map((t) => t._id).sort());
      check("and the same count", localList.data.count, serverList.body.count);
    }

    // ── Duplicating a layout ─────────────────────────────────────────────
    //
    // ⚠ THE LAST CHECK IN THIS BLOCK FAILS UNTIL THE BACKEND IS CHANGED.
    //
    // POST /api/templates/:id/duplicate hard-codes _id: uuidv4() at
    // src/routes/template.routes.js:493. Until it honours req.body._id the
    // server creates the copy under a different id, the outbox drains happily,
    // and the local row is orphaned in the mirror for ever — no pull removes it,
    // and the first "set as default" pressed on that phantom queues a PATCH the
    // server answers 404 to, which stops the whole outbox.
    {
      const copied = api.handle({
        method: "POST", path: "/api/templates/tpl-1/duplicate",
        query: {}, body: { schoolId: SCHOOL },
      }, tplCtx);

      check("a copy is accepted locally", copied?.status, 201);
      check("and queued", copied?.queued, true);

      const copyId = copied.data.template._id;
      check("named after the original", copied.data.template.name, "Term Report (Copy)");
      check("never the default", copied.data.template.isDefault, false);
      check("version reset to 1", copied.data.template.version, 1);
      check("carrying the original's html", copied.data.template.html, TPL_HTML);
      check("and its placeholder list, un-rescanned",
        copied.data.template.variables, ["{{student_name}}", "{{average}}"]);
      // toObject() with toObject: { virtuals: true }, so mongoose's default `id`
      // virtual rides along on the RESPONSE. The stored row keeps the feed's
      // lean shape and has no `id`.
      check("the response carries the id virtual", copied.data.template.id, copyId);
      check("the mirrored row does not", docs.get("reportTemplate", copyId)?.id, undefined);
      check("the id is in the body that will be replayed",
        queue.all().find((q) => q.path.endsWith("/duplicate")) &&
        JSON.parse(queue.all().find((q) => q.path.endsWith("/duplicate")).body)._id,
        copyId);
      check("and the copy is in the list at once",
        api.handle({ method: "GET", path: "/api/templates", query: { schoolId: SCHOOL } }, tplCtx)
          .data.templates.some((t) => t._id === copyId),
        true);

      await tplCycle();
      check("the queue drained", queue.all().length, 0);
      check("⚠ the server has the copy under the CLIENT'S id (needs template.routes.js:493)",
        (await ReportTemplate.findById(copyId).lean())?.name, "Term Report (Copy)");
      check("⚠ and did not make a second one",
        await ReportTemplate.countDocuments({ schoolId: SCHOOL, name: "Term Report (Copy)" }), 1);
      check("the copy is stamped with who made it",
        (await ReportTemplate.findById(copyId).lean())?.createdBy,
        docs.get("reportTemplate", copyId)?.createdBy);
    }

    /**
     * ── Re-confirming the current default: found broken, now fixed ─────────
     *
     * This section was written to DEMONSTRATE a bug, and the assertions below
     * are what it looked like. PATCH /:id/default cleared isDefault on every
     * non-deleted template of the school — the target INCLUDED — and then
     * assigned `template.isDefault = true` to a document loaded before that
     * clear, which already held true. Mongoose sends only modified paths, and
     * assigning true to true modifies nothing: modifiedPaths() was [], save()
     * issued no write, and the clear stood.
     *
     * The school was left with NO default. GET /templates/default answered 404
     * and a report card rendered without an explicit templateId had nothing to
     * render from — from the most innocuous action available, pressing "set as
     * default" on the row already marked default.
     *
     * The console hid the button on that row, so nothing reached it. It was one
     * line from being reachable, and template.routes.js now excludes the target
     * from the clear — which removes the dependency on dirty tracking entirely,
     * rather than relying on save() to put back what was just taken away.
     *
     * So these assert the fix. If somebody reinstates the old updateMany they
     * fail, which is the point of keeping them.
     */
    {
      const before = await ReportTemplate.findOne({ schoolId: SCHOOL, isDefault: true }).lean();
      check("the school has a default to begin with", before?._id, "tpl-2");

      const reDefault = await askTpl("PATCH", "/api/templates/tpl-2/default",
        { schoolId: SCHOOL }, tplAs);
      check("the server reports success", reDefault.status, 200);
      check("with the same cheerful message", reDefault.body.message, "Default template updated");
      // THE ASSERTIONS THE FIX EXISTS FOR. Both read the other way round before it.
      check("the school still has exactly one default",
        await ReportTemplate.countDocuments({ schoolId: SCHOOL, isDefault: true, deletedAt: null }),
        1);
      check("and it is still the one that was re-confirmed",
        (await ReportTemplate.findOne({ schoolId: SCHOOL, isDefault: true, deletedAt: null }).lean())?._id,
        "tpl-2");
      check("so the default lookup still answers",
        (await askTpl("GET", `/api/templates/default?schoolId=${SCHOOL}`, null, tplAs)).status,
        200);

      // Put it back, so anything spliced after this section sees a school with a
      // default. updateOne bumps updatedAt, which is what the next pull follows.
      await ReportTemplate.updateOne({ _id: "tpl-2" }, { $set: { isDefault: true } });
      await mirrorTemplates();
      check("restored", docs.get("reportTemplate", "tpl-2")?.isDefault, true);
    }

    tplEngine.stop();
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the settings screens: office accounts, grading, the ID card ---");

  /**
   * ── SPLICE THIS AT THE END OF main(), AFTER THE APPROVALS SECTION ────────
   *
   * Two reasons, both real rather than cautious:
   *
   *   · It adds settings.academicYear to the school fixture, which the id-card
   *     dates are computed from. The approvals section reads
   *     settings.approvals.expenseThreshold off the same document, and this
   *     section then asserts that a settings write does NOT disturb it — so the
   *     threshold assertions want to have run already.
   *   · It adds office accounts to the `user` collection. Nothing earlier joins
   *     on the whole staff list, but a section that did would see rows it did
   *     not seed.
   *
   * ── The queue may not be mine alone ─────────────────────────────────────
   *
   * A blocked entry left by an earlier section would stop the outbox before my
   * pushes, so the depth is recorded before the writes and compared against
   * afterwards rather than against zero. If that check fails with a bigger
   * number, the cause is upstream and the label says so.
   */

  const stgSession = {
    userId: "admin-1", schoolId: SCHOOL, role: "school_admin",
    permissions: ["settings.view", "settings.manage", "users.manage", "results.view"],
  };
  const stgCtx = { docs, meta, queue, session: stgSession };

  /** The same body, straight at the endpoint, so a refusal is never assumed. */
  const stgAsk = async (path, body, method = "PUT") => {
    const res = await fetch("http://127.0.0.1:" + port + path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const stgGet = async (pathAndQuery) => {
    const res = await fetch("http://127.0.0.1:" + port + pathAndQuery, {
      headers: { authorization: "Bearer " + token },
    });
    return { status: res.status, body: await res.json() };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // FIXTURES
  // ─────────────────────────────────────────────────────────────────────────

  const SettingsUser       = require("../src/db/models/User");
  const GradingConfigModel  = require("../src/db/models/GradingConfig");

  /**
   * The office accounts, each one a condition in the list endpoint's filter:
   *
   *   stg-burs    a bursar, ACTIVE — and carrying a tempPassword, which is the
   *               one this fixture exists for. tempPassword is NOT select:false
   *               on the model, so it really does travel out of a .find(); the
   *               endpoint drops it with .select("-password -tempPassword") and
   *               the handler has to drop it too. Without this row a handler
   *               that forgot would pass.
   *   stg-gone    a REMOVED admin — isActive false, which is what DELETE does.
   *               Absent by default, present under ?status=inactive.
   *   stg-noflag  NO isActive FIELD AT ALL. statusFilter writes { isActive: true }
   *               rather than { $ne: false }, so this row is absent by default —
   *               and a mirror that translated it as "not false" would show an
   *               account the server does not.
   *   stg-del     soft-deleted and STILL LISTED, because this endpoint applies
   *               no deletedAt filter. It looks like an oversight; the mirror
   *               must not be cleverer than the server about who can reach the
   *               school's records.
   *   stg-other   another school's bursar, for tenancy.
   *
   * t1 and t2 are already in the fixtures as teachers, which covers the role
   * filter: neither may appear.
   */
  await SettingsUser.collection.insertMany([
    { _id: "stg-burs", schoolId: SCHOOL, name: "Mme Bursar", email: "bursar@x.com",
      role: "bursar", isActive: true, password: "x", tempPassword: "SwiftRiver1234",
      deletedAt: null, updatedAt: new Date("2026-09-20T00:00:00Z") },
    { _id: "stg-gone", schoolId: SCHOOL, name: "Former Head", email: "former@x.com",
      role: "school_admin", isActive: false, password: "x",
      deletedAt: null, updatedAt: new Date("2026-09-20T00:00:00Z") },
    { _id: "stg-noflag", schoolId: SCHOOL, name: "No Flag", email: "noflag@x.com",
      role: "bursar", password: "x",
      deletedAt: null, updatedAt: new Date("2026-09-20T00:00:00Z") },
    { _id: "stg-del", schoolId: SCHOOL, name: "Deleted Bursar", email: "delbursar@x.com",
      role: "bursar", isActive: true, password: "x",
      deletedAt: new Date("2026-05-01T00:00:00Z"), updatedAt: new Date("2026-09-20T00:00:00Z") },
    { _id: "stg-other", schoolId: "other-school", name: "Elsewhere", email: "elsewhere@x.com",
      role: "bursar", isActive: true, password: "x",
      deletedAt: null, updatedAt: new Date("2026-09-20T00:00:00Z") },
  ]);

  /**
   * The school's academic year, which the ID-card dates are read from.
   *
   * $set on the dotted path rather than a whole settings object, for the same
   * reason the endpoint does it: settings.approvals is already on this document
   * and the approvals section depends on it.
   *
   * An ObjectId in the filter, not the string. School is the only model here
   * whose _id is an ObjectId, and a string filter matches nothing — silently,
   * so the academicYear would simply never arrive and the id-card dates would
   * both fall back to the calendar and agree by accident.
   *
   * 2030-2031 rather than YEAR, deliberately. The date assertions below turn on
   * the school's stated year being DIFFERENT from the one today's calendar
   * implies, and with 2026-2027 the two coincide for eleven months of every
   * twelve — so the run would pass or fail depending on which side of 1
   * September it happened on. Nothing else in this file reads
   * settings.academicYear; the fee and exam fixtures carry their own
   * academicYear fields and those are unrelated.
   */
  await School.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(SCHOOL) },
    { $set: { "settings.academicYear": "2030-2031", updatedAt: new Date() } }
  );

  docs.putMany("user", JSON.parse(JSON.stringify(await SettingsUser.find({}).lean())));
  docs.putMany("school", JSON.parse(JSON.stringify(await School.find({}).lean())));

  // ─────────────────────────────────────────────────────────────────────────
  // THE OFFICE ACCOUNTS — compared BY KEY, because neither side promises order
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * GET /admin/settings/admins has NO .sort().
   *
   * Mongo answers in storage order and SQLite answers in rowid order, and
   * neither is a promise. The handler sorts by _id so the settings list does not
   * reshuffle between two reads on the same machine, and this compares the two
   * sides as SETS keyed on _id — asserting position would be asserting something
   * the server never offered.
   *
   * Key order is normalised too: the endpoint's projection and the feed's are
   * different queries over the same documents, so the fields can arrive in a
   * different order while being the same fields.
   */
  const stgCanon = (rows) => [...rows]
    .map((row) => Object.fromEntries(
      Object.entries(row)
        .filter(([k]) => k !== "__v" && k !== "_pending")
        .sort(([a], [b]) => a.localeCompare(b))
    ))
    .sort((a, b) => String(a._id).localeCompare(String(b._id)));

  const stgAdminsParity = async (label, qs) => {
    const fromServer = await stgGet("/api/admin/settings/admins" + qs);
    const local = api.handle(
      { method: "GET", path: "/api/admin/settings/admins",
        query: Object.fromEntries(new URLSearchParams(qs.replace(/^\?/, ""))) },
      stgCtx
    );
    if (!local) {
      console.log("  ---- " + label + ": answered by the network, not locally");
      return;
    }
    check(label + ": HTTP status", local.status, fromServer.status);
    check(label + ": the same accounts, by key",
      stgCanon(local.data.admins), stgCanon(fromServer.body.admins));
  };

  await stgAdminsParity("the office accounts", "?schoolId=" + SCHOOL);
  await stgAdminsParity("removed accounts only", "?schoolId=" + SCHOOL + "&status=inactive");
  await stgAdminsParity("every account", "?schoolId=" + SCHOOL + "&status=all");
  // Not an enum the endpoint knows: statusFilter falls through to active-only
  // rather than refusing, so "?status=banana" is the default list.
  await stgAdminsParity("an unrecognised status is the default",
    "?schoolId=" + SCHOOL + "&status=banana");

  /**
   * resolveSchoolId IGNORES ?schoolId for anybody who is not a super_admin.
   *
   * So a school_admin naming another school gets their OWN accounts, not an
   * empty list — and a handler that took the query parameter (as the sibling
   * handlers in that directory do) would answer with nothing while the server
   * answered with five rows.
   */
  await stgAdminsParity("a foreign schoolId is ignored, not honoured",
    "?schoolId=other-school");

  const stgAdmins = api.handle(
    { method: "GET", path: "/api/admin/settings/admins", query: { schoolId: SCHOOL } },
    stgCtx
  ).data.admins;

  // Stated outright, so a failure names the decision rather than showing a diff.
  check("the bursar is an office account and is listed",
    stgAdmins.some((a) => a._id === "stg-burs"), true);
  check("a teacher is not",
    stgAdmins.some((a) => a._id === "t1" || a._id === "t2"), false);
  check("a row with no isActive field is absent — { isActive: true }, not { $ne: false }",
    stgAdmins.some((a) => a._id === "stg-noflag"), false);
  check("a soft-deleted office account IS listed, because the endpoint filters none",
    stgAdmins.some((a) => a._id === "stg-del"), true);
  check("another school's bursar is not",
    stgAdmins.some((a) => a._id === "stg-other"), false);
  // The projection, asserted rather than assumed. tempPassword is not
  // select:false on the model, so this is a credential that genuinely travels
  // unless something drops it.
  check("no password reaches the screen",
    stgAdmins.some((a) => "password" in a), false);
  check("and no temporary password either",
    stgAdmins.some((a) => "tempPassword" in a), false);

  // ─────────────────────────────────────────────────────────────────────────
  // THE GRADING SCALE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * First, with NO saved config — which is the state most schools are in.
   *
   * This is the assertion that earns the DEFAULT_GRADES copy in
   * handlers/settings.js. That table is duplicated from admin.routes.js and it
   * is not inert data: results.controller.js turns a percentage into a letter
   * and a remark with it, so a drifted copy would print a different grade on a
   * desktop report card than the school's own server would. This comparison is
   * the only thing holding the two together until the table moves to shared/.
   */
  // The precondition, stated rather than assumed. If some other section came to
  // seed a grading config, the comparison below would be measuring a different
  // thing and would fail for a reason nobody could read off the diff.
  check("no grading config exists on the server yet, which the next comparison " +
        "depends on", await GradingConfigModel.countDocuments({ schoolId: SCHOOL }), 0);
  check("nor in the mirror", docs.count("gradingConfig", { schoolId: SCHOOL }), 0);

  await parity("the grading scale a school has never configured",
    "/api/admin/settings/grading?schoolId=" + SCHOOL, { session: stgSession });

  /**
   * ── The first save cannot be queued, and the server would NOT have refused ──
   *
   * Read this one carefully, because it breaks the usual pattern. Every other
   * decline in this file is a prediction that the server would answer 4xx, and
   * is paired with the server actually doing so. This decline is NOT that: the
   * endpoint is an upsert and it accepts the request happily.
   *
   * It declines because GradingConfig's _id is a MONGO OBJECTID and the handler
   * never reads req.body._id. Queueing the first save would mean inventing an
   * id here, the server's upsert generating a different one, the push settling
   * the local row under the invented id, and the next pull delivering the
   * server's row under its own — two grading configs for one school in the
   * mirror, findOne returning whichever SQLite reached first, and the wrong one
   * possibly being the orphan for ever. A school's marking scheme, permanently
   * ambiguous.
   *
   * So the assertion below is the opposite of the usual one: the server accepts
   * it, and the decline is deliberate conservatism rather than a mispredicted
   * refusal. Making the first save queueable is a backend change (accept
   * req.body._id through $setOnInsert, or derive the id from schoolId, which
   * already carries a unique index) and it is reported, not made.
   */
  const stgFirstSave = {
    schoolId: SCHOOL,
    grades: [
      { grade: "A", minMark: 80, maxMark: 100, gpaPoints: 4, remark: "Very Good" },
      { grade: "B", minMark: 60, maxMark: 79,  gpaPoints: 3, remark: "Good"      },
      { grade: "F", minMark: 0,  maxMark: 59,  gpaPoints: 0, remark: "Fail"      },
    ],
    passMark: 60, useGpa: true, gpaScale: 4, gradingType: "gpa",
  };

  check("the first grading save for a school is not queued",
    api.handle({ method: "PUT", path: "/api/admin/settings/grading", query: {}, body: stgFirstSave }, stgCtx),
    null);
  const stgFirstOnServer = await stgAsk("/api/admin/settings/grading", stgFirstSave);
  // NOT a refusal. Asserted so that nobody reads the decline above as one.
  check("and the server would have ACCEPTED it — the decline is about the id, not a 4xx",
    stgFirstOnServer.status, 200);

  docs.putMany("gradingConfig",
    JSON.parse(JSON.stringify(await GradingConfigModel.find({}).lean())));

  const stgConfigId = String(
    (await GradingConfigModel.findOne({ schoolId: SCHOOL }).lean())._id
  );
  // Worth naming: the id really is an ObjectId, which is what the note above is
  // about. Every other collection in this mirror is keyed on a string uuid.
  check("the grading config is keyed on an ObjectId, not a uuid",
    /^[0-9a-f]{24}$/.test(stgConfigId), true);

  await parity("the grading scale, now that one is saved",
    "/api/admin/settings/grading?schoolId=" + SCHOOL, { session: stgSession });

  /**
   * ── An invalid marking scheme, and the status code that mattered ─────────
   *
   * These were written expecting a refusal, because GradingConfig declares
   * exactly what they violate — gradingType's enum, and grade/minMark/maxMark
   * required on every band — and the endpoint passes runValidators: true.
   *
   * The refusal was there. It arrived as a 500. The ValidationError was never
   * caught, so a school typing a grade band with no name got "Internal Server
   * Error" and no clue which field was wrong.
   *
   * The status code is not cosmetic here. This layer treats 5xx as "the server is
   * unwell, try again" and 4xx as "it refused, ask a person" — so an invalid
   * marking scheme became a queue entry that retried FOR EVER rather than
   * stopping once. admin.routes.js now maps ValidationError and CastError to 400
   * with a code; nothing about what the endpoint accepts has changed.
   *
   * The local handler declines these before they are queued, which is what makes
   * it worth checking them locally at all.
   */
  const stgGradingRejections = [
    ["a gradingType outside the enum",
      { ...stgFirstSave, gradingType: "letters" }],
    ["a band whose minMark will not cast",
      { ...stgFirstSave, grades: [{ grade: "A", minMark: "x", maxMark: 100 }] }],
    ["a band with an empty grade name",
      { ...stgFirstSave, grades: [{ grade: "", minMark: 80, maxMark: 100 }] }],
  ];

  for (const [what, body] of stgGradingRejections) {
    check("not queued: " + what,
      api.handle({ method: "PUT", path: "/api/admin/settings/grading", query: {}, body }, stgCtx),
      null);
    const refused = await stgAsk("/api/admin/settings/grading", body);
    // Recorded, not asserted as a refusal — see the note above. If somebody
    // makes the endpoint validate its bands, these flip and the note is stale.
    // A 400, not a 500 — and the difference is the point. The desktop treats 5xx
    // as "try again later", so an invalid marking scheme used to become a queue
    // entry that retried for ever instead of stopping once with a reason.
    check("and the server refuses it with a 4xx: " + what, refused.status, 400);
    check("naming the field: " + what, refused.body.code, "INVALID_GRADING");
  }

  /**
   * settings.manage, checked locally because a queued 403 stops the outbox as
   * surely as a 400 does.
   *
   * A bursar reaches this router — the router-level guard is STAFF_ROLES — and
   * is then refused by requirePermission("settings.manage"), which is
   * ADMIN_ROLES. Its own token, minted here rather than borrowed from another
   * section, so this assertion does not depend on where it is spliced.
   */
  const stgBursarToken = require("jsonwebtoken").sign(
    { id: "stg-burs", role: "bursar", schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );
  check("somebody without settings.manage is not queued",
    api.handle(
      { method: "PUT", path: "/api/admin/settings/grading", query: {}, body: stgFirstSave },
      { docs, meta, queue, session: { ...stgSession, permissions: ["settings.view"] } }
    ),
    null);
  const stgBursarRefused = await fetch(
    "http://127.0.0.1:" + port + "/api/admin/settings/grading",
    { method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer " + stgBursarToken },
      body: JSON.stringify(stgFirstSave) }
  );
  check("and the server refuses a bursar with a 403", stgBursarRefused.status, 403);

  /**
   * A body with no `grades` at all is the second conservative decline.
   *
   * The endpoint substitutes its own DEFAULT_GRADES table for a missing value,
   * so it is accepted — but reproducing that would put a second dependency on a
   * constant that lives inside a route file, and getting it wrong would replace
   * a school's marking scheme with the shipped one. The console never omits
   * grades; it sends the whole config back.
   *
   * Left to last of the grading writes because it CHANGES the server's config,
   * which is then re-mirrored below.
   */
  check("a grading save with no grades array is not queued",
    api.handle({ method: "PUT", path: "/api/admin/settings/grading", query: {},
                 body: { schoolId: SCHOOL, passMark: 55 } }, stgCtx),
    null);
  const stgNoGrades = await stgAsk("/api/admin/settings/grading", { schoolId: SCHOOL, passMark: 55 });
  check("and the server ACCEPTS it, substituting its own default table — so this " +
        "decline is conservatism, not a predicted 4xx",
    stgNoGrades.status, 200);
  check("which is exactly the damage being avoided: the school's bands are gone",
    stgNoGrades.body.grading.grades.length, 8);

  // Back in step with the server before the write that is meant to succeed.
  docs.putMany("gradingConfig",
    JSON.parse(JSON.stringify(await GradingConfigModel.find({}).lean())));

  // ── The write that is accepted ──────────────────────────────────────────

  const stgQueueBefore = queue.all().length;

  const stgEdit = {
    schoolId: SCHOOL,
    grades: [
      { grade: "Distinction", minMark: 70, maxMark: 100, gpaPoints: 4, remark: "Excellent" },
      // Deliberately awkward: numeric strings, which mongoose casts and the
      // handler has to cast the same way or the local row differs arithmetically
      // from the server's.
      { grade: "Credit",      minMark: "50", maxMark: "69" },
      { grade: "Fail",        minMark: 0,  maxMark: 49, gpaPoints: 0, remark: "Fail" },
    ],
    // ZERO, not absent. The endpoint uses `passMark ?? 50`, so 0 must survive —
    // a handler treating an empty field as missing would silently make every
    // pupil pass.
    passMark: 0,
    useGpa: false, gpaScale: 5, gradingType: "points",
  };

  const stgSaved = api.handle(
    { method: "PUT", path: "/api/admin/settings/grading", query: {}, body: stgEdit },
    stgCtx
  );

  check("a grading edit against a saved config is accepted locally", stgSaved?.status, 200);
  check("and queued", stgSaved?.queued, true);
  check("a pass mark of zero survives", stgSaved.data.grading.passMark, 0);
  check("the bands keep the order they arrived in — results.controller takes the " +
        "FIRST band a percentage falls in, so the order IS the marking scheme",
    stgSaved.data.grading.grades.map((g) => g.grade),
    ["Distinction", "Credit", "Fail"]);
  check("numeric strings are cast, as mongoose casts them",
    stgSaved.data.grading.grades[1],
    { grade: "Credit", minMark: 50, maxMark: 69, gpaPoints: 0, remark: "" });
  check("the local row keeps the server's ObjectId rather than inventing one",
    stgSaved.data.grading._id, stgConfigId);
  /**
   * The `id` virtual, which the GET does not send.
   *
   * GradingConfig sets toJSON: { virtuals: true } and the PUT answers with a
   * mongoose document while the GET answers with a .lean() one — so res.json()
   * adds mongoose's default `id` virtual to one reply and not the other. Two
   * shapes for one object from a single screen's point of view. Reported;
   * asserted here because the response body is a contract the screen reads.
   */
  check("and carries the id virtual the PUT response has and the GET has not",
    stgSaved.data.grading.id, stgConfigId);
  check("the mirror holds the edit", docs.get("gradingConfig", stgConfigId)?.gradingType, "points");

  // ─────────────────────────────────────────────────────────────────────────
  // THE ID CARD AND THE GATE
  // ─────────────────────────────────────────────────────────────────────────

  await parity("the ID card and gate settings",
    "/api/admin/settings/id-card?schoolId=" + SCHOOL, { session: stgSession });

  /**
   * ── A server bug, asserted as a bug on BOTH sides ─────────────────────────
   *
   * The school's academic year is 2030-2031 and it has set no custom expiry, so
   * "what an empty field means" and "what would actually be printed" ought to be
   * the same date. They are not.
   *
   * defaultValidUntil reads `school.academicYear ?? settings.academicYear`.
   * effectiveValidUntil goes through expiryFor(), which reads `school.academicYear`
   * ONLY — and School has no top-level academicYear path at all; the schema puts
   * it inside settings. So effectiveValidUntil ignores the school's stated year
   * and falls back to the calendar.
   *
   * Reproduced rather than fixed: documents.routes.js hands expiryFor a FLATTENED
   * school whose academicYear IS at the top level, so the printed card does not
   * have the bug and the settings screen does. A mirror that quietly agreed with
   * the printer would hide the inconsistency instead of showing it.
   *
   * When the server is fixed THIS assertion fails, which is the point — it is
   * the reminder to drop the same fallback into handlers/settings.js.
   */
  const stgIdCard = api.handle(
    { method: "GET", path: "/api/admin/settings/id-card", query: { schoolId: SCHOOL } },
    stgCtx
  ).data;
  const stgIdCardServer = (await stgGet("/api/admin/settings/id-card?schoolId=" + SCHOOL)).body;
  check("the default expiry reads the school's academic year",
    stgIdCard.idCard.defaultValidUntil, "2031-08-31");
  check("the EFFECTIVE expiry does not, on either side — expiryFor reads a field " +
        "School does not have (server bug, reproduced deliberately)",
    stgIdCard.idCard.effectiveValidUntil, stgIdCardServer.idCard.effectiveValidUntil);
  check("and the two dates disagree, which is the bug",
    stgIdCard.idCard.defaultValidUntil !== stgIdCard.idCard.effectiveValidUntil, true);

  // ── The declines, each against the real refusal ─────────────────────────

  const stgIdCardRejections = [
    // Caught by parseDay rather than left to the schema's regex, which would
    // accept it and store a day that does not exist.
    ["a validUntil of 2026-02-30",      { schoolId: SCHOOL, validUntil: "2026-02-30" }],
    ["a validUntil that is prose",      { schoolId: SCHOOL, validUntil: "next friday" }],
    ["a gate time of 25:00",            { schoolId: SCHOOL, gateLateAfter: "25:00" }],
    ["an early-departure time of 7pm",  { schoolId: SCHOOL, gateEarlyBefore: "19:00:00" }],
    ["a gateNotify outside the enum",   { schoolId: SCHOOL, gateNotify: "loud" }],
    // "Nothing to update". A screen sending an empty save is a 400, not a no-op.
    ["a body with nothing in it",       { schoolId: SCHOOL }],
  ];

  for (const [what, body] of stgIdCardRejections) {
    check("not queued: " + what,
      api.handle({ method: "PUT", path: "/api/admin/settings/id-card", query: {}, body }, stgCtx),
      null);
    const refused = await stgAsk("/api/admin/settings/id-card", body);
    check("and the server refuses it: " + what,
      refused.status >= 400 && refused.status < 500, true);
  }

  check("somebody without settings.manage is not queued for the ID card either",
    api.handle(
      { method: "PUT", path: "/api/admin/settings/id-card", query: {},
        body: { schoolId: SCHOOL, gateNotify: "all" } },
      { docs, meta, queue, session: { ...stgSession, permissions: ["settings.view"] } }
    ),
    null);

  // ── The write that is accepted ──────────────────────────────────────────

  /**
   * One field, and the assertion that matters is about the OTHERS.
   *
   * The endpoint writes dotted paths — "settings.gateNotify" — precisely so a
   * screen editing one setting cannot blank the rest. The local merge has to do
   * the same to the same document, and the document in question also holds
   * settings.approvals, which the expense write reads to decide whether money
   * needs a second signature. A merge that replaced `settings` wholesale would
   * quietly let unapproved expenses through on this machine.
   */
  /**
   * ── Read the threshold, do not assume it ─────────────────────────────────
   *
   * This asserted 50000, the School fixture's value, and failed once the
   * approvals section was spliced ahead of it: that section legitimately sets
   * the expense threshold to 75000, so the number here was a hostage to
   * whatever ran before.
   *
   * The claim being made is that a settings write leaves settings.approvals
   * ALONE — the expense write reads it to decide whether money needs a second
   * signature — so the honest form is to capture it first and require it
   * unchanged, whatever it happens to be.
   */
  const stgThresholdBefore =
    docs.get("school", SCHOOL)?.settings?.approvals?.expenseThreshold ?? null;

  const stgCardSaved = api.handle(
    { method: "PUT", path: "/api/admin/settings/id-card", query: {},
      body: { schoolId: SCHOOL, validUntil: "2027-07-15", gateNotify: "all" } },
    stgCtx
  );

  check("an ID card and gate change is accepted locally", stgCardSaved?.status, 200);
  check("and queued", stgCardSaved?.queued, true);
  check("the card's own date is what was typed", stgCardSaved.data.idCard.validUntil, "2027-07-15");
  check("and it is now the effective one, ahead of any default",
    stgCardSaved.data.idCard.effectiveValidUntil, "2027-07-15");
  check("the gate answer moves with it", stgCardSaved.data.gate.notify, "all");
  check("the two gate times are untouched and keep their defaults",
    [stgCardSaved.data.gate.lateAfter, stgCardSaved.data.gate.earlyBefore],
    ["07:45", "14:00"]);
  // reprintRequired is true because validUntil was PRESENT, not because it
  // changed. That is what the endpoint says, and it is saying the useful thing:
  // this changes cards printed from now on and nothing already laminated.
  check("and the office is told a reprint is needed", stgCardSaved.data.reprintRequired, true);

  const stgSchoolRow = docs.get("school", SCHOOL);
  check("the approval thresholds on the same document survived the merge",
    stgSchoolRow?.settings?.approvals?.expenseThreshold, stgThresholdBefore);
  check("so did the academic year",
    stgSchoolRow?.settings?.academicYear, "2030-2031");
  check("and the school's name, which this screen never mentions",
    stgSchoolRow?.name, "Parity College");

  // A change that touches only the gate must NOT claim a reprint.
  const stgGateOnly = api.handle(
    { method: "PUT", path: "/api/admin/settings/id-card", query: {},
      body: { schoolId: SCHOOL, gateEarlyBefore: "13:30" } },
    stgCtx
  );
  check("a gate-only change does not ask for a reprint",
    stgGateOnly?.data?.reprintRequired, false);
  check("and leaves the card's date alone",
    stgGateOnly?.data?.idCard?.validUntil, "2027-07-15");
  // An empty string is MEANINGFUL and accepted: it means "go back to the
  // academic-year default". A handler testing truthiness would drop it.
  const stgClearDate = api.handle(
    { method: "PUT", path: "/api/admin/settings/id-card", query: {},
      body: { schoolId: SCHOOL, validUntil: "" } },
    stgCtx
  );
  check("clearing the date is accepted, not treated as a missing field",
    stgClearDate?.status, 200);
  check("and hands back the default again",
    stgClearDate?.data?.idCard?.validUntil, "");

  // ─────────────────────────────────────────────────────────────────────────
  // RECONNECTING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * The cursors are deleted first.
   *
   * The fixtures in this file are dated across a school year, so a cursor set
   * from them sits in the FUTURE and nothing written during the run would ever
   * be pulled back. Without this the post-round-trip comparison would be reading
   * the local guess rather than the server's answer, and would pass whatever the
   * server had actually stored.
   */
  db.prepare("DELETE FROM sync_state WHERE collection = ?").run("gradingConfig");
  db.prepare("DELETE FROM sync_state WHERE collection = ?").run("school");

  const stgEngine = engine({
    docs, queue, state: store.state(db), client: apiClient,
    feedCollections: ["gradingConfig", "school"],
  });
  await stgEngine.cycle();

  // Against the depth recorded before these writes, not against zero — see the
  // note at the top. A bigger number here means something upstream is blocked.
  check("the settings writes left the queue", queue.all().length, stgQueueBefore);

  const stgServerGrading = await GradingConfigModel.findOne({ schoolId: SCHOOL }).lean();
  check("the server holds the edit under the same ObjectId",
    String(stgServerGrading._id), stgConfigId);
  check("with the bands in the order they were saved",
    stgServerGrading.grades.map((g) => g.grade), ["Distinction", "Credit", "Fail"]);
  check("and the pass mark of zero, not the default 50", stgServerGrading.passMark, 0);
  check("and the numeric strings stored as numbers", stgServerGrading.grades[1].minMark, 50);

  const stgServerSchool = await School.findById(SCHOOL).lean();
  check("the server has the gate settings", stgServerSchool.settings.gateNotify, "all");
  check("and the early-departure time from the second write",
    stgServerSchool.settings.gateEarlyBefore, "13:30");
  check("and the cleared card date from the third",
    stgServerSchool.settings.idCardValidUntil, "");
  // The whole point of the dotted paths, verified on the server side too.
  check("the approval thresholds survived three settings writes on the server",
    stgServerSchool.settings.approvals?.expenseThreshold, stgThresholdBefore);
  check("and the academic year", stgServerSchool.settings.academicYear, "2030-2031");

  await parity("the grading scale, after a round trip",
    "/api/admin/settings/grading?schoolId=" + SCHOOL, { session: stgSession });
  await parity("the ID card and gate, after a round trip",
    "/api/admin/settings/id-card?schoolId=" + SCHOOL, { session: stgSession });

  // ─────────────────────────────────────────────────────────────────────────
  // THE FIVE THAT ARE ONLINE-ONLY — asserted as declines, not as omissions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Each of these must fall through to the network. A handler accidentally
   * matching one of these paths would be far worse than not having it: creating
   * an admin and resetting a password both answer with a TEMPORARY PASSWORD the
   * server invented, and a locally invented one is a credential written on a
   * piece of paper that will not work.
   *
   * Asserted rather than assumed, because "we never wrote that handler" is not
   * something a reader of coverage.js can verify.
   */
  const stgOnlineOnly = [
    ["POST",   "/api/admin/settings/admins",
      { schoolId: SCHOOL, name: "New Bursar", email: "newbursar@x.com", role: "bursar" }],
    ["POST",   "/api/admin/settings/admins/stg-burs/reset-password", {}],
    ["DELETE", "/api/admin/settings/admins/stg-burs", {}],
    ["GET",    "/api/admin/settings/analytics", {}],
    ["PUT",    "/api/admin/settings/profile", { name: "Head", email: "head@x.com" }],
  ];

  for (const [method, path, body] of stgOnlineOnly) {
    check("online-only, goes to the network: " + method + " " + path,
      api.handle({ method, path, query: { schoolId: SCHOOL }, body }, stgCtx),
      null);
  }

  /**
   * And the reason GET /admin/settings/analytics is online-only, recorded as an
   * assertion so that fixing the server makes it fail.
   *
   * Both $unwind stages in that handler pass `preserveNullAndEmpty`, which is not
   * an option $unwind accepts — the real name is preserveNullAndEmptyArrays,
   * which appears NOWHERE in this backend. Mongo raises "unrecognized option to
   * $unwind", each aggregation is wrapped in a bare `catch { }`, and both arrays
   * come back empty on every request. Not sometimes: always.
   *
   * Mirroring that would mean either hard-coding two empty arrays to agree with
   * a swallowed server error — and silently diverging the day it is fixed — or
   * computing the real answer and disagreeing with the server today. Neither is
   * a mirror. Once the typo is fixed this is worth revisiting.
   */
  const stgAnalytics = await stgGet("/api/admin/settings/analytics?schoolId=" + SCHOOL);
  check("analytics answers 200", stgAnalytics.status, 200);
  check("but teachersBySubject is empty despite an assignment existing — the " +
        "$unwind option is misspelled and a bare catch swallows the error",
    stgAnalytics.body.analytics.teachersBySubject, []);
  check("and so is classLoad, despite approved pupils in cls-1",
    stgAnalytics.body.analytics.classLoad, []);
  // The summary counts DO work, which is what makes the emptiness look like real
  // data rather than a failure.
  check("while the summary counts are real, so the screen looks fine",
    stgAnalytics.body.analytics.summary.totalTeachers >= 2, true);

  /**
   * PUT /admin/settings/profile: the 409 nothing local can predict.
   *
   * The uniqueness check is User.findOne({ email, _id: { $ne: userId } }) with
   * NO role filter and NO tenancy — every User in the deployment, students
   * included, and students share addresses deliberately for siblings. The mirror
   * holds at most this school's staff, so the refusal is unknowable here, and a
   * queued one would stop the outbox with an unrelated payment behind it.
   */
  const stgProfileClash = await stgAsk("/api/admin/settings/profile",
    { name: "Head", email: "bursar@x.com" });
  check("a profile email held by a colleague is a 409 the mirror could not have " +
        "predicted", stgProfileClash.status, 409);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the structure of the school: counts, the school day, assignments ---");

  /**
   * ── WHERE THIS GOES ─────────────────────────────────────────────────────
   *
   * After the class and subject sections, and after `meta` and `queue` are
   * declared. It reuses Class, Subject, TeacherAssignment and UserModel from the
   * subject fixtures rather than inserting a second set, and it adds rows to
   * those collections — so spliced ABOVE them it would both fail to resolve the
   * models and change the answers those sections assert.
   *
   * It ends by mutating the server on purpose (the create and delete probes) and
   * puts the mirror back in step after each one, so a later section reading
   * classes or subjects still sees two stores that agree.
   *
   * ── ONE MOUNT IS NEEDED BEFORE THIS SECTION CAN RUN ──────────────────────
   *
   * The period endpoints are NOT in admin.routes.js. They live in
   * src/routes/periods.routes.js and src/server.js mounts them at
   * /api/admin/periods, ABOVE the /api/admin mount — deliberately, with a
   * comment saying why. This harness mounts only /api/admin, so every period
   * request here currently reaches the admin router's catch-all and comes back
   * as `Admin route not found`.
   *
   * It cannot be fixed by adding a mount after the fact: that catch-all answers
   * before a later mount is reached. So the line has to go ABOVE the existing
   * one, next to where the other routers are mounted:
   *
   *     app.use("/api/admin/periods", authenticate, require("../src/routes/periods.routes"));
   *     app.use("/api/admin", authenticate, require("../src/routes/admin.routes"));
   *
   * Until it is there, the probe below says so and the period assertions are
   * skipped rather than failing for a reason that has nothing to do with the
   * handlers.
   */

  const Period = require("../src/db/models/Period");
  await Period.init();

  /**
   * The school day, and the fixtures exist to hit each decision the controller
   * makes rather than to look like a timetable:
   *
   *   per-1  an ordinary period, first in the order
   *   per-2  a BREAK, and the one the toggle and the swap both touch
   *   per-3  an ordinary period, the one that gets reordered
   *   per-4  INACTIVE — still holds a place in the order, and is invisible to
   *          everybody's overlap check
   *   per-5  soft-deleted — out of the list, out of the ordering, and a 410 on
   *          a second delete
   *   per-9  another school's, which must never appear
   *
   * Every one carries `version`, because the update, toggle and delete paths all
   * compute `existing.version + 1` and the desktop declines a row whose version
   * is not a number rather than betting on when mongoose fills the default in.
   */
  await Period.collection.insertMany([
    { _id: "per-1", schoolId: SCHOOL, name: "First",   startTime: "08:00", endTime: "08:55",
      sortOrder: 1, isBreak: false, isActive: true,  version: 1, deletedAt: null, updatedAt: new Date() },
    { _id: "per-2", schoolId: SCHOOL, name: "Break",   startTime: "08:55", endTime: "09:10",
      sortOrder: 2, isBreak: true,  isActive: true,  version: 1, deletedAt: null, updatedAt: new Date() },
    { _id: "per-3", schoolId: SCHOOL, name: "Second",  startTime: "09:10", endTime: "10:05",
      sortOrder: 3, isBreak: false, isActive: true,  version: 1, deletedAt: null, updatedAt: new Date() },
    { _id: "per-4", schoolId: SCHOOL, name: "Retired", startTime: "10:05", endTime: "11:00",
      sortOrder: 4, isBreak: false, isActive: false, version: 1, deletedAt: null, updatedAt: new Date() },
    { _id: "per-5", schoolId: SCHOOL, name: "Gone",    startTime: "11:00", endTime: "12:00",
      sortOrder: 5, isBreak: false, isActive: true,  version: 1,
      deletedAt: new Date("2026-05-01"), updatedAt: new Date() },
    { _id: "per-9", schoolId: "other-school", name: "Elsewhere", startTime: "08:00", endTime: "09:00",
      sortOrder: 1, isBreak: false, isActive: true,  version: 1, deletedAt: null, updatedAt: new Date() },
  ]);

  /**
   * Two more rows for the structure section, and a scratch class for the probes
   * that have to actually delete something.
   *
   *   sub-orphan   a subject filed against a class id that does not exist. This
   *                is all it takes for GET /admin/classes/stats to report a
   *                class "with subjects" that the school does not have.
   *   as-class     the ONLY assignment in these fixtures filed under `class`
   *                rather than `classId`. Every other one uses classId, and the
   *                assignment list filters on `class` — so without this row the
   *                classId filter could not be shown to work at all.
   *   cls-scratch  a class with no pupils, so the delete probes below have
   *                something to destroy without disturbing cls-1..cls-9.
   *   sub-free     a subject with no teacher assignment: deletable.
   *   sub-held     a subject WITH one: a 409.
   *   as-held      the assignment that holds sub-held, and that the class
   *                delete cascades away.
   *   as-extra     a second assignment, for the assignment-delete probe.
   */
  await Class.collection.insertOne(
    { _id: "cls-scratch", schoolId: SCHOOL, name: "Scratch", isActive: true,
      deletedAt: null, updatedAt: new Date() }
  );
  await Subject.collection.insertMany([
    { _id: "sub-orphan", schoolId: SCHOOL, name: "Orphaned", classId: "cls-vanished",
      deletedAt: null, updatedAt: new Date() },
    { _id: "sub-free", schoolId: SCHOOL, name: "Unheld", classId: "cls-scratch",
      deletedAt: null, updatedAt: new Date() },
    { _id: "sub-held", schoolId: SCHOOL, name: "Held", classId: "cls-scratch",
      deletedAt: null, updatedAt: new Date() },
  ]);
  await TeacherAssignment.collection.insertMany([
    { _id: "as-class", schoolId: SCHOOL, subject: "sub-2", teacher: "t1", class: "cls-3",
      createdAt: new Date("2026-08-01"), deletedAt: null, updatedAt: new Date() },
    { _id: "as-held", schoolId: SCHOOL, subject: "sub-held", teacher: "t1", class: "cls-scratch",
      createdAt: new Date("2026-08-02"), deletedAt: null, updatedAt: new Date() },
    { _id: "as-extra", schoolId: SCHOOL, subject: "sub-held", teacher: "t2", class: "cls-scratch",
      createdAt: new Date("2026-08-03"), deletedAt: null, updatedAt: new Date() },
  ]);

  for (const [name, Model] of Object.entries({
    period: Period, class: Class, subject: Subject, teacherAssignment: TeacherAssignment,
    // Users too, and not as a formality: an earlier section removes t2 from the
    // mirror to simulate a bursar's gap and restores it, and the assignment list
    // joins on both teachers. A mirror missing one would report an id where the
    // server reports a name, and the diff would blame this handler.
    user: UserModel,
  })) {
    docs.putMany(name, JSON.parse(JSON.stringify(await Model.find({}).lean())));
  }

  /** The same request, straight at the endpoint, so a refusal is never assumed. */
  const askStructure = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload = null;
    try { payload = await res.json(); } catch { /* not every response is json */ }
    return { status: res.status, body: payload };
  };

  const periodsMounted =
    (await askStructure("GET", `/api/admin/periods?schoolId=${SCHOOL}`)).status === 200;
  if (!periodsMounted) {
    console.log("  ---- the periods router is not mounted here; see the note above. " +
                "Every period assertion in this section is SKIPPED.");
  }

  // ── The counts on the dashboard ────────────────────────────────────────

  await parity("class counts",   `/api/admin/classes/stats?schoolId=${SCHOOL}`);
  await parity("subject counts", `/api/admin/subjects/stats?schoolId=${SCHOOL}`);

  const classStats = api.handle({
    method: "GET", path: "/api/admin/classes/stats", query: { schoolId: SCHOOL },
  }, { docs }).data;

  /**
   * THE FINDING, stated as an assertion rather than left in a comment.
   *
   * `total` is active, undeleted classes: cls-1..cls-5 and cls-scratch, six.
   * `withSubjects` is the number of DISTINCT CLASS IDS MENTIONED BY SUBJECTS,
   * with no check that the class exists, is active or is undeleted: cls-1,
   * cls-2, cls-scratch and cls-vanished, four — and cls-vanished is not a class
   * at all. So the dashboard says "6 classes, 4 with subjects" while only three
   * of the school's classes have any.
   */
  check("class total counts the active, undeleted classes", classStats.total, 6);
  check("withSubjects counts class ids mentioned by subjects, existing or not",
    classStats.withSubjects, 4);
  check("and one of the four is not a class this school has",
    docs.get("class", "cls-vanished"), null);

  // ── Who takes what ────────────────────────────────────────────────────

  await parity("teacher assignments",       `/api/admin/assignments?schoolId=${SCHOOL}`);
  await parity("one teacher's assignments", `/api/admin/assignments?schoolId=${SCHOOL}&teacherId=t1`);
  await parity("by subject",                `/api/admin/assignments?schoolId=${SCHOOL}&subjectId=sub-3`);
  await parity("by class",                  `/api/admin/assignments?schoolId=${SCHOOL}&classId=cls-1`);
  await parity("by class, the spelling the filter reads",
    `/api/admin/assignments?schoolId=${SCHOOL}&classId=cls-3`);
  await parity("a teacher with nothing",    `/api/admin/assignments?schoolId=${SCHOOL}&teacherId=nobody`);

  const assignmentsFor = (query) => api.handle({
    method: "GET", path: "/api/admin/assignments", query,
  }, { docs }).data;

  /**
   * THE SECOND FINDING. The query parameter is classId and it is matched against
   * the assignment's `class` field, never against `classId` — unlike
   * GET /admin/subjects, which accepts both spellings for the same reason both
   * spellings exist in the data. as-1..as-6 are all filed under classId, so
   * filtering the assignment list by their class finds nothing at all, while
   * as-class (filed under `class`) is found.
   */
  check("filtering by a class whose assignments use classId finds none of them",
    assignmentsFor({ schoolId: SCHOOL, classId: "cls-1" }).count, 0);
  /**
   * And it is worse than a filter that misses them. The response's OWN classId is
   * derived from the row's `class` field too, so an assignment filed under
   * classId comes back with class: null and classId: null — a blank class column
   * on the screen, for a row that names its class perfectly well in the database.
   *
   * That is why the filter finds nothing: there is nothing to find. Both facts
   * are the same bug seen from two ends, and the fix is one line in
   * handleGetAssignments.
   */
  check("they are in the unfiltered list, with no class on them at all",
    assignmentsFor({ schoolId: SCHOOL }).assignments
      .filter((a) => ["as-1", "as-2", "as-3", "as-4", "as-5"].includes(a._id))
      // Sorted by id. All five rows have no createdAt, so they tie under the
      // endpoint's only sort key and their order is the storage engine's — which
      // is what the note on byCreatedAtDesc says. Pinning that order here would
      // assert a coincidence; the contents are the finding.
      .map((a) => [a._id, a.class, a.classId]).sort(),
    [["as-1", null, null], ["as-2", null, null], ["as-3", null, null],
     ["as-4", null, null], ["as-5", null, null]]);
  check("while the row in the database says which class it is",
    docs.get("teacherAssignment", "as-1").classId, "cls-1");
  check("and the filter does work for a row filed under `class`",
    assignmentsFor({ schoolId: SCHOOL, classId: "cls-3" }).assignments.map((a) => a._id),
    ["as-class"]);

  /**
   * THE THIRD FINDING. The subject is projected with .select("name code class
   * classId") — no coefficient — and then run through normaliseSubject(), which
   * defaults a missing coefficient to 1. So every subject on this screen reads
   * as coefficient 1 whatever the school set, and a school using coefficients
   * cannot see them here.
   *
   * Set on the real subject first, so the assertion is about the projection and
   * not about the fixture never having had a value.
   */
  await Subject.collection.updateOne({ _id: "sub-1" }, { $set: { coefficient: 4 } });
  docs.put("subject", JSON.parse(JSON.stringify(await Subject.findById("sub-1").lean())));

  await parity("assignments, with a coefficient the projection drops",
    `/api/admin/assignments?schoolId=${SCHOOL}&subjectId=sub-1`);
  check("a coefficient of 4 is reported as 1 by the assignment list",
    assignmentsFor({ schoolId: SCHOOL, subjectId: "sub-1" }).assignments[0].subject.coefficient, 1);
  check("while the subject list reports the real one",
    api.handle({ method: "GET", path: "/api/admin/subjects", query: { schoolId: SCHOOL } }, { docs })
      .data.subjects.find((s) => s._id === "sub-1").coefficient, 4);

  /**
   * An unresolvable reference keeps its id here and becomes null in the subject
   * list — two endpoints, two answers, because one spreads an empty map and the
   * other goes through populate(). Worth pinning: a screen that reads
   * assignment.teacher.name would print undefined rather than falling into its
   * "unassigned" branch.
   */
  check("a teacher this machine does not hold is an id and nothing else",
    assignmentsFor({ schoolId: SCHOOL }).assignments.find((a) => a._id === "as-6").teacher,
    { _id: "ghost" });

  // ── The school day ────────────────────────────────────────────────────

  if (periodsMounted) {
    await parity("the school day", `/api/admin/periods?schoolId=${SCHOOL}`);
    await parity("including the retired ones",
      `/api/admin/periods?schoolId=${SCHOOL}&includeInactive=true`);

    const day = api.handle({
      method: "GET", path: "/api/admin/periods", query: { schoolId: SCHOOL },
    }, { docs }).data;

    check("in sortOrder, and keyed `data` rather than `periods`",
      day.data.map((p) => p._id), ["per-1", "per-2", "per-3"]);
    check("with a count beside it", day.count, 3);
    // includeInactive here drops ONLY the isActive filter — unlike
    // GET /admin/classes, where the same parameter drops the deleted filter too.
    // One parameter name, two meanings, and this is the assertion that says so.
    check("includeInactive brings back the retired period and NOT the deleted one",
      api.handle({
        method: "GET", path: "/api/admin/periods",
        query: { schoolId: SCHOOL, includeInactive: "true" },
      }, { docs }).data.data.map((p) => p._id),
      ["per-1", "per-2", "per-3", "per-4"]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a class, a subject and the school day changed with no connection ---");

  const structureSession = {
    userId: "admin-1", role: ROLES.SCHOOL_ADMIN, schoolId: SCHOOL,
    permissions: ["classes.manage", "subjects.manage", "periods.manage", "teachers.manage"],
  };
  const structureCtx = { docs, meta, queue, session: structureSession };

  // ── Renaming a class ──────────────────────────────────────────────────

  const renamed = api.handle({
    method: "PUT", path: "/api/admin/classes/cls-4", query: {},
    body: { name: "  Zebra House  ", section: "  B  " },
  }, structureCtx);

  check("a class rename is accepted locally", renamed?.status, 200);
  check("and queued", renamed?.queued, true);
  check("the name is trimmed the way the endpoint trims it",
    renamed.data.class.name, "Zebra House");
  // The endpoint does NOT trim section — the SCHEMA does, and the stored value is
  // therefore trimmed. A mirror keeping the untrimmed string would disagree with
  // the server about a field nobody had changed.
  check("and so is a field only the schema trims", renamed.data.class.section, "B");
  check("with the `id` alias toObject() adds on this model", renamed.data.class.id, "cls-4");
  check("the row is in the mirror, not yet sent", docs.get("class", "cls-4")?._pending, true);
  check("and keeps a field the edit never mentioned",
    docs.get("class", "cls-4")?.isActive, true);

  // Each decline, against the real refusal.
  const classRejections = [
    // `name.trim()` on a number is a TypeError before mongoose sees it.
    ["a name that is not a string", { name: 7 }],
    // maxlength 100, under runValidators.
    ["a name over 100 characters",  { name: "x".repeat(101) }],
    // Not in mongoose's boolean conversion sets, so a CastError.
    ["isActive as arbitrary prose", { isActive: "maybe" }],
  ];
  for (const [what, body] of classRejections) {
    check(`not queued: ${what}`,
      api.handle({ method: "PUT", path: "/api/admin/classes/cls-5", query: {}, body },
        structureCtx),
      null);
    const refused = await askStructure("PUT", "/api/admin/classes/cls-5", body);
    check(`and the server really does refuse it: ${what}`, refused.status >= 400, true);
  }

  /**
   * ── The one that answers 500, which is worse than a 400 ──────────────────
   *
   * A name of "   " trims to "" and the endpoint sets it. Mongoose's update
   * validators DO run `required` on a path that is in the update, so this is a
   * ValidationError — and nothing maps it, so it surfaces as a 500.
   *
   * That matters more than the wrong number. The outbox treats 5xx as
   * RETRYABLE, on the reasonable theory that a server error is transient. This
   * one never will be: the same body fails the same way for ever, so a queued
   * write like it would retry on every cycle until somebody looked. A 409 stops
   * the queue and asks for a person; a 500 does not even do that.
   *
   * The handler declines it, so it is never queued from here. Reported for the
   * same ValidationError → 400 mapping that PUT /admin/settings/grading just
   * got. Asserted as "refused" rather than as 500 so the assertion survives the
   * fix, with the current status printed beside it.
   */
  {
    const blank = await askStructure("PUT", "/api/admin/classes/cls-scratch", { name: "   " });
    check("not queued: a name that is only spaces",
      api.handle({ method: "PUT", path: "/api/admin/classes/cls-scratch", query: {},
        body: { name: "   " } }, structureCtx),
      null);
    check("and the server refuses it: a name that is only spaces",
      blank.status >= 400, true);
    console.log(`  ---- and it refuses it with ${blank.status}` +
      (blank.status === 500 ? " — a ValidationError surfacing uncaught, and retryable" : ""));
    // Put the mirror back in step whatever happened, so nothing downstream sees
    // a class that differs between the two stores.
    docs.put("class", JSON.parse(JSON.stringify(await Class.findById("cls-scratch").lean())));
  }

  /**
   * Deliberately stricter than the server, and said out loud.
   *
   * Mongoose coerces "yes", "no", "1" and "0" to booleans. This layer does not
   * reproduce that table — a wrong entry in it would queue a CastError — so any
   * non-boolean is declined. cls-6 is already inactive, so the probe changes
   * nothing.
   */
  check("a coercible non-boolean is declined too",
    api.handle({ method: "PUT", path: "/api/admin/classes/cls-6", query: {},
      body: { isActive: "no" } }, structureCtx),
    null);
  {
    const coerced = await askStructure("PUT", "/api/admin/classes/cls-6", { isActive: "no" });
    check("even though the server would have taken it", coerced.status, 200);
    docs.put("class", JSON.parse(JSON.stringify(await Class.findById("cls-6").lean())));
  }

  /**
   * THE FOURTH FINDING, and the one with teeth: this path has no uniqueness
   * check and there is no unique index behind it either. POST /admin/classes
   * refuses a duplicate name with a 409; PUT happily makes one.
   *
   * Reproduced rather than guarded, because a local check the server does not
   * make would decline a write the server accepts and the rename would need a
   * connection. Asserted so that if the endpoint ever grows the check, the
   * mirror is known to need it too — this assertion is what will fail.
   */
  {
    const duplicate = await askStructure("PUT", "/api/admin/classes/cls-3", { name: "Form 1" });
    check("renaming one class onto another's name is accepted by the server",
      duplicate.status, 200);
    check("and the school now has two classes called Form 1",
      await Class.countDocuments({ schoolId: SCHOOL, name: "Form 1", isActive: true }), 2);
    check("which the local handler also allows, because the server does",
      api.handle({ method: "PUT", path: "/api/admin/classes/cls-3", query: {},
        body: { name: "Form 1" } }, structureCtx)?.status,
      200);
    // Undo it on both sides: a duplicate name would make every later comparison
    // of the class list about this probe rather than about the handler.
    await Class.collection.updateOne({ _id: "cls-3" },
      { $set: { name: "Form 2", updatedAt: new Date() } });
    docs.put("class", JSON.parse(JSON.stringify(await Class.findById("cls-3").lean())));
    // The queued rename of cls-3 goes with it. Left in the outbox it would
    // re-apply the duplicate on the next cycle.
    for (const item of queue.all()) {
      if (item.path === "/api/admin/classes/cls-3") queue.discard(item.seq);
    }
  }

  // ── Editing a subject ─────────────────────────────────────────────────

  const editedSubject = api.handle({
    method: "PUT", path: "/api/admin/subjects/sub-1", query: {},
    body: { name: "Further Mathematics", code: " MTH ", coefficient: "2.567" },
  }, structureCtx);

  check("a subject edit is accepted locally", editedSubject?.status, 200);
  check("and is its own queue entry, not a duplicate of the class rename",
    editedSubject?.duplicate, false);
  check("the code is trimmed", editedSubject.data.subject.code, "MTH");
  // parseCoefficient rounds to two places. A coefficient is a MULTIPLIER here —
  // 2 means "counts double" — while ExamSubject.weight is percentage-style, and
  // nothing converts between them on this path.
  check("the coefficient is rounded to two places",
    editedSubject.data.subject.coefficient, 2.57);
  check("the teacher is joined onto the response",
    editedSubject.data.subject.teacher._id, "t1");
  // .lean() on this endpoint, so no `id` alias — unlike the class response above.
  // Same router, two conventions, and a screen reading `.id` gets undefined.
  check("and there is no `id` alias on this one",
    Object.prototype.hasOwnProperty.call(editedSubject.data.subject, "id"), false);

  const subjectRejections = [
    ["a coefficient of zero",        { coefficient: 0 }],
    ["a coefficient above twenty",   { coefficient: 21 }],
    ["a coefficient that is prose",  { coefficient: "heavy" }],
    ["a class that does not exist",  { classId: "cls-vanished" }],
    ["a name that is only spaces",   { name: "   " }],
    ["a code that is not a string",  { code: 12 }],
  ];
  for (const [what, body] of subjectRejections) {
    check(`not queued: ${what}`,
      api.handle({ method: "PUT", path: "/api/admin/subjects/sub-2", query: {}, body },
        structureCtx),
      null);
    const refused = await askStructure("PUT", "/api/admin/subjects/sub-2", body);
    check(`and the server really does refuse it: ${what}`, refused.status >= 400, true);
  }

  // 403 and not 404, and not the 422 with a CLASS_NOT_SYNCED code that
  // POST /admin/subjects answers for the identical condition. A screen handling
  // one of those does not handle the other.
  check("an unknown class on an edit is a 403",
    (await askStructure("PUT", "/api/admin/subjects/sub-2", { classId: "cls-vanished" })).status,
    403);

  check("somebody without subjects.manage is not queued",
    api.handle({ method: "PUT", path: "/api/admin/subjects/sub-2", query: {},
      body: { name: "Nope" } },
      { docs, meta, queue, session: { ...structureSession, permissions: ["subjects.view"] } }),
    null);

  // ── The connection comes back ─────────────────────────────────────────

  const structureClient = client({ meta });
  structureClient.setServerUrl(`http://127.0.0.1:${port}`);
  structureClient.setToken(token);

  // The cursor in this file is set from fixtures dated across a school year, so
  // it sits in the future and nothing written during the run would be pulled.
  for (const collection of ["class", "subject", "period"]) {
    db.prepare("DELETE FROM sync_state WHERE collection = ?").run(collection);
  }

  const structureEngine = engine({
    docs, queue, state: store.state(db), client: structureClient,
    feedCollections: ["class", "subject", "period"],
  });

  await structureEngine.cycle();

  check("both requests drained", queue.all().length, 0);
  check("and the class settled", docs.get("class", "cls-4")?._pending, false);

  const onServerClass = await Class.findById("cls-4").lean();
  check("the server has the new name", onServerClass?.name, "Zebra House");
  check("and the section, trimmed", onServerClass?.section, "B");
  check("a field the edit never mentioned is untouched", onServerClass?.isActive, true);

  const onServerSubject = await Subject.findById("sub-1").lean();
  check("the subject was renamed", onServerSubject?.name, "Further Mathematics");
  // 2.567 rounded to two places by parseCoefficient, on both sides.
  check("with its coefficient", onServerSubject?.coefficient, 2.57);
  check("and the class it was already in", onServerSubject?.classId, "cls-1");

  await parity("the class list, after a round trip", `/api/admin/classes?schoolId=${SCHOOL}`);
  await parity("subjects, after a round trip",       `/api/admin/subjects?schoolId=${SCHOOL}`);
  await parity("class counts, after a round trip",   `/api/admin/classes/stats?schoolId=${SCHOOL}`);

  /**
   * ── An edit from a stale mirror must not revert somebody else ─────────────
   *
   * The same property the exam section pins, asserted again here because these
   * endpoints build their updates the same way and a handler that sent the whole
   * document would look correct in every test where one machine is the only
   * writer.
   */
  await Subject.collection.updateOne({ _id: "sub-1" },
    { $set: { description: "Set from the web", updatedAt: new Date() } });
  check("another machine's change is on the server",
    (await Subject.findById("sub-1").lean())?.description, "Set from the web");
  check("and this mirror has not seen it",
    docs.get("subject", "sub-1")?.description, undefined);

  api.handle({ method: "PUT", path: "/api/admin/subjects/sub-1", query: {},
    body: { code: "FMTH" } }, structureCtx);
  await structureEngine.cycle();

  {
    const both = await Subject.findById("sub-1").lean();
    check("the offline edit landed", both?.code, "FMTH");
    check("and the other machine's field survived it", both?.description, "Set from the web");
  }

  // ── The school day, changed offline ───────────────────────────────────

  if (periodsMounted) {
    const retimed = api.handle({
      method: "PUT", path: "/api/admin/periods/per-1", query: {},
      body: { endTime: "08:50" },
    }, structureCtx);
    check("a retime is accepted locally", retimed?.status, 200);
    check("keyed `data`, with the id alias the Period schema adds",
      retimed.data.data.id, "per-1");
    check("and the version is bumped", retimed.data.data.version, 2);

    // 409. An overlap with an ACTIVE period, which is the one that would stop
    // the outbox.
    check("an overlap is not queued",
      api.handle({ method: "PUT", path: "/api/admin/periods/per-1", query: {},
        body: { endTime: "09:00" } }, structureCtx),
      null);
    check("and the server really answers 409",
      (await askStructure("PUT", "/api/admin/periods/per-1", { endTime: "09:00" })).status, 409);

    // But an INACTIVE period holds no ground: checkOverlap filters isActive, so
    // per-4's hour is free for anybody. Reproduced because it is the endpoint's
    // rule, not because it is a good one.
    check("overlapping an inactive period is fine",
      api.handle({ method: "PUT", path: "/api/admin/periods/per-3", query: {},
        body: { endTime: "10:30" } }, structureCtx)?.status,
      200);

    const periodRejections = [
      ["a one-digit hour",          { startTime: "8:00" }],
      ["an end before the start",   { endTime: "07:00" }],
    ];
    for (const [what, body] of periodRejections) {
      check(`not queued: ${what}`,
        api.handle({ method: "PUT", path: "/api/admin/periods/per-2", query: {}, body },
          structureCtx),
        null);
      check(`and the server refuses it: ${what}`,
        (await askStructure("PUT", "/api/admin/periods/per-2", body)).status, 400);
    }

    /**
     * "25:99" IS a valid time to this endpoint — isValidTime is two digits, a
     * colon, two digits, and says nothing about hours below 24. Queued, because
     * a mirror that refused it would refuse a write the server takes and the
     * form would work online and not offline. Asserted so the behaviour is on
     * the record as the server's rather than as a bug in the handler.
     */
    check("a nonsense time the regex accepts is queued too",
      api.handle({ method: "PUT", path: "/api/admin/periods/per-4", query: {},
        body: { startTime: "25:00", endTime: "25:99" } }, structureCtx)?.status,
      200);

    check("a deleted period is a 404 and is not queued",
      api.handle({ method: "PUT", path: "/api/admin/periods/per-5", query: {},
        body: { endTime: "12:30" } }, structureCtx),
      null);
    check("and the server agrees",
      (await askStructure("PUT", "/api/admin/periods/per-5", { endTime: "12:30" })).status, 404);

    check("another school's period is not ours to edit",
      api.handle({ method: "PUT", path: "/api/admin/periods/per-9", query: {},
        body: { endTime: "09:30" } }, structureCtx),
      null);
    /**
     * THE FIFTH FINDING, now fixed on the server — so this asserts the fix.
     *
     * update, toggleActive, reorder and remove each began with
     * Period.findById(id) and then worked from `period.schoolId` — the ROW's
     * school, never the caller's. Their 404 meant "no such period", not "not
     * yours", so anybody holding periods.manage could rewrite, disable, reorder
     * or delete another school's timetable given only an id.
     *
     * findPeriodForCaller() closes it, and deliberately does not consult
     * resolveSchoolId: that one honours ?schoolId for a super_admin, and a
     * tenancy check that read the request would let a caller authorise
     * themselves by naming the school they wanted.
     *
     * 404 rather than 403 is the right refusal: somebody outside a school should
     * not learn that one of its periods exists.
     *
     * The desktop declined this before the fix and declines it now, for a
     * different reason — it holds one school's periods and has never heard of
     * that row. Both sides refusing for different reasons is fine; both sides
     * ACCEPTING was the bug.
     */
    check("and the SERVER refuses it too, now that the write paths are scoped",
      (await askStructure("PUT", "/api/admin/periods/per-9", { endTime: "09:30" })).status, 404);
    check("without saying whether such a period exists",
      (await askStructure("PUT", "/api/admin/periods/per-9", { endTime: "09:30" })).body?.message,
      "Period not found");
    check("and the other school's period is untouched",
      (await Period.findById("per-9").lean())?.endTime, "09:00");

    // ── The toggle, the swap and the retirement ─────────────────────────

    const toggled = api.handle({
      method: "PATCH", path: "/api/admin/periods/per-2/toggle", query: {}, body: {},
    }, structureCtx);
    check("the toggle is accepted", toggled?.status, 200);
    check("and flips isActive", toggled.data.data.isActive, false);
    check("bumping the version", toggled.data.data.version, 2);

    /**
     * ── The multi-document write ─────────────────────────────────────────
     *
     * A reorder is a neighbour SWAP: two rows change, and the second goes in
     * `also` so that the queue entry names it. A row nothing settles stays
     * pending for ever, and a pending row is never overwritten by a pull — so
     * without this the neighbour would hold this machine's guess at its position
     * permanently and the two halves of one swap would disagree.
     *
     * Bounded, which is why it can be queued at all: two documents, named
     * individually. No bulkWrite, no updateMany, no unbounded set.
     */
    const moved = api.handle({
      method: "POST", path: "/api/admin/periods/per-3/reorder", query: {},
      body: { direction: "up" },
    }, structureCtx);

    check("the swap is accepted", moved?.status, 200);
    check("the response is a two-element array, moved first",
      moved.data.data.map((p) => p._id), ["per-3", "per-2"]);
    check("the moved period takes its neighbour's place", moved.data.data[0].sortOrder, 2);
    check("and the neighbour takes its",                 moved.data.data[1].sortOrder, 3);
    // A reorder is the one period write that does NOT touch version. Both rows
    // are already at 2 — per-3 from the retime above, per-2 from the toggle — and
    // what this asserts is that the swap left them there.
    check("no version bump on either row",
      [moved.data.data[0].version, moved.data.data[1].version], [2, 2]);
    check("BOTH rows are in the mirror and both are pending",
      [docs.get("period", "per-3")?._pending, docs.get("period", "per-2")?._pending],
      [true, true]);

    check("moving the first period up is a 400 and is not queued",
      api.handle({ method: "POST", path: "/api/admin/periods/per-1/reorder", query: {},
        body: { direction: "up" } }, structureCtx),
      null);
    check("and the server really answers 400",
      (await askStructure("POST", "/api/admin/periods/per-1/reorder", { direction: "up" })).status,
      400);
    check("a direction that is neither up nor down is not queued",
      api.handle({ method: "POST", path: "/api/admin/periods/per-1/reorder", query: {},
        body: { direction: "sideways" } }, structureCtx),
      null);
    check("also a 400 on the server",
      (await askStructure("POST", "/api/admin/periods/per-1/reorder", { direction: "sideways" })).status,
      400);

    const retired = api.handle({
      method: "DELETE", path: "/api/admin/periods/per-4", query: {}, body: {},
    }, structureCtx);
    check("retiring a period is accepted", retired?.status, 200);
    check("with a message, not the period", retired.data,
      { success: true, message: "Period deleted" });
    check("it is SOFT, which is why this delete can be mirrored at all",
      Boolean(docs.get("period", "per-4")?.deletedAt), true);

    // 410 Gone, not 404, and it would stop the outbox exactly the same.
    check("a second delete is not queued",
      api.handle({ method: "DELETE", path: "/api/admin/periods/per-4", query: {}, body: {} },
        structureCtx),
      null);
    check("and the already-deleted per-5 is a 410 on the server",
      (await askStructure("DELETE", "/api/admin/periods/per-5")).status, 410);

    /**
     * Two periods sharing a sortOrder make the neighbour ambiguous: the
     * endpoint's .sort() picks between equals and nothing says which. The two
     * sides could swap DIFFERENT pairs, and the queue entry would then name a
     * row the server never touched — so the handler declines and lets the server
     * make the only choice that is made.
     *
     * Worth knowing how easily this happens: sortOrder defaults to 0, so a
     * school whose periods were inserted without one cannot reorder at all.
     */
    await Period.collection.insertOne(
      // sortOrder 2, which is where per-3 landed after the swap — so per-2, now
      // at 3, has TWO periods one place below it and no way to say which.
      { _id: "per-tie", schoolId: SCHOOL, name: "Tie", startTime: "13:00", endTime: "13:55",
        sortOrder: 2, isBreak: false, isActive: true, version: 1,
        deletedAt: null, updatedAt: new Date() }
    );
    docs.put("period", JSON.parse(JSON.stringify(await Period.findById("per-tie").lean())));
    check("an ambiguous neighbour goes to the network rather than being guessed at",
      api.handle({ method: "POST", path: "/api/admin/periods/per-2/reorder", query: {},
        body: { direction: "up" } }, structureCtx),
      null);

    check("somebody without periods.manage is not queued",
      api.handle({ method: "PATCH", path: "/api/admin/periods/per-1/toggle", query: {}, body: {} },
        { docs, meta, queue, session: { ...structureSession, permissions: ["periods.view"] } }),
      null);

    // ── Reconnecting ───────────────────────────────────────────────────

    await structureEngine.cycle();
    check("every period request drained", queue.all().length, 0);
    check("and the swapped neighbour settled — the row `also` exists for",
      docs.get("period", "per-2")?._pending, false);

    // Not named `server`: that is the harness's listening HTTP server two
    // hundred lines up, and shadowing it inside this block is how a later edit
    // here comes to fetch from a Map.
    const strDayOnServer = new Map(
      (await Period.find({ schoolId: SCHOOL }).lean()).map((p) => [p._id, p])
    );
    check("the retime reached the server", strDayOnServer.get("per-1").endTime, "08:50");
    check("the toggle did",               strDayOnServer.get("per-2").isActive, false);
    check("and the retirement did",
      Boolean(strDayOnServer.get("per-4").deletedAt), true);

    /**
     * ── The swap, and why it did not move the row the mirror predicted ───────
     *
     * The queued reorder was computed against a mirror in which per-2 was the
     * only period one place below per-3. By the time it was REPLAYED, per-tie
     * had been inserted at the same sortOrder — so the endpoint's
     * findOne(...).sort({ sortOrder: -1 }) had two equal candidates and picked
     * between them, and it did not pick the one this machine had guessed.
     *
     * This is the ambiguity the handler declines on, arriving by the back door:
     * declining at write time cannot help when the tie appears between the write
     * and its replay. What saves the mirror is push-then-pull — the pull in the
     * same cycle replaces both rows with the server's, so the wrong guess lives
     * for one cycle and not longer. That is the property worth pinning, and it
     * is the last assertion below.
     *
     * So: per-3 definitely gives up its place, and exactly one of the two rows
     * sharing the position below it definitely takes per-3's. WHICH one is the
     * storage engine's choice — reverse index order here, which happens to be
     * the newer row — and is not something either side promises.
     */
    check("the reordered period took the position below it",
      strDayOnServer.get("per-3").sortOrder, 2);
    {
      const shared = ["per-2", "per-tie"];
      check("and exactly one of the two rows sharing that position took its place",
        [shared.filter((id) => strDayOnServer.get(id).sortOrder === 3).length,
         shared.filter((id) => strDayOnServer.get(id).sortOrder === 2).length],
        [1, 1]);
      // THE ASSERTION THAT MATTERS. The mirror guessed per-2 and the server chose
      // per-tie; both rows are named on the queue entry, so both settled, and the
      // pull then corrected them. A row that had settled and NOT been corrected
      // would disagree with the school for ever.
      check("and the mirror agrees with the server about which one it was",
        ["per-1", "per-2", "per-3", "per-tie"].map((id) => docs.get("period", id).sortOrder),
        ["per-1", "per-2", "per-3", "per-tie"].map((id) => strDayOnServer.get(id).sortOrder));
    }

    await parity("the school day, after a round trip", `/api/admin/periods?schoolId=${SCHOOL}`);
    await parity("including the retired ones, after a round trip",
      `/api/admin/periods?schoolId=${SCHOOL}&includeInactive=true`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the seven writes in this domain that are NOT queued ---");

  /**
   * Each of these must be unanswered locally, and each for a stated reason. The
   * api.handle() calls below pass trivially — there is no route registered — so
   * what they actually assert is "this request goes over the network", which is
   * the property that matters. The server side of each pair is what makes the
   * reason checkable.
   *
   * The probes from here on MUTATE the server, so each one puts the mirror back
   * in step afterwards. Two of them do it with docs.forget(), which is the whole
   * problem: the write layer has no way to say "this row is gone", so the
   * harness has to do by hand what a handler cannot describe.
   */

  // ── 1. PATCH /admin/classes/:id/toggle-active — the route does not exist ──
  check("the class toggle is not queued",
    api.handle({ method: "PATCH", path: "/api/admin/classes/cls-5/toggle-active",
      query: {}, body: {} }, structureCtx),
    null);
  {
    const missing = await askStructure("PATCH", "/api/admin/classes/cls-5/toggle-active");
    check("because the endpoint does not exist — the console calls a 404",
      missing.status, 404);
    check("and it is the admin router's catch-all saying so",
      String(missing.body?.message || "").startsWith("Admin route not found"), true);
  }

  // ── 2, 3, 4. The creates: the server picks the id ────────────────────────
  for (const [what, path, body] of [
    ["a class",   "/api/admin/classes",  { id: "client-cls", name: "Form 3", schoolId: SCHOOL }],
    ["a subject", "/api/admin/subjects", { id: "client-sub", name: "Geography",
                                          classId: "cls-1", schoolId: SCHOOL }],
  ]) {
    check(`creating ${what} is not queued`,
      api.handle({ method: "POST", path, query: {}, body }, structureCtx), null);

    const created = await askStructure("POST", path, body);
    check(`the server accepts ${what}`, created.status, 201);
    // THE REASON. The endpoint reads body.id, echoes it back as clientId, and
    // then lets the model's default generate _id anyway — so the reply describes
    // a row this machine has never heard of while the row it wrote sits
    // orphaned. It is a mapping hint for a client that can remap ids; this one
    // stores documents under the id it chose and cannot.
    check(`and gives ${what} an id of its own`, created.body.serverId === body.id, false);
    check(`while echoing the client's id back as a hint`, created.body.clientId, body.id);
  }
  // Both new rows into the mirror, so no later comparison is about this probe.
  for (const [name, Model] of Object.entries({ class: Class, subject: Subject })) {
    docs.putMany(name, JSON.parse(JSON.stringify(await Model.find({}).lean())));
  }

  /**
   * Deliberately NOT against cls-scratch or its subjects.
   *
   * It was, and it made the subject-delete probe below answer 409 instead of 200:
   * this create gives the subject a teacher assignment, and
   * DELETE /admin/subjects/:id refuses a subject that has one. The probe was
   * quietly testing its own side effect.
   *
   * cls-2 and sub-5 instead. t2 has no assignment there — as-6 files sub-5 under
   * a teacher who does not exist — so the unique index is satisfied and nothing
   * the delete probes touch is affected.
   */
  const strNewAssignment =
    { teacherId: "t2", classId: "cls-2", subjectId: "sub-5", schoolId: SCHOOL };

  check("creating an assignment is not queued",
    api.handle({ method: "POST", path: "/api/admin/assignments", query: {},
      body: strNewAssignment }, structureCtx),
    null);
  {
    // This one does not even read an id from the body: TeacherAssignment.create
    // hard-codes uuidv4().
    const created = await askStructure("POST", "/api/admin/assignments", strNewAssignment);
    check("the server accepts it", created.status, 201);
    check("under an id it generated, with nothing echoed back",
      created.body.assignment.id.length, 36);
    docs.putMany("teacherAssignment",
      JSON.parse(JSON.stringify(await TeacherAssignment.find({}).lean())));
  }

  // ── 5, 6, 7. The deletes: a mirror cannot remove a row ──────────────────

  /**
   * THE SIXTH FINDING, and the one that decides three of these seven.
   *
   * A write handler describes rows to WRITE — `doc` and `also` both go through
   * docs.put — so there is no way to say "and this row is gone". Nor can the
   * sync feed ever say it: the feed sends documents that EXIST, so a row the
   * server hard-deleted is never mentioned again and a local copy of it sits on
   * the machine for ever.
   *
   * Marking it deleted locally does not help either, because GET /admin/subjects
   * applies no deleted filter at all — the subject would keep appearing on the
   * screen that had just deleted it. Every assertion below is the harness doing
   * with docs.forget() what a handler has no way to ask for.
   */
  for (const [what, path] of [
    ["a subject",    "/api/admin/subjects/sub-free"],
    ["an assignment", "/api/admin/assignments/as-extra"],
    ["a class",      "/api/admin/classes/cls-scratch"],
  ]) {
    check(`deleting ${what} is not queued`,
      api.handle({ method: "DELETE", path, query: {}, body: {} }, structureCtx), null);
  }

  // The 409s first, because they are the interesting refusals and neither
  // mutates anything.
  check("a subject with a teacher assignment cannot be deleted",
    (await askStructure("DELETE", "/api/admin/subjects/sub-held")).status, 409);
  check("nor a class with pupils in it",
    (await askStructure("DELETE", "/api/admin/classes/cls-1")).status, 409);
  /**
   * Which pupils hold it open, rather than how many.
   *
   * A count here was wrong twice over: cls-1 also holds rows the admissions
   * section inserts, so the number is not this section's to know, and a count
   * assertion would have stayed green if addNotDeleted were dropped and some
   * other fixture added. What the 409 turns on is that the SOFT-DELETED pupil is
   * not one of the ones holding the class.
   */
  {
    const inClassOne = await Student
      .find({ schoolId: SCHOOL, classId: "cls-1" }).select("_id deletedAt").lean();
    check("the soft-deleted pupil is in the class",
      inClassOne.some((s) => s._id === "p4"), true);
    check("but is not among the ones holding it open",
      inClassOne.filter((s) => !s.deletedAt).some((s) => s._id === "p4"), false);
    check("while the live ones are",
      inClassOne.filter((s) => !s.deletedAt).map((s) => s._id).includes("p1"), true);
  }

  // Then the ones that succeed, each followed by the hand-cleanup.
  {
    const gone = await askStructure("DELETE", "/api/admin/assignments/as-extra");
    check("an assignment delete is a HARD delete", gone.status, 200);
    check("the row is off the server entirely",
      await TeacherAssignment.countDocuments({ _id: "as-extra" }), 0);
    // Nothing in the sync feed will ever mention it again, so the mirror can only
    // be corrected by hand. This line is the missing primitive, written out.
    docs.forget("teacherAssignment", "as-extra");
  }

  {
    const gone = await askStructure("DELETE", "/api/admin/subjects/sub-free");
    check("a subject delete is a HARD delete", gone.status, 200);
    check("the row is off the server entirely",
      await Subject.countDocuments({ _id: "sub-free" }), 0);
    docs.forget("subject", "sub-free");
  }

  {
    const gone = await askStructure("DELETE", "/api/admin/classes/cls-scratch");
    check("a class with no pupils is deleted", gone.status, 200);
    // The class itself is SOFT-deleted…
    check("the class row survives, soft-deleted",
      Boolean((await Class.findById("cls-scratch").lean())?.deletedAt), true);
    // …and its subjects and assignments are removed outright. THIS is the
    // cascade that cannot be mirrored: one request, hard deletes across two
    // other collections.
    check("but its subject is gone outright",
      await Subject.countDocuments({ _id: "sub-held" }), 0);
    check("and so is the teacher assignment that held it",
      await TeacherAssignment.countDocuments({ _id: "as-held" }), 0);
    check("with a count of the subjects it removed", gone.body.deletedSubjects, 1);
    // THE SEVENTH FINDING: class.service.ts reads data.deletedAssignments and
    // the endpoint never sends it, so the office is always told nothing was
    // unassigned however many teachers just lost the class.
    check("and no count of the assignments, which the console does read",
      Object.prototype.hasOwnProperty.call(gone.body, "deletedAssignments"), false);

    docs.put("class", JSON.parse(JSON.stringify(await Class.findById("cls-scratch").lean())));

    /**
     * ── The cleanup a handler would have had to do, and cannot ───────────────
     *
     * Naming the rows was not enough. deleteMany takes EVERY subject and EVERY
     * assignment for the class, whatever else happened to point at it since —
     * and the set is not knowable from the request. Two forget() calls left the
     * mirror holding a row the cascade had removed, and the assignment list then
     * differed by 143 keys.
     *
     * So this asks the server what survived and drops the rest, which is exactly
     * the one thing a machine with no connection cannot do. It is the clearest
     * statement of why these three deletes are online-only: not "the cascade is
     * large", but "only the server knows what it removed".
     */
    for (const [collection, Model] of [
      ["subject", Subject], ["teacherAssignment", TeacherAssignment],
    ]) {
      const alive = new Set(
        (await Model.find({}).select("_id").lean()).map((r) => String(r._id))
      );
      for (const row of docs.find(collection, {})) {
        if (!alive.has(String(row._id))) docs.forget(collection, row._id);
      }
    }
  }

  check("the outbox is still empty — nothing in this section queued a refusal",
    queue.all().length, 0);

  await parity("the class list, after all of that",
    `/api/admin/classes?schoolId=${SCHOOL}`);
  await parity("subjects, after all of that",
    `/api/admin/subjects?schoolId=${SCHOOL}`);
  await parity("assignments, after all of that",
    `/api/admin/assignments?schoolId=${SCHOOL}`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- finance: staff, salaries, and the income statement ---");

  /**
   * ── SPLICE THIS AT THE END of main(), just before server.close() ─────────
   *
   * Not a preference. This section inserts USERS, and several sections above it
   * assert exact teacher and staff lists by id — /admin/teachers among them — so
   * placed earlier it would "fail" assertions that are correct. Everything it
   * adds is prefixed `fin-` for the same reason.
   *
   * It also re-mirrors the user collection at the end of the fixtures, because
   * the payroll join and the staff list both read it.
   *
   * ── Two things to know about what is compared ───────────────────────────
   *
   * SORT TIES ARE NOT A PROMISE. /finance/salary-structures sorts on
   * effectiveFrom alone and the report's byCategory sorts on total alone;
   * neither endpoint has a tiebreak, so two rows with the same value come back
   * in whatever order the storage engine used. The fixtures below deliberately
   * avoid ties so that parity()'s positional diff is meaningful. If a tie is
   * ever added, that array has to be compared by key rather than by position.
   *
   * THE DECLINES HERE ARE NOT ALL REFUSALS. Most declines in this harness are
   * asserted by showing the server refusing the same request. Two of these are a
   * different thing: /finance/staff and /finance/salary-structures decline for a
   * bursar because the FEED will not mirror the collections they read, while the
   * server answers them perfectly well. So those are asserted against the feed
   * table itself rather than against a status code — that is where the authority
   * is, and a guess about it would be exactly the sort of quiet death the
   * offline path dies of.
   */

  const FinUser            = require("../src/db/models/User");
  const FinExpense         = require("../src/db/models/Expense");
  const FinExpenseCategory = require("../src/db/models/ExpenseCategory");
  const FinSalaryStructure = require("../src/db/models/SalaryStructure");
  const FinSalaryPayment   = require("../src/db/models/SalaryPayment");
  const FinPayrollRun      = require("../src/db/models/PayrollRun");
  const FinSchool          = require("../src/db/models/School");
  const finFeed            = require("../src/config/syncFeed");
  const finDefaults        = require("../src/services/permissions.service").defaultsFor;
  const finJwt             = require("jsonwebtoken");

  await Promise.all([
    FinUser.init(), FinExpense.init(), FinExpenseCategory.init(),
    FinSalaryStructure.init(), FinSalaryPayment.init(), FinPayrollRun.init(),
  ]);

  const finHead = {
    token,
    session: {
      userId: "admin-1", role: "school_admin", schoolId: SCHOOL,
      permissions: finDefaults("school_admin"),
    },
  };

  // A bursar: holds payroll.view, payroll.process, expenses.manage and
  // finance.reports, and holds neither payroll.setSalary nor users.manage. That
  // pair of absences is what the two declines below are about.
  const finBursar = {
    token: finJwt.sign(
      { id: "fin-bursar", role: "bursar", schoolId: SCHOOL },
      process.env.JWT_SECRET, { expiresIn: "1h" }
    ),
    session: {
      userId: "fin-bursar", role: "bursar", schoolId: SCHOOL,
      permissions: finDefaults("bursar"),
    },
  };

  // A teacher: holds none of this router's three capabilities, so the guard at
  // the top of it refuses them outright. Used only to show what a 403 looks
  // like, which is the answer that stops an outbox.
  const finTeacher = {
    token: finJwt.sign(
      { id: "t1", role: "teacher", schoolId: SCHOOL },
      process.env.JWT_SECRET, { expiresIn: "1h" }
    ),
    session: {
      userId: "t1", role: "teacher", schoolId: SCHOOL,
      permissions: finDefaults("teacher"),
    },
  };

  const finLocal = (method, path, { body = {}, query = {}, as = finHead } = {}) =>
    api.handle({ method, path, query, body }, { docs, meta, queue, session: as.session });

  const finSend = async (method, path, body, as = finHead) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${as.token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  // ── Fixtures ────────────────────────────────────────────────────────────

  await FinUser.collection.insertMany([
    { _id: "fin-bursar", schoolId: SCHOOL, name: "Grace Ayuk", email: "grace.ayuk@x.com",
      role: "bursar", isActive: true, password: "x", updatedAt: new Date() },
    // Deactivated: the filter is isActive: true, so this is off the payroll list.
    { _id: "fin-inactive", schoolId: SCHOOL, name: "Zoe Retired", email: "zoe@x.com",
      role: "teacher", isActive: false, password: "x", updatedAt: new Date() },
    // NO isActive FIELD AT ALL — the case that separates `isActive: true` from
    // `isActive: { $ne: false }`. This account fails the first and passes the
    // second, and the endpoint uses the first.
    { _id: "fin-nofield", schoolId: SCHOOL, name: "Aaron Legacy", email: "aaron@x.com",
      role: "teacher", password: "x", updatedAt: new Date() },
    { _id: "fin-other", schoolId: "other-school", name: "Far Away", email: "far@x.com",
      role: "teacher", isActive: true, password: "x", updatedAt: new Date() },
  ]);

  await FinSalaryStructure.collection.insertMany([
    // t1's trail: one closed row and one in force. A raise closes rather than
    // overwrites, which is what makes an old payslip reproducible.
    { _id: "fin-ss-t1-old", schoolId: SCHOOL, userId: "t1", baseAmount: 150000,
      allowances: [], deductions: [],
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo:   new Date("2026-06-30T23:59:59.999Z"),
      deletedAt: null, updatedAt: new Date() },
    { _id: "fin-ss-t1", schoolId: SCHOOL, userId: "t1", baseAmount: 180000,
      allowances: [{ code: "HOU", label: "Housing", labelFr: null, amount: 30000 },
                   { code: "TRA", label: "Transport", labelFr: null, amount: 10000 }],
      deductions: [{ code: "TAX", label: "Tax", labelFr: null, amount: 12000 }],
      effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), effectiveTo: null,
      deletedAt: null, updatedAt: new Date() },
    { _id: "fin-ss-t2", schoolId: SCHOOL, userId: "t2", baseAmount: 200000,
      allowances: [], deductions: [],
      effectiveFrom: new Date("2026-02-01T00:00:00.000Z"), effectiveTo: null,
      deletedAt: null, updatedAt: new Date() },
    // Deleted, and open-ended: excluded by deletedAt, and outside the unique
    // index for the same reason, which is why two open rows for t1 can coexist.
    { _id: "fin-ss-gone", schoolId: SCHOOL, userId: "t1", baseAmount: 999999,
      allowances: [], deductions: [],
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"), effectiveTo: null,
      deletedAt: new Date("2026-08-02T00:00:00.000Z"), updatedAt: new Date() },
    // A structure in THIS school naming somebody in another one. The endpoint's
    // staff join is scoped to the school, so it resolves to null — and the local
    // handler has to answer null too rather than joining the user it holds.
    { _id: "fin-ss-foreign", schoolId: SCHOOL, userId: "fin-other", baseAmount: 1,
      allowances: [], deductions: [],
      effectiveFrom: new Date("2026-03-01T00:00:00.000Z"), effectiveTo: null,
      deletedAt: null, updatedAt: new Date() },
    { _id: "fin-ss-elsewhere", schoolId: "other-school", userId: "t1", baseAmount: 5,
      allowances: [], deductions: [],
      effectiveFrom: new Date("2026-04-01T00:00:00.000Z"), effectiveTo: null,
      deletedAt: null, updatedAt: new Date() },
  ]);

  // An expense whose category document does not exist — a category deleted
  // outright at some point in the past, which the report's $lookup finds nothing
  // for and labels "—". Inserted with the first batch so that it is counted
  // before the before/after assertions below start.
  await FinExpense.collection.insertOne({
    _id: "fin-ex-nocat", schoolId: SCHOOL, categoryId: "fin-ec-missing", amount: 700,
    status: "approved", incurredAt: new Date("2026-10-15T00:00:00.000Z"),
    deletedAt: null, voidedAt: null, updatedAt: new Date(),
  });

  /**
   * Both stores, holding the same rows.
   *
   * The report sums FOUR collections, two of which earlier sections write to, so
   * this re-mirrors fee payments and charges as well — otherwise a difference
   * left over from another section would be reported as a difference in this
   * one, which is the least useful kind of failure.
   */
  const FinFeePayment = require("../src/db/models/FeePayment");
  const FinFeeCharge  = require("../src/db/models/FeeCharge");

  const finMirror = async () => {
    for (const [name, Model] of Object.entries({
      user:            FinUser,
      salaryStructure: FinSalaryStructure,
      salaryPayment:   FinSalaryPayment,
      expense:         FinExpense,
      expenseCategory: FinExpenseCategory,
      feePayment:      FinFeePayment,
      feeCharge:       FinFeeCharge,
    })) {
      docs.putMany(name, JSON.parse(JSON.stringify(await Model.find({}).lean())));
    }
  };
  await finMirror();

  // ── Who can be put on payroll ───────────────────────────────────────────

  await parity("who can be put on payroll", `/api/finance/staff?schoolId=${SCHOOL}`, finHead);

  const finStaff = finLocal("GET", "/api/finance/staff", { query: { schoolId: SCHOOL } }).data;
  const finStaffIds = finStaff.data.map((s) => s._id);

  check("the head and the teachers are on it",
    ["admin-1", "t1", "t2"].every((id) => finStaffIds.includes(id)), true);
  check("a deactivated account is not",
    finStaffIds.includes("fin-inactive"), false);
  // The one that separates the two readings of the field.
  check("nor is an account that never had isActive at all",
    finStaffIds.includes("fin-nofield"), false);
  check("nor anybody from another school",
    finStaffIds.includes("fin-other"), false);
  /**
   * THE BURSAR IS NOT ON THE PAYROLL LIST.
   *
   * The endpoint's own comment says it exists because /admin/teachers "would
   * leave the head and the bursar off the payroll entirely" — and then filters
   * role $in ["school_admin", "teacher"], which leaves the bursar off. So a
   * school cannot give its own bursar a salary structure through this screen.
   * Reproduced exactly and reported as a defect; a mirror that helpfully added
   * them would offer a structure the server then refuses to find.
   */
  check("and the bursar is left off, exactly as the endpoint leaves them off",
    finStaffIds.includes("fin-bursar"), false);

  check("projected to name, email and role and nothing else",
    Object.keys(finStaff.data[0]).sort(), ["_id", "email", "name", "role"]);
  check("sorted by Mongo's byte order, not localeCompare",
    finStaff.data.map((s) => s.name),
    [...finStaff.data.map((s) => s.name)].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1)));

  // ── The two declines that are not refusals ──────────────────────────────
  console.log("--- and it declines where a bursar's mirror is empty ---");

  check("a bursar is not answered locally for the staff list",
    finLocal("GET", "/api/finance/staff", { query: { schoolId: SCHOOL }, as: finBursar }),
    null);
  // Because the feed will not send them the collection, while the server will
  // answer the request. An empty list would say "this school has no staff".
  check("because users.manage is what mirrors the user collection",
    finFeed.satisfies(finFeed.byCollection.get("user"), new Set(finDefaults("bursar"))),
    false);
  const finStaffFromServer = await fetch(
    `http://127.0.0.1:${port}/api/finance/staff?schoolId=${SCHOOL}`,
    { headers: { authorization: `Bearer ${finBursar.token}` } }
  );
  check("and the server answers the same bursar without complaint",
    finStaffFromServer.status, 200);
  check("which is the whole point: the decline is about the mirror, not the rule",
    (await finStaffFromServer.json()).data.length > 0, true);

  // ── Salary structures ───────────────────────────────────────────────────

  await parity("salary structures in force",
    `/api/finance/salary-structures?schoolId=${SCHOOL}`, finHead);
  await parity("the whole trail",
    `/api/finance/salary-structures?schoolId=${SCHOOL}&history=1`, finHead);
  await parity("one person's",
    `/api/finance/salary-structures?schoolId=${SCHOOL}&userId=t1`, finHead);
  await parity("one person's whole trail",
    `/api/finance/salary-structures?schoolId=${SCHOOL}&userId=t1&history=1`, finHead);
  await parity("somebody with none",
    `/api/finance/salary-structures?schoolId=${SCHOOL}&userId=fin-nofield`, finHead);
  // history=0 is NOT "no history" — the test is `!== "1"`, so anything other
  // than the string 1 means only what is in force. Surprising, and reproduced.
  await parity("history=0 still means only what is in force",
    `/api/finance/salary-structures?schoolId=${SCHOOL}&history=0`, finHead);

  const finForce = finLocal("GET", "/api/finance/salary-structures",
    { query: { schoolId: SCHOOL } }).data;
  const finTrail = finLocal("GET", "/api/finance/salary-structures",
    { query: { schoolId: SCHOOL, history: "1" } }).data;

  check("only the open rows by default",
    finForce.data.map((r) => r._id).sort(), ["fin-ss-foreign", "fin-ss-t1", "fin-ss-t2"]);
  check("the closed row appears only with history=1",
    finTrail.data.map((r) => r._id).includes("fin-ss-t1-old"), true);
  check("a deleted structure appears in neither",
    finTrail.data.map((r) => r._id).includes("fin-ss-gone"), false);
  check("nor another school's",
    finTrail.data.map((r) => r._id).includes("fin-ss-elsewhere"), false);
  check("newest effective date first",
    finTrail.data.map((r) => r.effectiveFrom),
    [...finTrail.data.map((r) => r.effectiveFrom)]
      .sort((a, b) => (a === b ? 0 : a < b ? 1 : -1)));

  // gross is base PLUS allowances, with deductions NOT taken off — and it is
  // computed by the route rather than read from the model's virtual, which
  // .lean() drops. Reading the virtual instead would also add a `net` key the
  // server never sends.
  const finT1 = finForce.data.find((r) => r._id === "fin-ss-t1");
  check("gross is base plus allowances", finT1.gross, 180000 + 30000 + 10000);
  check("and there is no net key, because the endpoint does not send one",
    Object.prototype.hasOwnProperty.call(finT1, "net"), false);

  check("a structure naming another school's staff joins to null, as the server's does",
    finForce.data.find((r) => r._id === "fin-ss-foreign").staff, null);

  // The same gap as the staff list, one collection along.
  check("a bursar is not answered locally for the salary structures either",
    finLocal("GET", "/api/finance/salary-structures",
      { query: { schoolId: SCHOOL }, as: finBursar }),
    null);
  check("because the feed gates salaryStructure on payroll.setSalary",
    finFeed.byCollection.get("salaryStructure").permission, "payroll.setSalary");
  check("which a bursar does not hold, though the endpoint only wants payroll.view",
    [finDefaults("bursar").includes("payroll.setSalary"),
     finDefaults("bursar").includes("payroll.view")],
    [false, true]);

  // And the join declines rather than blanking a name, as the payslip view does.
  docs.forget("user", "t2");
  check("a structure whose staff is not mirrored makes it decline",
    finLocal("GET", "/api/finance/salary-structures", { query: { schoolId: SCHOOL } }),
    null);
  docs.putMany("user", JSON.parse(JSON.stringify(await FinUser.find({}).lean())));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the income statement, where four filters are load-bearing ---");

  await parity("the report, all time", `/api/finance/reports/summary?schoolId=${SCHOOL}`, finHead);
  await parity("the report over one month",
    `/api/finance/reports/summary?schoolId=${SCHOOL}&from=2026-09-01&to=2026-09-30T23:59:59.999Z`,
    finHead);
  await parity("with an academic year, which narrows the arrears and not the flow",
    `/api/finance/reports/summary?schoolId=${SCHOOL}&academicYear=${YEAR}`, finHead);
  await parity("a period with nothing in it",
    `/api/finance/reports/summary?schoolId=${SCHOOL}&from=2030-01-01&to=2030-01-31`, finHead);
  await parity("from with no to", `/api/finance/reports/summary?schoolId=${SCHOOL}&from=2026-09-15`,
    finHead);

  /**
   * ── Each filter, asserted by moving one row and watching the total ───────
   *
   * Written as a before/after rather than as an absolute figure on purpose:
   * this section runs after several others that write expenses of their own, so
   * an absolute total here would be an assertion about them. What matters is the
   * RULE — that this row does or does not move the number.
   */
  /**
   * The FLOW half of the answer, which is not the whole answer.
   *
   * The endpoint replies { data: { summary, arrears } } and keeps the two in
   * separate objects on purpose: the summary is a flow over an interval and
   * arrears are a position at a moment, so a caller cannot add them together by
   * accident. This helper read `.data.data` as if it WERE the summary, which
   * threw on the first assertion below — the nesting is the point of the
   * response shape and reaching past it is exactly the mistake it guards.
   */
  const finReport  = () => finLocal("GET", "/api/finance/reports/summary",
    { query: { schoolId: SCHOOL } }).data.data.summary;

  /** And the POSITION half, over the same request. */
  const finArrears = (qs = "") => finLocal("GET", "/api/finance/reports/summary", {
    query: Object.fromEntries(new URLSearchParams(`schoolId=${SCHOOL}&${qs}`)),
  }).data.data.arrears;

  const finBefore = finReport();

  await FinExpense.collection.insertMany([
    // Waiting for a second signature. Counting it would tell a head the money
    // is gone before anybody agreed it should be.
    { _id: "fin-ex-pending", schoolId: SCHOOL, categoryId: "ec-2", amount: 777000,
      status: "pending", incurredAt: new Date("2026-10-10T00:00:00.000Z"),
      deletedAt: null, voidedAt: null, updatedAt: new Date() },
    // Somebody said no. Kept for the record, never counted.
    { _id: "fin-ex-rejected", schoolId: SCHOOL, categoryId: "ec-2", amount: 555000,
      status: "rejected", incurredAt: new Date("2026-10-11T00:00:00.000Z"),
      deletedAt: null, voidedAt: null, updatedAt: new Date() },
    // Cancelled: in the ledger listing, out of every total.
    { _id: "fin-ex-voided", schoolId: SCHOOL, categoryId: "ec-2", amount: 333000,
      status: "approved", incurredAt: new Date("2026-10-12T00:00:00.000Z"),
      deletedAt: null, voidedAt: new Date("2026-10-13T00:00:00.000Z"), updatedAt: new Date() },
  ]);
  await finMirror();

  check("a pending, a rejected and a voided expense move nothing",
    finReport().expenditure.expenses, finBefore.expenditure.expenses);
  await parity("and the server agrees about all three",
    `/api/finance/reports/summary?schoolId=${SCHOOL}`, finHead);

  const finAfterExpenses = finReport();

  // A draft pays nobody, so it is not expenditure.
  await FinSalaryPayment.collection.insertOne({
    _id: "fin-slip-draft", schoolId: SCHOOL, userId: "t2", runId: "fin-run",
    periodMonth: "2026-10", gross: 500000, totalDeductions: 0, net: 500000,
    status: "draft", paidAt: null, deletedAt: null, updatedAt: new Date(),
  });
  await finMirror();

  check("a draft payslip is not expenditure",
    finReport().expenditure.payroll, finAfterExpenses.expenditure.payroll);

  /**
   * THE PAIR THAT CATCHES `status: "paid"`.
   *
   * Reversing a run flips each original to "reversed" and appends a negative
   * mirror that is itself "paid". Summing only paid rows keeps the mirror and
   * drops the original, so a reversed month reports as a large NEGATIVE
   * expenditure — 100,000 of imaginary income in this fixture. Excluding drafts
   * instead keeps both halves, and they cancel, which is what this pins.
   */
  await FinSalaryPayment.collection.insertMany([
    { _id: "fin-slip-rev-orig", schoolId: SCHOOL, userId: "t1", runId: "fin-run-2",
      periodMonth: "2026-11", gross: 120000, totalDeductions: 20000, net: 100000,
      status: "reversed", paidAt: new Date("2026-11-05T00:00:00.000Z"),
      deletedAt: null, updatedAt: new Date() },
    { _id: "fin-slip-rev", schoolId: SCHOOL, userId: "t1", runId: null,
      periodMonth: "2026-11", gross: -120000, totalDeductions: -20000, net: -100000,
      status: "paid", reversesId: "fin-slip-rev-orig",
      paidAt: new Date("2026-11-05T00:00:00.000Z"), deletedAt: null, updatedAt: new Date() },
  ]);
  await finMirror();

  check("and a reversed run nets to zero rather than to minus its own value",
    finReport().expenditure.payroll, finAfterExpenses.expenditure.payroll);
  await parity("and the server agrees about the payroll filter",
    `/api/finance/reports/summary?schoolId=${SCHOOL}`, finHead);

  // The reversal pair IS in the monthly series, on both sides, at zero. A
  // handler that dropped either half would report a month that never happened.
  const finNov = finReport().months.find((m) => m.month === "2026-11");
  check("november exists in the series and cancels", finNov && finNov.expenditure, 0);

  // The endpoint's $ifNull, which is not the same as leaving the label out.
  check("an expense whose category has no document is labelled with a dash",
    finReport().byCategory.find((c) => c.categoryId === "fin-ec-missing")?.label, "—");
  check("and the categories are ordered largest first",
    finReport().byCategory.map((c) => c.total),
    [...finReport().byCategory.map((c) => c.total)].sort((a, b) => b - a));

  /**
   * ── Arrears are a position, and the period must not touch them ───────────
   *
   * A debt raised in October is still owed in March. The service takes from/to
   * for the summary and ignores them entirely for the arrears, so clipping the
   * position to the period would report old debt as settled — the one figure on
   * this screen a school chases people about.
   */
  check("a date range moves the flow",
    finReport().expenditure.expenses ===
      finLocal("GET", "/api/finance/reports/summary", {
        query: { schoolId: SCHOOL, from: "2026-09-01", to: "2026-09-30" },
      }).data.data.summary.expenditure.expenses,
    false);
  check("and leaves the position exactly where it was",
    finArrears("from=2026-09-01&to=2026-09-30"), finArrears());
  check("the academic year DOES narrow it",
    finArrears(`academicYear=${YEAR}`).charged < finArrears().charged, true);
  check("outstanding is billed less paid, with waivers already off the bill",
    (() => {
      const a = finArrears();
      return [a.billed, a.outstanding];
    })(),
    (() => {
      const a = finArrears();
      return [a.charged - a.waived, a.charged - a.waived - a.paid];
    })());

  // ── The report's own refusals, and its permission floor ─────────────────
  for (const [what, qs] of [
    ["an unreadable from", `from=soon`],
    ["an unreadable to",   `to=whenever`],
    ["a reversed range",   `from=2026-10-01&to=2026-09-01`],
  ]) {
    check(`not answered locally: ${what}`,
      finLocal("GET", "/api/finance/reports/summary",
        { query: Object.fromEntries(new URLSearchParams(`schoolId=${SCHOOL}&${qs}`)) }),
      null);

    const refused = await fetch(
      `http://127.0.0.1:${port}/api/finance/reports/summary?schoolId=${SCHOOL}&${qs}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    check(`and the server refuses it: ${what}`, refused.status, 400);
  }

  /**
   * finance.reports alone is not enough to answer this offline.
   *
   * The endpoint is gated on that one capability and then sums four collections
   * the feed gates on three others. finance.reports is delegable, so a school
   * can hand it to somebody who mirrors none of the inputs — and that machine
   * would answer a report of zeros, which reads as a bad month rather than as an
   * empty mirror.
   */
  check("somebody with finance.reports and none of the inputs is not answered locally",
    finLocal("GET", "/api/finance/reports/summary", {
      query: { schoolId: SCHOOL },
      as: { session: { ...finHead.session, permissions: ["finance.reports"] } },
    }),
    null);
  check("and the server answers them, which is why declining is the safe half",
    (await fetch(`http://127.0.0.1:${port}/api/finance/reports/summary?schoolId=${SCHOOL}`,
      { headers: { authorization: `Bearer ${finBursar.token}` } })).status,
    200);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- writes: a category, a void, and a raise ---");

  // ── A new expense category ─────────────────────────────────────────────
  const finCat = finLocal("POST", "/api/finance/expense-categories", {
    body: { schoolId: SCHOOL, code: " TRP ", label: " Transport ", labelFr: "Transport" },
  });

  check("a new category is accepted", finCat?.status, 201);
  check("and queued", finCat?.queued, true);
  check("trimmed as the endpoint trims it",
    [finCat.data.data.code, finCat.data.data.label], ["TRP", "Transport"]);
  check("with the defaults the model would have given it",
    [finCat.data.data.isActive, finCat.data.data.parentId, finCat.data.data.deletedAt],
    [true, null, null]);
  const finCatId = finCat.data.data._id;

  // The endpoint reads req.body._id, so a replay of this request lands on the
  // row it already made rather than making a second one.
  const finQueuedCat = queue.all().find((r) => r.path === "/api/finance/expense-categories");
  check("the id is chosen here and travels in the body",
    JSON.parse(finQueuedCat.body)._id, finCatId);

  // ── What must not be queued ────────────────────────────────────────────
  const finBadCategories = [
    ["no code",  { label: "No code" },                    400],
    ["no label", { code: "NOLABEL" },                     400],
    // The 409 that would stop the outbox and everything queued behind it.
    ["a code already in use", { code: "UTL", label: "Utilities again" }, 409],
  ];

  for (const [what, patch, status] of finBadCategories) {
    check(`not queued: ${what}`,
      finLocal("POST", "/api/finance/expense-categories", { body: { schoolId: SCHOOL, ...patch } }),
      null);
    const refused = await finSend("POST", "/api/finance/expense-categories",
      { schoolId: SCHOOL, ...patch });
    check(`and the server refuses it: ${what}`, refused.status, status);
  }

  // A retired category's code is free again — the unique index is partial on
  // deletedAt: null — so this must NOT be declined.
  check("a deleted category's code can be reused",
    finLocal("POST", "/api/finance/expense-categories",
      { body: { schoolId: SCHOOL, code: "OLD", label: "Reused" } })?.status,
    201);

  check("not queued: without expenses.manage",
    finLocal("POST", "/api/finance/expense-categories", {
      body: { schoolId: SCHOOL, code: "ZZZ", label: "Z" },
      as: { session: { ...finHead.session, permissions: ["expenses.view"] } },
    }),
    null);

  // ── Voiding an expense ─────────────────────────────────────────────────
  await FinExpense.collection.insertOne({
    _id: "fin-ex-void-me", schoolId: SCHOOL, categoryId: "ec-2", amount: 45000,
    description: "Wrong vendor", status: "approved",
    incurredAt: new Date("2026-10-14T00:00:00.000Z"),
    deletedAt: null, voidedAt: null, updatedAt: new Date(),
  });
  await finMirror();

  const finVoidedBefore = finReport().expenditure.expenses;
  const finExpenseRows  = docs.count("expense", { schoolId: SCHOOL });

  const finVoid = finLocal("POST", "/api/finance/expenses/fin-ex-void-me/void",
    { body: { schoolId: SCHOOL, reason: "  paid the wrong vendor  " } });

  check("a void is accepted", finVoid?.status, 200);
  check("200 and not 201, because nothing was created",
    [finVoid.status, finVoid.data.success], [200, true]);
  check("the row is stamped rather than removed",
    [Boolean(finVoid.data.data.voidedAt), finVoid.data.data.amount], [true, 45000]);
  check("the reason is trimmed as the endpoint trims it",
    finVoid.data.data.voidReason, "paid the wrong vendor");
  check("and recorded against the person who did it",
    finVoid.data.data.voidedBy, "admin-1");
  /**
   * A voided expense is STILL IN THE LIST, marked — a bursar looking for the
   * payment they cancelled has to be able to find it. Only the totals drop it.
   *
   * Asked for over October rather than unfiltered, and that is not incidental:
   * the endpoint returns the newest 500 rows and the section above this one
   * inserts 520 expenses dated 2027-01, so an unfiltered list is entirely those
   * and contains nothing from 2026 at all. The first version of this assertion
   * failed for exactly that reason and read as the void having removed the row.
   * The cap is the endpoint's own behaviour, faithfully mirrored; a query narrow
   * enough to be about this expense is the honest way to ask.
   */
  check("the expense is still in the ledger listing",
    finLocal("GET", "/api/finance/expenses", {
      query: { schoolId: SCHOOL, from: "2026-10-01", to: "2026-10-31T23:59:59.999Z" },
    }).data.data.some((r) => r._id === "fin-ex-void-me"),
    true);
  check("marked as void where the screen can show it",
    finLocal("GET", "/api/finance/expenses", {
      query: { schoolId: SCHOOL, from: "2026-10-01", to: "2026-10-31T23:59:59.999Z" },
    }).data.data.find((r) => r._id === "fin-ex-void-me").voidReason,
    "paid the wrong vendor");
  check("and out of the report's expenditure",
    finReport().expenditure.expenses, finVoidedBefore - 45000);
  // A void is a STAMP. A fee payment reversal is an appended negative row, and
  // confusing the two would either count the void twice or subtract the
  // reversal twice, one screen apart.
  check("no second row was appended — unlike a payment reversal",
    docs.count("expense", { schoolId: SCHOOL }), finExpenseRows);

  const finBadVoids = [
    ["no reason",         "fin-ex-void-me", { reason: "" },     400],
    ["a reason of spaces", "fin-ex-void-me", { reason: "   " }, 400],
    ["an expense nobody has", "fin-ex-nope", { reason: "why" }, 404],
  ];

  for (const [what, id, patch, status] of finBadVoids) {
    check(`not queued: ${what}`,
      finLocal("POST", `/api/finance/expenses/${id}/void`,
        { body: { schoolId: SCHOOL, ...patch } }),
      null);
    const refused = await finSend("POST", `/api/finance/expenses/${id}/void`,
      { schoolId: SCHOOL, ...patch });
    check(`and the server refuses it: ${what}`, refused.status, status);
  }

  // Already void. The endpoint answers 200 replay rather than 409 — so queueing
  // it again would be harmless and would also store nothing, which is why it is
  // declined rather than reported as done.
  check("not queued: an expense that is already void",
    finLocal("POST", "/api/finance/expenses/fin-ex-voided/void",
      { body: { schoolId: SCHOOL, reason: "again" } }),
    null);
  const finReplayVoid = await finSend("POST", "/api/finance/expenses/fin-ex-voided/void",
    { schoolId: SCHOOL, reason: "again" });
  check("and the server answers it 200 with replay, not 409",
    [finReplayVoid.status, finReplayVoid.body.replay], [200, true]);

  // On a DIFFERENT expense, one that is not already void, so that the decline
  // can only be about the permission.
  check("not queued: without expenses.manage",
    finLocal("POST", "/api/finance/expenses/fin-ex-pending/void", {
      body: { schoolId: SCHOOL, reason: "no rights" },
      as: { session: { ...finHead.session, permissions: ["expenses.view"] } },
    }),
    null);
  // Proved with a teacher, who holds none of this router's capabilities, rather
  // than by voiding something with a bursar's token to see it work — that would
  // void a row these assertions are still counting.
  const finVoidNoRights = await finSend("POST", "/api/finance/expenses/fin-ex-pending/void",
    { schoolId: SCHOOL, reason: "no rights" }, finTeacher);
  check("and the server answers 403, which is a full stop for the whole outbox",
    finVoidNoRights.status, 403);

  // ── A raise ────────────────────────────────────────────────────────────
  const finRaise = finLocal("POST", "/api/finance/salary-structures", {
    body: {
      schoolId: SCHOOL, userId: "t1", baseAmount: 210000,
      allowances: [{ code: "HOU", label: " Housing ", amount: 35000 }],
      deductions: [{ code: "TAX", label: "Tax", amount: 14000 }],
      effectiveFrom: "2026-10-01",
    },
  });

  check("a raise is accepted", finRaise?.status, 201);
  check("the new row is open-ended", finRaise.data.data.effectiveTo, null);
  check("its components are cleaned the way the endpoint cleans them",
    finRaise.data.data.allowances,
    [{ code: "HOU", label: "Housing", labelFr: null, amount: 35000 }]);

  // THE SECOND ROW. One open structure per person is a unique index, so a new
  // row written without closing the previous one leaves the mirror showing two
  // concurrent salaries — and the screen offering a figure the server does not
  // hold.
  check("the previous structure is closed in the same commit",
    docs.get("salaryStructure", "fin-ss-t1").effectiveTo,
    new Date(Date.parse("2026-10-01T00:00:00.000Z") - 1).toISOString());
  check("both rows provisional until it lands",
    [docs.get("salaryStructure", finRaise.data.data._id)._pending,
     docs.get("salaryStructure", "fin-ss-t1")._pending],
    [true, true]);
  check("and only one row is in force for that person",
    docs.find("salaryStructure",
      { schoolId: SCHOOL, userId: "t1", effectiveTo: null, deletedAt: null }).length,
    1);

  const finBadRaises = [
    ["no userId",           { baseAmount: 1, effectiveFrom: "2026-10-01" }, 400],
    ["no effectiveFrom",    { userId: "t1", baseAmount: 1 }, 400],
    ["a fractional salary", { userId: "t1", baseAmount: 1500.5, effectiveFrom: "2026-10-01" }, 400],
    ["a negative salary",   { userId: "t1", baseAmount: -1, effectiveFrom: "2026-10-01" }, 400],
    ["an allowance with no label",
      { userId: "t1", baseAmount: 1, effectiveFrom: "2026-10-01",
        allowances: [{ code: "X", amount: 1 }] }, 400],
    ["a negative deduction",
      { userId: "t1", baseAmount: 1, effectiveFrom: "2026-10-01",
        deductions: [{ code: "X", label: "X", amount: -1 }] }, 400],
    ["a fractional allowance",
      { userId: "t1", baseAmount: 1, effectiveFrom: "2026-10-01",
        allowances: [{ code: "X", label: "X", amount: 0.5 }] }, 400],
    ["somebody who does not work here", { userId: "fin-nobody", baseAmount: 1,
      effectiveFrom: "2026-10-01" }, 404],
    ["somebody at another school", { userId: "fin-other", baseAmount: 1,
      effectiveFrom: "2026-10-01" }, 404],
  ];

  for (const [what, patch, status] of finBadRaises) {
    check(`not queued: ${what}`,
      finLocal("POST", "/api/finance/salary-structures", { body: { schoolId: SCHOOL, ...patch } }),
      null);
    const refused = await finSend("POST", "/api/finance/salary-structures",
      { schoolId: SCHOOL, ...patch });
    check(`and the server refuses it: ${what}`, refused.status, status);
  }

  /**
   * An unreadable date is not a 400 — it is a 500, and a 500 is RETRYABLE.
   *
   * effectiveFrom goes straight into new Date() and then into a required Date
   * field, so "soon" is a cast error. That would not block the outbox; it would
   * retry it for ever behind a row that never settles, which is worse than a
   * block because nothing asks anybody to look at it.
   */
  check("not queued: an unreadable effectiveFrom",
    finLocal("POST", "/api/finance/salary-structures",
      { body: { schoolId: SCHOOL, userId: "t1", baseAmount: 1, effectiveFrom: "soon" } }),
    null);
  const finBadDate = await finSend("POST", "/api/finance/salary-structures",
    { schoolId: SCHOOL, userId: "t1", baseAmount: 1, effectiveFrom: "soon" });
  check("and the server answers it 500, which the queue would retry rather than block on",
    finBadDate.status >= 500, true);

  check("not queued: without payroll.setSalary",
    finLocal("POST", "/api/finance/salary-structures", {
      body: { schoolId: SCHOOL, userId: "t1", baseAmount: 1, effectiveFrom: "2026-10-01" },
      as: finBursar,
    }),
    null);
  const finBursarRaise = await finSend("POST", "/api/finance/salary-structures",
    { schoolId: SCHOOL, userId: "t1", baseAmount: 1, effectiveFrom: "2026-10-01" }, finBursar);
  check("and the server refuses the bursar with 403, which would stop the whole outbox",
    finBursarRaise.status, 403);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- reconnecting ---");

  /**
   * A push is not scoped to a collection: it drains the whole outbox, oldest
   * first, and stops dead at the first entry the server refuses. So if a section
   * spliced before this one leaves a BLOCKED entry behind, the three writes above
   * never leave the machine and the assertions below fail for that reason rather
   * than for anything wrong here. Worth knowing before debugging the wrong file.
   */
  {
    const finEngine = engine({
      docs, queue, state: store.state(db), client: apiClient,
      feedCollections: ["expense", "expenseCategory", "salaryStructure"],
    });
    // The fixtures in this file are dated across a school year, so a cursor set
    // from them sits in the future and nothing written during the run would be
    // pulled back.
    db.prepare("DELETE FROM sync_state WHERE collection IN (?, ?, ?)")
      .run("expense", "expenseCategory", "salaryStructure");
    await finEngine.cycle();
    finEngine.stop();
  }

  check("everything of this domain's drained",
    queue.all().filter((r) => String(r.path).startsWith("/api/finance/")).length, 0);
  check("and none of it blocked",
    queue.all().filter((r) => r.status === "blocked").length, 0);

  check("the server has the category, under the id this machine chose",
    (await FinExpenseCategory.findById(finCatId).lean())?.code, "TRP");
  check("the server voided the expense",
    Boolean((await FinExpense.findById("fin-ex-void-me").lean())?.voidedAt), true);
  check("with the reason it was given",
    (await FinExpense.findById("fin-ex-void-me").lean())?.voidReason, "paid the wrong vendor");
  check("the server has the new structure",
    (await FinSalaryStructure.findById(finRaise.data.data._id).lean())?.baseAmount, 210000);
  check("and closed the previous one at the same instant this machine did",
    (await FinSalaryStructure.findById("fin-ss-t1").lean())?.effectiveTo?.toISOString(),
    new Date(Date.parse("2026-10-01T00:00:00.000Z") - 1).toISOString());
  check("every local row settled",
    [docs.get("expenseCategory", finCatId)._pending,
     docs.get("expense", "fin-ex-void-me")._pending,
     docs.get("salaryStructure", finRaise.data.data._id)._pending,
     docs.get("salaryStructure", "fin-ss-t1")._pending],
    [false, false, false, false]);

  await parity("the categories after the round trip",
    `/api/finance/expense-categories?schoolId=${SCHOOL}`, finHead);
  await parity("the structures after the round trip",
    `/api/finance/salary-structures?schoolId=${SCHOOL}&history=1`, finHead);
  await parity("and the report after it",
    `/api/finance/reports/summary?schoolId=${SCHOOL}`, finHead);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and the payroll run, which stays on the server ---");

  /**
   * ── Why these three are online-only, asserted rather than asserted-ish ───
   *
   * Not because they are big. Because each of them mints values only the server
   * can mint, for an unbounded number of rows: generate creates a PayrollRun
   * with no client id AND payslip rows with no _id at all, and confirm and
   * reverse mint gapless payslip numbers from an atomic Counter the feed
   * deliberately never mirrors.
   *
   * The probes below show that from the server rather than from reasoning: an
   * _id sent in the body is ignored, so a local generate would write a run and N
   * payslips the school's record has never heard of while the server writes its
   * own — a month with two runs and every payslip twice.
   */
  for (const [what, path, body] of [
    ["generate", "/api/finance/payroll/generate", { schoolId: SCHOOL, periodMonth: "2026-12" }],
    ["confirm",  "/api/finance/payroll/run-2026-09/confirm", { schoolId: SCHOOL, method: "bank" }],
    ["reverse",  "/api/finance/payroll/run-2026-09/reverse", { schoolId: SCHOOL, reason: "wrong" }],
  ]) {
    check(`${what} is not answered locally`, finLocal("POST", path, { body }), null);
  }

  const finGenerated = await finSend("POST", "/api/finance/payroll/generate", {
    schoolId: SCHOOL, periodMonth: "2026-12",
    // A client id, offered and ignored.
    _id: "fin-run-mine",
  });
  check("generate succeeds on the server", finGenerated.status, 201);
  check("and IGNORES the id the client chose — the reason it cannot be queued",
    finGenerated.body.run._id === "fin-run-mine", false);
  check("its payslips carry ids the client never sent either",
    finGenerated.body.payslips.every((p) => typeof p._id === "string" && p._id.length > 0), true);
  check("one payslip per structure in force, which is unbounded by anything local",
    finGenerated.body.payslips.length,
    (await FinSalaryStructure.countDocuments({
      schoolId: SCHOOL, deletedAt: null,
      effectiveFrom: { $lte: new Date(Date.UTC(2026, 12, 0, 23, 59, 59, 999)) },
      $or: [{ effectiveTo: null }, { effectiveTo: { $gte: new Date(Date.UTC(2026, 12, 0, 23, 59, 59, 999)) } }],
    })));
  check("and a draft has no payslip number, because a draft is not a payslip",
    finGenerated.body.payslips.every((p) => !p.payslipNo), true);

  // A second generate for the same month is the 409 a stale mirror would walk
  // into — and RUN_EXISTS depends on the school's whole collection, not on this
  // machine's copy of it.
  const finAgain = await finSend("POST", "/api/finance/payroll/generate",
    { schoolId: SCHOOL, periodMonth: "2026-12" });
  check("a second run for the same month is refused", finAgain.status, 409);
  check("with the code that would stop the outbox", finAgain.body.code, "RUN_EXISTS");

  // Confirming is where the money moves. Whether it is even allowed depends on
  // the school's payroll setting, which is why the probe reads it rather than
  // assuming — and either answer makes the same point.
  const finPayrollApproval = Boolean(
    (await FinSchool.findById(SCHOOL).lean())?.settings?.approvals?.payrollRequired
  );
  const finConfirm = await finSend("POST",
    `/api/finance/payroll/${finGenerated.body.run._id}/confirm`,
    { schoolId: SCHOOL, method: "bank" });

  if (finPayrollApproval) {
    check("with payroll approval on, a draft cannot be confirmed at all",
      [finConfirm.status, finConfirm.body.code], [409, "APPROVAL_REQUIRED"]);
    // Which is itself a second reason this cannot be queued: whether a run has
    // been signed off, and by whom, is state only the server holds.
  } else {
    check("confirming mints a payslip number per row", finConfirm.status, 200);
    const finPaid = await FinSalaryPayment.find({
      schoolId: SCHOOL, runId: finGenerated.body.run._id,
    }).lean();
    check("gapless, from a Counter the feed deliberately never mirrors",
      finPaid.every((p) => /^PSL-2026-12-\d{4}$/.test(String(p.payslipNo))), true);
  }

  // Reversing depends on state only the server holds — "is this run confirmed"
  // is a fact this machine may be a sync behind on, and the answer decides
  // between a 409 and money moving.
  const finReverse = await finSend("POST",
    `/api/finance/payroll/${finGenerated.body.run._id}/reverse`,
    { schoolId: SCHOOL, reason: "wrong month" });

  if (finPayrollApproval) {
    // The run is still a draft, because confirm refused it above.
    check("an unconfirmed run cannot be reversed",
      [finReverse.status, finReverse.body.code], [409, "NOT_CONFIRMED"]);
  } else {
    check("reversing a confirmed run appends one negative payslip per paid row",
      [finReverse.status, finReverse.body.reversed],
      [200, finGenerated.body.payslips.length]);
    const finMirrored = await FinSalaryPayment.find({
      schoolId: SCHOOL, reversesId: { $ne: null }, periodMonth: "2026-12",
    }).lean();
    check("each with a payslip number of its own, minted server-side",
      finMirrored.length > 0 && finMirrored.every((p) => /^PSL-2026-12-\d{4}$/.test(String(p.payslipNo))),
      true);
    check("and Counter is excluded from the feed, so no offline machine can mint one",
      Boolean(finFeed.EXCLUDED.Counter), true);
  }

  // A reason is required, exactly as voiding an expense requires one.
  const finReverseNoReason = await finSend("POST",
    `/api/finance/payroll/${finGenerated.body.run._id}/reverse`, { schoolId: SCHOOL });
  check("and reversing without a reason is refused",
    [finReverseNoReason.status, finReverseNoReason.body.code], [400, "REASON_REQUIRED"]);

  server.close();
  db.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => { cleanup(); process.exit(fail ? 1 : 0); });
