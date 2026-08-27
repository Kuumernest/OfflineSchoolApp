// backend/scripts/fix-payroll-index.js
"use strict";

/**
 * Replace the "one live payroll run per month" index.
 *
 * The old index was declared without a name, so mongoose auto-named it
 * "schoolId_1_periodMonth_1", and its partial filter was:
 *
 *   { status: { $in: ["draft", "confirmed"] }, deletedAt: null }
 *
 * Approvals added a fourth state. A run that has been signed off but not yet
 * paid is "approved" — very much live — and the old filter does not cover it,
 * so while a run sat awaiting payment a second run could be generated for the
 * same month. Two runs, two sets of payslips, one month.
 *
 * The replacement is declared in the model as "payroll_live_per_month" and adds
 * "approved" to the filter. It is given a NEW NAME on purpose: redefining
 * "schoolId_1_periodMonth_1" with a different partialFilterExpression raises
 * IndexOptionsConflict on connect, which would stop the app booting on every
 * existing deployment.
 *
 * That means both indexes coexist until this script removes the old one. That
 * is safe — the old filter is narrower, not wrong, so while it is present it
 * simply enforces less than the new one. Nothing breaks if this is never run;
 * the gap it closes only opens for schools that turn payroll approval on.
 *
 * Safe to run more than once.
 *
 *   node scripts/fix-payroll-index.js --dry-run
 *   node scripts/fix-payroll-index.js
 */

require("dotenv").config();

const mongoose        = require("mongoose");
const connectDatabase = require("../src/config/database");
const PayrollRun      = require("../src/db/models/PayrollRun");

const DRY_RUN  = process.argv.includes("--dry-run");
const OLD_NAME = "schoolId_1_periodMonth_1";
const NEW_NAME = "payroll_live_per_month";

const main = async () => {
  await connectDatabase();

  console.log(DRY_RUN ? "\nDRY RUN — nothing will change\n" : "\nApplying\n");

  const indexes = await PayrollRun.collection.indexes();
  const byName  = new Map(indexes.map((i) => [i.name, i]));

  console.log("Indexes on payrollruns touching periodMonth:");
  for (const i of indexes) {
    if (!i.key || !("periodMonth" in i.key)) continue;
    console.log(
      `  ${i.name.padEnd(30)} unique=${!!i.unique} ` +
      `partial=${i.partialFilterExpression ? JSON.stringify(i.partialFilterExpression) : "none"}`
    );
  }
  console.log("");

  // Before dropping the old constraint, check the data would satisfy the new,
  // WIDER one. The old index permitted two live runs for a month where one was
  // approved; if any school actually has that, the new index would refuse to
  // build and the failure must be reported rather than hit halfway through.
  const dupes = await PayrollRun.aggregate([
    {
      $match: {
        deletedAt: null,
        status: { $in: ["draft", "approved", "confirmed"] },
      },
    },
    {
      $group: {
        _id: { schoolId: "$schoolId", periodMonth: "$periodMonth" },
        n:   { $sum: 1 },
        ids: { $push: "$_id" },
        states: { $push: "$status" },
      },
    },
    { $match: { n: { $gt: 1 } } },
    { $limit: 20 },
  ]);

  if (dupes.length) {
    console.error(
      `Refusing to continue: ${dupes.length} school/month pair(s) already have ` +
      `more than one live payroll run. Reverse or delete the extras first — ` +
      `the new index would reject them.\n`
    );
    for (const d of dupes) {
      console.error(
        `  ${d._id.schoolId} ${d._id.periodMonth} -> ` +
        `${d.ids.map((id, n) => `${id} (${d.states[n]})`).join(", ")}`
      );
    }
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  if (!byName.has(NEW_NAME)) {
    console.log(
      `The new index "${NEW_NAME}" is not present yet. It is created by the ` +
      `model on connect — start the app once, then run this again.\n`
    );
    await mongoose.disconnect();
    return;
  }

  if (!byName.has(OLD_NAME)) {
    console.log(`Nothing to do: "${OLD_NAME}" is already gone.\n`);
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log(`Would drop "${OLD_NAME}".\n`);
    await mongoose.disconnect();
    return;
  }

  await PayrollRun.collection.dropIndex(OLD_NAME);
  console.log(`Dropped "${OLD_NAME}". "${NEW_NAME}" now enforces it.\n`);

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error("\nFailed:", err.message);
  process.exitCode = 1;
  try { await mongoose.disconnect(); } catch { /* already closed */ }
});
