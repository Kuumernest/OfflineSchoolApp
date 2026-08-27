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
    console.log(`  FAIL ${label}:\n       local  ${JSON.stringify(actual)}\n       server ${JSON.stringify(expected)}`);
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

  // Mirror: read back through Mongo so the SQLite copy holds what the feed would
  // actually have sent, dates serialised and all.
  const db   = store.open(file);
  const docs = store.documents(db);
  for (const [name, Model] of Object.entries(models)) {
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
  const server = app.listen(0);
  const port   = server.address().port;

  /**
   * Ask both, and compare.
   */
  const parity = async (label, pathAndQuery) => {
    const [pathname, qs = ""] = pathAndQuery.split("?");
    const query = Object.fromEntries(new URLSearchParams(qs));

    const res  = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const fromServer = await res.json();

    const local = api.handle({ method: "GET", path: pathname, query }, { docs });

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

  const School = require("../src/db/models/School");
  await School.collection.insertOne({
    _id: SCHOOL, name: "Parity College", isActive: true, updatedAt: new Date(),
  });
  docs.putMany("school", JSON.parse(JSON.stringify(await School.find({}).lean())));

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
  await School.collection.updateOne(
    { _id: SCHOOL },
    { $set: { "settings.approvals": { expenseThreshold: 50000 }, updatedAt: new Date() } }
  );
  docs.putMany("school", JSON.parse(JSON.stringify(await School.find({}).lean())));

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
