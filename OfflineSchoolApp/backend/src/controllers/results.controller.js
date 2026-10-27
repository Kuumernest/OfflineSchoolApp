// backend/src/controllers/results.controller.js
"use strict";

const { v4: uuidv4 }  = require("uuid");
const StudentScore    = require("../db/models/StudentScore");
const ResultSummary   = require("../db/models/ResultSummary");
const Exam            = require("../db/models/Exam");
const ExamSubject     = require("../db/models/ExamSubject");
const GradingConfig   = require("../db/models/GradingConfig");
const { processExam } = require("../services/examProcess.service");
const GeneratedReport = require("../db/models/GeneratedReport");
const ResultChangeLog = require("../db/models/ResultChangeLog");
const {
  guardResultWrite,
  logResultChange,
  diffField,
} = require("../services/resultAudit.service");
const Student = require("../db/models/Student");
const Class   = require("../db/models/Class");
const AcademicStructure = require("../db/models/AcademicStructure");
const TeacherAssignment = require("../db/models/TeacherAssignment");
const Subject           = require("../db/models/Subject");
const { teacherAssigned } = require("../utils/teacherScope");
const { renderReportCardHtml, renderReportCard } =
  require("../services/reportHtml.service");
const resultsService = require("../services/results.service");
const { getRankings } = resultsService;
const { lookupGrade } = require("../services/grading.service");
// The §5/§7/§8 rules, shared with the term and annual cards and covered by
// scripts/check-report-card.js.
const { reportTypeFor, subjectRanking, periodName } =
  require("../../../shared/reportCard");
const { legacyTermsOf } = require("../../../shared/academicPolicy");
const { sequenceAverageIsOn20 } = require("../../../shared/academicRules");
// The CA half of a sequence. A sequence card shows both assessments and the
// mark they combine to; the pairing and the arithmetic are shared with the
// grading engine so the card cannot print a different number from the one the
// term average was computed from.
const sequenceAssessment = require("../services/sequenceAssessment.service");

// ─────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided)
    return String(provided).trim();
  return req.user?.schoolId;
};

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const isAdmin = (role) =>
  ["super_admin", "school_admin", "admin"].includes(role);

/**
 * The exam this request is about, IN THE CALLER'S SCHOOL.
 *
 * Every per-student read and write in this controller used to start from
 * Exam.findById(examId) or from a { examId, studentId } filter with no school
 * in it, so a results.view holder in one school who knew an exam and pupil id
 * from another read that pupil's marks, positions and report card — and the
 * write routes minted rows into the other school's pipeline. The exam is the
 * anchor: it is loaded scoped, and its school is the scope for everything
 * that follows.
 *
 * A super_admin who named no school is the one caller allowed to look across
 * schools (docs/20 Info-A); for them the exam's own school becomes the scope,
 * so the sub-queries still stay within one school.
 *
 * @returns {Promise<{exam: object, schoolId: string}|null>} null = not this school's
 */
const loadScopedExam = async (req, examId, provided, select = null) => {
  const schoolId = req ? resolveSchoolId(req, provided) : null;
  const q = Exam.findOne({ _id: String(examId ?? ""), ...(schoolId ? { schoolId } : {}) });
  if (select) q.select(select);
  const exam = await q.lean();
  if (!exam) return null;
  return { exam, schoolId: schoolId ? String(schoolId) : String(exam.schoolId) };
};

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId
// ─────────────────────────────────────────────────────────

