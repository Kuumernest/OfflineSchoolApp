// backend/scripts/check-fee-inheritance.js
"use strict";

/**
 * A student who joins a class gets that class's fees for the current year.
 *
 * A fee structure is applied from a button, to the students who are in the
 * class at that moment. Students admitted, approved, restored or moved in
 * afterwards were not billed by most of the paths that put them there, and the
 * one function that billed newcomers applied every active structure for the
 * class whatever its year. The rules this asserts (decided 2026-10-24):
 *
 *   1. Joining a class raises its current-year structures, full amounts.
 *      Individual reductions are waivers. Pending students and schools with no
 *      current year set are not billed.
 *   2. A transfer voids the year's charges from the old class's structures.
 *      Payments stay; school-wide structures and late fees stay.
 *   3. Applying a replacement structure voids what the deactivated structure
 *      it replaces charged for the same year and term.
 *   4. Restoring a student bills what was applied while they were away.
 *   5. Promotion does not bill; the bursar applies the new year's structures.
 *   A replay, a double click or a second path raises nothing twice.
 *
 *   node scripts/check-fee-inheritance.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const fs       = require("fs");
const path     = require("path");

const SCHOOL   = "aaaaaaaaaaaaaaaaaaaaaaaa";
const NO_YEAR  = "bbbbbbbbbbbbbbbbbbbbbbbb";
const YEAR     = "2026/2027";

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "fee-inheritance" });

  const FeeCharge    = require("../src/db/models/FeeCharge");
  const FeePayment   = require("../src/db/models/FeePayment");
  const FeeStructure = require("../src/db/models/FeeStructure");
  const Student      = require("../src/db/models/Student");
  const School       = require("../src/db/models/School");
  const Class        = require("../src/db/models/Class");
  const { ROLES }    = require("../src/config/roles");
  const fees         = require("../src/services/fees.service");
  await Promise.all([FeeCharge.init(), FeeStructure.init()]);

  await School.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(SCHOOL),  name: "Green Valley", settings: { academicYear: YEAR } },
    { _id: new mongoose.Types.ObjectId(NO_YEAR), name: "No Year",      settings: { academicYear: null } },
  ]);
  await Class.collection.insertMany([
    { _id: "class-a", schoolId: SCHOOL, name: "Form 1", isActive: true },
    { _id: "class-b", schoolId: SCHOOL, name: "Form 2", isActive: true },
  ]);

  const item = (code, amount, extra = {}) => ({ code, label: code, amount, ...extra });
  const due  = new Date("2026-10-15");
  await FeeStructure.create([
    { _id: "s-a",    schoolId: SCHOOL, academicYear: YEAR, classIds: ["class-a"], term: "T1", dueDate: due,
      items: [item("tuition", 50000), item("bus", 10000, { isOptional: true })] },
    { _id: "s-b",    schoolId: SCHOOL, academicYear: YEAR, classIds: ["class-b"], term: "T1", dueDate: due,
      items: [item("tuition", 70000)] },
    { _id: "s-all",  schoolId: SCHOOL, academicYear: YEAR, classIds: [],          term: "T1", dueDate: due,
      items: [item("pta", 5000)] },
    // Last year's, never switched off: must not bill anybody now.
    { _id: "s-old",  schoolId: SCHOOL, academicYear: "2025/2026", classIds: ["class-a"], term: "T1", dueDate: due,
      items: [item("tuition", 40000)] },
    // The other school has a structure but no current year.
    { _id: "s-ny",   schoolId: NO_YEAR, academicYear: YEAR, classIds: ["class-n"], term: "T1", dueDate: due,
      items: [item("tuition", 1000)] },
  ]);

  const mkStudent = (id, classId, status = "approved", schoolId = SCHOOL) =>
    Student.collection.insertOne({ _id: id, schoolId, classId, status, isActive: status === "approved",
      deletedAt: null, firstName: id, lastName: "Test", studentName: `${id} Test` });

  const live = (studentId) => FeeCharge.find({ studentId, voidedAt: null, deletedAt: null }).lean()
    .then((rows) => rows.map((r) => `${r.structureId}:${r.code}:${r.amount}`).sort());
  const balance = (studentId) => fees.balanceFor({ schoolId: SCHOOL, studentId, academicYear: YEAR })
    .then((b) => b.balance ?? b.totals?.balance ?? b);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. joining a class raises its current-year fees ---");
  await mkStudent("ada", "class-a");
  const first = await fees.applyActiveStructuresForStudent({ schoolId: SCHOOL, student: { _id: "ada", classId: "class-a" } });
  check("the class's and the school-wide structure, full amounts, no optional item, not last year's",
    await live("ada"), ["s-a:tuition:50000", "s-all:pta:5000"]);
  check("reported as raised", [first.raised, first.voided], [2, 0]);

  const again = await fees.applyActiveStructuresForStudent({ schoolId: SCHOOL, student: { _id: "ada", classId: "class-a" } });
  check("a replay raises nothing", [again.raised, (await live("ada")).length], [0, 2]);

  await mkStudent("pending-pat", "class-a", "pending");
  const pend = await fees.applyActiveStructuresForStudent({ schoolId: SCHOOL, student: { _id: "pending-pat", classId: "class-a" } });
  check("a pending applicant is not billed", [pend.reason, (await live("pending-pat")).length], ["NOT_APPROVED", 0]);

  await mkStudent("nia", "class-n", "approved", NO_YEAR);
  const noYear = await fees.applyActiveStructuresForStudent({ schoolId: NO_YEAR, student: { _id: "nia", classId: "class-n" } });
  check("a school with no current year bills nobody automatically", [noYear.reason, (await live("nia")).length], ["NO_CURRENT_YEAR", 0]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 2. a transfer voids the old class's fees and raises the new ---");
  await FeePayment.create({ schoolId: SCHOOL, studentId: "ada", academicYear: YEAR, term: "T1", amount: 20000 });
  await FeeCharge.create({ schoolId: SCHOOL, studentId: "ada", academicYear: YEAR, term: "T1",
    structureId: "s-a", classId: "class-a", code: "LATE", label: "Late fee", amount: 2500 });

  // Through the admin route the phones and the desktop replay.
  let actor = { _id: "bursar", id: "bursar", role: ROLES.SCHOOL_ADMIN, schoolId: SCHOOL, email: "b@gv.cm" };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = actor; next(); });
  app.use("/api/admin", require("../src/routes/admin.routes"));
  app.use("/api/fees",  require("../src/routes/fees.routes"));
  const server = app.listen(0);
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null; try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: json };
  };

  const moved = await call("PATCH", "/api/admin/students/ada/move", { classId: "class-b" });
  check("the move succeeds and reports what it did",
    [moved.status, moved.body?.feesRaised, moved.body?.feesVoided], [200, 1, 1]);
  check("now owes Form 2's tuition and the school-wide fee; the late fee earned in Form 1 stands",
    await live("ada"), ["s-a:LATE:2500", "s-all:pta:5000", "s-b:tuition:70000"]);
  const voidedRow = await FeeCharge.findOne({ studentId: "ada", structureId: "s-a", code: "tuition" }).lean();
  check("Form 1's tuition is voided with a reason, not deleted", [Boolean(voidedRow?.voidedAt), voidedRow?.voidReason], [true, "Moved to another class"]);
  check("the payment counts against the new fees", await balance("ada"), 70000 + 5000 + 2500 - 20000);

  const replayMove = await call("PATCH", "/api/admin/students/ada/move", { classId: "class-b" });
  check("replaying the move changes nothing", [replayMove.body?.feesRaised, replayMove.body?.feesVoided, (await live("ada")).length], [0, 0, 3]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 3. applying a replacement voids what the old structure charged ---");
  await mkStudent("ben", "class-b");
  await fees.applyActiveStructuresForStudent({ schoolId: SCHOOL, student: { _id: "ben", classId: "class-b" } });
  await FeeStructure.updateOne({ _id: "s-b" }, { isActive: false });
  await FeeStructure.create({ _id: "s-b2", schoolId: SCHOOL, academicYear: YEAR, classIds: ["class-b"], term: "T1",
    dueDate: due, items: [item("tuition", 65000)] });
  // A deactivated structure for ANOTHER term is not what this replaces.
  await FeeStructure.create({ _id: "s-b-t2", schoolId: SCHOOL, academicYear: YEAR, classIds: ["class-b"], term: "T2",
    dueDate: due, items: [item("tuition", 60000)], isActive: true });
  await fees.applyActiveStructuresForStudent({ schoolId: SCHOOL, student: { _id: "ben", classId: "class-b" } });
  await FeeStructure.updateOne({ _id: "s-b-t2" }, { isActive: false });

  const applied = await call("POST", "/api/fees/structures/s-b2/apply", { schoolId: SCHOOL });
  check("apply raises the new price and voids the replaced one", [applied.status, applied.body?.voided], [201, 2]);
  check("Ben owes the new price, term 2 and the school-wide fee untouched",
    await live("ben"), ["s-all:pta:5000", "s-b-t2:tuition:60000", "s-b2:tuition:65000"]);
  check("Ada, moved in earlier, also moves to the new price (late fee kept)",
    await live("ada"), ["s-a:LATE:2500", "s-all:pta:5000", "s-b2:tuition:65000"]);
  const again2 = await call("POST", "/api/fees/structures/s-b2/apply", { schoolId: SCHOOL });
  check("applying it twice raises and voids nothing more", [again2.body?.raised, again2.body?.voided], [0, 0]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4. restoring a student bills what was applied while away ---");
  await mkStudent("cleo", "class-a", "suspended");
  await call("POST", "/api/fees/structures/s-a/apply", { schoolId: SCHOOL });
  check("a suspended student is not billed by apply", (await live("cleo")).length, 0);
  const restored = await call("PATCH", "/api/admin/students/cleo/restore", {});
  check("restoring raises Form 1's fees", [restored.status, restored.body?.feesRaised, await live("cleo")],
    [200, 2, ["s-a:tuition:50000", "s-all:pta:5000"]]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- every path that puts a student into a class bills, and promotion does not ---");
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
  const students = src("routes/students.routes.js");
  const between  = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
  check("POST /students bills, including an outbox replay of one already saved",
    (between(students, 'router.post("/", authenticate', "router.post(\"/:id/reset-password\"").match(/billStudentForClass\(/g) || []).length, 2);
  check("both branches of /students/:id/approve bill",
    (between(students, "const handleApprove", "router.post(\"/:id/approve\"").match(/billStudentForClass\(/g) || []).length, 2);
  check("/students/:id/restore bills",
    /billStudentForClass\(/.test(between(students, 'router.patch("/:id/restore"', 'router.patch("/:id/move"')), true);
  check("/students/:id/move voids the old class",
    /leavingOtherClasses: true/.test(between(students, 'router.patch("/:id/move"', 'router.get("/:id"')), true);
  check("the sync push approval bills",
    /applyActiveStructuresForStudent\(/.test(src("controllers/sync.controller.js")), true);
  check("promotion commits do not bill (the bursar applies next year's structures)",
    /applyActiveStructuresForStudent|billStudentForClass|applyStructure/.test(src("services/promotion.service.js")), false);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
