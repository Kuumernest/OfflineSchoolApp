// backend/scripts/check-real-school-seed.js
"use strict";

/**
 * The real school's ACTIVE evidence population carries no record made by
 * seed-form1-students.js. Read-only, against the configured database; counts
 * only — no name, number, credential, hash or password appears here or in
 * the output. Opt-in and live, so NOT part of check:all (like
 * check-student-integrity.js); it needs MONGODB_URI and a school id.
 *
 * ── What a seeded record is ───────────────────────────────────────────────
 *
 * Not a prefix and not a name. seed-form1-students.js writes one fixed class
 * id, one literal address string, a "+237 6…" guardian phone, no e-mail,
 * mustResetPassword, and sequential enrollment numbers under GVA00/2026/ —
 * and the school's own code is GVA001, so its numbering never produces that
 * prefix. A record counts as seeded here only when it sits in the seed's
 * class, carries the seed's enrollment pattern, has no e-mail on its account
 * and still has mustResetPassword set (never signed in), AND carries the
 * seed's literal address or was created inside the one seed run on
 * 2026-08-31 17:50–18:10 UTC. Anything else is a school record and is not
 * counted, whatever it looks like.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 *   1. every seeded pupil is soft-deleted and inactive
 *   2. every seeded account is inactive (cannot authenticate, whatever its password)
 *   3. no seeded pupil is in the live intelligence cohort, on the review sheet,
 *      or in the preflight's counts
 *   4. no published result, score or term result of a seeded pupil is active
 *   5. any seeded review is stamped synthetic/development and counts as excluded
 *
 *   MONGODB_URI=… node scripts/check-real-school-seed.js <schoolId>
 */

const path = require("path");
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const SEED_CLASS = "0ac69e73-2729-443d-9f72-a26c396c3c59";
const SEED_ADDRESS = "Buea, Cameroon";
const SEED_RUN = { from: new Date("2026-08-31T17:50:00Z"), to: new Date("2026-08-31T18:10:00Z") };
const SEED_ENROLLMENT = /^GVA00\/2026\/\d{3}$/;

(async () => {
  const schoolId = process.argv[2];
  if (!schoolId || !process.env.MONGODB_URI) { console.log("  usage: MONGODB_URI=… node scripts/check-real-school-seed.js <schoolId>"); process.exit(2); }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  const reviewCases = require(path.join(SRC, "services/intelligence/reviewCases.service"));
  const pilots      = require(path.join(SRC, "services/intelligence/pilot.service"));

  console.log("\n--- the seeded population, re-derived from the seed's own signature ---");
  const candidates = await M("Student").find({ schoolId, classId: SEED_CLASS, enrollmentNo: SEED_ENROLLMENT }).select("_id userId address createdAt deletedAt isActive status").lean();
  const seeded = [];
  for (const s of candidates) {
    const u = s.userId ? await M("User").findById(s.userId).select("email mustResetPassword isActive role").lean() : null;
    const noEmail = !u || !u.email, neverSignedIn = !u || u.mustResetPassword === true;
    const inRun = s.createdAt >= SEED_RUN.from && s.createdAt <= SEED_RUN.to;
    if (noEmail && neverSignedIn && (s.address === SEED_ADDRESS || inRun)) seeded.push({ s, u });
  }
  const ids = seeded.map((x) => String(x.s._id));
  console.log(`       candidates by class and pattern: ${candidates.length}; confirmed seeded: ${seeded.length}`);
  check("every confirmed seeded pupil is soft-deleted and inactive", seeded.filter((x) => !x.s.deletedAt || x.s.isActive !== false).length, 0);
  check("every confirmed seeded account is inactive — it cannot authenticate", seeded.filter((x) => x.u && x.u.isActive !== false).length, 0);
  check("no active pupil of the school carries the seed's signature", (await M("Student").countDocuments({ schoolId, deletedAt: null, classId: SEED_CLASS, enrollmentNo: SEED_ENROLLMENT, address: SEED_ADDRESS })), 0);

  console.log("\n--- the active evidence population ---");
  const { studentIds } = await reviewCases.liveCohort({ schoolId, classIds: null });
  check("no seeded pupil is in the live intelligence cohort", studentIds.filter((id) => ids.includes(id)).length, 0);
  const pkg = await reviewCases.reviewPackage({ schoolId, classIds: null }, { userId: null, role: "school_admin" });
  check("no seeded pupil has a case on the review sheet", pkg.cases.filter((c) => ids.includes(String(c.studentId))).length, 0);
  const active = async (model) => M(model).countDocuments({ studentId: { $in: ids }, deletedAt: null });
  check("no active published result, score or term result belongs to a seeded pupil", [await M("ResultSummary").countDocuments({ studentId: { $in: ids }, deletedAt: null, isPublished: true }), await active("StudentScore"), await active("TermResult")], [0, 0, 0]);
  const reviews = await M("IntelligenceReview").find({ schoolId, studentId: { $in: ids } }).select("pilotKind").lean();
  check("any review about a seeded pupil is stamped synthetic or development, never real", reviews.filter((r) => !["synthetic", "development"].includes(r.pilotKind)).length, 0);
  const pre = await pilots.preflight({ schoolId, classIds: null });
  const remaining = await M("Student").countDocuments({ schoolId, deletedAt: null, status: "approved" });
  check("the preflight counts exactly the school's remaining active pupils", pre.counts.students, remaining);
  console.log(`       remaining active pupils ${remaining}; cases on the sheet ${pre.counts.cases}; published results ${pre.counts.published}; preflight ${pre.status}`);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err.message); process.exit(1); });
