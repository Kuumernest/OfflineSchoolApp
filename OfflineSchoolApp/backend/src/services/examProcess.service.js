// backend/src/services/examProcess.service.js
"use strict";

/**
 * Processing one exam's sequence results: the decided calculation every
 * school uses (shared/academicRules, docs/39 §21.1), stamped exam-process/3.
 *
 * Moved here from POST /api/exams/:examId/process so that the one other
 * writer of a pupil's sequence summary — the "calculate & save" route
 * (results.controller calculateStudentReportCard) — runs exactly the same
 * code on the same stored marks, rather than building a summary from numbers
 * a client sent (docs/39 §20.0, "follow-up to the agreed calculation").
 */

const { v4: uuidv4 } = require("uuid");

const Exam          = require("../db/models/Exam");
const ExamSubject   = require("../db/models/ExamSubject");
const StudentScore  = require("../db/models/StudentScore");
const ResultSummary = require("../db/models/ResultSummary");
const GradingConfig = require("../db/models/GradingConfig");
const sequenceAssessment = require("./sequenceAssessment.service");
const { lookupGrade, normalizeTo20 } = require("./grading.service");
const academicPolicy = require("./academicPolicy.service");
const { calcVersionFor } = require("../../../shared/academicRules");
const { weightedSequenceResult } = require("./weightedSequence.service");
const { competitionPlaces } = require("../../../shared/ranking");
const { rosterDecides } = require("./rankingScope.service");

const computeGrade = (score, maxScore, gradingConfig) => {
  if (score === null || score === undefined) {
    return {
      percentage: null,
      grade:      null,
      remark:     null,
      gpaPoints:  null,
      isPassing:  null,
    };
  }
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  // Normalize to /20 Cameroon scale for grade band lookup
  const markOutOf20 = normalizeTo20(score, maxScore);
  const grades   = gradingConfig?.grades || [];
  const passMark = gradingConfig?.passMark ?? 10;
  // Bands are stored on the /20 scale. If the school has no config — or stored
  // bands on some other scale — fall back to the built-in Cameroon scale so a
  // genuine 12/20 never degrades to a wrong letter like F for everyone.
  let match = grades.find(
    (g) => markOutOf20 >= g.minMark && markOutOf20 <= g.maxMark
  );
  if (!match) {
    const fb = lookupGrade(markOutOf20);
    match = fb
      ? { grade: fb.grade, remark: fb.remark, gpaPoints: fb.points }
      : null;
  }
  return {
    percentage,
    grade:     match?.grade     || null,
    remark:    match?.remark    || null,
    gpaPoints: match?.gpaPoints ?? null,
    isPassing: markOutOf20 >= passMark,
  };
};

/**
 * Process an exam (optionally one class of it).
 *
 * Every class is ranked on its own. An exam sat by several classes and
 * processed without a classId used to be ranked as one group, every summary
 * stamped with the exam's single class: two pupils of Form 1A came 7th and 8th
 * "of 8" because Form 1B's six were counted with them. Each class now runs
 * exactly what processing it by name runs.
 *
 * @param {object} p
 * @param {object} p.exam       the Exam, already scoped to the school
 * @param {string} p.schoolId
 * @param {string|null} [p.classId]
 * @param {string|null} [p.userId]
 * @returns {Promise<{ status: number, body: object, summaries?: object[] }>}
 *   409 PUBLISHED_RESULTS with nothing written when a summary is published
 */
