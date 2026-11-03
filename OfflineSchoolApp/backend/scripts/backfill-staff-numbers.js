// backend/scripts/backfill-staff-numbers.js
"use strict";

/**
 * Give every teacher without a staff number one (CODE-STF-NNN).
 *
 * The server already does this at every boot (src/db/ensureStaffNoIndex.js),
 * so a deployment needs no step. This is the operator's view of the same
 * thing: preview what is missing, apply it without a restart, and verify.
 *
 *   npm run staffno:backfill                    # dry run: who has no number
 *   npm run staffno:backfill -- --apply         # number them (index first)
 *   npm run staffno:backfill -- --school=<id>   # one school only
 *
 * Reads MONGODB_URI (or MONGO_URI). Idempotent: a teacher with a number is
 * never touched, so it is safe to run again; a second --apply reports 0.
 * Ordered per school by createdAt then _id; deactivated teachers included.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY  = process.argv.includes("--apply");
const SCHOOL = (process.argv.find((a) => a.startsWith("--school=")) || "").split("=")[1] || null;

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error("Set MONGODB_URI."); process.exit(1); }
  await mongoose.connect(uri);
  require("../src/db/models");
  const svc = require("../src/services/staffNumber.service");

  const preview = await svc.backfillStaffNumbers({ schoolId: SCHOOL, dryRun: true });
  console.log(`Teachers without a staff number: ${preview.missing}`);
  for (const [sid, n] of Object.entries(preview.bySchool)) console.log(`  school ${sid}: ${n}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to number them.");
    await mongoose.disconnect();
    return;
  }

  const { ensureStaffNoIndex } = require("../src/db/ensureStaffNoIndex");
  if (!(await ensureStaffNoIndex())) {
    console.error("The unique (schoolId, staffNo) index is not in place — not numbering anybody.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const r = await svc.backfillStaffNumbers({ schoolId: SCHOOL, log: (l) => console.log("  " + l) });
  const left = await svc.backfillStaffNumbers({ schoolId: SCHOOL, dryRun: true });
  console.log(`\nAPPLIED — ${r.assigned} numbered, ${r.failed} failed. Still without a number: ${left.missing}.`);
  await mongoose.disconnect();
  process.exit(r.failed || left.missing ? 1 : 0);
})().catch((err) => {
  console.error("backfill failed:", err.message);
  process.exit(1);
});