const getExamResults = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const {
    schoolId: qSchoolId,
    classId,
    isPublished,
    page  = 1,
    limit = 50,
  } = req.query;

  const schoolId = resolveSchoolId(req, qSchoolId);
  const filter   = { examId, deletedAt: null };

  if (schoolId) filter.schoolId = schoolId;
  if (classId)  filter.classId  = classId;

  if (!isAdmin(req.user?.role)) {
    filter.isPublished = true;
  } else if (isPublished !== undefined) {
    filter.isPublished = isPublished === "true";
  }

  const skip    = (Number(page) - 1) * Number(limit); if (!(skip >= 0) || !(Number(limit) >= 1)) return res.status(400).json({ success: false, message: "page and limit must be positive integers" });
  const total   = await ResultSummary.countDocuments(filter);
  const results = await ResultSummary.find(filter)
    .sort({ classPosition: 1 })
    .skip(skip)
    .limit(Number(limit))
    .lean();

  // Backfill studentName / admissionNo / className for old results that were
  // processed before the fields were denormalised. enrollmentNo is the single
  // source of truth; admissionNo only survives as a legacy fallback.
  const missing = results.filter((r) => (!r.studentName || !r.className) && r.studentId);
  if (missing.length > 0 && schoolId) {
    const Student = require("../db/models/Student");
    const ids = [...new Set(missing.map((r) => r.studentId))];
    const [students, classes] = await Promise.all([
      Student.find({ _id: { $in: ids }, schoolId })
        .select("_id studentName firstName lastName enrollmentNo admissionNo classId")
        .lean(),
      Class.find({ schoolId }).select("_id name").lean(),
    ]);
    const sMap = new Map(students.map((s) => [String(s._id), s]));
    const cMap = new Map(classes.map((c) => [String(c._id), c.name]));
    const bulkOps = [];
    for (const r of missing) {
      const s = sMap.get(String(r.studentId));
      if (!s) continue;
      const name    = s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" ") || null;
      const admNo   = s.enrollmentNo || s.admissionNo || null;
      const clsName = cMap.get(String(s.classId)) || null;
      if (!r.studentName) r.studentName = name;
      if (!r.admissionNo) r.admissionNo = admNo;
      if (!r.className)   r.className   = clsName;
      const $set = {};
      if (name)    $set.studentName = name;
      if (admNo)   $set.admissionNo = admNo;
      if (clsName) $set.className   = clsName;
      bulkOps.push({ updateOne: { filter: { _id: r._id }, update: { $set } } });
    }
    if (bulkOps.length > 0) {
      await ResultSummary.bulkWrite(bulkOps).catch(() => {});
    }
  }

  return res.json({
    success: true,
    count:   results.length,
    total,
    page:    Number(page),
    pages:   Math.ceil(total / Number(limit)),
    data:    results,
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/stats
// ─────────────────────────────────────────────────────────

const getExamStats = asyncHandler(async (req, res) => {
  const { examId }  = req.params;
  const { classId, schoolId: qSchoolId } = req.query;

  // The arithmetic lives in services/classStats.service.js, where the report
  // card reads it too. It moved there unchanged: same filter, same percentage
  // scale, same zeroes on an empty class, same subject breakdown.
  const data = await classStats.examStatistics({
    schoolId: resolveSchoolId(req, qSchoolId),
    examId,
    classId,
    onlyPublished: !isAdmin(req.user?.role),
  });

  return res.json({ success: true, data });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/rankings
// ─────────────────────────────────────────────────────────

const getExamRankings = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const {
    rankBy = "class",
    classId,
    limit  = 100,
  } = req.query;

  const scope = ["class", "grade", "school"].includes(rankBy)
    ? rankBy : "class";

  // Tenancy: a ranking is one school's table. The service filtered on examId
  // alone, so a foreign examId answered another school's positions, names and
  // admission numbers.
  const scoped = await loadScopedExam(req, examId, req.query.schoolId, "_id schoolId");
  if (!scoped) {
    return res.status(404).json({ success: false, error: "Exam not found" });
  }

  let rankings = await getRankings(examId, scope, classId || null, scoped.schoolId, { onlyPublished: !isAdmin(req.user?.role), limit: Number(limit) });
  rankings     = rankings.slice(0, Number(limit));

  // Each pupil's average on /20, the school's remark and pass/fail — what
  // the analytics tables print instead of a percentage, a letter and a GPA.
  rankings = await classStats.withAverage20(rankings, scoped.schoolId);

  return res.json({
    success: true,
    rankBy:  scope,
    count:   rankings.length,
    data:    rankings,
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId
// ─────────────────────────────────────────────────────────

const getStudentResult = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;

  // ✅ Phase 0 repoint: this route used to read ExamResult/ExamScore — models
  //    the processing pipeline no longer writes (processResults lands data in
  //    ResultSummary / StudentScore). Consumers got an empty summary and the
  //    web batch print silently fell back to blank marks. Response shape is
  //    unchanged: { summary, scores }.
  // Tenancy: the exam anchors the read. Without it a results.view holder in
  // one school read another school's pupil by (examId, studentId).
  const scoped = await loadScopedExam(req, examId, req.query.schoolId, "_id schoolId");
  if (!scoped) {
    return res.status(404).json({
      success: false,
      error:   "No result found for this student in this exam",
    });
  }
  const { schoolId } = scoped;

  const [summary, scores] = await Promise.all([
    ResultSummary.findOne({ examId, studentId, schoolId, deletedAt: null }).lean(),
    StudentScore.find({ examId, studentId, schoolId, deletedAt: null }).lean(),
  ]);

  // Published or not there, for anyone who is not an administrator — the rule
  // GET /results/:examId applies one route up, applied to the single pupil too.
  if (!isAdmin(req.user?.role) && !summary?.isPublished) {
    return res.status(404).json({
      success: false,
      error:   "No result found for this student in this exam",
    });
  }

  if (!summary && !scores.length) {
    return res.status(404).json({
      success: false,
      error:   "No result found for this student in this exam",
    });
  }

  // Backfill studentName if missing
  if (summary && !summary.studentName && summary.studentId) {
    const Student = require("../db/models/Student");
    const stu = await Student.findOne({ _id: summary.studentId, schoolId: summary.schoolId })
      .select("_id studentName firstName lastName admissionNo")
      .lean();
    if (stu) {
      const name = stu.studentName || [stu.firstName, stu.lastName].filter(Boolean).join(" ") || null;
      summary.studentName = name;
      summary.admissionNo = stu.admissionNo || null;
      await ResultSummary.updateOne(
        { _id: summary._id },
        { $set: { studentName: name, admissionNo: stu.admissionNo || null } }
      ).catch(() => {});
    }
  }

  return res.json({
    success: true,
    data:    { summary: summary ?? null, scores },
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId/reportcard
// ─────────────────────────────────────────────────────────

// Shared payload builder — used by the JSON endpoint and the HTML renderer
// endpoint (Phase 2 single-engine consolidation). Returns
// { ok: true, data } or { ok: false }.
/**
 * @param {object} [req]  only to make the pupil's photo URL absolute — the
 *   card is printed into an about:blank window, so a served path has no origin
 *   to resolve against. Optional: a caller without a request gets the stored
 *   relative path, which is still correct data.
 */
/**
 * The filter that selects every row sharing a ranking key with these scores:
 * their examSubjectIds, and — for any row of theirs without one — their
 * subjectIds, which is the key subjectRanking falls back to. A pupil with no
 * scores matches nothing, as nothing could place them.
 */
const cohortKeysFor = (pupilScores) => {
  const es = [...new Set(pupilScores.map((s) => s.examSubjectId).filter((x) => x != null).map(String))];
  const su = [...new Set(pupilScores.filter((s) => s.examSubjectId == null && s.subjectId != null).map((s) => String(s.subjectId)))];
  const or = [];
  if (es.length) or.push({ examSubjectId: { $in: es } });
  if (su.length) or.push({ subjectId: { $in: su } });
  return or.length ? { $or: or } : { _id: { $in: [] } };
};

const buildStudentReportCardData = async (examId, studentId, req) => {
  // ✅ Phase 0 repoint: reads the LIVE pipeline collections (StudentScore +
  //    ResultSummary, written by processResults) instead of ExamResult/ExamScore.
  //    Payload shape is unchanged — the mobile ReportCard (admin + student
  //    views), the web batch print and the shared HTML renderer consume it.
  // Tenancy: the exam is loaded in the caller's school first, and its school
  // scopes every read below. The card, the verification code it mints and the
  // archive it writes are therefore always this school's — a foreign examId
  // used to build another school's card, mint a public code for that pupil
  // and freeze the card into THIS school's GeneratedReports.
  const scoped = await loadScopedExam(req, examId, req?.query?.schoolId ?? req?.body?.schoolId);
  if (!scoped) return { ok: false };
  const { exam, schoolId } = scoped;

  const [scores, examSubjects, summary] = await Promise.all([
    // Sorted, because the card's subject rows follow this order. Unsorted,
    // the order was whichever index the planner picked — {examId, studentId,
    // subjectId} gives subject order, {schoolId, studentId} does not — so the
    // same card could list its subjects differently from one print to the next
    // (seen as an intermittent check:academic failure). subjectId order is
    // what the unique index usually gave.
    StudentScore.find({ examId, studentId, schoolId, deletedAt: null }).sort({ subjectId: 1 }).lean(),
    ExamSubject.find({ examId, schoolId, deletedAt: null }).lean(),
    ResultSummary.findOne({ examId, studentId, schoolId, deletedAt: null }).lean(),
  ]);

  // A card is a published result, printed. Anyone who is not an administrator
  // gets no card for a result the school has not published.
  if (req?.user && !isAdmin(req.user.role) && !summary?.isPublished) return { ok: false };

  /*
   * The continuous assessment beside this paper.
   *
   * Inactive — and every lookup below null — for a school with CA off, for a
   * card that is not a sequence card, and for a sequence with no CA exam,
   * which is every report card this system printed before CA existed. Those
   * cards come out byte-identical.
   */
  const ca = await sequenceAssessment.loadSequenceContext(exam);

  if (!summary && !scores.length && ca.caByKey.size === 0) return { ok: false };

  /*
   * The form master, from the class this card belongs to.
   *
   * Read off the class rather than through the teacher's account, because the
   * class stores the name denormalised: a teacher who leaves has their User
   * row deactivated, and a card reprinted afterwards must still name whoever
   * signed it.
   */
  const cardClassId = summary?.classId || scores[0]?.classId || exam?.classId || null;
  const classTeacherName = cardClassId
    ? (await Class.findOne({ _id: String(cardClassId), schoolId })
        .select("classTeacherName").lean().catch(() => null))?.classTeacherName || null
    : null;

  /*
   * How the class did: the same function GET /:examId/stats answers with,
   * never a second implementation, and scoped to this exam's school — which
   * loadScopedExam settled above — so a card can no more reach another
   * school's marks than the pages that show them can.
   */
  const cardClassStats = cardClassId
    ? await classStats.sequenceClassStats({ schoolId, examId, classId: cardClassId })
    : null;

  // ── Student info + school grading settings (requirements §1, §3) ──────────
  const [student, gradingConfig, allExamScores] = await Promise.all([
    // gender / dateOfBirth live on the Student document, not the summary
    Student.findOne({ _id: studentId, schoolId })
      .select("gender dateOfBirth studentName enrollmentNo admissionNo photoUrl")
      .lean()
      .catch(() => null),
    // showGrades + the school's configurable grade bands (§3). Falls back to
    // the model's DEFAULT_GRADE_SCALE when the school has no config.
    exam?.schoolId
      ? GradingConfig.findOne({ schoolId: String(exam.schoolId) }).lean()
          .catch(() => null)
      : Promise.resolve(null),
    // The scores the pupil is ranked among (§5). subjectRanking groups by
    // examSubjectId when a row carries one and by subjectId otherwise, and
    // positionOf looks a pupil's row up in its own group only — so the rows
    // that can move this pupil's place are those sharing one of their keys.
    // Reading the whole exam (every class the exam covers) answered the same
    // positions at the cost of S×M rows per card; a class print of forty
    // cards read the school forty times.
    StudentScore.find({
      examId, schoolId, deletedAt: null,
      ...cohortKeysFor(scores),
    })
      .select("studentId examSubjectId subjectId score maxScore isAbsent isExempt")
      .lean(),
  ]);

  const showGrades = gradingConfig?.showGrades ?? true;

  // ── Per-subject positions (§5) ─────────────────────────────────────────────
  // The rule itself is in shared/reportCard.js, where the term and annual cards
  // reach it too and where scripts/check-report-card.js can test it: pupils who
  // did not sit a subject are out of both the ranking and the denominator, and
  // equal marks share a place.
  /*
   * Ranked on the SEQUENCE mark, not on the paper alone.
   *
   * A pupil's place in a subject has to be a place in the mark the card
   * prints. Ranking the paper while printing CA+paper would put a pupil 3rd
   * beside a mark that is 1st, on the same line, on paper a family keeps.
   *
   * With CA inactive this is the untouched list of paper scores and the
   * positions are exactly what they were.
   */
  const rankingInput = ca.active
    ? allExamScores.map((row) => {
        const blended = sequenceAssessment.blendSubject({
          ca:   ca.lookup(row.studentId, row.subjectId),
          test: row,
          settings: ca.settings,
        });
        return { ...row, score: blended.score, maxScore: blended.maxScore };
      })
    : allExamScores;

  const ranking = subjectRanking(rankingInput);
  // Positions are looked up by the same identity the ranking was built on, so
  // a row is probed with its blended mark rather than its paper mark.
  const blendedForRanking = new Map(
    rankingInput.map((row) => [
      `${String(row.studentId)}|${String(row.subjectId)}`, row,
    ])
  );
  const computeSubjectPosition = (score) =>
    ranking.positionOf(
      blendedForRanking.get(`${String(score.studentId)}|${String(score.subjectId)}`) || score
    );

  // ── Grade + remark per the school's configured bands (§3, §4) ──────────────
  // The school's GradingConfig.grades bands are on the /20 Cameroon scale
  // (see DEFAULT_GRADE_SCALE in the model). When the school has no config or
  // no band matches, fall back to the built-in Cameroon scale so a real mark
  // never renders without its grade/remark.
  const bands = Array.isArray(gradingConfig?.grades)
    ? gradingConfig.grades.filter((b) => b && b.grade != null)
    : [];
  // One lookup, from shared/, rather than a fourth hand-written band search.
  // Both remarks come back: a report card renders in the reader's language and
  // the renderer picks, so the payload cannot decide that for it.
  const gradeInfo = (normalizedMark) => {
    if (normalizedMark == null) {
      return { grade: null, points: null, remark: null, remarkFr: null };
    }
    const band = GradingConfig.findGradeBand(normalizedMark, bands);
    if (band) {
      return {
        grade:    band.grade,
        points:   band.gpaPoints ?? null,
        remark:   band.remark    || null,
        remarkFr: band.remarkFr  || band.remark || null,
      };
    }
    const fb = lookupGrade(normalizedMark);
    return {
      grade:    fb.grade,
      points:   fb.points ?? null,
      remark:   fb.remark,
      remarkFr: fb.remarkFr || fb.remark,
    };
  };

  // A subject passes on its sequence mark under weighted_20 (see the row).
  const onSequenceMark = sequenceAverageIsOn20(summary?.calcVersion);
  const passMark20     = Number(gradingConfig?.passMark ?? 10);

  /**
   * The stored average on /20, for the headline band lookup.
   *
   * A weighted_20 summary is on /20 already. A live-route (raw_mean) summary
   * is the mean of raw paper marks on the papers' OWN scale: /20 when every
   * paper is /20, which is unchanged here, but 65 for papers marked /100 —
   * and read as /20 that headlined a pupil on 65% (13/20) "A+" (docs/39
   * §4.7d/f). Such a summary is read through its own percentage instead.
   * Which figure a card headlines is not decided here: this is the same
   * stored figure, on the scale the bands are written in.
   */
  const resolveAvg20 = () => {
    if (summary?.average == null) return null;
    const average = Number(summary.average);
    const live = summary.calcVersion == null || summary.calcVersion === "exam-process/1";
    const subjects = Number(summary.subjectsTotal), maxTotal = Number(summary.maxTotalScore);
    const allOn20 = subjects > 0 && maxTotal === 20 * subjects;
    if (!live || allOn20 || !(subjects > 0 && maxTotal > 0) || summary.percentage == null) return average;
    return Math.round((Number(summary.percentage) / 5) * 100) / 100;
  };

  // Lookup by both ref styles: StudentScore.examSubjectId → ExamSubject._id,
  // while rows entered before subjects were set up may only carry subjectId.
  const subjectMap = new Map();
  for (const es of examSubjects) {
    subjectMap.set(String(es._id), es);
    if (es.subjectId != null) subjectMap.set(String(es.subjectId), es);
  }

  // Canonical weight semantics: ExamSubject.weight is percentage-style
  // (schema default 100). ÷100 → multiplier coefficient, so the default
  // leaves every subject equally weighted (×1).
  //
  // Shared, because the term and annual cards need the identical answer and
  // their own copy of this read a field ExamSubject does not have — so the
  // same pupil's sequence card said ×4 and their term card said ×1.
  const resolveCoeff = (es) => coefficientFromWeight(es?.weight);

  /*
   * A subject this pupil has CA in and no paper mark for.
   *
   * Without these the mark a teacher entered would sit in the database and
   * appear on no report card, because the card is built from the paper's
   * scores. A stand-in row carries no paper mark — which is the honest state —
   * and blends to the CA alone.
   */
  const caOnlyRows = [];
  if (ca.active) {
    const marked = new Set(scores.map((row) => String(row.subjectId)));
    for (const [key, caRow] of ca.caByKey) {
      const [sid, subjectId] = key.split("|");
      if (String(sid) !== String(studentId)) continue;
      if (marked.has(subjectId)) continue;
      caOnlyRows.push({
        _id: `ca-only:${subjectId}`,
        studentId, subjectId,
        examSubjectId: null,
        score:    null,
        maxScore: caRow.maxScore,
        isAbsent: false,
        isExempt: false,
      });
    }
  }

  // The decided calculation (exam-process/3, docs/39 §21.1) counts a subject
  // only with a paper mark: a CA with no paper is printed, not counted. A card
  // for a summary computed before it keeps the arithmetic it was printed with.
  const agreed = !summary || summary.calcVersion === "exam-process/3";

  const subjectRows = [...scores, ...caOnlyRows].map((score) => {
    const es       = subjectMap.get(String(score.examSubjectId)) ||
                     subjectMap.get(String(score.subjectId)) || {};
    // The exam's own total before a literal 100. A subject row written before
    // ExamSubject inherited the exam's totals says 100 even in a school that
    // marks out of 20, and normalising an 18 against 100 gives 3.6 — an F on
    // every subject of every card.
    const maxScore = score.maxScore || es.maxScore || exam?.totalMarks || 100;
    const coeff    = resolveCoeff(es);

    /*
     * The sequence mark: CA and the paper, combined by the school's split.
     *
     * `blended` is null whenever CA is inactive, and then every value below is
     * the paper's own — the same card this system has always printed.
     *
     * A pupil with no CA is graded on the paper alone, not on 60 % of it. A
     * missing CA is an absent record, not a zero, and the renormalisation in
     * blendSubject is what keeps those two different.
     */
    const blended = ca.active
      ? sequenceAssessment.blendSubject({
          ca:   ca.lookup(studentId, score.subjectId),
          test: { score: score.score, maxScore,
                  isAbsent: score.isAbsent || false,
                  isExempt: score.isExempt || false },
          settings: ca.settings,
        })
      : null;

    const noPaper = agreed && (score.score == null || score.isAbsent || score.isExempt);
    const effectiveScore = noPaper ? null : (blended ? blended.score : score.score);

    const normalizedMark =
      effectiveScore != null && !score.isAbsent && !score.isExempt
        ? Math.round((effectiveScore / maxScore) * 20 * 100) / 100
        : null;

    const weightedScore =
      normalizedMark != null
        ? Math.round(normalizedMark * coeff * 100) / 100
        : null;

    const posInfo = computeSubjectPosition(score);
    const gi      = gradeInfo(normalizedMark);

    return {
      scoreId:       String(score._id),
      subjectId:     String(score.subjectId),
      examSubjectId: score.examSubjectId || es._id || null,
      subjectName:   es.subjectName  || String(score.subjectId),
      teacherName:   es.teacherName  || null,
      // The sequence mark — what the "Score" column has always held, now made
      // of both assessments when the school uses both.
      score:         effectiveScore,
      maxScore,
      /*
       * The two halves, for the CA and Test columns.
       *
       * null throughout when CA is off or nothing was recorded, and null is
       * what the renderer prints as "—". It must never become a 0: a dash says
       * "no CA was entered", a zero says "this pupil scored nothing", and a
       * parent reads the difference.
       */
      caScore:       blended?.caScore      ?? null,
      caMaxScore:    blended?.caMaxScore   ?? null,
      caMark:        blended?.caMark       ?? null,
      testScore:     blended?.testScore    ?? null,
      testMaxScore:  blended?.testMaxScore ?? null,
      testMark:      blended?.testMark     ?? null,
      caWeight:      blended?.caWeight     ?? null,
      testWeight:    blended?.testWeight   ?? null,
      isAbsent:      score.isAbsent      ?? false,
      isExempt:      score.isExempt      ?? false,
      teacherRemark: score.teacherRemark || null,
      // Remark shown on the card: the teacher's own remark wins, then the
      // school's configured band remark (§4).
      remark:        score.teacherRemark || gi.remark || null,
      // The band remark in French. A teacher's own remark is their words and
      // is not translated — it stands in whichever language it was written.
      remarkFr:      score.teacherRemark || gi.remarkFr || null,
      coefficient:   coeff,
      percentage:    score.percentage    ?? null,
      // Derived first, stored second — the other way round until now, and the
      // stored value is a snapshot. Every grade in this database was computed
      // under the previous /100 table keyed on percentage, so an 11/20 came
      // back as "D" where the school's own table says "C+ / Above Average".
      // The remark beside it was already derived, so the card was showing a
      // grade and a remark from two different scales. The stored value remains
      // the fallback for a score with no mark to look up.
      grade:         gi.grade            ?? score.grade,
      gradePoint:    gi.points           ?? score.gpaPoints ?? null,
      // The paper's stored flag — except where the school's rule says a
      // subject passes on its sequence mark (weighted_20: "the subject passes
      // on its blended mark", shared/academicRules), which is the mark this
      // row prints and the stored summary counts. There the row printed
      // "10.2, C, Fail" beside a summary that counted it passed (docs/39
      // §4.6l). Under raw_mean the row is unchanged: which figure that card
      // prints is the school's decision (§4.7f).
      isPassing:     onSequenceMark || agreed
        ? (normalizedMark != null ? normalizedMark >= passMark20 : false)
        : (score.isPassing ?? null),
      normalizedMark,
      weightedScore,
      // Per-subject rank over the students who actually sat this subject (§5)
      subjectPosition: posInfo.position,
      subjectTotal:    posInfo.total,
    };
  });

  /*
   * Who teaches each subject.
   *
   * The exam subject names a teacher when whoever set the exam up said so,
   * and most of the time nobody did — so the card fell back to nothing. The
   * assignment register (TeacherAssignment, the same rows the permission
   * layer reads) is the authority on who teaches a subject to a class, and
   * it fills the gaps. Two queries for the whole card; see subjectTeachers.
   */
  const assignedTeachers = await subjectTeachers({
    schoolId,
    classId:    cardClassId,
    subjectIds: subjectRows.map((r) => r.subjectId),
  });
  for (const r of subjectRows) {
    r.teacherName = r.teacherName || assignedTeachers.get(String(r.subjectId)) || null;
  }
  // A sequence card's own columns are the CA and the paper it was marked
  // from — they are already on each row (caScore / testScore) and the
  // renderer shows them when the school marks both ways.

  const activeRows    = subjectRows.filter(
    (r) => !r.isAbsent && !r.isExempt && r.score != null
  );
  const totalCoeff    = activeRows.reduce((s, r) => s + r.coefficient, 0);
  const totalWeighted = activeRows.reduce(
    (s, r) => s + (r.weightedScore ?? 0), 0
  );

  // ── Report type (§7) ────────────────────────────────────────────────────────
  // sequence → a bound sequence (1–6); annual → the promotion exam, the only
  // card allowed to carry a promotion decision (§8); everything else → term.
  const reportType = reportTypeFor(exam);

  // The period this card is FOR, spelled the way a parent reads it. A
  // sequence card names its sequence, a term card names its term, and the
  // annual card names neither because it covers the whole year.
  let ownName = null;
  let structure = null;
  if (reportType === "sequence") {
    structure = exam?.schoolId
      ? await AcademicStructure.findOne({
          schoolId: String(exam.schoolId), academicYear: exam.academicYear,
        }).lean().catch(() => null)
      : null;
    // The sequence's name, from the period tree (docs/39 Phase 3).
    ownName = legacyTermsOf(structure)
      .flatMap((t) => t.sequences)
      .find((sq) => sq.number === exam.sequenceNumber)?.name || null;
  }

  // No subject counted: there is no figure, and the route stores none
  // (check:weightednomarks), so the card prints none either rather than a 0
  // the pupil never scored. A card for an exam-process/1 summary is
  // unchanged: it prints the 0 its stored result also holds.
  const weightedAverage = totalCoeff > 0
    ? Math.round((totalWeighted / totalCoeff) * 100) / 100
    : (agreed || onSequenceMark ? null : 0);

  // The facts about the period, not a sentence about it. The header names the
  // period in the reader's language ("Première Séquence"), so a string built
  // here would be the one line of English left on a French card — the same
  // fault the remarks had. periodLabel stays for {{term}}, which templates
  // already reference.
  const period = {
    reportType,
    sequenceNumber: exam?.sequenceNumber ?? null,
    term:           exam?.term ?? null,
    name:           ownName,
  };
  const periodLabel = periodName(period, "en");

  const data = {
      examId,
      studentId,
      studentName:  summary?.studentName || null,
      admissionNo:  summary?.admissionNo || null,
      className:    summary?.className   || null,
      examName:     exam?.name           || null,
      academicYear: exam?.academicYear   || null,
      // §7 wants the sequence NAMED on a sequence card. Exam.term is a number
      // now, so printing it raw put "1" in the subtitle where "First Sequence"
      // belongs. The school's own name for the sequence wins; "Sequence 3" is
      // the fallback for a school that has not named them.
      term:         periodLabel,
      period,
      totalMarks:   exam?.totalMarks     || null,
      passMark:     exam?.passMark       || null,
      // §1 student identity + §3 grade toggle, consumed by the renderer
      gender:       student?.gender      || null,
      dateOfBirth:  student?.dateOfBirth || null,
      // Absolute, for the same reason the logo is: the card is printed by
      // writing the HTML into a new window whose document is about:blank, so
      // a served path like /uploads/photos/x.jpg has no origin to resolve
      // against and the image silently 404s.
      photoUrl:     absoluteLogoUrl(student?.photoUrl, req),
      // The form master, over the signature rule at the foot of the card.
      classTeacher: classTeacherName,
      showGrades,
      /*
       * Whether this card carries CA columns at all (§1).
       *
       * True only when the school has CA on AND this sequence actually has a
       * CA exam: a card with two empty columns headed "CA" tells a parent the
       * school assessed nothing, which is not what "no CA exam was created"
       * means. The weights ride along so the card can say what the split was —
       * a mark of 15.2 is not checkable without them.
       */
      caEnabled:    ca.active,
      caWeight:     ca.active ? ca.settings.caWeight   : null,
      testWeight:   ca.active ? ca.settings.testWeight : null,
      reportType,
      subjects:     subjectRows,
      summary: summary
        ? {
            totalScore:      summary.totalScore,
            totalMaxScore:   summary.maxTotalScore,
            percentage:      summary.percentage,
            average:         summary.average,
            // From the average, for the reason above: the stored overall grade
            // was computed under the old table too, so the headline letter
            // disagreed with the subject letters underneath it.
            overallGrade:    gradeInfo(resolveAvg20()).grade ?? summary.overallGrade,
            overallRemark:   summary.overallRemark,
            // Derived from the band the average falls in, so the overall
            // remark translates like the per-subject ones rather than being
            // the one line of English left on a French card.
            overallRemarkFr: gradeInfo(resolveAvg20()).remarkFr,
            gpa:             summary.gpa,
            isPassing:       summary.isPassing,
            // Exposed so the archive can freeze only what has actually been
            // issued to parents, not a draft an admin previewed.
            isPublished:     summary.isPublished ?? false,
            classPosition:   summary.classPosition,
            gradePosition:   summary.gradePosition,
            schoolPosition:  summary.schoolPosition,
            totalInClass:    summary.totalInClass,
            totalInGrade:    summary.totalInGrade,
            totalInSchool:   summary.totalInSchool,
            subjectsPassed:  summary.subjectsPassed,
            subjectsFailed:  summary.subjectsFailed,
            // §8: promotion only exists on the final annual report card —
            // sequence and intermediate term cards never carry it.
            promotionStatus: reportType === "annual"
              ? summary.promotionStatus
              : null,
            subjectScores:   summary.subjectBreakdown,
          }
        : null,
      computed: {
        totalCoefficients: totalCoeff,
        // What the coefficients were applied to: the sum the average above
        // is divided by them from. Exposed rather than recomputed anywhere
        // else, so the table's last row and the average cannot disagree.
        totalWeighted:     Math.round(totalWeighted * 100) / 100,
        weightedAverage,
        outOf: 20,
      },
      // The class this pupil sat in, on the scale the exam statistics use
      // (percentages — see services/classStats.service.js). Null where there
      // is nothing to say; never a zero standing in for an unknown.
      classStats:  cardClassStats,
};

  // The school this card belongs to — the scoped exam's, resolved above. The
  // HTML route loads the letterhead, template, verification code and archive
  // by it; a super_admin's token names no school, so reading the token there
  // printed "SCHOOL" with no logo, no template, no code, and archived nothing.
  return { ok: true, data, schoolId };
};

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId/reportcard
// ─────────────────────────────────────────────────────────

const getStudentReportCard = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;

  const built = await buildStudentReportCardData(examId, studentId, req);
  if (!built?.ok) {
    return res.status(404).json({
      success: false,
      error:   "No scores found for this student in this exam",
      detail:  "Enter marks first before generating a report card",
    });
  }

  // The sections this card prints — the layout it was issued with, or the
  // school's current one — for a client that draws a card from this payload
  // rather than printing the server's HTML (docs/39 §10). Beside the data,
  // not inside it: the payload is what results produced, the layout is how
  // the school chose to print it.
  const layout = await reportLayout.layoutForSequenceCard({ schoolId: built.schoolId, examId, studentId });

  return res.json({ success: true, data: built.data, layout: reportLayout.describe(layout) });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/student/:studentId/reportcard/html
//
// ✅ Phase 2: single rendering engine. Returns the canonical printable HTML
//    produced server-side; the web batch print and the mobile PDF export
//    fetch this instead of keeping their own local builders.
//    Printed in the school's language (School.defaultLanguage), whoever
//    views it; ?lang= is no longer read (docs/41 §7).
// ─────────────────────────────────────────────────────────

/**
 * The template that should drive this school's report cards.
 *
 * Resolution order: an explicit ?templateId=, then the school's default
 * (isDefault), then none — in which case the renderer uses its built-in
 * layout. ?templateId=builtin forces the built-in layout, which is the
 * escape hatch when a school's template is misbehaving.
 *
 * Never throws: a template lookup failure must not cost the school its
 * report cards, so it degrades to the built-in layout.
 */
// The template lookup moved to reportCardData.service.js, where the term and
// annual cards reach the same one — see the note there.
const { coefficientFromWeight } = require("../services/subjectCoefficient.service");
const { cardVerification } = require("../services/reportCardData.service");
const classStats = require("../services/classStats.service");
const { loadReportTemplate, loadSchoolForCard, absoluteLogoUrl, subjectTeachers } =
  require("../services/reportCardData.service");
// Which sections a card prints (docs/39 §10, Phase 2d).
const reportLayout = require("../services/reportLayout.service");
const { recordAudit } = require("../services/audit.service");

/**
 * Freeze what was just issued.
 *
 * GeneratedReport is the legal record: a parent reprinting in two years must
 * get the card the school issued, not one re-derived from data and a template
 * that have both moved on since. Upserted on examId + studentId, so
 * re-issuing replaces rather than accumulates.
 *
 * variablePayload stores the report card payload — the canonical input both
 * render paths consume — rather than the engine's nested view of it, which is
 * derived from this and reproducible.
 *
 * Deliberately fire-and-forget: a failure to archive must never cost the user
 * the report card they asked for.
 */
const archiveGeneratedReport = ({
  schoolId, examId, studentId, data, html, template, source, userId, layout,
}) => {
  if (!schoolId) return;

  // Only freeze what has actually been issued. Before results are published
  // the card is a draft, and an admin previewing one must not create a record
  // that later reads as "what the parent received".
  if (!data.summary?.isPublished) return;

  GeneratedReport.findOneAndUpdate(
    { examId, studentId },
    {
      // Every frozen field is $setOnInsert, never $set: the FIRST issue wins.
      // Re-reading a card months later must not silently rewrite what a parent
      // already holds — by then the template may have been edited or a mark
      // corrected. Reissuing after a genuine correction is a deliberate act;
      // see POST /:examId/student/:studentId/reportcard/reissue.
      $setOnInsert: {
        _id:             uuidv4(),
        schoolId,
        examId,
        studentId,
        templateId:      source === "template" ? String(template._id) : null,
        templateVersion: source === "template" ? template.version ?? 1 : 1,
        // The sections it was printed with, so it reprints with them.
        ...reportLayout.issuedFields(layout),
        renderedHtml:    html,
        variablePayload: data,
        term:            data.term         || null,
        academicYear:    data.academicYear || null,
        generatedBy:     userId || null,
        isPublished:     false,
        deletedAt:       null,
      },
    },
    { upsert: true }
  )
    .lean()
    .catch((err) =>
      console.error("[reportcard] archive failed:", err.message)
    );
};

const getStudentReportCardHtml = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;

  const built = await buildStudentReportCardData(examId, studentId, req);
  if (!built?.ok) {
    return res.status(404).json({
      success: false,
      error:   "No scores found for this student in this exam",
      detail:  "Enter marks first before generating a report card",
    });
  }

  // The scoped exam's school, not the token's: the same school every read
  // above was scoped to, and the only one a super_admin acting on a selected
  // school actually has. For a school user the two are the same id.
  const schoolId = built.schoolId;

  // Logo, motto and the official header's delegations come from the school's
  // settings (§2) — never hard-coded, and loaded by the one function all three
  // card routes share so they cannot select different fields from each other.
  //
  // C2: the four reads below do not depend on each other, so they go out
  // together. One after another they were most of a card's ~3s on a remote
  // database — about twenty round trips in a row, per pupil, per print.
  //
  // An actual print sends ?issue=1; without it this is a preview. The web
  // console fetches this same route to fill its preview, and opening one is
  // not issuing the card: it must neither archive it as the parent's copy
  // nor count as a print on its verification code.
  const issuing = req.query.issue === "1" || req.query.issue === "true";
  const [letterhead, verify, template, layout] = await Promise.all([
    loadSchoolForCard(schoolId, req),
    // The verification strip: QR + code resolving to a public page that shows
    // what the school's records say, so a registrar elsewhere can check a
    // paper bulletin against them (shared with the term and annual cards).
    cardVerification({ data: built.data, schoolId, studentId, documentKey: examId, req, count: issuing }),
    // Per-school template drives the layout when the school has one; the
    // built-in layout is the fallback, including when a template fails.
    loadReportTemplate(schoolId, req.query.templateId),
    // Which sections it prints (docs/39 §10). A card already issued prints
    // with the layout it was issued with — a school that hides a section today
    // does not change a card a family already holds. One issued before layouts
    // existed prints every section, as it was issued. Anything else prints
    // with the school's current layout, and records it if this is its issue.
    reportLayout.layoutForSequenceCard({ schoolId, examId, studentId }),
  ]);
  const schoolName = req.user?.schoolName || letterhead.doc?.name || null;
  // The school's language, whoever views or reissues the card (docs/41 §7);
  // a ?lang= or body.lang from the viewer's interface no longer decides it.
  const lang = letterhead.language;

  const rendered = renderReportCard(built.data, {
    lang,
    schoolName: schoolName || "School",
    // §2: logo, motto and delegations from the school's settings document
    school: { ...letterhead.school, name: schoolName || "" },
    verify,
    template,
    sections: layout.sections,
  });

  if (issuing) archiveGeneratedReport({
    schoolId,
    examId,
    studentId,
    data:      built.data,
    html:      rendered.html,
    template,
    source:    rendered.source,
    userId:    req.user?._id,
    layout,
  });

  return res.json({
    success: true,
    data: {
      html:     rendered.html,
      filename: `report-${built.data.admissionNo || studentId}-${examId}.html`,
      // Which layout produced this, so a caller can tell the school their
      // template was skipped, and so an archived copy is traceable.
      source:          rendered.source,
      templateId:      rendered.source === "template" ? String(template._id) : null,
      templateVersion: rendered.source === "template" ? template.version ?? 1 : null,
      ...(rendered.error ? { templateError: rendered.error } : {}),
      // Tokens in the school's template that the engine does not know. The
      // card still printed; this lets the UI tell the admin to fix the typo.
      ...(rendered.unknownTokens ? { unknownTokens: rendered.unknownTokens } : {}),
      // The layout it printed with, and any switched-off section the school's
      // template printed anyway because it does not gate it.
      layout: reportLayout.describe(layout, rendered.source === "template" ? template : null),
    },
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/:examId/student/:studentId/reportcard/calculate
// ─────────────────────────────────────────────────────────

/**
 * POST /api/results/:examId/student/:studentId/reportcard/reissue
 *
 * Replace the frozen copy of an already-issued report card.
 *
 * The normal render path never overwrites an archived card, so a mark
 * corrected after issue would leave the parent's copy stale forever. This is
 * the deliberate act that supersedes it — admin-only, and it records who did
 * it, because replacing a document a parent already holds is exactly the kind
 * of change that needs a name against it.
 */
const reissueStudentReportCard = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;
  const schoolId = resolveSchoolId(req, req.body.schoolId);

  if (!schoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }

  // Deliberately NOT filtered on deletedAt. The automatic archive matches on
  // examId + studentId alone and only $setOnInsert, so once a card is soft
  // deleted a reprint quietly no-ops against the dead row and the unique index
  // blocks a fresh insert — leaving the card unrecoverable. Reissue is the
  // explicit admin action, so it is the thing that may revive one.
  // Scoped to the caller's school: the (examId, studentId) pair is unique
  // across the platform, so without schoolId a foreign pair reissued — and
  // overwrote — another school's frozen card.
  const existing = await GeneratedReport.findOne({
    examId, studentId, schoolId,
  }).select("_id templateId templateVersion layoutVersion deletedAt").lean();

  if (!existing) {
    return res.status(404).json({
      success: false,
      error:   "No issued report card to reissue",
      code:    "NOT_ISSUED",
      detail:  "A card is archived the first time it is printed after results are published.",
    });
  }

  const built = await buildStudentReportCardData(examId, studentId, req);
  if (!built?.ok) {
    return res.status(404).json({
      success: false,
      error:   "No scores found for this student in this exam",
    });
  }

  // The same letterhead and verification strip the issue path prints
  // (getStudentReportCardHtml). A reissue used to render with the school's
  // name alone, so the card that superseded an issued one had no logo, motto,
  // delegations or QR (docs/39 §4.6f).
  const letterhead = await loadSchoolForCard(schoolId, req);
  const schoolName = req.user?.schoolName || letterhead.doc?.name || null;
  // The school's language, whoever views or reissues the card (docs/41 §7);
  // a ?lang= or body.lang from the viewer's interface no longer decides it.
  const lang = letterhead.language;
  const verify = await cardVerification({
    data:        built.data,
    schoolId,
    studentId,
    documentKey: examId,
    req,
  });

  const template = await loadReportTemplate(schoolId, req.body.templateId);

  // A reissue is the deliberate act that supersedes an issued card, so it
  // takes the school's CURRENT layout and records it (docs/39 §10).
  const layout = { ...(await reportLayout.currentLayout(schoolId)) };
  const issued = reportLayout.issuedFields(layout);

  const rendered = renderReportCard(built.data, {
    lang,
    schoolName: schoolName || "School",
    school: { ...letterhead.school, name: schoolName || "" },
    verify,
    template,
    sections: layout.sections,
  });

  await GeneratedReport.updateOne(
    { _id: existing._id },
    {
      $set: {
        templateId:      rendered.source === "template" ? String(template._id) : null,
        templateVersion: rendered.source === "template" ? template.version ?? 1 : 1,
        ...issued,
        renderedHtml:    rendered.html,
        variablePayload: built.data,
        term:            built.data.term         || null,
        academicYear:    built.data.academicYear || null,
        generatedBy:     req.user?._id || null,
        // Revive a soft-deleted card: reissuing is how an admin undoes a
        // delete, and leaving it set would keep the portal at NOT_ISSUED.
        deletedAt:       null,
      },
    }
  );

  // The name against it (docs/39 §4.6f): who superseded which card, from
  // which template and layout to which, and why if they said.
  await recordAudit(req, {
    action:   "reportCard.reissued",
    schoolId,
    resource: { type: "GeneratedReport", id: existing._id, label: `exam ${examId}` },
    before: {
      templateId:      existing.templateId ?? null,
      templateVersion: existing.templateVersion ?? null,
      layoutVersion:   existing.layoutVersion ?? null,
      deleted:         Boolean(existing.deletedAt),
    },
    after: {
      templateId:      rendered.source === "template" ? String(template._id) : null,
      templateVersion: rendered.source === "template" ? template.version ?? 1 : 1,
      layoutVersion:   issued.layoutVersion ?? null,
      deleted:         false,
      verifyCode:      verify?.code ?? null,
    },
    reason: typeof req.body.reason === "string" ? req.body.reason
          : typeof req.body.changeReason === "string" ? req.body.changeReason : null,
  });

  console.log(
    `♻️  Report card reissued: exam=${examId} student=${studentId} ` +
    `by=${req.user?._id || "?"}` +
    (existing.deletedAt ? " (revived a deleted card)" : "")
  );

  return res.json({
    success: true,
    data: {
      html:            rendered.html,
      source:          rendered.source,
      revived:         Boolean(existing.deletedAt),
      templateId:      rendered.source === "template" ? String(template._id) : null,
      templateVersion: rendered.source === "template" ? template.version ?? 1 : null,
      ...(rendered.unknownTokens ? { unknownTokens: rendered.unknownTokens } : {}),
      layout: reportLayout.describe(layout, rendered.source === "template" ? template : null),
    },
  });
});

const calculateStudentReportCard = asyncHandler(async (req, res) => {
  const { examId, studentId } = req.params;

  // Tenancy: the exam anchors the write. Exam.findById plus an unscoped
  // { examId, studentId } lookup let a results.edit holder rewrite another
  // school's summary from body numbers.
  const scoped = await loadScopedExam(req, examId, req.body.schoolId);
  if (!scoped) {
    return res.status(404).json({ success: false, error: "Exam not found" });
  }
  const { exam, schoolId } = scoped;

  if (!(await Student.exists({ _id: String(studentId), schoolId }))) {
    return res.status(404).json({ success: false, error: "Student not found" });
  }

  // A teacher recomputes the summaries of the classes they teach and no
  // other — the class-level question, because a summary spans every subject.
  // Admins pass. Same boundary as the register.
  //
  // The class is the one the pupil's marks were sat in, ahead of the stored
  // summary's: a summary written by a run that ranked several classes as one
  // carries another class's id, and trusting it first would both keep the
  // pupil there and let that class's teacher in.
  const sittingClassId =
    (await StudentScore.findOne({ examId, studentId, schoolId, deletedAt: null })
      .select("classId").lean())?.classId || null;
  if (req.user?.role === "teacher") {
    const summaryClassId =
      sittingClassId ||
      (await ResultSummary.findOne({ examId, studentId, schoolId, deletedAt: null })
        .select("classId").lean())?.classId ||
      exam.classId || null;
    const ok = summaryClassId && await teacherAssigned(TeacherAssignment, {
      teacherId: req.user._id || req.user.id, schoolId, classId: summaryClassId,
    });
    if (!ok) {
      return res.status(403).json({
        success: false, code: "CLASS_NOT_ASSIGNED",
        error: "You are not assigned to this student's class",
      });
    }
  }

  /*
   * The pupil's summary, computed the decided way (docs/39 §21.1).
   *
   * This route used to build the summary from the marks, coefficients, scale
   * and pass mark the client sent, and keep the row's calcVersion — so an
   * exam-process/3 row could be rewritten with numbers no calculation of
   * ours produced. It now runs exactly what POST /exams/:examId/process runs
   * (examProcess.service), for the pupil's class, on the stored marks and
   * CA; the body's numbers are not read. A mark is corrected through mark
   * entry, then recalculated here.
   *
   * A published summary is never recomputed: 409 PUBLISHED_RESULTS and
   * nothing written, as /process answers. The lock guard still applies.
   */
  const existing = await ResultSummary.findOne({ examId, studentId, schoolId, deletedAt: null }).lean();
  if (existing?.isPublished) {
    return res.status(409).json({
      success: false, code: "PUBLISHED_RESULTS",
      error:   "This result is published. Unpublish it first.",
    });
  }
  const audit = await guardResultWrite(req, res, { examId, schoolId, studentId });
  if (!audit) return;

  const classId = sittingClassId || existing?.classId || exam.classId || null;

  const result = await processExam({ exam, schoolId, classId, userId: req.user?._id ?? null });
  if (result.status !== 200) {
    return res.status(result.status).json({ ...result.body, error: result.body?.message });
  }

  const summary = await ResultSummary.findOne({ examId, studentId, schoolId, deletedAt: null }).lean();
  if (!summary) {
    // No paper mark in any subject: no result, not a 0 (check:weightednomarks).
    return res.status(404).json({
      success: false, code: "NO_RESULT",
      error:   "This pupil has no paper mark in this exam, so there is no result to calculate.",
    });
  }

  await logResultChange(audit, {
    entity:   "summary",
    entityId: String(summary._id),
    action:   existing ? "updated" : "created",
    field:    "average",
    oldValue: existing?.average ?? null,
    newValue: summary.average,
  });

  const counted = (summary.subjectBreakdown || []).filter((b) => b.normalizedMark != null);
  const gradingConfig = await GradingConfig.findOne({ schoolId }).select("passMark").lean();
  return res.json({
    success: true,
    data: {
      summaryId:          summary._id,
      average:            summary.average,
      outOf:              20,
      passMark:           gradingConfig?.passMark ?? 10,
      percentage:         summary.percentage,
      overallGrade:       summary.overallGrade,
      overallRemark:      summary.overallRemark,
      gpa:                summary.gpa,
      isPassing:          summary.isPassing,
      subjectsPassed:     summary.subjectsPassed,
      subjectsFailed:     summary.subjectsFailed,
      subjectsTotal:      summary.subjectsTotal,
      totalCoefficients:  counted.reduce((n, b) => n + (b.coefficient ?? 1), 0),
      totalWeightedScore: Math.round(counted.reduce((n, b) => n + (b.weightedMark ?? 0), 0) * 100) / 100,
      subjectBreakdown:   summary.subjectBreakdown,
      calcVersion:        summary.calcVersion,
      classPosition:      summary.classPosition,
      gradePosition:      summary.gradePosition,
      schoolPosition:     summary.schoolPosition,
      totalInClass:       summary.totalInClass,
      totalInGrade:       summary.totalInGrade,
      totalInSchool:      summary.totalInSchool,
      promotionStatus:    summary.promotionStatus,
    },
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/:examId/publish
// ─────────────────────────────────────────────────────────

const publishResults = asyncHandler(async (req, res) => {
  const { examId }  = req.params;
  const { classId } = req.body;

  // ── Tenancy: publishing is per school, and the school is named ──────────
  // The old filter matched { examId } across every school, so a foreign
  // examId published another school's report cards, and the summary route
  // below could retract one. A platform write names its school or nothing
  // happens.
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }

  const exam = await Exam.findOne({ _id: examId, schoolId }).select("_id").lean();
  if (!exam) {
    return res.status(404).json({ success: false, error: "Exam not found" });
  }

  // Publish all ResultSummary records for this exam
  const filter = { examId, schoolId, deletedAt: null };
  if (classId) filter.classId = classId;

  const result = await ResultSummary.updateMany(filter, {
    $set: {
      isPublished: true,
      publishedAt: new Date(),
    },
  });

  // Also update the Exam status
  await Exam.findOneAndUpdate(
    { _id: examId, schoolId },
    {
      $set: {
        status: "published",
        resultsPublished: true,
        resultsPublishedAt: new Date(),
        publishedBy: req.user?._id || null,
      },
    }
  );

  return res.json({
    success:   true,
    message:   "Results published successfully",
    published: result.modifiedCount,
  });
});

// ─────────────────────────────────────────────────────────
// PUT /api/results/summary/:summaryId/publish
// ─────────────────────────────────────────────────────────

const publishResult = asyncHandler(async (req, res) => {
  const { summaryId }      = req.params;
  const { publish = true } = req.body;

  // Tenancy: a summary id without a school names nothing. The old
  // findById(summaryId) let a foreign id publish or retract another school's
  // report card under a family that already holds it.
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }

  const summary = await ResultSummary.findOne({ _id: summaryId, schoolId });

  if (!summary) {
    return res.status(404).json({
      success: false,
      error:   "Result summary not found",
    });
  }

  // 423 Locked, not 400: the request is well formed, the resource's own state
  // forbids it. And the check now covers unpublishing too — pulling a result
  // back from parents who have seen it is a change, not an exemption.
  if (summary.isLocked) {
    const reason = (req.body?.changeReason || req.body?.reason || "").trim();
    if (!reason) {
      return res.status(423).json({
        success: false,
        code:    "RESULTS_LOCKED",
        message: "This result is locked. Send a `changeReason` to record why you are overriding the lock.",
      });
    }
  }

  const wasPublished = Boolean(summary.isPublished);
  const reason       = (req.body?.changeReason || req.body?.reason || "").trim() || null;

  summary.isPublished = Boolean(publish);
  summary.publishedAt = publish ? new Date() : null;
  await summary.save();

  if (wasPublished !== Boolean(publish)) {
    await logResultChange(
      {
        examId:     String(summary.examId),
        schoolId:   String(summary.schoolId),
        studentId:  summary.studentId ? String(summary.studentId) : null,
        reason,
        isOverride: Boolean(summary.isLocked),
        actor: {
          id:   req.user?._id ? String(req.user._id) : null,
          name: req.user?.name || null,
          role: req.user?.role || null,
        },
      },
      {
        entity:   "summary",
        entityId: String(summary._id),
        action:   publish ? "published" : "unpublished",
        field:    "isPublished",
        oldValue: wasPublished,
        newValue: Boolean(publish),
      }
    );
  }

  return res.json({
    success: true,
    message: publish ? "Result published" : "Result unpublished",
    data:    summary,
  });
});

// ─────────────────────────────────────────────────────────
// POST /api/results/score
// ─────────────────────────────────────────────────────────

const upsertScore = asyncHandler(async (req, res) => {
  const {
    examId, examSubjectId, studentId,
    subjectId, classId, schoolId,
    score, maxScore, isAbsent, isExempt, teacherRemark,
  } = req.body;

  // ── Tenancy: the exam anchors the write ──────────────────────────────────
  // The row's schoolId field is what the write RECORDS, not what authorises
  // it. Without an in-school exam check, a results.edit holder could supply
  // another school's exam/student/subject ids and mint a mark that feeds that
  // school's pipeline; without the assignment check below, any teacher could
  // do it to any class of their own school.
  const callerSchoolId = resolveSchoolId(req, schoolId);
  if (!callerSchoolId) {
    return res.status(400).json({ success: false, error: "schoolId is required" });
  }

  const exam = await Exam.findOne({ _id: examId, schoolId: callerSchoolId })
    .select("_id schoolId type")
    .lean();
  if (!exam) {
    return res.status(404).json({ success: false, error: "Exam not found" });
  }

  if (!studentId || !subjectId) {
    return res.status(400).json({ success: false, error: "studentId and subjectId are required" });
  }
  if (!(await Student.exists({ _id: String(studentId), schoolId: callerSchoolId }))) {
    return res.status(404).json({ success: false, error: "Student not found" });
  }

  // ── The class and subject come from the exam, not the request ───────────
  // The ExamSubject row is the exam's own statement of which class sits which
  // subject. When one exists it decides the class (and the examSubjectId the
  // row records); the body's classId is only consulted for an exam that
  // carries no ExamSubject rows, and even then the class and the subject must
  // both be this school's.
  const examSubjectBase = {
    examId, schoolId: callerSchoolId, subjectId: String(subjectId), deletedAt: null,
  };
  let examSubject = await ExamSubject.findOne({
    ...examSubjectBase,
    ...(examSubjectId ? { _id: String(examSubjectId) } : {}),
    ...(!examSubjectId && classId ? { classId: String(classId) } : {}),
  }).select("_id classId subjectId maxScore").lean();
  if (!examSubject && !examSubjectId && classId) {
    // The body named a class the exam does not sit this subject in; the
    // exam's own row for the subject decides, if it has one.
    examSubject = await ExamSubject.findOne(examSubjectBase)
      .select("_id classId subjectId maxScore").lean();
  }
  if (examSubjectId && !examSubject) {
    return res.status(404).json({ success: false, error: "Exam subject not found" });
  }

  const existing = await StudentScore.findOne({
    examId, studentId, subjectId, schoolId: callerSchoolId,
  });

  const effectiveClassId = examSubject?.classId
    ? String(examSubject.classId)
    : String(classId || existing?.classId || "");
  if (!effectiveClassId) {
    return res.status(400).json({ success: false, error: "classId is required" });
  }
  if (!examSubject) {
    const [classOk, subjectOk] = await Promise.all([
      Class.exists({ _id: effectiveClassId, schoolId: callerSchoolId }),
      Subject.exists({ _id: String(subjectId), schoolId: callerSchoolId }),
    ]);
    if (!classOk)   return res.status(404).json({ success: false, error: "Class not found" });
    if (!subjectOk) return res.status(404).json({ success: false, error: "Subject not found" });
  }

  // The relationship, not just the capability — the same rule as the exam
  // router's bulk sheet, quiz authoring and homework: a teacher writes marks
  // for the (class, subject) pairs they are assigned, and for no other. Asked
  // of the pair the exam names, before anything is written.
  if (req.user?.role === "teacher") {
    const ok = await teacherAssigned(TeacherAssignment, {
      teacherId: req.user._id || req.user.id,
      schoolId:  callerSchoolId,
      classId:   effectiveClassId,
      subjectId,
    });
    if (!ok) {
      return res.status(403).json({
        success: false,
        code:    "SUBJECT_NOT_ASSIGNED",
        error:   "You are not assigned to this class and subject",
      });
    }
  }

  /*
   * ── A present pupil needs a real mark ───────────────────────────────────
   *
   * The same rule the bulk sheet applies, and for the same reason it gives:
   * "a blank cell on a present student silently corrupts every average and
   * grade computed from it". This route had no such guard, so a body with no
   * `score` stored score: null with isAbsent false — and processResults turns
   * that into a genuine ZERO in ResultSummary.subjectBreakdown
   * (`score: effectiveScore ?? 0`), where nothing downstream can tell it from
   * a mark the pupil actually earned. The report card prints it, the term
   * average counts it, and the student intelligence layer reads it as a real
   * collapse in the subject.
   *
   * Closed here, at the door, rather than by teaching every reader to guess
   * what a zero meant. A pupil with no mark is recorded as absent or exempt,
   * which the whole system already understands; the fallback below it stays
   * as it is, now genuinely unreachable from either write path.
   *
   * After authorisation on purpose: somebody who may not write this mark
   * learns that and nothing else.
   */
  //
  // The ceiling is the exam subject's maxScore whenever there is one — what
  // processing divides by — and it is also what the row stores. A body's own
  // maxScore used to win both, so { score: 300, maxScore: 1000 } on a /20
  // subject passed and processed as 300/20 (docs/39 §4.6a). The body's value
  // is honoured only for a mark with no exam subject to answer for it.
  // A ceiling that is not a positive number (a body's "abc") would make every
  // comparison below false and let any mark through, so it reads as 100.
  const ceilingRaw = Number(examSubject?.maxScore ?? maxScore ?? existing?.maxScore ?? 100);
  const ceiling    = Number.isFinite(ceilingRaw) && ceilingRaw > 0 ? ceilingRaw : 100;
  if (!isAbsent && !isExempt) {
    const blank = score === null || score === undefined || score === "";
    const value = Number(score);
    if (blank || !Number.isFinite(value) || value < 0 || value > ceiling) {
      return res.status(400).json({
        success: false,
        code:    "SCORE_REQUIRED",
        error:   `A present student needs a mark between 0 and ${ceiling}. ` +
                 `Record the student as absent or exempt if there is no mark.`,
      });
    }
  }

  const audit = await guardResultWrite(req, res, {
    examId,
    schoolId: callerSchoolId,
    studentId,
    subjectId,
  });
  if (!audit) return;

  if (existing) {
    // Snapshot before Object.assign mutates the document in place.
    const before = {
      score:         existing.score         ?? null,
      isAbsent:      existing.isAbsent      ?? false,
      isExempt:      existing.isExempt      ?? false,
      teacherRemark: existing.teacherRemark ?? null,
    };

    const corrections = existing.corrections ?? [];
    if (existing.score !== null && existing.score !== score) {
      corrections.push({
        originalScore: existing.score,
        newScore:      score,
        reason:        req.body.correctionReason ?? "Score updated",
        correctedBy:   req.user?._id,
        correctedAt:   new Date(),
      });
    }
    Object.assign(existing, {
      score,
      maxScore:      ceiling,
      isAbsent:      isAbsent      ?? existing.isAbsent,
      isExempt:      isExempt      ?? existing.isExempt,
      teacherRemark: teacherRemark ?? existing.teacherRemark,
      updatedBy:     req.user?._id,
      corrections,
      syncStatus:    "pending",
    });
    await existing.save();

    await logResultChange(
      audit,
      [
        diffField("score",         before.score,         score         ?? null),
        diffField("isAbsent",      before.isAbsent,      isAbsent      ?? before.isAbsent),
        diffField("isExempt",      before.isExempt,      isExempt      ?? before.isExempt),
        diffField("teacherRemark", before.teacherRemark, teacherRemark ?? before.teacherRemark),
      ]
        .filter(Boolean)
        .map((f) => ({
          entity:   "score",
          entityId: String(existing._id),
          action:   "updated",
          ...f,
        }))
    );

    return res.json({ success: true, action: "updated", data: existing });
  }

  const newScore = await StudentScore.create({
    examId, examSubjectId: examSubject?._id ?? examSubjectId ?? null, studentId,
    subjectId, classId: effectiveClassId, schoolId: callerSchoolId,
    score,
    maxScore:      ceiling,
    isAbsent:      isAbsent      ?? false,
    isExempt:      isExempt      ?? false,
    teacherRemark: teacherRemark ?? null,
    enteredBy:     req.user?._id,
    enteredAt:     new Date(),
    syncStatus:    "pending",
  });

  await logResultChange(audit, {
    entity:   "score",
    entityId: String(newScore._id),
    action:   "created",
    field:    "score",
    oldValue: null,
    newValue: score ?? null,
  });

  return res.status(201).json({
    success: true,
    action:  "created",
    data:    newScore,
  });
});

// ─────────────────────────────────────────────────────────
// DELETE /api/results/score/:scoreId
// ─────────────────────────────────────────────────────────

const deleteScore = asyncHandler(async (req, res) => {
  // Tenancy: scoped to the CALLER's school. The old lookup trusted the row's
  // own schoolId — which is exactly what it then handed to the guard — so a
  // foreign score id deleted another school's mark.
  const callerSchoolId = resolveSchoolId(req);
  const score = await StudentScore.findOne({
    _id: req.params.scoreId,
    ...(callerSchoolId ? { schoolId: callerSchoolId } : {}),
  });

  if (!score) {
    return res.status(404).json({
      success: false,
      error:   "Score not found",
    });
  }

  const audit = await guardResultWrite(req, res, {
    examId:    String(score.examId),
    schoolId:  String(score.schoolId),
    studentId: score.studentId ? String(score.studentId) : null,
    subjectId: score.subjectId ? String(score.subjectId) : null,
  });
  if (!audit) return;

  score.deletedAt  = new Date();
  score.syncStatus = "pending";
  await score.save();

  await logResultChange(audit, {
    entity:   "score",
    entityId: String(score._id),
    action:   "deleted",
    field:    "score",
    oldValue: score.score ?? null,
    newValue: null,
  });

  return res.json({
    success: true,
    message: "Score deleted successfully",
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/results/:examId/history
//
// The change history for an exam, or for one student within it.
// ?studentId=  narrow to a single student
// ?overridesOnly=1  only edits made past a lock — what an auditor asks for
// ─────────────────────────────────────────────────────────

const getResultHistory = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { examId } = req.params;
  const { studentId, subjectId, overridesOnly } = req.query;

  const filter = { schoolId, examId };
  if (studentId) filter.studentId = String(studentId);
  if (subjectId) filter.subjectId = String(subjectId);
  if (overridesOnly === "1" || overridesOnly === "true") filter.isOverride = true;

  const limit = Math.min(Number(req.query.limit) || 200, 1000);

  const rows = await ResultChangeLog.find(filter)
    .sort({ changedAt: -1 })
    .limit(limit)
    .lean();

  return res.json({
    success: true,
    count:   rows.length,
    data:    rows,
  });
});

// ─────────────────────────────────────────────────────────
// ✅ SINGLE CLEAN EXPORT — const declarations above,
//    module.exports here. No mixing of exports.x = and
//    module.exports = {} styles.
// ─────────────────────────────────────────────────────────

module.exports = {
  // The payload every report-card route is built from, exported so the CA
  // rules can be asserted against the thing a card is actually made of rather
  // than against a hand-written imitation of it.
  buildStudentReportCardData,
  getExamResults,
  getExamStats,
  getExamRankings,
  getStudentResult,
  getStudentReportCard,
  getStudentReportCardHtml,
  reissueStudentReportCard,
  calculateStudentReportCard,
  publishResults,
  publishResult,
  upsertScore,
  deleteScore,
  getResultHistory,
};