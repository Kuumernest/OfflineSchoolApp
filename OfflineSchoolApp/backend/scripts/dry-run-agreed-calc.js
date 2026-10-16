// backend/scripts/dry-run-agreed-calc.js
"use strict";

/**
 * Dry run of the agreed calculation for one school (docs/40, step 1.7).
 *
 * Copies one school's academic records from a SOURCE database into a private
 * in-memory MongoDB, reprocesses that school's unpublished results for the
 * year with the code of this branch, and reports what would change. It never
 * writes to the source: the source is opened on its own connection and only
 * read with find(); no model is bound to it, so nothing can create an index
 * or a document there (check:dryrun proves the source is byte-identical
 * afterwards).
 *
 * What is reprocessed is exactly what the release reprocesses: every exam of
 * the year with no published result (published exams are refused, as on the
 * server), then every class's term and year, each refused where a published
 * row exists. Published rows are compared as unchanged.
 *
 * The report names no pupil: a pupil is "P-" plus 8 hex characters of
 * sha256(salt + id). Pass --salt to make the ids reproducible.
 *
 *   node scripts/dry-run-agreed-calc.js --uri <source URI> --school <schoolId> [--year 2026/2027] [--salt s] [--json]
 *
 * Needs the backend's devDependencies (mongodb-memory-server).
 */

const path   = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

/** The collections the calculation reads, by model, filtered to the school. */
const MODELS = ["School", "GradingConfig", "AcademicStructure", "Class", "Student", "Exam",
  "ExamSubject", "StudentScore", "ResultSummary", "TermResult", "AnnualResult"];

const round2 = (n) => Math.round(n * 100) / 100;

const dryRun = async ({ sourceUri, schoolId, year = null, salt = "" }) => {
  if (!sourceUri || !schoolId) throw new Error("dry run: --uri and --school are required");
  const { MongoMemoryServer } = require("mongodb-memory-server");

  // ── Read the source: its own connection, find() only ────────────────────
  const source = await mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 15000 }).asPromise();
  const mem = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  try {
    await mongoose.connect(mem.getUri());
    require("../src/db/models");
    const M = (n) => mongoose.model(n);

    const copied = {};
    for (const name of MODELS) {
      const coll = M(name).collection.collectionName;
      const filter = name === "School" ? { _id: schoolIdFilter(schoolId) } : { schoolId: String(schoolId) };
      const docs = await source.db.collection(coll).find(filter).toArray();
      copied[name] = docs.length;
      if (docs.length) await mongoose.connection.db.collection(coll).insertMany(docs, { ordered: true });
    }
    await source.close();
    if (!copied.School) throw new Error("dry run: no such school in the source");

    const school = await M("School").findOne({}).lean();
    const academicYear = year || school?.settings?.academicYear;
    if (!academicYear) throw new Error("dry run: no academic year (pass --year)");
    const pid = (id) => `P-${crypto.createHash("sha256").update(`${salt}${id}`).digest("hex").slice(0, 8)}`;

    // ── Before: as stored ─────────────────────────────────────────────────
    const { sequenceFigureOn20 } = require("../../shared/academicRules");
    const { legacyTermsOf } = require("../../shared/academicPolicy");
    const exams = await M("Exam").find({ schoolId: String(schoolId), academicYear, deletedAt: null, type: { $ne: "ca" } }).lean();
    const examIds = exams.map((e) => String(e._id));
    const snap = async () => ({
      seq: new Map((await M("ResultSummary").find({ schoolId: String(schoolId), examId: { $in: examIds }, deletedAt: null }).lean())
        .map((r) => [`${r.examId}|${r.studentId}`, { v: sequenceFigureOn20(r), pos: r.classPosition ?? null, pub: !!r.isPublished, sid: r.studentId, ref: r.examId }])),
      term: new Map((await M("TermResult").find({ schoolId: String(schoolId), academicYear, deletedAt: null }).lean())
        .map((r) => [`${r.term}|${r.classId}|${r.studentId}`, { v: r.termAverage, pos: r.classPosition ?? null, pub: !!r.isPublished, sid: r.studentId, ref: `term ${r.term}` }])),
      annual: new Map((await M("AnnualResult").find({ schoolId: String(schoolId), academicYear, deletedAt: null }).lean())
        .map((r) => [`${r.classId}|${r.studentId}`, { v: r.annualAverage, pos: r.classPosition ?? null, pub: !!r.isPublished, sid: r.studentId, ref: "year", status: r.promotionStatus ?? null }])),
    });
    const before = await snap();

    // ── Reprocess what the release would ──────────────────────────────────
    const { processExam } = require("../src/services/examProcess.service");
    const termGrading   = require("../src/services/termGrading.service");
    const annualGrading = require("../src/services/annualGrading.service");
    const counts = { examsProcessed: 0, examsRefusedPublished: 0, termsComputed: 0, termsRefusedPublished: 0, yearsComputed: 0, yearsRefusedPublished: 0 };
    for (const exam of exams) {
      const r = await processExam({ exam, schoolId: String(schoolId) });
      if (r.status === 200) counts.examsProcessed += 1; else if (r.status === 409) counts.examsRefusedPublished += 1;
    }
    const structure = await M("AcademicStructure").findOne({ schoolId: String(schoolId), academicYear, deletedAt: null }).lean();
    const termNumbers = [...new Set(legacyTermsOf(structure).map((t) => t.number))];
    const classes = await M("Class").find({ schoolId: String(schoolId), deletedAt: null }).select("_id").lean();
    for (const cls of classes) {
      for (const term of termNumbers) {
        try { await termGrading.computeClassTermAverages({ schoolId: String(schoolId), academicYear, term, classId: String(cls._id) }); counts.termsComputed += 1; }
        catch (err) { if (err.code === "PUBLISHED_RESULTS") counts.termsRefusedPublished += 1; else throw err; }
      }
      try { await annualGrading.computeClassAnnualAverages({ schoolId: String(schoolId), academicYear, classId: String(cls._id) }); counts.yearsComputed += 1; }
      catch (err) { if (err.code === "PUBLISHED_RESULTS") counts.yearsRefusedPublished += 1; else throw err; }
    }
    const after = await snap();

    // ── Compare ───────────────────────────────────────────────────────────
    const compare = (b, a) => {
      let changed = 0, created = 0, removed = 0, positionsChanged = 0, largest = null;
      for (const [k, x] of a) {
        const y = b.get(k);
        if (!y) { created += 1; continue; }
        if (y.v != null && x.v != null && Math.abs(x.v - y.v) >= 0.005) {
          changed += 1;
          const delta = round2(x.v - y.v);
          if (!largest || Math.abs(delta) > Math.abs(largest.delta)) largest = { pupil: pid(x.sid), of: x.ref, from: y.v, to: x.v, delta };
        }
        if ((y.pos ?? null) !== (x.pos ?? null)) positionsChanged += 1;
      }
      for (const k of b.keys()) if (!a.has(k)) removed += 1;
      return { compared: b.size, changed, created, removed, positionsChanged, largestChange: largest };
    };
    const promotion = [];
    for (const [k, x] of after.annual) {
      const y = before.annual.get(k);
      const from = y?.status ?? null, to = x.status ?? null;
      if (from !== to) promotion.push({ pupil: pid(x.sid), from, to });
    }
    promotion.sort((p, q) => (p.pupil < q.pupil ? -1 : 1));

    return {
      schoolId: String(schoolId),
      academicYear,
      copied,
      reprocessed: counts,
      sequence: compare(before.seq, after.seq),
      term: compare(before.term, after.term),
      annual: compare(before.annual, after.annual),
      promotionStatusChanges: promotion,
      notes: [
        "Sequence figures are compared on /20: a result stored before the change is read as its percentage / 5, as the new term calculation reads it.",
        "Published results are refused, as on the server, and appear unchanged.",
        "The promotion run proposes from published annual results; these are the annual rows' statuses, which the run follows once published.",
      ],
    };
  } finally {
    // Only this run's in-memory connection: mongoose.disconnect() would also
    // close any connection the caller holds.
    await mongoose.connection.close().catch(() => {});
    await source.close().catch(() => {});
    await mem.stop().catch(() => {});
  }
};

