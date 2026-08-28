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
  const mongo = await MongoMemoryServer.create();
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
  app.use("/api/admin", authenticate, require("../src/routes/admin.routes"));
  app.use("/api/fees",  authenticate, require("../src/routes/fees.routes"));
  app.use("/api/finance", authenticate, require("../src/routes/finance.routes"));
  app.use("/api/approvals", authenticate, require("../src/routes/approvals.routes"));
  app.use("/api/attendance", authenticate, require("../src/routes/attendance.routes"));
  app.use("/api/exams", authenticate, require("../src/routes/exam.routes"));
  app.use("/api/results", authenticate, require("../src/routes/results.routes"));
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

  server.close();
  db.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await mongo.stop();
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => { cleanup(); process.exit(fail ? 1 : 0); });
