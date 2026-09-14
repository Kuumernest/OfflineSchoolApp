// backend/src/services/sequenceAssessment.service.js
"use strict";

/**
 * A sequence is CA plus the paper. This is the seam.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 *   Sequence 1
 *     ├── Exam { type: "ca",   sequenceNumber: 1, parentExamId: <paper> }
 *     └── Exam { type: "test", sequenceNumber: 1 }              ← the paper
 *
 * Both are ordinary exams. They have ExamSubjects, StudentScores, submission
 * and approval, the mark-entry screens, the offline queue and the sync engine —
 * none of which needed to learn what continuous assessment is, which is the
 * entire reason CA is an exam type rather than a pair of extra columns.
 *
 * ── Which one is "the sequence" ───────────────────────────────────────────
 *
 * The paper. Its ResultSummary is the sequence result — the row the term
 * average reads, the row the sequence report card is printed from — and it now
 * carries the CA blended into it. The CA exam gets a summary of its own too,
 * because it is an exam and processing one must not be a special case, but
 * nothing downstream aggregates that summary: doing so would count CA twice.
 *
 * ── What this module refuses to do ────────────────────────────────────────
 *
 * Turn a missing CA into a zero. Everywhere below, "no CA" renormalises the
 * weights onto the paper alone. A school that has never used CA therefore gets
 * byte-identical results to the ones it had before this existed, with no
 * migration and no backfill.
 */

const Exam          = require("../db/models/Exam");
const ExamSubject   = require("../db/models/ExamSubject");
const StudentScore  = require("../db/models/StudentScore");
const GradingConfig = require("../db/models/GradingConfig");

const CA = require("../../../shared/caAssessment");

const { CA_TYPE } = CA;

// ── Settings ──────────────────────────────────────────────────────────────

/**
 * The CA settings a school is operating under.
 *
 * ── The only source of a CA/Test weight ───────────────────────────────────
 *
 * GradingConfig.caWeight and GradingConfig.testWeight are the authoritative
 * weights for every sequence CA/Test calculation, and this function is the one
 * way into them. Exam.weight is exam metadata for display and backward
 * compatibility; it does not override GradingConfig and nothing in the
 * calculation path reads it.
 *
 * Everything that weighs a sequence — processResults, the sequence report card,
 * the term and annual cards — takes its percentages from here and hands them to
 * shared/caAssessment.js. There is one combiner (combineSequenceMark) and one
 * source of its inputs, so a school's split cannot mean one thing on a report
 * card and another in the term average.
 *
 * A school with no grading config is not a school without CA — it is a school
 * that has never opened the settings screen — so the shipped defaults apply,
 * which is what every other grading default in this system does.
 *
 * @param {string} schoolId
 * @returns {Promise<{caEnabled: boolean, caWeight: number, testWeight: number}>}
 */
async function loadCaSettings(schoolId) {
  if (!schoolId) return CA.caSettings(null);
  const config = await GradingConfig.findOne({ schoolId: String(schoolId) })
    .select("caEnabled caWeight testWeight")
    .lean()
    .catch(() => null);
  return CA.caSettings(config);
}

// ── Pairing ───────────────────────────────────────────────────────────────

/** Is this exam the paper half of a sequence — the row a sequence card prints? */
const isSequencePaper = (exam) =>
  !!exam && exam.type !== CA_TYPE && exam.sequenceNumber != null;

/** Is this exam a continuous assessment? */
const isContinuousAssessment = (exam) => !!exam && exam.type === CA_TYPE;

/**
 * The continuous assessment belonging to a sequence paper, or null.
 *
 * parentExamId first, because it is exact. The fallback — same school, year,
 * term and sequence — exists for a CA exam created by hand or by an older
 * build, and is deliberately narrowed by class: two classes sitting Sequence 1
 * have two papers and two CAs, and attaching a mark to the wrong paper is
 * worse than showing no mark.
 *
 * @param {object} paper  a lean Exam
 * @returns {Promise<object|null>} a lean Exam
 */
async function findCaExam(paper) {
  if (!isSequencePaper(paper)) return null;

  const linked = await Exam.findOne({
    parentExamId: String(paper._id), type: CA_TYPE, deletedAt: null,
  }).lean();
  if (linked) return linked;

  const query = {
    schoolId:       paper.schoolId,
    academicYear:   paper.academicYear,
    term:           paper.term,
    sequenceNumber: paper.sequenceNumber,
    type:           CA_TYPE,
    deletedAt:      null,
  };
  // Only narrow by class when the paper names one; an exam sat by several
  // classes carries classIds instead, and its CA covers the same set.
  if (paper.classId) query.classId = paper.classId;

  return Exam.findOne(query).lean();
}