/** A school _id as the source stores it: an ObjectId when it looks like one. */
const schoolIdFilter = (id) => (mongoose.isValidObjectId(id) && String(id).length === 24
  ? { $in: [String(id), new mongoose.Types.ObjectId(String(id))] } : String(id));

const text = (r) => {
  const line = (label, c) => `${label}: ${c.changed} of ${c.compared} change, ${c.created} new, ${c.removed} removed, ` +
    `${c.positionsChanged} position(s) move` +
    (c.largestChange ? `; largest ${c.largestChange.delta > 0 ? "+" : ""}${c.largestChange.delta} (${c.largestChange.pupil}, ${c.largestChange.of}: ${c.largestChange.from} → ${c.largestChange.to})` : "");
  return [
    `Dry run — school ${r.schoolId}, ${r.academicYear}`,
    `Reprocessed: ${r.reprocessed.examsProcessed} exam(s) (${r.reprocessed.examsRefusedPublished} published, left), ` +
      `${r.reprocessed.termsComputed} class-term(s) (${r.reprocessed.termsRefusedPublished} published), ` +
      `${r.reprocessed.yearsComputed} class-year(s) (${r.reprocessed.yearsRefusedPublished} published)`,
    line("Sequence averages", r.sequence),
    line("Term averages", r.term),
    line("Annual averages", r.annual),
    `Promotion status changes: ${r.promotionStatusChanges.length}` +
      r.promotionStatusChanges.map((p) => `\n  ${p.pupil}: ${p.from} → ${p.to}`).join(""),
    ...r.notes.map((n) => `Note: ${n}`),
  ].join("\n");
};

module.exports = { dryRun, text };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
  // The services log their progress to stdout; send it to stderr so stdout
  // carries the report alone (and --json stays parseable).
  const print = console.log.bind(console);
  console.log = (...a) => console.error(...a);
  dryRun({ sourceUri: arg("uri"), schoolId: arg("school"), year: arg("year"), salt: arg("salt") ?? "" })
    .then((r) => { print(process.argv.includes("--json") ? JSON.stringify(r, null, 2) : text(r)); process.exit(0); })
    .catch((err) => { console.error(`dry run failed: ${err.message}`); process.exit(1); });
}
