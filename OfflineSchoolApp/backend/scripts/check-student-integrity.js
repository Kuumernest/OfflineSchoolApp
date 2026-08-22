#!/usr/bin/env node
"use strict";

/**
 * Reports — and optionally repairs — contradictory student records.
 *
 * Written after a student showed as "Pending" in the list while holding an
 * admission number. The UI was partly to blame (the detail screen mapped every
 * unrecognised status to "Active"), but the record really was inconsistent:
 * it carried an admission number yet had never been approved.
 *
 * Checks
 *   1. numbered-but-not-approved  a student holding an admission/enrolment
 *                                 number whose status is not "approved".
 *                                 Numbers are only minted on approval, so this
 *                                 is contradictory. NOT auto-fixed: flipping a
 *                                 status decides an admission, and the record
 *                                 also has no user account, so it would enroll
 *                                 someone who cannot log in. Needs a human.
 *   2. missing-name               `name` empty while firstName/lastName or
 *                                 studentName is present. Pure denormalisation
 *                                 drift; safe to repair.
 *   3. approved-without-number    approved but no number — the account
 *                                 provisioning step did not finish.
 *   4. orphan-application         an application marked approved with no
 *                                 studentId linking it to a Student record.
 *   5. duplicate-person           the same name appearing more than once.
 *
 * Usage
 *   node scripts/check-student-integrity.js            # report only (default)
 *   node scripts/check-student-integrity.js --fix-names    # repair check 2
 *   node scripts/check-student-integrity.js --fix-numbers  # repair check 3
 */

require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const Student  = require("../src/db/models/Student");
const User     = require("../src/db/models/User");

let StudentApp = null;
try { StudentApp = require("../src/db/models/StudentApplication"); } catch { /* optional */ }

const FIX_NAMES   = process.argv.includes("--fix-names");
const FIX_NUMBERS = process.argv.includes("--fix-numbers");

const label = (s) =>
  s.name || s.studentName ||
  [s.firstName, s.lastName].filter(Boolean).join(" ") ||
  `<unnamed ${String(s._id).slice(0, 8)}>`;

const numberOf = (s) => s.enrollmentNo || s.admissionNo || s.admissionNumber || null;

