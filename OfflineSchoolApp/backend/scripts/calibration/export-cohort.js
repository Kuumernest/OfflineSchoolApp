// backend/scripts/calibration/export-cohort.js
"use strict";

/**
 * Export one school's published results as an anonymised calibration cohort.
 *
 * ── Who runs this, and where ──────────────────────────────────────────────
 *
 * The school's operator, against a database they are entitled to read, on a
 * machine they control. It is deliberately NOT wired into any npm script and it
 * refuses to start without three things named explicitly:
 *
 *   MONGODB_URI        where the school's data is
 *   SCHOOL_ID          which school — one, never all
 *   CALIBRATION_SALT   a secret only the operator holds (see below)
 *
 *     MONGODB_URI=... SCHOOL_ID=... CALIBRATION_SALT=... \
 *       node scripts/calibration/export-cohort.js out/cohort.json
 *
 * ── What leaves the database ──────────────────────────────────────────────
 *
 * Marks, and the structure around them: which exam, which term, which
 * sequence, whether the pupil was absent or exempt, whether the row was
 * published. That is the whole of what shared/intelligence reads.
 *
 * What does not: names, enrolment numbers, contacts, guardians, users, money.
 * The projection below names every field it reads, and the output is run
 * through the same validator the analysis uses, which does a deep scan for
 * identifying keys and refuses to write the file on the first hit.
 *
 * ── How identity is removed ───────────────────────────────────────────────
 *
 * Every pupil id, class id, exam id and result id is replaced by an HMAC-SHA256
 * of the original under CALIBRATION_SALT, truncated. Two properties follow:
 *
 *   the same pupil gets the same opaque id everywhere in the file, so a
 *   history stays a history;
 *
 *   nobody without the salt can get back from the file to the database, and
 *   the salt never leaves the operator's machine.
 *
 * Subject NAMES are kept. "Mathematics" is not a person, and a review sheet
 * with subject codes on it is one a teacher cannot read.
 *
 * ── Read-only ─────────────────────────────────────────────────────────────
 *
 * Every query is a find() with a projection. Nothing is written, updated or
 * deleted, and the connection is closed on the way out whatever happened.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const { FORMAT, FORMAT_VERSION, validateCohort } = require("./cohortSchema");

const need = (name) => {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    console.error(`${name} is required. This exporter never guesses where a school's data is.`);
    process.exit(2);
  }
  return String(v).trim();
};

const main = async () => {
  const outFile = process.argv[2];
  if (!outFile) {
    console.error("usage: node scripts/calibration/export-cohort.js <out.json>");
    process.exit(2);
  }
  const uri      = need("MONGODB_URI");
  const schoolId = need("SCHOOL_ID");
  const salt     = need("CALIBRATION_SALT");
  if (salt.length < 16) {
    console.error("CALIBRATION_SALT must be at least 16 characters.");
    process.exit(2);
  }

  const mask = (kind, id) =>
    `${kind}_${crypto.createHmac("sha256", salt).update(`${kind}:${String(id)}`).digest("hex").slice(0, 16)}`;

  const mongoose = require("mongoose");
  await mongoose.connect(uri);

  try {
    require(path.join(__dirname, "..", "..", "src", "db", "models"));
    const Exam          = mongoose.model("Exam");
    const ResultSummary = mongoose.model("ResultSummary");
    const Student       = mongoose.model("Student");
    const GradingConfig = mongoose.model("GradingConfig");
    const Structure     = mongoose.model("AcademicStructure");
    const Intervention  = mongoose.models.Intervention ?? null;

    // Every field read is named. Nothing else can reach the file.
    const [exams, summaries, students, grading, structure] = await Promise.all([
      Exam.find({ schoolId, deletedAt: null })
        .select("_id type academicYear term sequenceNumber startDate parentExamId").lean(),
      ResultSummary.find({ schoolId, deletedAt: null })
        .select("_id examId studentId classId isPublished createdAt " +
                "subjectBreakdown.subjectId subjectBreakdown.subjectName " +
                "subjectBreakdown.normalizedMark subjectBreakdown.score subjectBreakdown.maxScore " +
                "subjectBreakdown.coefficient subjectBreakdown.isAbsent subjectBreakdown.isExempt").lean(),
      Student.find({ schoolId, status: "approved", deletedAt: null }).select("_id classId").lean(),
      GradingConfig.findOne({ schoolId }).select("passMark grades.grade grades.minMark grades.maxMark").lean(),
      Structure.findOne({ schoolId, deletedAt: null }).sort({ academicYear: -1 }).select("passMark").lean(),
    ]);
    const interventions = Intervention
      ? await Intervention.find({ schoolId, deletedAt: null })
          .select("_id studentId subjectId status createdAt startedAt").lean()
      : [];

    const cohort = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      provenance: {
        kind: "anonymised-real",
        note: "Exported by scripts/calibration/export-cohort.js. Identifiers are HMAC-SHA256 under an operator-held salt.",
      },
      grading: grading
        ? { passMark: grading.passMark, grades: (grading.grades ?? []).map((g) => ({ grade: g.grade, minMark: g.minMark, maxMark: g.maxMark })) }
        : null,
      academicStructure: structure ? { passMark: structure.passMark } : null,
      exams: exams.map((e) => ({
        examId:         mask("exam", e._id),
        type:           e.type,
        academicYear:   e.academicYear,
        term:           e.term,
        sequenceNumber: e.sequenceNumber ?? null,
        startDate:      e.startDate ?? null,
        parentExamId:   e.parentExamId ? mask("exam", e.parentExamId) : null,
      })),
      students: students.map((s) => ({
        studentId: mask("student", s._id),
        classId:   s.classId ? mask("class", s.classId) : null,
      })),
      results: summaries.map((r) => ({
        resultId:    mask("result", r._id),
        studentId:   mask("student", r.studentId),
        classId:     r.classId ? mask("class", r.classId) : null,
        examId:      mask("exam", r.examId),
        isPublished: r.isPublished === true,
        computedAt:  r.createdAt ? new Date(r.createdAt).toISOString() : null,
        subjects: (r.subjectBreakdown ?? []).map((s) => ({
          subjectId:      String(s.subjectId),
          subjectName:    s.subjectName ?? String(s.subjectId),
          normalizedMark: s.normalizedMark ?? null,
          // Preserved exactly: 0 and null are different facts.
          score:          s.score === undefined ? null : s.score,
          maxScore:       s.maxScore ?? 20,
          coefficient:    s.coefficient ?? 1,
          isAbsent:       s.isAbsent === true,
          isExempt:       s.isExempt === true,
        })),
      })),
      interventions: interventions.map((iv) => ({
        interventionId: mask("intervention", iv._id),
        studentId:      mask("student", iv.studentId),
        subjectId:      iv.subjectId ? String(iv.subjectId) : null,
        status:         iv.status,
        createdAt:      new Date(iv.createdAt).toISOString(),
        startedAt:      iv.startedAt ? new Date(iv.startedAt).toISOString() : null,
      })),
    };

    // The same validator the analysis runs. A file that would not analyse, or
    // that carries an identifying key, is not written at all.
    const verdict = validateCohort(cohort);
    if (!verdict.ok) {
      console.error("Refusing to write: the export does not validate.");
      for (const e of verdict.errors.slice(0, 20)) console.error("  -", e);
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(cohort, null, 2)}\n`);
    console.log(`wrote ${outFile}`);
    console.log(`  ${JSON.stringify(verdict.stats)}`);
    for (const w of verdict.warnings.slice(0, 10)) console.log("  warning:", w);
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => { console.error(err); process.exit(1); });
