// backend/scripts/check-fee-reminders.js
"use strict";

/**
 * Assert the fee reminder and late-fee logic.
 *
 * Needs a database (mongodb-memory-server, so nothing real is touched) because
 * almost everything here is a query: who owes, whose deadline has passed, who
 * has already been reminded, who already carries a penalty.
 *
 * The parts most worth pinning are the boundaries, which is where date logic
 * quietly goes wrong and where the mistake is invisible until a parent is told
 * their fees are late on the morning they are due:
 *
 *   • a bill is NOT overdue on its own due date, and IS the day after
 *   • a family who has paid drops off the list entirely
 *   • an undated charge is invisible to both jobs
 *   • the grace period holds the penalty back, and then releases it
 *   • applying penalties twice raises one charge, not two
 *   • a percentage penalty is a share of what is still owed, not of the bill
 *
 *   node scripts/check-fee-reminders.js
 */

const mongoose = require("mongoose");

const reminders = require("../src/services/feeReminders.service");
const { balanceFor } = require("../src/services/fees.service");

const FeeStructure = require("../src/db/models/FeeStructure");
const FeeCharge    = require("../src/db/models/FeeCharge");
const FeePayment   = require("../src/db/models/FeePayment");
const Notification = require("../src/db/models/Notification");
const Student      = require("../src/db/models/Student");
const School       = require("../src/db/models/School");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
};

const YEAR = "2025/2026";
const day  = (iso) => new Date(`${iso}T12:00:00.000Z`);

/**
 * Move every reminder already queued back to a chosen day.
 *
 * The service takes an `asOf` so due dates can be simulated, but the cooldown
 * reads Notification.createdAt — real wall-clock time, stamped by mongoose. So
 * a notification "sent" at a simulated October 2025 actually carries today's
 * date, and every simulated later run sees it as minutes old.
 *
 * That is a property of the cooldown rather than a flaw in it: in production
 * asOf IS now, and the two clocks agree. Here they have to be aligned by hand,
 * and doing so is what makes the cooldown assertions test the real rule instead
 * of an accident of when the suite was run.
 */
// Through the raw collection, not the model. Mongoose strips createdAt from an
// update even with { timestamps: false } — the plugin owns the field — so
// Notification.updateMany() here silently did nothing and the cooldown
// assertion below passed for the wrong reason until this was checked directly.
const backdateReminders = (to) =>
  Notification.collection.updateMany(
    { kind: "fee.reminder" },
    { $set: { createdAt: to } }
  );