const main = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set — check backend/.env");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const students = await Student.find({}).lean();
  console.log(`${students.length} student record(s)\n`);

  // ── 1. Holding a number but not approved ──────────────────────────────────
  const numbered = students.filter(
    (s) => numberOf(s) && s.status !== "approved"
  );
  console.log(`[1] Holding an admission number but status is not "approved": ${numbered.length}`);
  for (const s of numbered) {
    console.log(
      `      ${label(s)}  status=${s.status}  number=${numberOf(s)}\n` +
      `        id=${s._id}\n` +
      `        approvedAt=${s.approvedAt ?? "never"}  userId=${s.userId ?? "none"}  ` +
      `created=${s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : "?"}`
    );
    if (!s.userId) {
      console.log(
        `        ↳ no user account: this student cannot log in even if approved.`
      );
    }
  }
  if (numbered.length) {
    console.log(
      `    Not auto-repaired. Either approve them properly through the admin\n` +
      `    screen (which provisions a login and a real number), or clear the\n` +
      `    stray number if they were never admitted.`
    );
  }

  // ── 2. Missing studentName ────────────────────────────────────────────────
  //
  // `studentName` is the real field. `name` is NOT a path on this schema and
  // the schema is strict, so Mongoose silently drops any write to it — a
  // "backfill name" repair looks like it succeeds and changes nothing. Some
  // old documents do carry `name`, from before the schema tightened; the app's
  // display helpers already fall back to studentName, so those are harmless.
  const nameless = students.filter(
    (s) => !s.studentName && (s.firstName || s.lastName)
  );
  console.log(`\n[2] Missing 'studentName' but recoverable: ${nameless.length}`);
  for (const s of nameless) {
    console.log(
      `      ${label(s)}  (id=${String(s._id).slice(0, 8)}…)  ` +
      `first=${JSON.stringify(s.firstName)} last=${JSON.stringify(s.lastName)}`
    );
  }

  if (nameless.length && FIX_NAMES) {
    let fixed = 0;
    for (const s of nameless) {
      const derived = [s.firstName, s.lastName].filter(Boolean).join(" ").trim();
      if (!derived) continue;
      const res = await Student.updateOne(
        { _id: s._id }, { $set: { studentName: derived } }
      );
      // Report what the database actually acknowledged, not what we attempted.
      if (res.modifiedCount > 0) fixed++;
      else console.log(`      ! ${label(s)}: update not applied`);
    }
    console.log(`    repaired ${fixed}/${nameless.length}`);
  } else if (nameless.length) {
    console.log(`    re-run with --fix-names to repair these`);
  }

  // Purely informational: documents carrying the vestigial `name` field.
  const vestigial = students.filter((s) => s.name);
  if (vestigial.length) {
    console.log(
      `    note: ${vestigial.length} document(s) still carry a legacy 'name' ` +
      `field that the schema no longer defines — harmless, reads fall back to studentName`
    );
  }

  // ── 3. Approved without a number ──────────────────────────────────────────
  //
  // The usual cause was a write to `admissionNo`, which is not a path on this
  // schema — strict mode discarded it, so the number stayed only on the linked
  // User account. Where that account has one, copying it back is safe: it
  // recovers an existing number rather than minting a new one.
  const unnumbered = students.filter((s) => s.status === "approved" && !numberOf(s));
  console.log(`\n[3] Approved but holding no number: ${unnumbered.length}`);

  let recoverable = 0;
  for (const s of unnumbered) {
    let fromUser = null;
    if (s.userId) {
      const u = await User.findById(String(s.userId)).select("enrollmentNo").lean().catch(() => null);
      fromUser = u?.enrollmentNo || null;
    }
    if (fromUser) recoverable++;
    console.log(
      `      ${label(s)}  userId=${s.userId ?? "none"}  ` +
      `account number=${fromUser ?? "none"}  (id=${String(s._id).slice(0, 8)}…)`
    );

    if (fromUser && FIX_NUMBERS) {
      const res = await Student.updateOne(
        { _id: s._id }, { $set: { enrollmentNo: fromUser } }
      );
      console.log(`        ${res.modifiedCount ? "recovered" : "update not applied"}`);
    }
  }
  if (unnumbered.length) {
    console.log(
      `    ${recoverable} recoverable from the linked account` +
      (FIX_NUMBERS ? "" : ` — re-run with --fix-numbers`) +
      `; the rest never had an account provisioned.`
    );
  }

  // ── 4. Approved applications with no linked Student ───────────────────────
  if (StudentApp) {
    const apps = await StudentApp.find({ status: "approved" }).lean();
    const orphans = apps.filter((a) => !a.studentId);
    console.log(`\n[4] Approved applications with no linked Student: ${orphans.length}`);
    for (const a of orphans) {
      const selfLinked = students.some((s) => String(s._id) === String(a._id));
      console.log(
        `      ${a.studentName ?? "?"}  appId=${String(a._id).slice(0, 8)}…` +
        (selfLinked
          ? "  (a Student shares this id — linked implicitly)"
          : "  (no matching Student — approval did not create one)")
      );
    }
  } else {
    console.log("\n[4] StudentApplication model not present — skipped");
  }

  // ── 5. Possible duplicates ────────────────────────────────────────────────
  const byName = new Map();
  for (const s of students) {
    const k = label(s).toLowerCase();
    if (k.startsWith("<unnamed")) continue;
    byName.set(k, [...(byName.get(k) ?? []), s]);
  }
  const dupes = [...byName.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n[5] Names appearing more than once: ${dupes.length}`);
  for (const [name, rows] of dupes) {
    console.log(
      `      "${name}" ×${rows.length}: ` +
      rows.map((r) => `${String(r._id).slice(0, 8)}…(${r.status})`).join(", ")
    );
  }

  const issues =
    numbered.length + nameless.length + unnumbered.length + dupes.length;
  console.log(`\n${issues === 0 ? "No inconsistencies found." : `${issues} record(s) need attention.`}`);

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error("\nCheck failed:", err.message);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
