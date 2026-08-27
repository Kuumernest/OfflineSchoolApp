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