async function processExam({ exam, schoolId, classId = null, userId = null }) {
  const examId = String(exam._id);

  const gradingConfig = await GradingConfig.findOne({ schoolId }).lean();

  // The configuration this run reads, frozen and named, so every summary it
  // writes can say what produced it (docs/39 §8).
  const policy = await academicPolicy.resolve({
    schoolId, academicYear: exam.academicYear, gradingConfig, createdBy: userId ?? null,
  });

  // How every school calculates (shared/academicRules, decided by the
  // project owner, docs/39 §21.1): the coefficient-weighted /20 mean, CA
  // blended when the school has it on, a subject with no paper mark left out.
  // The raw-mark mean this route computed before (exam-process/1) is no longer
  // computed anywhere; rows it wrote are read through their calcVersion.
  const calcVersion = calcVersionFor("examProcess");

  // The class a mark belongs to is the one it was sat in: StudentScore.classId
  // is required, and is the class mark entry was opened for.
  const classIds = classId
    ? [String(classId)]
    : (await StudentScore.distinct("classId", { examId, schoolId, deletedAt: null }))
        .filter(Boolean).map(String);

  // Every class is planned before anything is written, so a published summary
  // in any of them refuses the whole run with nothing written, as before.
  const plans = [];
  for (const cId of classIds) {
    plans.push(await planClass({ exam, examId, schoolId, classId: cId, gradingConfig, policy, calcVersion }));
  }

  // A published result is never recomputed in place, for any school (D3,
  // decided): unpublishing first is the deliberate, visible act. Nothing is
  // written here.
  const published = plans.reduce((n, p) => n + p.published, 0);
  if (published > 0) {
    return { status: 409, body: {
      success: false,
      code:    "PUBLISHED_RESULTS",
      message: `${published} published result(s) would be recomputed. Unpublish them first.`,
      published,
    } };
  }

  const summaries  = plans.flatMap((p) => p.summaries);
  const noMarkIds  = plans.flatMap((p) => p.noMarkIds);
  const departedIds = plans.flatMap((p) => p.departedIds);

  // Collected here and sent as one bulkWrite.
  const summaryOps = [];
  for (const s of summaries) {
    const { _id, examId: eId, studentId: sId, schoolId: schId, ...fields } = s;
    summaryOps.push({
      updateOne: {
        // Keyed on the natural identity rather than the generated _id, so
        // a concurrent run cannot insert a second summary for one pupil.
        filter: { examId: eId, studentId: sId, schoolId: schId },
        update: {
          $set: fields,
          $setOnInsert: { _id, examId: eId, studentId: sId, schoolId: schId },
        },
        upsert: true,
      },
    });
  }

  if (summaryOps.length) {
    await ResultSummary.bulkWrite(summaryOps, { ordered: false });
  }

  // A row an earlier run left for those pupils: an unpublished one goes, so
  // it is neither ranked nor read by the term; a published one stays exactly
  // as issued and is outside the places above. As the annual layer does.
  // Pupils who have left the class this year (see rankingScope.service) go
  // the same way, for the same reason.
  const unranked = [...noMarkIds, ...departedIds];
  if (unranked.length) {
    await ResultSummary.deleteMany({
      examId, schoolId, studentId: { $in: unranked }, isPublished: { $ne: true },
    });
  }

  // A row filed under one of these classes whose pupil has no mark in it.
  // When the pupil has none anywhere in the exam — every score withdrawn —
  // the row goes too. When the marks are in another class, it is that
  // class's row: its own run rewrites it (in this same run, when no class
  // was named), and processing one class never removes another's.
  //
  // With no class named, a row can also be filed under a class with no mark
  // left in the exam at all, or under none: no class's plan reads it, so it is
  // read here.
  const unfiled = classId ? [] : await ResultSummary.find({
    examId, schoolId, classId: { $nin: classIds },
  }).select("studentId isPublished").lean();
  const unscoredIds = [...new Set([
    ...plans.flatMap((p) => p.unscoredIds),
    ...unfiled.filter((s) => !s.isPublished).map((s) => String(s.studentId)),
  ])];
  if (unscoredIds.length) {
    const stillScored = new Set((await StudentScore.distinct("studentId", {
      examId, schoolId, deletedAt: null, studentId: { $in: unscoredIds },
    })).map(String));
    const withdrawn = unscoredIds.filter((id) => !stillScored.has(id));
    if (withdrawn.length) {
      await ResultSummary.deleteMany({
        examId, schoolId, studentId: { $in: withdrawn }, isPublished: { $ne: true },
      });
    }
  }

  // A published summary in these classes that this run did not rank: kept
  // exactly as issued, its place and class size included, and named here
  // rather than silently left to disagree with the places just written.
  const publishedNotRanked = plans.reduce((n, p) => n + p.publishedNotRanked, 0)
    + unfiled.filter((s) => s.isPublished).length;

  await Exam.findByIdAndUpdate(examId, { status: "completed" });
  console.log(`✅ Results processed: ${summaries.length} students`);

  return { status: 200, summaries, body: {
    success:   true,
    processed: summaries.length,
    message:   `Results processed for ${summaries.length} student(s)`,
    ...(departedIds.length ? { departed: departedIds.length } : {}),
    ...(publishedNotRanked ? { publishedNotRanked } : {}),
  } };
}