let seq = 0;
const makeStudent = async (schoolId, name) => {
  seq += 1;
  return Student.create({
    schoolId, studentName: name, status: "approved", isActive: true,
    userId: `u-${seq}`, enrollmentNo: `TS-${String(seq).padStart(4, "0")}`,
    guardianName: "Guardian", guardianPhone: "670000000",
    guardianEmail: `g${seq}@example.com`,
  });
};

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "fee-reminders" });

  await Promise.all([
    FeeCharge.syncIndexes(),
    FeeStructure.syncIndexes(),
    FeePayment.syncIndexes(),
  ]);

  const school = await School.create({ name: "Test School" });
  const schoolId = String(school._id);

  // ── A structure due 15 September, 5% late fee after 7 days grace ──────────
  const structure = await FeeStructure.create({
    schoolId, academicYear: YEAR, term: "1", classIds: [],
    items:   [{ code: "TUIT", label: "Tuition", amount: 60_000 }],
    dueDate: day("2025-09-15"),
    penalty: { mode: "percent", amount: 5, graceDays: 7 },
  });

  const owing  = await makeStudent(schoolId, "Ama Owing");
  const paid   = await makeStudent(schoolId, "Ben Paid");
  const undated = await makeStudent(schoolId, "Cara Undated");

  const charge = (studentId, extra = {}) => FeeCharge.create({
    schoolId, studentId: String(studentId), academicYear: YEAR, term: "1",
    structureId: String(structure._id), code: "TUIT", label: "Tuition",
    amount: 60_000, dueDate: structure.dueDate, ...extra,
  });

  await charge(owing._id);
  await charge(paid._id);
  // Same bill, no deadline — the shape of every charge raised before this
  // feature existed.
  await FeeCharge.create({
    schoolId, studentId: String(undated._id), academicYear: YEAR, term: "1",
    structureId: null, code: "TUIT", label: "Tuition", amount: 60_000,
    dueDate: null,
  });

  await FeePayment.create({
    schoolId, studentId: String(paid._id), academicYear: YEAR,
    amount: 60_000, method: "cash",
  });

  // ── THE BOUNDARY ─────────────────────────────────────────────────────────
  console.log("--- a bill is not overdue on its own due date ---");

  const onDueDate = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-09-15"),
  });
  check("nothing overdue on the 15th", onDueDate.length, 0);

  const dayAfter = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-09-16"),
  });
  check("overdue on the 16th", dayAfter.map((r) => r.name), ["Ama Owing"]);
  check("and by one day", dayAfter[0].daysOverdue, 1);

  const threeWeeks = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-06"),
  });
  check("21 days later", threeWeeks[0].daysOverdue, 21);

  console.log("--- who is on the list, and who is not ---");
  check("a family who paid is not chased",
    threeWeeks.some((r) => r.name === "Ben Paid"), false);
  check("an undated charge is invisible",
    threeWeeks.some((r) => r.name === "Cara Undated"), false);
  check("the balance is what is owed", threeWeeks[0].balance, 60_000);
  check("reachable, because a guardian email is on file",
    threeWeeks[0].reachable, true);

  console.log("--- due soon looks forward, not back ---");
  const soon = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "dueSoon", asOf: day("2025-09-10"),
  });
  check("five days out is due soon", soon.map((r) => r.name), ["Ama Owing"]);
  check("and not marked overdue", soon[0].isOverdue, false);

  const farOut = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "dueSoon", asOf: day("2025-08-01"),
  });
  check("six weeks out is not yet due soon", farOut.length, 0);

  // ── SENDING ──────────────────────────────────────────────────────────────
  console.log("--- sending queues one notification per family ---");

  const sent = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue",
    requestedBy: "bursar-1", asOf: day("2025-10-06"),
  });
  check("one queued", sent.queued, 1);

  const queued = await Notification.find({ schoolId, kind: "fee.reminder" }).lean();
  check("the notification exists", queued.length, 1);
  check("addressed to the guardian", queued[0].to, "g1@example.com");
  check("carrying the due date", Boolean(queued[0].data?.dueDate), true);
  check("and the overdue flag", queued[0].data?.isOverdue, true);

  await backdateReminders(day("2025-10-06"));

  console.log("--- and will not send again inside the cooldown ---");
  const again = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-07"),
  });
  check("skipped as recently reminded", again.skippedRecent, 1);
  check("nothing queued", again.queued, 0);
  check("still one notification",
    await Notification.countDocuments({ schoolId, kind: "fee.reminder" }), 1);

  const forced = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue", force: true, asOf: day("2025-10-07"),
  });
  check("force overrides the cooldown", forced.queued, 1);

  console.log("--- after the cooldown it sends again on its own ---");
  // The forced send above left a fresh row; align it with the simulated clock.
  await backdateReminders(day("2025-10-06"));
  const later = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-20"),
  });
  check("two weeks later, queued", later.queued, 1);

  console.log("--- a family with no contact details is reported, not sent to ---");
  const unreachable = await makeStudent(schoolId, "Dele NoPhone");
  await Student.updateOne(
    { _id: unreachable._id },
    { $unset: { guardianEmail: "", guardianPhone: "", email: "", phone: "" } }
  );
  await charge(unreachable._id);

  const withUnreachable = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-06"),
  });
  const dele = withUnreachable.find((r) => r.name === "Dele NoPhone");
  check("still on the list", Boolean(dele), true);
  check("flagged as unreachable", dele.reachable, false);

  const sendAll = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue", force: true, asOf: day("2025-10-06"),
  });
  check("counted as unreachable rather than queued", sendAll.skippedUnreachable, 1);

  // ── PENALTIES ────────────────────────────────────────────────────────────
  console.log("--- the grace period holds the late fee back ---");

  const inGrace = await reminders.penaltyPreview({
    schoolId, academicYear: YEAR, asOf: day("2025-09-20"),
  });
  check("nothing five days after the due date", inGrace.length, 0);

  const afterGrace = await reminders.penaltyPreview({
    schoolId, academicYear: YEAR, asOf: day("2025-09-25"),
  });
  check("two families ten days later, past 7 days grace",
    afterGrace.map((r) => r.name).sort(), ["Ama Owing", "Dele NoPhone"]);

  console.log("--- a percentage is a share of what is still owed ---");
  const ama = afterGrace.find((r) => r.name === "Ama Owing");
  check("5% of 60,000", ama.amount, 3_000);
  check("and it says so", [ama.mode, ama.rate], ["percent", 5]);

  // Half-paid: the penalty should follow the remaining balance, not the bill.
  await FeePayment.create({
    schoolId, studentId: String(owing._id), academicYear: YEAR,
    amount: 40_000, method: "cash",
  });
  const partPaid = await reminders.penaltyPreview({
    schoolId, academicYear: YEAR, asOf: day("2025-09-25"),
  });
  check("5% of the remaining 20,000",
    partPaid.find((r) => r.name === "Ama Owing").amount, 1_000);
  check("a family who paid in full owes no penalty",
    partPaid.some((r) => r.name === "Ben Paid"), false);

  console.log("--- applying raises a charge, and only once ---");
  const applied = await reminders.applyPenalties({
    schoolId, academicYear: YEAR, raisedBy: "bursar-1", asOf: day("2025-09-25"),
  });
  check("two raised", applied.raised, 2);
  check("totalling 1,000 + 3,000", applied.total, 4_000);

  const amaBalance = await balanceFor({
    schoolId, studentId: String(owing._id), academicYear: YEAR,
  });
  check("the late fee is on the account", amaBalance.charged, 61_000);
  check("and in the balance", amaBalance.balance, 21_000);

  const twice = await reminders.applyPenalties({
    schoolId, academicYear: YEAR, raisedBy: "bursar-1", asOf: day("2025-09-25"),
  });
  check("a second run raises nothing", twice.raised, 0);
  check("still one late fee per student",
    await FeeCharge.countDocuments({ schoolId, code: "LATE" }), 2);

  console.log("--- the late fee has no deadline of its own ---");
  const lateCharge = await FeeCharge.findOne({ schoolId, code: "LATE" }).lean();
  check("no due date, so it can never be penalised in turn",
    lateCharge.dueDate, null);

  console.log("--- a structure with no penalty rule raises none ---");
  const plain = await FeeStructure.create({
    schoolId, academicYear: YEAR, term: "2", classIds: [],
    items: [{ code: "TUIT2", label: "Tuition 2", amount: 50_000 }],
    dueDate: day("2026-01-15"),
  });
  const other = await makeStudent(schoolId, "Efe Second");
  await FeeCharge.create({
    schoolId, studentId: String(other._id), academicYear: YEAR, term: "2",
    structureId: String(plain._id), code: "TUIT2", label: "Tuition 2",
    amount: 50_000, dueDate: plain.dueDate,
  });

  const noRule = await reminders.penaltyPreview({
    schoolId, academicYear: YEAR, structureId: String(plain._id), asOf: day("2026-06-01"),
  });
  check("mode none means nothing", noRule.length, 0);
  check("but they are still reminded",
    (await reminders.candidates({
      schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2026-06-01"),
    })).some((r) => r.name === "Efe Second"), true);

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
