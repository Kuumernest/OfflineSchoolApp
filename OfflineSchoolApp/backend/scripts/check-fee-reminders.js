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
 *   • an undated charge is overdue at once, but only within the year in scope
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
const PaymentPlan  = require("../src/db/models/PaymentPlan");
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
  const mongo = await MongoMemoryServer.create({
    // The default launch timeout is ten seconds, which is not enough on a
    // developer machine with a browser and an editor open — the suite failed
    // intermittently with "Instance failed to start within 10000ms" and the
    // failure looked like a broken test rather than a busy host.
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: "fee-reminders" });

  await Promise.all([
    FeeCharge.syncIndexes(),
    FeeStructure.syncIndexes(),
    FeePayment.syncIndexes(),
    PaymentPlan.syncIndexes(),
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
  // Same bill, no deadline. Undated now means overdue at once — but only inside
  // the academic year in scope. Cara's is this year, so she is chased; the
  // earlier-year case is asserted separately below.
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
  check("the dated bill is not overdue on its own due date",
    onDueDate.some((r) => r.name === "Ama Owing"), false);
  check("and on that day only the undated one is late",
    onDueDate.map((r) => r.name), ["Cara Undated"]);

  const dayAfter = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-09-16"),
  });
  check("overdue on the 16th",
    dayAfter.map((r) => r.name).sort(), ["Ama Owing", "Cara Undated"]);
  // Found by name rather than taken from [0]: the undated row shares this list
  // now, and an assertion that depends on ordering passes or fails by luck.
  check("and by one day",
    dayAfter.find((r) => r.name === "Ama Owing").daysOverdue, 1);

  const threeWeeks = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-06"),
  });
  const ama3w = threeWeeks.find((r) => r.name === "Ama Owing");
  check("21 days later", ama3w.daysOverdue, 21);

  console.log("--- who is on the list, and who is not ---");
  check("a family who paid is not chased",
    threeWeeks.some((r) => r.name === "Ben Paid"), false);
  check("an undated charge in the year in scope is chased",
    threeWeeks.some((r) => r.name === "Cara Undated"), true);
  check("the balance is what is owed", ama3w.balance, 60_000);
  check("reachable, because a guardian email is on file",
    ama3w.reachable, true);

  console.log("--- but an undated charge from an earlier year stays silent ---");
  // The bound that makes the rule above safe to ship. Every charge raised
  // before due dates existed is undated, so unbounded this would hand a school
  // its whole history the first time a bursar opened the preview. With no
  // academicYear argument the school's own current year is what binds.
  await School.updateOne(
    { _id: schoolId },
    { $set: { "settings.academicYear": YEAR } }
  );
  const legacy = await makeStudent(schoolId, "Eve Legacy");
  await FeeCharge.create({
    schoolId, studentId: String(legacy._id), academicYear: "2019/2020", term: "1",
    structureId: null, code: "TUIT", label: "Tuition", amount: 60_000,
    dueDate: null,
  });

  const noYearNamed = await reminders.candidates({
    schoolId, mode: "overdue", asOf: day("2025-10-06"),
  });
  check("this year's undated charge is still chased when the caller names no year",
    noYearNamed.some((r) => r.name === "Cara Undated"), true);
  check("and 2019/2020's is not",
    noYearNamed.some((r) => r.name === "Eve Legacy"), false);

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
  // Two: the dated bill and the undated one, which are both overdue by now.
  check("one per family queued", sent.queued, 2);

  const queued = await Notification.find({ schoolId, kind: "fee.reminder" }).lean();
  check("both notifications exist", queued.length, 2);
  // Ama's specifically — g1 is the first student makeStudent numbered — because
  // queued[0] is now whichever of the two the driver happened to write first.
  const amaNote = queued.find((n) => n.to === "g1@example.com");
  check("addressed to the guardian", Boolean(amaNote), true);
  check("carrying the due date", Boolean(amaNote.data?.dueDate), true);
  check("and the overdue flag", amaNote.data?.isOverdue, true);

  await backdateReminders(day("2025-10-06"));

  console.log("--- and will not send again inside the cooldown ---");
  const again = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-07"),
  });
  check("skipped as recently reminded", again.skippedRecent, 2);
  check("nothing queued", again.queued, 0);
  check("still just the two notifications",
    await Notification.countDocuments({ schoolId, kind: "fee.reminder" }), 2);

  const forced = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue", force: true, asOf: day("2025-10-07"),
  });
  check("force overrides the cooldown", forced.queued, 2);

  console.log("--- after the cooldown it sends again on its own ---");
  // The forced send above left a fresh row; align it with the simulated clock.
  await backdateReminders(day("2025-10-06"));
  const later = await reminders.sendReminders({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-20"),
  });
  check("two weeks later, queued", later.queued, 2);

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
  check("and named, because a count alone is a mystery",
    (sendAll.unreachable ?? []).map((u) => u.name), ["Dele NoPhone"]);

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

  // ── INSTALMENT PLANS ─────────────────────────────────────────────────────
  //
  // The point of a plan: a family who cannot pay in one go agrees dates with
  // the school and is measured against THOSE. Chasing them on the original
  // deadline while they keep to an arrangement the school itself proposed is
  // worse than having no plans at all, so these are the assertions that matter
  // most in this file.
  console.log("--- the cumulative rule ---");

  const schedule = [
    { seq: 1, amount: 20_000, dueDate: day("2025-09-15") },
    { seq: 2, amount: 20_000, dueDate: day("2025-10-15") },
    { seq: 3, amount: 20_000, dueDate: day("2025-11-15") },
  ];
  const status = (paidSoFar, asOf) =>
    reminders.planStatus({ instalments: schedule }, paidSoFar, day(asOf));

  check("before the first date, nothing is due",
    status(0, "2025-09-10").dueByNow, 0);
  check("and they are not behind",
    status(0, "2025-09-10").isBehind, false);
  check("the day after, 20,000 was due",
    status(0, "2025-09-16").dueByNow, 20_000);
  check("so they are behind by that much",
    status(0, "2025-09-16").behindBy, 20_000);
  check("paying it on time clears them",
    status(20_000, "2025-09-16").isBehind, false);

  // The assertion the whole design turns on.
  check("paying double early and nothing next is ON TRACK",
    status(40_000, "2025-10-16").isBehind, false);
  check("and the next date is the third",
    status(40_000, "2025-10-16").nextDue.toISOString().slice(0, 10), "2025-11-15");
  check("the quoted date is the FIRST shortfall, not the last",
    status(0, "2025-11-16").missedSince.toISOString().slice(0, 10), "2025-09-15");
  check("paying everything up front settles it",
    status(60_000, "2025-11-16").settled, true);

  console.log("--- a family on a plan is measured against the plan ---");

  const onPlan = await makeStudent(schoolId, "Fola OnPlan");
  await FeeCharge.create({
    schoolId, studentId: String(onPlan._id), academicYear: YEAR, term: "3",
    structureId: null, code: "TUIT3", label: "Tuition 3",
    amount: 60_000, dueDate: day("2025-09-15"),
  });

  await PaymentPlan.create({
    schoolId, studentId: String(onPlan._id), academicYear: YEAR, term: null,
    instalments: schedule, reason: "Hardship, agreed with the head",
  });
  await FeePayment.create({
    schoolId, studentId: String(onPlan._id), academicYear: YEAR,
    amount: 20_000, method: "cash",
  });

  const chased = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-01"),
  });
  check("keeping to the plan means not chased",
    chased.some((r) => r.name === "Fola OnPlan"), false);

  const soonOnPlan = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "dueSoon", asOf: day("2025-10-05"),
  });
  const fola = soonOnPlan.find((r) => r.name === "Fola OnPlan");
  check("but due soon against the NEXT instalment", Boolean(fola), true);
  check("which is the plan date, not the bill date",
    fola.earliestDue.toISOString().slice(0, 10), "2025-10-15");
  check("and flagged as being on a plan", fola.onPlan, true);

  const fallenBehind = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-20"),
  });
  const behind = fallenBehind.find((r) => r.name === "Fola OnPlan");
  check("missing an instalment does put them on the list", Boolean(behind), true);
  check("behind by the second instalment", behind.planBehindBy, 20_000);
  check("and the full balance is still reported", behind.balance, 40_000);

  console.log("--- a plan being kept to exempts them from late fees ---");

  const penaltyStructure = await FeeStructure.create({
    schoolId, academicYear: YEAR, term: "4", classIds: [],
    items:   [{ code: "TUIT4", label: "Tuition 4", amount: 60_000 }],
    dueDate: day("2025-09-15"),
    penalty: { mode: "fixed", amount: 5_000, graceDays: 0 },
  });

  const exempt = await makeStudent(schoolId, "Gita Exempt");
  const liable = await makeStudent(schoolId, "Hama Liable");

  for (const s of [exempt, liable]) {
    await FeeCharge.create({
      schoolId, studentId: String(s._id), academicYear: YEAR, term: "4",
      structureId: String(penaltyStructure._id), code: "TUIT4",
      label: "Tuition 4", amount: 60_000, dueDate: penaltyStructure.dueDate,
    });
    await PaymentPlan.create({
      schoolId, studentId: String(s._id), academicYear: YEAR, term: "4",
      instalments: schedule, reason: "Agreed",
    });
  }

  // Both have a plan; only one is keeping to it.
  await FeePayment.create({
    schoolId, studentId: String(exempt._id), academicYear: YEAR,
    amount: 20_000, method: "cash",
  });

  const liableList = await reminders.penaltyPreview({
    schoolId, academicYear: YEAR, structureId: String(penaltyStructure._id),
    asOf: day("2025-10-01"),
  });
  check("a plan being kept to is exempt",
    liableList.some((r) => r.name === "Gita Exempt"), false);
  check("a plan being broken is not",
    liableList.some((r) => r.name === "Hama Liable"), true);
  check("and the row says it is a plan-holder",
    liableList.find((r) => r.name === "Hama Liable").onPlan, true);

  console.log("--- cancelling a plan restores the original deadline ---");
  await PaymentPlan.updateOne(
    { schoolId, studentId: String(exempt._id) },
    { $set: { status: "cancelled", cancelledReason: "Broke the arrangement" } }
  );
  const afterCancel = await reminders.penaltyPreview({
    schoolId, academicYear: YEAR, structureId: String(penaltyStructure._id),
    asOf: day("2025-10-01"),
  });
  check("now liable like anybody else",
    afterCancel.some((r) => r.name === "Gita Exempt"), true);

  console.log("--- one active plan per student per term ---");
  let dupeCode = "no error";
  try {
    await PaymentPlan.create({
      schoolId, studentId: String(liable._id), academicYear: YEAR, term: "4",
      instalments: schedule, reason: "A second one",
    });
  } catch (err) { dupeCode = err.code; }
  check("a second active plan is refused", dupeCode, 11000);

  console.log("--- nor to a family reachable only on a channel this school does not use ---");

  // The case the whole-journey smoke test found, and the ordinary case in a
  // Cameroonian school: a phone number on file and no email address, at a
  // school that sends by email.
  //
  // Both layers used to disagree about this. candidates() asked "any contact
  // detail at all" and said reachable; the notification pipeline asked for an
  // address the configured channel could use, found none, and wrote a skipped
  // row. sendReminders counted that row as queued because enqueue had resolved
  // without throwing — so the bursar was told the reminder went, the cooldown
  // (which counts only sent and pending) never engaged, and pressing send
  // again reported another success with the same result, indefinitely.
  const phoneOnly = await makeStudent(schoolId, "Marthe PhoneOnly");
  await Student.updateOne(
    { _id: phoneOnly._id },
    { $unset: { guardianEmail: "", email: "" }, $set: { guardianPhone: "+237670000099" } }
  );
  await charge(phoneOnly._id);

  const withPhoneOnly = await reminders.candidates({
    schoolId, academicYear: YEAR, mode: "overdue", asOf: day("2025-10-06"),
  });
  const marthe = withPhoneOnly.find((r) => r.name === "Marthe PhoneOnly");
  check("on the arrears list, where she belongs", Boolean(marthe), true);
  check("but not described as reachable", marthe.reachable, false);

  const sendPhoneOnly = await reminders.sendReminders({
    schoolId, academicYear: YEAR, studentIds: [String(phoneOnly._id)],
    mode: "overdue", force: true, asOf: day("2025-10-06"),
  });
  check("nothing is queued for her", sendPhoneOnly.queued, 0);
  check("she is reported as unreachable", sendPhoneOnly.skippedUnreachable, 1);
  check("with a reason a bursar can act on",
    /address|email|phone/i.test((sendPhoneOnly.unreachable ?? [])[0]?.reason ?? ""), true);

  // Nothing was sent, so nothing may suppress the next attempt — otherwise a
  // family with no address would be silently dropped for a week at a time.
  const retryHer = await reminders.sendReminders({
    schoolId, academicYear: YEAR, studentIds: [String(phoneOnly._id)],
    mode: "overdue", asOf: day("2025-10-07"),
  });
  check("and the cooldown does not pretend otherwise", retryHer.skippedRecent, 0);
  check("she is still reported the next day", retryHer.skippedUnreachable, 1);

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