/**
 * One class of an exam: its summaries, ranked within the class, and who was
 * left out. Writes nothing.
 */
async function planClass({ exam, examId, schoolId, classId, gradingConfig, policy, calcVersion }) {
  const allScores    = await StudentScore.find({ examId, schoolId, classId, deletedAt: null }).lean();
  const examSubjects = await ExamSubject.find({
    examId,
    schoolId,
    deletedAt: null,
    classId,
  }).lean();

  const byStudent  = {};
  for (const score of allScores) {
    if (!byStudent[score.studentId]) byStudent[score.studentId] = [];
    byStudent[score.studentId].push(score);
  }

  // Fetch student names for all students in this result set
  const studentIds = Object.keys(byStudent);
  const Student = require("../db/models/Student");
  const Class   = require("../db/models/Class");
  const students = await Student.find({ _id: { $in: studentIds }, schoolId })
    .select("_id studentName firstName lastName enrollmentNo classId className isActive deletedAt")
    .lean();
  const studentMap = new Map(students.map((s) => [String(s._id), s]));

  // Every summary this run might update, in one query.
  //
  // The loop below used to run ResultSummary.findOne per pupil and then a
  // findByIdAndUpdate or create per pupil, and the positions pass after it
  // a third write per pupil — three sequential round trips each, awaited
  // one at a time. On an in-memory mongod with no network at all that was
  // 10.5s for 1,200 pupils; against Atlas, where every one of those trips
  // pays real latency, it is minutes. This is the whole reason processing
  // an exam felt like it hung.
  //
  // Also every summary already filed under this class, so a row whose pupil
  // has no mark in it any more is found in the same read.
  const existingSummaries = await ResultSummary.find({
    examId, schoolId, $or: [{ studentId: { $in: studentIds } }, { classId }],
  }).select("_id studentId isPublished").lean();
  const existingByStudent = new Map(
    existingSummaries.map((s) => [String(s.studentId), s])
  );
  const scoredHere = new Set(studentIds.map(String));
  const unscored   = existingSummaries.filter((s) => !scoredHere.has(String(s.studentId)));

  // Counted, not refused here: processExam refuses the whole run (D3).
  const published = existingSummaries
    .filter((s) => s.isPublished && scoredHere.has(String(s.studentId))).length;

  // The CA beside the paper, as the card reads it (inactive when the school
  // has CA off: the paper then counts in full).
  const caContext = await sequenceAssessment.loadSequenceContext(exam, classId);
  const subjectMapForCard = new Map();
  for (const es of examSubjects) {
    subjectMapForCard.set(String(es._id), es);
    if (es.subjectId != null) subjectMapForCard.set(String(es.subjectId), es);
  }
  // A paper's summary carries its year and term, which the promotion run and
  // the term layer select by (docs/39 §4.7e). Not a CA's: its marks are
  // already inside the paper's result.
  const placeFields = !sequenceAssessment.isContinuousAssessment(exam)
    ? { academicYear: exam.academicYear ?? null, term: exam.term != null ? String(exam.term) : null }
    : {};

  // This year, a pupil who has left the class (inactive, deleted, moved) is
  // not ranked with it; in any other year every pupil who sat the paper is
  // (rankingScope.service). Read off the pupils already loaded, by the roster
  // test the term and annual layers query with: in this class, active, not
  // deleted.
  const rosterCounts = await rosterDecides({ schoolId, academicYear: exam.academicYear, classId });
  const onRoster = (id) => {
    const s = studentMap.get(String(id));
    return Boolean(s) && s.isActive === true && !s.deletedAt && String(s.classId) === classId;
  };

  // Fetch class names for all classes represented
  const classIds = [...new Set(students.map((s) => s.classId).filter(Boolean))];
  const classes = classIds.length > 0
    ? await Class.find({ _id: { $in: classIds }, schoolId }).select("_id name").lean()
    : [];
  const classNamesById = new Map(classes.map((c) => [String(c._id), c.name]));

  const summaries = [];
  // Pupils with no counted subject: no result, not a 0.
  const noMarkIds = [];
  const departedIds = [];

  for (const [studentId, scores] of Object.entries(byStudent)) {
    if (rosterCounts && !onRoster(studentId)) { departedIds.push(String(studentId)); continue; }
    const r = weightedSequenceResult({
      studentId, scores, subjectMap: subjectMapForCard, ca: caContext, exam,
      grade: (mark20) => computeGrade(mark20, 20, gradingConfig),
    });
    // No paper mark in any subject: each one is left out, so there is
    // nothing to average. This stored 0, F, ranked last, and the term
    // averaged that 0 in as a sequence sat — the sequence-level twin of
    // docs/39 §4.6k, handled the same way (check:weightednomarks).
    if (r.active === 0) { noMarkIds.push(String(studentId)); continue; }
    const overall = computeGrade(r.average, 20, gradingConfig);
    const stu = studentMap.get(studentId);
    summaries.push({
      _id:            existingByStudent.get(String(studentId))?._id || uuidv4(),
      classId,
      className:      stu?.className || classNamesById.get(String(stu?.classId)) || null,
      studentName:    stu?.studentName || [stu?.firstName, stu?.lastName].filter(Boolean).join(" ") || null,
      admissionNo:    stu?.enrollmentNo || null,
      totalScore:     Math.round(r.totalScore * 100) / 100,
      maxTotalScore:  r.maxTotalScore,
      percentage:     Math.round((r.average / 20) * 100),
      average:        r.average,
      overallGrade:   overall.grade,
      overallRemark:  overall.remark,
      gpa:            overall.gpaPoints,
      subjectsPassed: r.passed,
      subjectsFailed: r.failed,
      subjectsTotal:  r.subjectBreakdown.length,
      isPassing:      overall.isPassing,
      subjectBreakdown: r.subjectBreakdown,
      ...placeFields,
      policyHash:     policy._id,
      calcVersion,
      syncStatus:     "synced",
      lastSyncedAt:   new Date(),
      examId, studentId, schoolId,
    });
  }

  // ── Class positions ──────────────────────────────────────
  // Ranked on the official figure itself, competition style (1, 1, 3), and
  // the class size is the same population the places were counted over.
  const places = competitionPlaces(summaries.map((s) => s.average));
  summaries.forEach((s, i) => {
    s.classPosition = places[i];
    s.totalInClass  = summaries.length;
  });

  return {
    published, summaries, noMarkIds, departedIds,
    // Filed under this class, but the pupil has no mark in it.
    unscoredIds:        unscored.filter((s) => !s.isPublished).map((s) => String(s.studentId)),
    publishedNotRanked: unscored.filter((s) => s.isPublished).length,
  };
}

module.exports = { processExam, computeGrade };
