// backend/src/db/ensureStaffNoIndex.js
"use strict";

/**
 * Staff numbers at boot: the index that keeps them unique, then the backfill
 * that numbers every teacher who has none.
 *
 * ── The index ──────────────────────────────────────────────────────────────
 *
 * users { schoolId: 1, staffNo: 1 }, unique, partial on staffNo being a
 * string (models/User.js). Production connects with autoIndex off, so a
 * declared index exists only if somebody builds it; this builds it, the way
 * ensureStudentIndexes.js builds the idempotency index, and then CHECKS it is
 * there with the declared options. Idempotent: a no-op once it exists.
 *
 * Never fatal. If it cannot be built — duplicate numbers already stored, say —
 * the server still starts (a school's day does not stop over this), the
 * failure is said loudly with the duplicates counted, and the backfill does
 * NOT run: numbering without the index would be numbering without the
 * guarantee.
 *
 * ── The backfill ───────────────────────────────────────────────────────────
 *
 * services/staffNumber.service.js backfillStaffNumbers(): every teacher of
 * every school without a number gets the next one, oldest first. Run at every
 * boot because it is a no-op once done (one indexed query finding nobody),
 * and because it is also what settles an account created by any path that
 * did not number it (a seed, an import). An operator can run or preview it
 * by hand too: `npm run staffno:backfill` (dry run) / `-- --apply`.
 */

const mongoose = require("mongoose");

const INDEX_NAME = "schoolId_staffNo_unique_present";
const KEY = { schoolId: 1, staffNo: 1 };
const OPTIONS = {
  unique: true,
  partialFilterExpression: { staffNo: { $type: "string" } },
  name: INDEX_NAME,
};

const isRight = (ix) =>
  Boolean(ix?.unique) &&
  JSON.stringify(ix.key) === JSON.stringify(KEY) &&
  ix.partialFilterExpression?.staffNo?.$type === "string";

/** @returns {Promise<boolean>} whether the unique index is in place */
async function ensureStaffNoIndex({ log = console.log, error = console.error } = {}) {
  const User = mongoose.model("User");
  const coll = User.collection;
  const live = await coll.indexes().catch(() => []);
  if (live.some(isRight)) {
    log("[indexes] users (schoolId, staffNo) is unique ✅");
    return true;
  }
  try {
    await coll.createIndex(KEY, OPTIONS);
  } catch (err) {
    const dupes = await User.aggregate([
      { $match: { staffNo: { $type: "string" } } },
      { $group: { _id: { s: "$schoolId", n: "$staffNo" }, c: { $sum: 1 } } },
      { $match: { c: { $gt: 1 } } },
      { $count: "groups" },
    ]).catch(() => []);
    error(
      `[indexes] users (schoolId, staffNo): could not build the unique index — ${err.message}. ` +
      `Duplicate staff numbers already stored: ${dupes[0]?.groups ?? 0}. ` +
      "Staff numbers are not being guaranteed unique and the backfill is skipped " +
      "until the duplicates are corrected (PUT /admin/teachers/:id with a new staffNo)."
    );
    return false;
  }
  const ok = (await coll.indexes().catch(() => [])).some(isRight);
  (ok ? log : error)(ok
    ? "[indexes] users (schoolId, staffNo) built, unique ✅"
    : "[indexes] users (schoolId, staffNo) is still not unique after the build");
  return ok;
}

/**
 * The index, then — only if it is there — the backfill. Never throws.
 * @returns {Promise<{ indexed: boolean, backfill: object|null }>}
 */
async function ensureStaffNumbers({ log = console.log, error = console.error } = {}) {
  let indexed = false;
  try {
    indexed = await ensureStaffNoIndex({ log, error });
  } catch (err) {
    error(`[staffNo] could not check the staff-number index — ${err.message}`);
  }
  if (!indexed) return { indexed, backfill: null };
  try {
    const { backfillStaffNumbers } = require("../services/staffNumber.service");
    const r = await backfillStaffNumbers();
    if (r.missing) {
      log(`[staffNo] numbered ${r.assigned} of ${r.missing} teacher(s) without a staff number` +
        (r.failed ? `, ${r.failed} failed (retried at the next boot)` : ""));
    }
    return { indexed, backfill: r };
  } catch (err) {
    error(`[staffNo] backfill failed — ${err.message} (retried at the next boot)`);
    return { indexed, backfill: null };
  }
}

module.exports = { ensureStaffNoIndex, ensureStaffNumbers, INDEX_NAME };
