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

  const scoreQuery    = { examId, schoolId, deletedAt: null };
  if (classId) scoreQuery.classId = classId;

  const allScores    = await StudentScore.find(scoreQuery).lean();
  const examSubjects = await ExamSubject.find({
    examId,
    schoolId,
    deletedAt: null,
    ...(classId ? { classId } : {}),
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
    .select("_id studentName firstName lastName enrollmentNo classId className")
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
  const existingSummaries = await ResultSummary.find({
    examId, schoolId, studentId: { $in: studentIds },
  }).select("_id studentId isPublished").lean();
  const existingByStudent = new Map(
    existingSummaries.map((s) => [String(s.studentId), s])
  );

  // A published result is never recomputed in place, for any school (D3,
  // decided): unpublishing first is the deliberate, visible act. Nothing is
  // written here.
  const published = existingSummaries.filter((s) => s.isPublished).length;
  if (published > 0) {
    return { status: 409, body: {
      success: false,
      code:    "PUBLISHED_RESULTS",
      message: `${published} published result(s) would be recomputed. Unpublish them first.`,
      published,
    } };
  }

  // The CA beside the paper, as the card reads it (inactive when the school
  // has CA off: the paper then counts in full).
  const caContext = await sequenceAssessment.loadSequenceContext(exam, classId || null);
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

  // Collected here and sent as one bulkWrite after the loop.
  const summaryOps = [];

  // Fetch class names for all classes represented
  const classIds = [...new Set(students.map((s) => s.classId).filter(Boolean))];
  const classes = classIds.length > 0
    ? await Class.find({ _id: { $in: classIds }, schoolId }).select("_id name").lean()
    : [];
  const classNamesById = new Map(classes.map((c) => [String(c._id), c.name]));

  const summaries = [];
  // Pupils with no counted subject: no result, not a 0.
  const noMarkIds = [];

  for (const [studentId, scores] of Object.entries(byStudent)) {
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
      classId:        classId || exam.classId,
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
  const grouped = {};
  for (const s of summaries) {
    const cId = s.classId || "unknown";
    if (!grouped[cId]) grouped[cId] = [];
    grouped[cId].push(s);
  }

  for (const classSummaries of Object.values(grouped)) {
    // Ranked on the official figure itself, competition style (1, 1, 3).
    const places = competitionPlaces(classSummaries.map((s) => s.average));
    classSummaries.forEach((s, i) => {
      s.classPosition = places[i];
      s.totalInClass  = classSummaries.length;
    });
  }

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
  if (noMarkIds.length) {
    await ResultSummary.deleteMany({
      examId, schoolId, studentId: { $in: noMarkIds }, isPublished: { $ne: true },
    });
  }

  await Exam.findByIdAndUpdate(examId, { status: "completed" });
  console.log(`✅ Results processed: ${summaries.length} students`);

  return { status: 200, summaries, body: {
    success:   true,
    processed: summaries.length,
    message:   `Results processed for ${summaries.length} student(s)`,
  } };
}

module.exports = { processExam, computeGrade };
