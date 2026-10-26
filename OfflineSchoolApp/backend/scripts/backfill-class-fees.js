// backend/scripts/backfill-class-fees.js
"use strict";

/**
 * Raise the class fees that students missed.
 *
 * Until fees.service applyActiveStructuresForStudent was called from every
 * path that puts a student into a class, students who were approved through
 * /students/:id/approve, restored, or enrolled by an outbox replay of a
 * request that had failed half way were never billed for their class's
 * structures. This finds them and, with --apply, bills them by the same rule
 * the routes now follow:
 *
 *   - the school's CURRENT academic year (School.settings.academicYear) only;
 *     a school with none set is reported and left alone;
 *   - approved, not-deleted students with a class;
 *   - every active structure naming their class, or school-wide;
 *   - non-optional items, full amounts (reductions are waivers).
 *
 * A charge that exists for that student, structure, item and term — even a
 * voided one — counts as decided and is never raised again. That is the same
 * unique index applyStructure relies on, so running this twice, or after the
 * office has pressed Apply, raises nothing twice.
 *
 * Also REPORTED, never changed: students still carrying live charges from a
 * class structure for the current year that does not cover the class they are
 * in now (a transfer from before transfers voided the old class's fees). Those
 * are for the bursar to look at; the script does not void anything.
 *
 *   node scripts/backfill-class-fees.js                       # dry run, every school
 *   node scripts/backfill-class-fees.js --school <id>[,<id>]  # dry run, these schools
 *   node scripts/backfill-class-fees.js --school <id> --apply # write
 */

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY   = process.argv.includes("--apply");
const argAt   = process.argv.indexOf("--school");
const SCHOOLS = argAt > 0 ? String(process.argv[argAt + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : null;

const xaf = (n) => `${Number(n).toLocaleString("en-US")} XAF`;

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error("Set MONGODB_URI (or MONGO_URI) to the database to check."); process.exit(2); }
  await mongoose.connect(uri);

  const School       = require("../src/db/models/School");
  const Class        = require("../src/db/models/Class");
  const Student      = require("../src/db/models/Student");
  const FeeCharge    = require("../src/db/models/FeeCharge");
  const FeeStructure = require("../src/db/models/FeeStructure");
  const { applyStructure } = require("../src/services/fees.service");
  const { yearKey, yearForms } = require("../src/services/rankingScope.service");

  const schools = await School.find(SCHOOLS ? { _id: { $in: SCHOOLS } } : {})
    .select("name settings.academicYear").lean();
  if (!schools.length) { console.log("No schools match."); await mongoose.disconnect(); return; }

  let grandStudents = 0, grandCharges = 0, grandAmount = 0, grandRaised = 0;

  for (const school of schools) {
    const schoolId = String(school._id);
    const year     = yearKey(school.settings?.academicYear);
    console.log(`\n══ ${school.name ?? schoolId} (${schoolId})`);
    if (!year) { console.log("   no current academic year set — skipped (set it in the school's settings)"); continue; }
    console.log(`   current year ${year}`);

    const structures = await FeeStructure.find({
      schoolId, academicYear: { $in: yearForms(year) }, isActive: true, deletedAt: null,
    }).lean();
    if (!structures.length) { console.log("   no active fee structures for this year — nothing to raise"); continue; }

    const students = await Student.find({
      schoolId, status: "approved", deletedAt: null, classId: { $nin: [null, ""] },
    }).select("_id classId studentName firstName lastName").lean();
    const classes  = new Map((await Class.find({ schoolId }).select("_id name section").lean())
      .map((c) => [String(c._id), [c.name, c.section].filter(Boolean).join(" ")]));

    const existing = await FeeCharge.find({
      schoolId, studentId: { $in: students.map((s) => String(s._id)) },
      structureId: { $in: structures.map((s) => String(s._id)) },
    }).select("studentId structureId code term voidedAt").lean();
    const has = new Map(existing.map((c) => [`${c.studentId}|${c.structureId}|${c.code}|${c.term ?? ""}`, c]));

    // structureId → students to raise it for
    const toRaise = new Map();
    let schoolStudents = 0, schoolCharges = 0, schoolAmount = 0, blocked = 0;

    for (const st of students) {
      const sid   = String(st._id);
      const cid   = String(st.classId);
      const name  = st.studentName || [st.firstName, st.lastName].filter(Boolean).join(" ") || sid;
      const lines = [];
      for (const structure of structures) {
        const covers = !(structure.classIds ?? []).length || structure.classIds.includes(cid);
        if (!covers) continue;
        const missing = [];
        for (const it of structure.items) {
          if (it.isOptional) continue;
          const found = has.get(`${sid}|${structure._id}|${it.code}|${structure.term ?? ""}`);
          if (found?.voidedAt) { blocked++; continue; }
          if (!found) missing.push(it);
        }
        if (!missing.length) continue;
        const amount = missing.reduce((n, it) => n + it.amount, 0);
        lines.push(`${structure.term ?? "year"} · ${missing.map((it) => `${it.code} ${xaf(it.amount)}`).join(", ")}`);
        schoolCharges += missing.length;
        schoolAmount  += amount;
        if (!toRaise.has(String(structure._id))) toRaise.set(String(structure._id), { structure, students: [] });
        toRaise.get(String(structure._id)).students.push({ _id: sid, classId: cid });
      }
      if (lines.length) {
        schoolStudents++;
        console.log(`   - ${name} (${classes.get(cid) ?? cid}): ${lines.join(" | ")}`);
      }
    }

    console.log(`   missing: ${schoolStudents} student(s), ${schoolCharges} charge(s), ${xaf(schoolAmount)}`);
    if (blocked) console.log(`   ${blocked} item(s) not raised because a voided charge for them exists (voided on purpose, or a student who left the class and came back)`);

    // Report only: live charges from another class's structure this year.
    const otherClass = await FeeStructure.find({
      schoolId, academicYear: { $in: yearForms(year) }, deletedAt: null, "classIds.0": { $exists: true },
    }).select("_id classIds").lean();
    const covering = new Map(otherClass.map((s) => [String(s._id), s.classIds]));
    const live = await FeeCharge.find({
      schoolId, studentId: { $in: students.map((s) => String(s._id)) },
      structureId: { $in: [...covering.keys()] }, voidedAt: null, deletedAt: null, code: { $ne: "LATE" },
    }).select("studentId structureId amount").lean();
    const classOf = new Map(students.map((s) => [String(s._id), String(s.classId)]));
    const strays  = live.filter((c) => !covering.get(c.structureId).includes(classOf.get(c.studentId)));
    if (strays.length) {
      const who = new Set(strays.map((c) => c.studentId));
      console.log(`   REVIEW: ${who.size} student(s) still owe ${xaf(strays.reduce((n, c) => n + c.amount, 0))} from another class's structure (not changed by this script)`);
      const nameOf = new Map(students.map((s) => [String(s._id), s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" ") || String(s._id)]));
      for (const sid of who) {
        const owed = strays.filter((c) => c.studentId === sid).reduce((n, c) => n + c.amount, 0);
        console.log(`     · ${nameOf.get(sid)} (now in ${classes.get(classOf.get(sid)) ?? classOf.get(sid)}): ${xaf(owed)}`);
      }
    }

    if (APPLY && toRaise.size) {
      let raised = 0;
      for (const { structure, students: list } of toRaise.values()) {
        const r = await applyStructure({ structure, students: list, raisedBy: "backfill-class-fees" });
        raised += r.raised;
      }
      console.log(`   APPLIED: ${raised} charge(s) raised`);
      grandRaised += raised;
    }

    grandStudents += schoolStudents; grandCharges += schoolCharges; grandAmount += schoolAmount;
  }

  console.log(`\nTotal missing: ${grandStudents} student(s), ${grandCharges} charge(s), ${xaf(grandAmount)}`);
  if (APPLY) console.log(`Raised: ${grandRaised} charge(s).`);
  else       console.log("DRY RUN — nothing written. Re-run with --apply to raise these charges.");
  await mongoose.disconnect();
  // Explicit: the services this loads keep timers (school context cache) that
  // would otherwise hold the process open after the work is done.
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
