// backend/scripts/fix-enrollment-index.js
"use strict";

/**
 * Drop the broken unique index on User.enrollmentNo.
 *
 * The old index was { enrollmentNo: 1 } unique + sparse. A sparse index skips
 * a MISSING field but still indexes an explicit null, and the schema declares
 * `enrollmentNo: { default: null }` — so every user without a number was
 * stored with the field present and null, and they all collided on the same
 * key. On a fresh database the second teacher or admin could not be created:
 *
 *   E11000 duplicate key error ... index: enrollmentNo_1
 *   dup key: { enrollmentNo: null }
 *
 * The replacement, declared in the model as "enrollmentNo_unique_present",
 * uses a partial filter on $type: "string" so it covers only rows that
 * actually have a number. Uniqueness for real enrolment numbers is preserved;
 * any number of users may have none.
 *
 * The new index is created under a different name on purpose. Redefining
 * "enrollmentNo_1" with different options raises IndexOptionsConflict on
 * connect, which would stop the app booting on every existing deployment.
 * That means both indexes coexist until this script removes the old one, and
 * while the old one is present the bug is still live.
 *
 * Safe to run more than once.
 *
 *   node scripts/fix-enrollment-index.js --dry-run
 *   node scripts/fix-enrollment-index.js
 */

require("dotenv").config();

const mongoose        = require("mongoose");
const connectDatabase = require("../src/config/database");
const User            = require("../src/db/models/User");

const DRY_RUN  = process.argv.includes("--dry-run");
const OLD_NAME = "enrollmentNo_1";
const NEW_NAME = "enrollmentNo_unique_present";

const main = async () => {
  await connectDatabase();

  console.log(DRY_RUN ? "\nDRY RUN — nothing will change\n" : "\nApplying\n");

  const indexes = await User.collection.indexes();
  const byName  = new Map(indexes.map((i) => [i.name, i]));

  console.log("Indexes on users touching enrollmentNo:");
  for (const i of indexes) {
    if (!i.key || !("enrollmentNo" in i.key)) continue;
    console.log(
      `  ${i.name.padEnd(30)} unique=${!!i.unique} sparse=${!!i.sparse} ` +
      `partial=${i.partialFilterExpression ? JSON.stringify(i.partialFilterExpression) : "none"}`
    );
  }
  console.log("");

  // Before dropping anything, check the data would actually satisfy the new
  // constraint. Two users sharing a REAL number is a data problem the index
  // cannot paper over, and it must be reported rather than discovered halfway
  // through a rebuild.
  const dupes = await User.aggregate([
    { $match: { enrollmentNo: { $type: "string", $ne: "" } } },
    { $group: { _id: "$enrollmentNo", n: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 20 },
  ]);

  if (dupes.length) {
    console.error(
      `Refusing to continue: ${dupes.length} enrolment number(s) are used by ` +
      `more than one user. Fix these first — the new index would reject them.\n`
    );
    for (const d of dupes) {
      console.error(`  ${d._id} -> ${d.ids.join(", ")}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("No duplicate enrolment numbers. Safe to proceed.\n");

  // Create the good index first, so uniqueness is never unenforced.
  if (byName.has(NEW_NAME)) {
    console.log(`  ${NEW_NAME} already exists`);
  } else if (DRY_RUN) {
    console.log(`  would create ${NEW_NAME}`);
  } else {
    await User.collection.createIndex(
      { enrollmentNo: 1 },
      {
        unique: true,
        partialFilterExpression: { enrollmentNo: { $type: "string" } },
        name: NEW_NAME,
      }
    );
    console.log(`  created ${NEW_NAME}`);
  }

  if (!byName.has(OLD_NAME)) {
    console.log(`  ${OLD_NAME} is already gone — nothing to drop`);
  } else if (DRY_RUN) {
    console.log(`  would drop ${OLD_NAME}`);
  } else {
    await User.collection.dropIndex(OLD_NAME);
    console.log(`  dropped ${OLD_NAME}`);
  }

  if (!DRY_RUN) {
    const after = await User.collection.indexes();
    const still = after.find((i) => i.name === OLD_NAME);
    console.log(
      still
        ? "\nWARNING: the old index is still present."
        : "\nDone. Staff users without an enrolment number can now be created."
    );
  }
};

main()
  .catch((err) => {
    console.error("\nFailed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