/**
 * Every exam of a term with its continuous assessments folded in.
 *
 * Term and annual averages combine per-subject marks across exams by weight.
 * Once a sequence has two exams, the sequence's own share has to be split
 * between them or CA is counted as a whole extra sequence. Splitting the share
 * — and letting the caller's renormalisation drop whichever part is missing —
 * gives exactly the same subject mark the sequence card shows.
 *
 * @param {Array<object>} exams        lean Exams, papers and CA alike
 * @param {(exam: object) => number} sequenceShareOf  the paper's weight
 * @param {{caEnabled, caWeight, testWeight}} settings
 * @returns {Map<string, number>} examId → weight
 */
function weightsWithCa(exams, sequenceShareOf, settings) {
  const papers = exams.filter((e) => !isContinuousAssessment(e));
  const cas    = exams.filter((e) =>  isContinuousAssessment(e));

  /** The paper a CA belongs to: by its link, else by term + sequence. */
  const paperFor = (ca) => {
    if (ca.parentExamId) {
      const linked = papers.find((p) => String(p._id) === String(ca.parentExamId));
      if (linked) return linked;
    }
    return papers.find(
      (p) => p.sequenceNumber === ca.sequenceNumber &&
             String(p.term) === String(ca.term)
    ) || null;
  };

  const shareOf = (exam) => Number(sequenceShareOf(exam)) || 0;

  const weights = new Map();
  /** paper id → the CA sitting beside it, when there is one. */
  const caOfPaper = new Map();

  for (const ca of cas) {
    const paper = paperFor(ca);
    if (paper) caOfPaper.set(String(paper._id), ca);

    // CA off: the mark is kept and not counted. Zero rather than omitted, so
    // it is still there to read back when a school turns CA on again.
    const weight = !settings.caEnabled || !paper
      ? 0
      : shareOf(paper) * (settings.caWeight / 100);
    weights.set(String(ca._id), weight);
  }

  for (const paper of papers) {
    const share = shareOf(paper);
    // A paper with no CA beside it, or a school with CA off, keeps the whole
    // share — which is the arithmetic this system had before CA existed.
    const splits = settings.caEnabled && caOfPaper.has(String(paper._id));
    weights.set(String(paper._id), splits ? share * (settings.testWeight / 100) : share);
  }

  return weights;
}

// ── Blending ──────────────────────────────────────────────────────────────

/** studentId|subjectId → the score row. */
const scoreKey = (studentId, subjectId) => `${String(studentId)}|${String(subjectId)}`;

/**
 * A sequence's CA marks, indexed for blending, plus the maxima to read them
 * against.
 *
 * @param {object|null} caExam  a lean CA Exam, or null
 * @param {string|null} classId restrict to one class, as processResults does
 * @returns {Promise<Map<string, {score, maxScore, isAbsent, isExempt}>>}
 */
async function caScoresFor(caExam, classId = null) {
  if (!caExam) return new Map();

  const scoreFilter = { examId: String(caExam._id), deletedAt: null };
  if (classId) scoreFilter.classId = classId;

  const [scores, subjects] = await Promise.all([
    StudentScore.find(scoreFilter)
      .select("studentId subjectId examSubjectId classId score maxScore isAbsent isExempt")
      .lean(),
    ExamSubject.find({ examId: String(caExam._id), deletedAt: null })
      .select("_id subjectId maxScore")
      .lean(),
  ]);

  const maxById      = new Map(subjects.map((es) => [String(es._id), es.maxScore]));
  const maxBySubject = new Map(subjects.map((es) => [String(es.subjectId), es.maxScore]));

  const byKey = new Map();
  for (const row of scores) {
    // The subject's own ceiling wins over the score row's, for the same reason
    // the sequence card prefers it: a row written before the subject inherited
    // the exam's totals says 100 in a school that marks out of 20.
    const max =
      maxById.get(String(row.examSubjectId)) ??
      maxBySubject.get(String(row.subjectId)) ??
      row.maxScore ?? caExam.totalMarks ?? 20;

    byKey.set(scoreKey(row.studentId, row.subjectId), {
      score:    row.score,
      maxScore: max,
      classId:  row.classId ?? null,
      isAbsent: row.isAbsent || false,
      isExempt: row.isExempt || false,
    });
  }
  return byKey;
}

