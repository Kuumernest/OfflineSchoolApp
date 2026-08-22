// backend/scripts/backfill-admission-numbers.js
"use strict";

/**
 * Reconcile student admission numbers.
 *
 * This school's roster was built across several eras of the app — some students
 * seeded directly, some approved before enrolment numbers existed, some when the
 * duplicate check was on email alone. The result is three different states, and
 * only one of them is "missing a number":
 *
 *   B  a number in `admissionNo` but not `enrollmentNo` — the parent portal
 *      and the login both read `enrollmentNo`, so these students look
 *      numberless to every screen while plainly having a number on paper;
 *   C  a number in `enrollmentNo` but not `admissionNo` — invisible to the
 *      generator in admin.routes, which searches `admissionNo` only;
 *   D  genuinely nothing.
 *
 * Only D gets a NEW number. B and C are copied across, because minting for a
 * student who already has a number printed on their file would give them two
 * identities, which is worse than the state we started in.
 *
 * C is not cosmetic. The generator takes the highest `admissionNo` matching
 * the prefix and adds one; with Ken and Chou invisible to it, the next approval
 * would mint GVA00/2026/001 again, collide with Ken on the sparse-unique index,
 * and fail. Copying their numbers across is what stops that.
 *
 * Existing numbers are never rewritten, including the two legacy formats
 * (GVA00/2026/001 and GVA00-2026-0001). Renumbering a real student would
 * invalidate whatever paperwork already carries the old number.
 *
 *   node scripts/backfill-admission-numbers.js            # dry run
 *   node scripts/backfill-admission-numbers.js --apply    # write
 */

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY    = process.argv.includes("--apply");
const SCHOOL   = process.env.BACKFILL_SCHOOL_ID || "6a4ccbfac10ad6faa189bd85";

const has = (v) => Boolean(v && String(v).trim());

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  const Student = require("../src/db/models/Student");
  const School  = require("../src/db/models/School");

  const school = await School.findById(SCHOOL).lean().catch(() => null);

  // Mirrors admin.routes exactly. If these ever diverge the backfill starts
  // minting numbers in a series the app will not continue.
  const schoolCode =
    school?.code?.trim().toUpperCase().slice(0, 5) ||
    (SCHOOL || "SCH").replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase() ||
    "SCH";
  const prefix = `${schoolCode}/${new Date().getFullYear()}/`;

  const students = await Student.find({
    schoolId: SCHOOL, status: "approved", deletedAt: null,
  }).select("studentName enrollmentNo admissionNo").lean();

  // Every number already in use, in EITHER field, so a minted one cannot
  // collide with a number that exists but is stored in the other column.
  const taken = new Set();
  for (const s of students) {
    if (has(s.enrollmentNo)) taken.add(String(s.enrollmentNo).trim());
    if (has(s.admissionNo))  taken.add(String(s.admissionNo).trim());
  }

  // Continue the series from the highest number in the generator's format,
  // looking at both fields.
  let nextSeq = 0;
  for (const value of taken) {
    if (!value.startsWith(prefix)) continue;
    const seq = parseInt(value.slice(prefix.length), 10);
    if (!Number.isNaN(seq) && seq > nextSeq) nextSeq = seq;
  }

  const plan = [];

  for (const s of students) {
    const name = s.studentName || "(unnamed)";
    const e = has(s.enrollmentNo) ? String(s.enrollmentNo).trim() : null;
    const a = has(s.admissionNo)  ? String(s.admissionNo).trim()  : null;

    if (e && a) continue;                                  // A — nothing to do

    if (a && !e) {
      plan.push({ _id: s._id, name, action: "copy admissionNo → enrollmentNo", value: a });
    } else if (e && !a) {
      plan.push({ _id: s._id, name, action: "copy enrollmentNo → admissionNo", value: e });
    } else {
      let value;
      do {
        nextSeq += 1;
        value = `${prefix}${String(nextSeq).padStart(3, "0")}`;
      } while (taken.has(value));   // never reuse, even across formats
      taken.add(value);
      plan.push({ _id: s._id, name, action: "MINT new number", value });
    }
  }

  console.log(`school code : ${schoolCode}   prefix: ${prefix}`);
  console.log(`students    : ${students.length} approved`);
  console.log(`unchanged   : ${students.length - plan.length}`);
  console.log(`to change   : ${plan.length}\n`);

  for (const p of plan) {
    console.log(`  ${p.name.padEnd(18)} ${p.action.padEnd(32)} ${p.value}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  for (const p of plan) {
    // Written through the driver, not the model: `enrollment_no` and
    // `admissionNumber` are legacy aliases the schema does not declare, and a
    // strict-mode save would silently drop them — leaving the very split this
    // script exists to repair.
    await Student.collection.updateOne(
      { _id: p._id },
      { $set: {
          enrollmentNo:    p.value,
          admissionNo:     p.value,
          admissionNumber: p.value,
          enrollment_no:   p.value,
      } }
    );
    done += 1;
  }

  console.log(`\nAPPLIED — ${done} student(s) updated.`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error("backfill failed:", err.message);
  process.exit(1);
});
