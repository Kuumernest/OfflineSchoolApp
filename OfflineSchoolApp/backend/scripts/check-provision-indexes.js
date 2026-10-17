// backend/scripts/check-provision-indexes.js
"use strict";

/**
 * scripts/provision-indexes.js plans read-only, counts what a unique index
 * would refuse before building it, builds only what is missing and clean, and
 * never drops or changes an index that is already there. In-memory MongoDB.
 *
 *   node scripts/check-provision-indexes.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  require("../src/db/models");
  // As production connects: nothing built behind the tool's back.
  await mongoose.connect(mongo.getUri(), { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const { provision } = require("./provision-indexes");
  const quiet = () => {};
  const indexNames = async (coll) => {
    try { return (await db.collection(coll).indexes()).map((ix) => ix.name).sort(); } catch { return []; }
  };

  // What a database left without its indexes may hold:
  //   two payments with one receipt number in a school;
  //   two active fee structures for one class (B), year and term — through the
  //   classIds array;
  //   a School email index built earlier, not unique (incompatible);
  //   an index somebody made by hand, which no model declares.
  await db.collection("feepayments").insertMany([
    { schoolId: "s1", receiptNo: "R-1" }, { schoolId: "s1", receiptNo: "R-1" }, { schoolId: "s1", receiptNo: "R-2" },
  ]);
  await db.collection("feestructures").insertMany([
    { schoolId: "s1", academicYear: "2026", term: "1", classIds: ["A", "B"], isActive: true, deletedAt: null },
    { schoolId: "s1", academicYear: "2026", term: "1", classIds: ["B", "C"], isActive: true, deletedAt: null },
    { schoolId: "s1", academicYear: "2026", term: "1", classIds: ["B"], isActive: false, deletedAt: null },
  ]);
  await db.collection("schools").createIndex({ email: 1 }, { name: "email_1" });
  await db.collection("students").createIndex({ handMade: 1 }, { name: "hand_made" });
  const before = { feepayments: await indexNames("feepayments"), students: await indexNames("students"), schools: await indexNames("schools") };
  const rowsOf = async (coll) => JSON.stringify(await db.collection(coll).find({}).sort({ _id: 1 }).toArray());
  const dataBefore = { feepayments: await rowsOf("feepayments"), feestructures: await rowsOf("feestructures") };

  // ── plan ────────────────────────────────────────────────────────────────
  console.log("--- plan (default) ---");
  const plan = await provision({ log: quiet });
  const row = (coll, field) => plan.rows.find((r) => r.collection === coll && field in r.key && r.unique);
  check("a duplicated receipt number is counted: 1 group of 2 rows",
    [row("feepayments", "receiptNo")?.status, row("feepayments", "receiptNo")?.duplicates], ["missing", { groups: 1, rows: 2 }]);
  check("  through an array field and a partial filter: class B twice among the active structures",
    row("feestructures", "classIds")?.duplicates, { groups: 1, rows: 2 });
  check("  the School email index built without unique is incompatible, not missing",
    row("schools", "email")?.status, "incompatible");
  check("  no declared index is unique + sparse over a null default any more (School, Conversation, GeneratedReport fixed)",
    plan.rows.filter((r) => r.warning).map((r) => r.collection), []);
  check("  the incompatible unique index gets a duplicate count too",
    row("schools", "email")?.duplicates, { groups: 0, rows: 0 });
  check("  nothing written by a plan",
    { feepayments: await indexNames("feepayments"), students: await indexNames("students"), schools: await indexNames("schools") }, before);
  check("  plan totals add up", plan.rows.length > 400 && plan.created === 0, true);

  // A unique index the models no longer declare still enforces its rule:
  // reported as legacy, never dropped.
  await db.collection("schools").createIndex({ code: 1 }, { unique: true, sparse: true, name: "schools_code_unique" });
  const withLegacy = await provision({ log: quiet });
  check("an undeclared unique index left from an old schema is reported as legacy",
    withLegacy.legacy.map((l) => `${l.collection}:${l.name}:${l.sparse}`), ["schools:schools_code_unique:true"]);
  check("  and a plain hand-made index is not (it enforces nothing)",
    withLegacy.legacy.some((l) => l.name === "hand_made"), false);

  // ── apply ───────────────────────────────────────────────────────────────
  console.log("--- --apply ---");
  const applied = await provision({ apply: true, log: quiet });
  const after = (coll, field) => applied.rows.find((r) => r.collection === coll && field in r.key && r.unique);
  check("the duplicated unique indexes are skipped, the incompatible one left alone",
    [after("feepayments", "receiptNo")?.outcome, after("feestructures", "classIds")?.outcome?.startsWith("skipped"),
     after("schools", "email")?.outcome?.startsWith("skipped")],
    ["skipped (duplicates must be resolved first)", true, true]);
  check("  a clean missing unique index is built (exam marks)",
    after("exammarks", "teacherId")?.outcome, "created");
  check("  and builds as declared: unique, named, partial",
    (await db.collection("timetableslots").indexes()).filter((ix) => ix.name === "unique_class_day_period")
      .map((ix) => [ix.unique, Boolean(ix.partialFilterExpression)]), [[true, true]]);
  check("  nothing dropped: the hand-made index and the incompatible one are still there",
    [(await indexNames("students")).includes("hand_made"), (await indexNames("schools")).includes("email_1"),
     (await db.collection("schools").indexes()).find((ix) => ix.name === "email_1")?.unique ?? false],
    [true, true, false]);
  check("  and the legacy index is still there too", (await indexNames("schools")).includes("schools_code_unique"), true);
  check("  failures 0; the skipped are counted", [applied.failed, applied.skipped >= 3, applied.created > 300], [0, true, true]);
  check("  the conflicting records are exactly as they were: nothing merged, moved or deleted",
    { feepayments: await rowsOf("feepayments"), feestructures: await rowsOf("feestructures") }, dataBefore);

  // ── again ───────────────────────────────────────────────────────────────
  const again = await provision({ apply: true, log: quiet });
  check("a second apply builds nothing new: what it built is present",
    [again.created, again.rows.find((r) => r.collection === "exammarks" && r.unique)?.status], [0, "present"]);

  // The duplicates resolved, the skipped index builds.
  await db.collection("feepayments").updateOne({ receiptNo: "R-1" }, { $set: { receiptNo: "R-1b" } });
  const fixed = await provision({ apply: true, only: ["FeePayment"], log: quiet });
  check("once the duplicate receipt is resolved, --only=FeePayment builds it",
    fixed.rows.find((r) => "receiptNo" in r.key && r.unique)?.outcome, "created");

  // ── a build that fails is reported as a failure, not as done ─────────────
  console.log("--- a failed build ---");
  const School = mongoose.model("School");
  await db.collection("schools").dropIndex("email_1");   // the test's own index, made above
  const realCreate = School.collection.createIndex.bind(School.collection);
  School.collection.createIndex = async () => { const e = new Error("simulated: not authorized"); e.codeName = "Unauthorized"; throw e; };
  const broken = await provision({ apply: true, only: ["School"], log: quiet });
  School.collection.createIndex = realCreate;
  const emailRow = broken.rows.find((r) => r.collection === "schools" && "email" in r.key);
  check("a createIndex error: outcome failed with the reason, counted, nothing reported as created",
    [emailRow?.outcome?.startsWith("failed: Unauthorized"), broken.failed > 0, broken.created], [true, true, 0]);

  // ── a clean database ────────────────────────────────────────────────────
  console.log("--- a clean database ---");
  await db.dropDatabase();
  const clean = await provision({ apply: true, log: quiet });
  const recheck = await provision({ log: quiet });
  check("a clean database: every declared index created, none skipped or failed",
    [clean.failed, clean.skipped, clean.created === clean.rows.length], [0, 0, true]);
  check("  and a plan afterwards finds every one present",
    recheck.rows.filter((r) => r.status !== "present").map((r) => `${r.collection} ${JSON.stringify(r.key)} ${r.status}`), []);
  const { verifyDeclaredIndexes } = require("../src/services/indexCheck.service");
  const boot = await verifyDeclaredIndexes({ log: quiet });
  check("  the boot check agrees: nothing missing or incompatible",
    [boot.missing.length, boot.incompatible.length, boot.criticalProblems], [0, 0, 0]);

  // The four definitions that were unique + sparse over a null default.
  const accepts = async (coll, docs) => {
    try { await db.collection(coll).insertMany(docs); return true; } catch (e) { return e.code; }
  };
  check("with their indexes built: two schools with no email and no code are both accepted",
    await accepts("schools", [{ name: "A", email: null, code: null }, { name: "B", email: null, code: null }]), true);
  check("  but two schools with one email are still refused",
    await accepts("schools", [{ name: "C", email: "x@example.test" }, { name: "D", email: "x@example.test" }]), 11000);
  check("  two class conversations in one school (directKey null) are both accepted",
    await accepts("conversations", [{ schoolId: "s1", kind: "class", classId: "c1", directKey: null }, { schoolId: "s1", kind: "class", classId: "c2", directKey: null }]), true);
  check("  one direct pair twice is still refused",
    await accepts("conversations", [{ schoolId: "s1", directKey: "u1|u2" }, { schoolId: "s1", directKey: "u1|u2" }]), 11000);
  check("  two exam-less reports (term, annual) for one pupil are both accepted",
    await accepts("generatedreports", [{ studentId: "p1", examId: null }, { studentId: "p1", examId: null }]), true);
  check("  two pupils with no account yet (userId: null) and no number yet (enrollmentNo: null) are both accepted",
    await accepts("students", [{ schoolId: "s1", userId: null, enrollmentNo: null }, { schoolId: "s1", userId: null, enrollmentNo: null }]), true);
  check("  one account linked to two pupils is still refused",
    await accepts("students", [{ schoolId: "s1", userId: "u-1" }, { schoolId: "s1", userId: "u-1" }]), 11000);
  check("  one enrolment number given twice is still refused",
    await accepts("students", [{ schoolId: "s1", enrollmentNo: "EN-1" }, { schoolId: "s1", enrollmentNo: "EN-1" }]), 11000);
  check("  one exam's report twice for one pupil is still refused",
    await accepts("generatedreports", [{ studentId: "p1", examId: "e1" }, { studentId: "p1", examId: "e1" }]), 11000);

  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