/**
 * Everything the sequence result needs about CA, fetched once per exam rather
 * than once per pupil.
 *
 * @param {object} exam      the exam being processed (lean or hydrated)
 * @param {string|null} classId
 * @returns {Promise<{
 *   settings: object, caExam: object|null, caByKey: Map,
 *   active: boolean, lookup: (studentId, subjectId) => object|null,
 * }>}
 */
async function loadSequenceContext(exam, classId = null) {
  const settings = await loadCaSettings(exam?.schoolId);

  // CA off, or this is not a sequence paper: nothing to blend, and `active`
  // false means every caller below is a no-op that returns the paper's own
  // mark untouched.
  if (!settings.caEnabled || !isSequencePaper(exam)) {
    return {
      settings, caExam: null, caByKey: new Map(), active: false,
      lookup: () => null,
    };
  }

  const caExam  = await findCaExam(exam);
  const caByKey = await caScoresFor(caExam, classId);

  return {
    settings,
    caExam,
    caByKey,
    active: !!caExam,
    lookup: (studentId, subjectId) =>
      caByKey.get(scoreKey(studentId, subjectId)) || null,
  };
}

/**
 * One subject's sequence mark, and the record of what it was made of.
 *
 * The returned `score` is on the PAPER's scale, not /20, because everything
 * downstream — gradeSubject, the breakdown, the card's "14 / 20" cell — is
 * written against a score and its maximum. Blending as fractions and
 * projecting back keeps a school that marks CA out of 20 and the paper out of
 * 100 correct without anybody having to think about it.
 *
 * @param {object} p
 * @param {object|null} p.ca    the CA part, or null when none was recorded
 * @param {object}      p.test  the paper part {score, maxScore, isAbsent, isExempt}
 * @param {{caWeight, testWeight}} p.settings
 * @returns {{
 *   score: number|null, maxScore: number,
 *   caScore, caMaxScore, caMark, testScore, testMaxScore, testMark,
 *   caWeight, testWeight, hasCa: boolean,
 * }}
 */
function blendSubject({ ca, test, settings }) {
  const maxScore = Number(test?.maxScore) > 0 ? Number(test.maxScore) : 20;

  const combined = CA.combineSequenceMark({
    ca,
    test,
    caWeight:   settings.caWeight,
    testWeight: settings.testWeight,
  });

  return {
    // null, not 0 — a pupil with neither mark has no sequence mark, and the
    // caller keeps its own absent/exempt handling for what that means.
    score: combined.fraction == null
      ? null
      : Math.round(combined.fraction * maxScore * 100) / 100,
    maxScore,
    caScore:      combined.hasCa  ? Number(ca.score)   : null,
    caMaxScore:   combined.hasCa  ? Number(ca.maxScore) : null,
    caMark:       combined.caMark20,
    testScore:    combined.hasTest ? Number(test.score)    : null,
    testMaxScore: combined.hasTest ? Number(test.maxScore) : null,
    testMark:     combined.testMark20,
    caWeight:     combined.appliedCaWeight,
    testWeight:   combined.appliedTestWeight,
    hasCa:        combined.hasCa,
  };
}

// ── Creating the CA half ──────────────────────────────────────────────────

/**
 * Give a sequence paper its continuous assessment.
 *
 * Called when a sequence exam is created and CA is on, so that "CA is an
 * assessment type under every sequence" is true of the data rather than of a
 * screen. Idempotent: a paper that already has one keeps it, which is what
 * makes this safe on a replayed offline create.
 *
 * The subjects are mirrored from the paper — same subjects, same teachers,
 * same coefficients — because a CA sheet listing different subjects from the
 * paper beside it is not a sequence, it is two exams.
 *
 * @param {object} p
 * @param {object} p.paper     the created Exam (lean or hydrated)
 * @param {object} [p.settings] resolved CA settings; loaded if omitted
 * @param {string} [p.userId]
 * @param {string} [p.caExamId] an id the client chose, for an offline create
 * @param {string} [p.name]     a name for the CA exam
 * @returns {Promise<{exam: object|null, subjects: Array, created: boolean}>}
 */
