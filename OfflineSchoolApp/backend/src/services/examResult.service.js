// backend/src/services/examResult.service.js
"use strict";

const ExamScore   = require("../db/models/ExamScore");
const ExamResult  = require("../db/models/ExamResult");
const ExamSubject = require("../db/models/ExamSubject");
const Exam        = require("../db/models/Exam");

const {
  gradeSubject,
  normalizeTo20,
  lookupGrade,
  generateRemark,
} = require("../utils/gradeUtils");

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Sort comparator — descending average, alphabetical tiebreaker.
 */
const byAverageDesc = (a, b) => {
  const diff = b.average - a.average;
  if (diff !== 0) return diff;
  return (a.studentName || "").localeCompare(b.studentName || "");
};

/**
 * Assign dense ranks to a pre-sorted array.
 * Dense: 1, 2, 2, 3 (no gap after tie).
 */
const assignDenseRanks = (sorted, field) => {
  let currentRank = 0;
  let prevAverage = null;
  for (let i = 0; i < sorted.length; i++) {
    const avg = sorted[i].average;
    if (avg !== prevAverage) {
      currentRank = i + 1;
      prevAverage = avg;
    }
    sorted[i][field] = currentRank;
  }
};

/**
 * Group an array by the value of a key.
 */
const groupBy = (arr, key) => {
  const groups = {};
  for (const item of arr) {
    const k = item[key] || "unknown";
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
};

/**
 * True when every subject in the breakdown is absent.
 */
const isFullyAbsent = (result) => {
  if (!result.subjectScores || result.subjectScores.length === 0) return false;
  return result.subjectScores.every((s) => s.isAbsent);
};

// ─────────────────────────────────────────────────────────
// COMPUTE RESULTS
// ─────────────────────────────────────────────────────────

/**
 * Compute / recompute ExamResult documents for every student
 * in a given exam (optionally filtered to one class).
 *
 * Called after bulk score save or explicit admin trigger.
 *
 * @param {{ examId: string, classId?: string, schoolId: string }}
 * @returns {{ computed: number, warnings: string[], isPartial: boolean }}
 */
const computeResults = async ({ examId, classId, schoolId }) => {

  // ── 1. Validate exam ──────────────────────────────────
  const exam = await Exam.findOne({ _id: examId, deletedAt: null }).lean();
  if (!exam) throw new Error("EXAM_NOT_FOUND");

  const warnings = [];

  // ── 2. Check subject approval status ─────────────────
  const subjectFilter = { examId, deletedAt: null };
  if (classId) subjectFilter.classId = classId;

  const examSubjects = await ExamSubject.find(subjectFilter).lean();
  if (examSubjects.length === 0) {
    return { computed: 0, warnings: ["No subjects found"], isPartial: false };
  }

  const pendingSubjects = examSubjects.filter(
    (s) => s.submissionStatus !== "approved" && s.submissionStatus !== "rejected"
  );

  let isPartial = false;
  if (pendingSubjects.length > 0) {
    isPartial = true;
    warnings.push(
      `${pendingSubjects.length} subject(s) not yet approved. ` +
      `Results are partial. Unapproved: ` +
      pendingSubjects.map((s) => s.subjectName || s.subjectId).join(", ")
    );
  }

  // ── 3. Fetch all score records ────────────────────────
  const scoreFilter = { examId, schoolId, deletedAt: null };
  if (classId) scoreFilter.classId = classId;

  const allScores = await ExamScore.find(scoreFilter).lean();
  if (allScores.length === 0) {
    return { computed: 0, warnings: ["No scores found"], isPartial };
  }

  // ── 4. Build ExamSubject lookup map ──────────────────
  const subjectMap = new Map();
  for (const es of examSubjects) {
    subjectMap.set(String(es._id), {
      maxScore:    es.maxScore    || 100,
      passMark:    es.passMark    || 50,
      subjectName: es.subjectName || null,
      subjectId:   es.subjectId,
      classId:     es.classId,
    });
  }

  // ── 5. Group scores by studentId ─────────────────────
  const studentScoresMap = new Map();
  for (const score of allScores) {
    const sid = String(score.studentId);
    if (!studentScoresMap.has(sid)) studentScoresMap.set(sid, []);
    studentScoresMap.get(sid).push(score);
  }

  // ── 6. Calculate result for each student ─────────────
  const resultDocs = [];

  for (const [studentId, scores] of studentScoresMap) {
    const first = scores[0];

    let totalRawScore  = 0;
    let totalMaxScore  = 0;
    let totalPoints    = 0;
    let subjectsPassed = 0;
    let subjectsFailed = 0;
    let subjectsAbsent = 0;
    let subjectsTaken  = 0;

    const subjectScores = scores.map((sc) => {
      const subInfo   = subjectMap.get(String(sc.examSubjectId)) || {};
      const maxScore  = subInfo.maxScore || sc.maxScore || 100;
      const passMark  = subInfo.passMark || sc.passMark || 50;

      if (sc.isAbsent || sc.isExempt) {
        subjectsAbsent++;
        return {
          subjectId:      String(sc.subjectId),
          subjectName:    subInfo.subjectName || sc.subjectName || null,
          score:          null,
          maxScore,
          passMark,
          grade:          "AB",
          gradePoint:     0,
          percentage:     null,
          normalizedMark: null,
          isAbsent:       sc.isAbsent  || false,
          isExempt:       sc.isExempt  || false,
          isPassing:      false,
          teacherRemark:  sc.teacherRemark || null,
        };
      }

      subjectsTaken++;
      const graded = gradeSubject(sc.score ?? 0, maxScore);

      totalRawScore += sc.score ?? 0;
      totalMaxScore += maxScore;
      totalPoints   += graded.points;

      if (graded.normalizedMark >= 10) {
        subjectsPassed++;
      } else {
        subjectsFailed++;
      }

      return {
        subjectId:      String(sc.subjectId),
        subjectName:    subInfo.subjectName || sc.subjectName || null,
        score:          sc.score,
        maxScore,
        passMark,
        grade:          graded.grade,
        gradePoint:     graded.points,
        percentage:     graded.percentage,
        normalizedMark: graded.normalizedMark,
        isAbsent:       false,
        isExempt:       false,
        isPassing:      graded.isPassing,
        teacherRemark:  sc.teacherRemark || null,
      };
    });

    // Overall average on /20 scale
    const average = subjectsTaken > 0
      ? Math.round((totalPoints / subjectsTaken) * 100) / 100
      : 0;

    // Overall percentage on raw marks
    const percentage = totalMaxScore > 0
      ? Math.round((totalRawScore / totalMaxScore) * 10000) / 100
      : 0;

    const gpa = average; // same in Cameroon system

    const overallGradeInfo = lookupGrade(average * 5); // convert GPA → /20
    const overallRemark    = generateRemark({
      overallGrade: overallGradeInfo.grade,
      isPassing:    average >= 2.0,
    });

    const isPassing = average >= 2.0; // GPA 2.0 = C = passing

    resultDocs.push({
      examId,
      studentId,
      classId:      first.classId,
      schoolId,
      studentName:  first.studentName || null,
      admissionNo:  first.admissionNo || null,
      className:    first.className   || null,
      academicYear: exam.academicYear,
      term:         exam.term,
      subjectScores,
      totalScore:      Math.round(totalRawScore * 100) / 100,
      totalMaxScore:   Math.round(totalMaxScore * 100) / 100,
      percentage:      Math.round(percentage * 100) / 100,
      average:         Math.round(average * 100) / 100,
      gpa:             Math.round(gpa * 100) / 100,
      overallGrade:    overallGradeInfo.grade,
      overallRemark,
      subjectsPassed,
      subjectsFailed,
      subjectsTaken,
      subjectsAbsent,
      isPassing,
      isPartial,
      // Rankings assigned below
      classPosition:  null,
      gradePosition:  null,
      schoolPosition: null,
      totalInClass:   null,
      totalInGrade:   null,
      totalInSchool:  null,
    });
  }

  // ── 7. Assign rankings ────────────────────────────────

  const ranked   = resultDocs.filter((r) => !isFullyAbsent(r));
  const excluded = resultDocs.filter((r) =>  isFullyAbsent(r));

  // Class rankings
  const classGroups = groupBy(ranked, "classId");
  for (const members of Object.values(classGroups)) {
    members.sort(byAverageDesc);
    assignDenseRanks(members, "classPosition");
    members.forEach((m) => { m.totalInClass = members.length; });
  }

  // Grade rankings (by className as stream key)
  const gradeGroups = groupBy(ranked, "className");
  for (const members of Object.values(gradeGroups)) {
    members.sort(byAverageDesc);
    assignDenseRanks(members, "gradePosition");
    members.forEach((m) => { m.totalInGrade = members.length; });
  }

  // School rankings
  ranked.sort(byAverageDesc);
  assignDenseRanks(ranked, "schoolPosition");
  ranked.forEach((r) => { r.totalInSchool = ranked.length; });

  const allResults = [...ranked, ...excluded];

  // ── 8. Bulk upsert into ExamResult ───────────────────
  if (allResults.length > 0) {
    const bulkOps = allResults.map((r) => ({
      updateOne: {
        filter: { examId: r.examId, studentId: r.studentId },
        update: { $set: r },
        upsert: true,
      },
    }));
    await ExamResult.bulkWrite(bulkOps, { ordered: false });
  }

  return {
    computed:  allResults.length,
    warnings,
    isPartial,
    stats: generateStats(allResults),
  };
};

// ─────────────────────────────────────────────────────────
// PUBLISH RESULTS
// ─────────────────────────────────────────────────────────

/**
 * Mark all ExamResult docs as published for an exam.
 * Optionally filter to one class.
 *
 * @param {{ examId: string, classId?: string, publishedBy?: string }}
 */
const publishResults = async ({ examId, classId, publishedBy }) => {
  const filter = { examId, deletedAt: null };
  if (classId) filter.classId = classId;

  const result = await ExamResult.updateMany(filter, {
    $set: {
      isPublished: true,
      publishedAt: new Date(),
      publishedBy: publishedBy || null,
      syncStatus:  "pending",
    },
  });

  // Also mark the Exam document as published
  await Exam.updateOne({ _id: examId }, {
    $set: {
      resultsPublished:   true,
      resultsPublishedAt: new Date(),
      publishedBy:        publishedBy || null,
      status:             "published",
    },
  });

  return { published: result.modifiedCount };
};

// ─────────────────────────────────────────────────────────
// GET EXAM RESULTS (paginated)
// ─────────────────────────────────────────────────────────

const getExamResults = async (examId, classId = null, options = {}) => {
  const {
    page      = 1,
    limit     = 50,
    sortBy    = "classPosition",
    sortOrder = 1,
  } = options;

  const filter = { examId, deletedAt: null };
  if (classId) filter.classId = classId;

  const [total, results] = await Promise.all([
    ExamResult.countDocuments(filter),
    ExamResult.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  return {
    results,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  };
};

// ─────────────────────────────────────────────────────────
// GET RANKINGS
// ─────────────────────────────────────────────────────────

const getRankings = async (examId, scope = "class", classId = null) => {
  const filter = { examId, deletedAt: null };

  const sortField =
    scope === "school" ? "schoolPosition" :
    scope === "grade"  ? "gradePosition"  :
                         "classPosition";

  // Exclude fully absent students
  filter[sortField] = { $ne: null };
  if (classId) filter.classId = classId;

  return ExamResult.find(filter)
    .sort({ [sortField]: 1 })
    .lean();
};

// ─────────────────────────────────────────────────────────
// GET SINGLE STUDENT RESULT
// ─────────────────────────────────────────────────────────

const getStudentResult = async (examId, studentId) => {
  const result = await ExamResult.findOne({
    examId,
    studentId,
    deletedAt: null,
  }).lean();
  if (!result) throw new Error("RESULT_NOT_FOUND");
  return result;
};

// ─────────────────────────────────────────────────────────
// GET EXAM STATS
// ─────────────────────────────────────────────────────────

const getExamStats = async (examId, classId = null) => {
  const filter = { examId, deletedAt: null };
  if (classId) filter.classId = classId;

  const results = await ExamResult.find(filter).lean();
  return generateStats(results);
};

// ─────────────────────────────────────────────────────────
// STATS HELPER
// ─────────────────────────────────────────────────────────

const generateStats = (results) => {
  if (!results.length) {
    return {
      totalStudents:     0,
      present:           0,
      absent:            0,
      passed:            0,
      failed:            0,
      passRate:          0,
      classAverage:      0,
      highest:           0,
      lowest:            0,
      gradeDistribution: {},
    };
  }

  const present = results.filter((r) => !isFullyAbsent(r));
  const absent  = results.filter((r) =>  isFullyAbsent(r));
  const passed  = present.filter((r) => r.isPassing);
  const failed  = present.filter((r) => !r.isPassing);

  const averages     = present.map((r) => r.average).filter((a) => a != null);
  const classAverage = averages.length
    ? Math.round((averages.reduce((s, v) => s + v, 0) / averages.length) * 100) / 100
    : 0;
  const highest = averages.length ? Math.max(...averages) : 0;
  const lowest  = averages.length ? Math.min(...averages) : 0;

  const gradeDistribution = {};
  for (const r of present) {
    const g = r.overallGrade || "N/A";
    gradeDistribution[g] = (gradeDistribution[g] || 0) + 1;
  }

  return {
    totalStudents: results.length,
    present:       present.length,
    absent:        absent.length,
    passed:        passed.length,
    failed:        failed.length,
    passRate:      present.length
      ? Math.round((passed.length / present.length) * 10000) / 100
      : 0,
    classAverage,
    highest,
    lowest,
    gradeDistribution,
  };
};

// ─────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────

module.exports = {
  computeResults,
  publishResults,
  getExamResults,
  getRankings,
  getStudentResult,
  getExamStats,
};