async function ensureCaExam({ paper, settings = null, userId = null, caExamId = null, name = null }) {
  if (!isSequencePaper(paper)) return { exam: null, subjects: [], created: false };

  const cfg = settings || await loadCaSettings(paper.schoolId);
  if (!cfg.caEnabled) return { exam: null, subjects: [], created: false };

  const existing = await findCaExam(paper);
  if (existing) {
    const subjects = await ExamSubject.find({
      examId: String(existing._id), deletedAt: null,
    }).lean();
    return { exam: existing, subjects, created: false };
  }

  const { v4: uuidv4 } = require("uuid");
  const examId = caExamId || uuidv4();

  const caExam = await Exam.create({
    _id:          examId,
    schoolId:     paper.schoolId,
    classId:      paper.classId   ?? null,
    className:    paper.className ?? null,
    classIds:     paper.classIds  ?? [],
    classNames:   paper.classNames ?? null,
    name:         name || `${paper.name} — CA`,
    type:         CA_TYPE,
    parentExamId: String(paper._id),
    sequenceNumber: paper.sequenceNumber,
    academicYear: paper.academicYear,
    term:         paper.term,
    startDate:    paper.startDate ?? null,
    endDate:      paper.endDate   ?? null,
    // The paper's own totals. A CA marked out of 100 in a school that grades
    // out of 20 is the same bug the sequence subjects already had.
    totalMarks:   paper.totalMarks ?? 20,
    passMark:     paper.passMark   ?? 10,
    /*
     * Exam.weight is deliberately NOT set to the school's CA percentage.
     *
     * It was, briefly. A CA exam carrying `weight: 40` reads as though 40 were
     * this exam's own share of the sequence — and the next administrator to
     * change the school split to 30/70 would leave every CA exam ever created
     * still saying 40, with nothing to say which number graded which report
     * card. A stale copy of an authoritative value is worse than no copy.
     *
     * The field keeps its schema default. The split is read from
     * GradingConfig, once, through loadCaSettings().
     */
    status:       paper.status === "archived" ? "draft" : (paper.status || "draft"),
    createdBy:    userId || null,
  });

  const paperSubjects = await ExamSubject.find({
    examId: String(paper._id), deletedAt: null,
  }).lean();

  const subjects = [];
  for (const es of paperSubjects) {
    subjects.push(await ExamSubject.create({
      _id:              uuidv4(),
      examId:           caExam._id,
      subjectId:        es.subjectId,
      classId:          es.classId,
      schoolId:         es.schoolId,
      teacherId:        es.teacherId   ?? null,
      subjectName:      es.subjectName ?? null,
      teacherName:      es.teacherName ?? null,
      maxScore:         es.maxScore    ?? paper.totalMarks ?? 20,
      passMark:         es.passMark    ?? paper.passMark   ?? 10,
      // The subject's coefficient, which belongs to the subject and not to the
      // paper: Mathematics counts four times in CA as well.
      weight:           es.weight      ?? 100,
      isPractical:      es.isPractical ?? false,
      isTheory:         es.isTheory    ?? true,
      isOral:           es.isOral      ?? false,
      submissionStatus: "pending",
    }));
  }

  return { exam: caExam.toObject(), subjects, created: true };
}

/**
 * Mirror a subject added to a sequence paper onto its CA, if it has one.
 *
 * A subject attached to the paper after the CA was created would otherwise be
 * markable in one half of the sequence and not the other.
 */
async function mirrorSubjectToCa(paper, examSubject) {
  const caExam = await findCaExam(paper);
  if (!caExam) return null;

  const already = await ExamSubject.findOne({
    examId: String(caExam._id), subjectId: examSubject.subjectId,
    classId: examSubject.classId, deletedAt: null,
  }).lean();
  if (already) return already;

  const { v4: uuidv4 } = require("uuid");
  return ExamSubject.create({
    _id:              uuidv4(),
    examId:           caExam._id,
    subjectId:        examSubject.subjectId,
    classId:          examSubject.classId,
    schoolId:         examSubject.schoolId,
    teacherId:        examSubject.teacherId   ?? null,
    subjectName:      examSubject.subjectName ?? null,
    teacherName:      examSubject.teacherName ?? null,
    maxScore:         examSubject.maxScore    ?? caExam.totalMarks ?? 20,
    passMark:         examSubject.passMark    ?? caExam.passMark   ?? 10,
    weight:           examSubject.weight      ?? 100,
    isPractical:      examSubject.isPractical ?? false,
    isTheory:         examSubject.isTheory    ?? true,
    isOral:           examSubject.isOral      ?? false,
    submissionStatus: "pending",
  });
}

module.exports = {
  CA_TYPE,
  loadCaSettings,
  isSequencePaper,
  isContinuousAssessment,
  findCaExam,
  caScoresFor,
  loadSequenceContext,
  blendSubject,
  weightsWithCa,
  ensureCaExam,
  mirrorSubjectToCa,
  scoreKey,
  // Re-exported so a caller holding this service does not need the shared
  // module as well for the two things it will certainly want.
  caSettings:       CA.caSettings,
  validateCaWeights: CA.validateCaWeights,
};
