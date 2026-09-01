// backend/src/services/results.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESULTS SERVICE — Processing Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles:
 *   - Full exam result processing
 *   - Class rankings (dense ranking — ties share position)
 *   - School rankings (dense ranking)
 *   - Result publishing and locking
 *   - Statistics generation
 *
 * Processing can be triggered:
 *   - For the entire exam (all classes)
 *   - For a single class within an exam
 *
 * Partial processing:
 *   - If not all ExamSubjects are approved, processing continues
 *   - Results are marked as "partial" via a flag
 *   - Admin receives a warning about unapproved subjects
 * ═══════════════════════════════════════════════════════════════════════════
 */

const Exam          = require("../db/models/Exam");
const ExamSubject   = require("../db/models/ExamSubject");
const StudentScore  = require("../db/models/StudentScore");
const ResultSummary = require("../db/models/ResultSummary");

const {
  calculateOverallResult,
  generateRemark,
  gradeSubject,
} = require("./grading.service");

// ─── Main Processing Function ─────────────────────────────────────────────

/**
 * Process results for an exam (optionally filtered to one class).
 *
 * @param {string}      examId
 * @param {string|null} classId
 * @param {string|null} processedBy
 * @returns {Promise<{
 *   processed: number,
 *   warnings:  string[],
 *   isPartial: boolean,
 *   stats:     object,
 * }>}
 */
async function processResults(examId, classId = null, processedBy = null) {

  // ── Step 1: Validate exam ──────────────────────────────────────────────
  const exam = await Exam.findOne({ _id: examId, deletedAt: null });
  if (!exam) throw new Error("EXAM_NOT_FOUND");

  const warnings = [];

  // ── Step 2: Check subject approval status ─────────────────────────────
  const subjectFilter = { examId, deletedAt: null };
  if (classId) subjectFilter.classId = classId;

  const examSubjects = await ExamSubject.find(subjectFilter);
  if (examSubjects.length === 0) throw new Error("NO_SUBJECTS_FOUND");

  const pendingSubjects = examSubjects.filter(
    (s) => s.submissionStatus !== "approved" && s.submissionStatus !== "rejected"
  );

  let isPartial = false;
  if (pendingSubjects.length > 0) {
    isPartial = true;
    warnings.push(
      `${pendingSubjects.length} subject(s) not yet approved. ` +
      `Results are marked as PARTIAL. Unapproved: ` +
      pendingSubjects.map((s) => s.subjectName || s.subjectId).join(", ")
    );
  }

  // ── Step 3: Fetch all student scores ──────────────────────────────────
  const scoreFilter = { examId, deletedAt: null };
  if (classId) scoreFilter.classId = classId;

  const allScores = await StudentScore.find(scoreFilter);
  if (allScores.length === 0) throw new Error("NO_SCORES_FOUND");

  // ── Step 4: Build ExamSubject lookup map ──────────────────────────────
  const subjectMap = new Map();
  for (const es of examSubjects) {
    subjectMap.set(String(es._id), {
      maxScore:    es.maxScore    || 100,
      subjectName: es.subjectName || null,
      subjectId:   es.subjectId,
      classId:     es.classId,
      // Canonical weight semantics: ExamSubject.weight is percentage-style
      // (schema default 100). ÷100 → multiplier coefficient, so the default
      // leaves every subject equally weighted (×1).
      weight:      es.weight,
    });
  }

  // ── Step 5: Group scores by studentId ─────────────────────────────────
  const studentScoresMap = new Map();
  for (const score of allScores) {
    const sid = String(score.studentId);
    if (!studentScoresMap.has(sid)) studentScoresMap.set(sid, []);
    studentScoresMap.get(sid).push(score);
  }

  // ── Step 6: Calculate results for each student ────────────────────────
  const resultDocs     = [];
  const scoreUpdateOps = [];

  for (const [studentId, scores] of studentScoresMap) {
    // Build the per-subject input array for grading
    const subjectScores = [];

    for (const scoreDoc of scores) {
      const subjectInfo = subjectMap.get(String(scoreDoc.examSubjectId));
      const maxScore    = subjectInfo?.maxScore || scoreDoc.maxScore || 100;

      // Percentage-style weight → multiplier coefficient (default 100 ⇒ ×1).
      const coefficient = subjectInfo?.weight != null
        ? Math.round((Number(subjectInfo.weight) / 100) * 100) / 100 || 1
        : 1;

      subjectScores.push({
        score:       scoreDoc.score  ?? 0,
        maxScore,
        coefficient,
        isAbsent:    scoreDoc.isAbsent  || false,
        isExempt:    scoreDoc.isExempt  || false,
        subjectId:   String(scoreDoc.subjectId),
        subjectName: subjectInfo?.subjectName || null,
      });

      // Queue a grade write-back to StudentScore
      if (!scoreDoc.isAbsent && !scoreDoc.isExempt && scoreDoc.score != null) {
        const graded = gradeSubject(scoreDoc.score, maxScore);
        scoreUpdateOps.push({
          updateOne: {
            filter: { _id: scoreDoc._id },
            update: {
              $set: {
                percentage: Math.round((scoreDoc.score / maxScore) * 10000) / 100,
                grade:      graded.grade,
                remark:     graded.remark,
                gpaPoints:  graded.points,
                isPassing:  graded.isPassing,
                syncStatus: "pending",
              },
            },
          },
        });
      }
    }

    // Calculate overall result
    const overall = calculateOverallResult(subjectScores);
    const remark  = generateRemark(overall);
    const first   = scores[0];

    resultDocs.push({
      examId,
      studentId,
      classId:      first.classId,
      schoolId:     exam.schoolId,
      studentName:  first.studentName  || null,
      admissionNo:  first.admissionNo  || null,
      className:    first.className    || null,
      academicYear: exam.academicYear,
      term:         exam.term,
      totalScore:       overall.totalScore,
      maxTotalScore:    overall.maxTotalScore,
      percentage:       overall.percentage,
      average:          overall.normalizedAverage,
      overallGrade:     overall.overallGrade,
      overallRemark:    remark,
      gpa:              overall.gpa,
      subjectsPassed:   overall.subjectsPassed,
      subjectsFailed:   overall.subjectsFailed,
      subjectsTotal:    overall.subjectsTotal,
      isPassing:        overall.isPassing,
      subjectBreakdown: overall.subjectBreakdown,
      isPartial,
      isPublished: false,
      isLocked:    false,
      classPosition:  null,
      gradePosition:  null,
      schoolPosition: null,
      totalInClass:   null,
      totalInGrade:   null,
      totalInSchool:  scores.length,
      syncStatus: "pending",
    });
  }

  // ── Step 7: Assign Rankings ────────────────────────────────────────────

  const isStudentFullyAbsent = (r) => {
    if (!r.subjectBreakdown || r.subjectBreakdown.length === 0) return false;
    return r.subjectBreakdown.every((s) => s.isAbsent || s.isExempt);
  };

  const byAverageDesc = (a, b) => {
    const diff = b.average - a.average;
    if (diff !== 0) return diff;
    return (a.studentName || "").localeCompare(b.studentName || "");
  };

  const groupBy = (arr, key) => {
    const groups = {};
    for (const item of arr) {
      const k = item[key] || "unknown";
      if (!groups[k]) groups[k] = [];
      groups[k].push(item);
    }
    return groups;
  };

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

  const rankedResults   = resultDocs.filter((r) => !isStudentFullyAbsent(r));
  const excludedResults = resultDocs.filter((r) =>  isStudentFullyAbsent(r));

  // Class rankings
  const classGroups = groupBy(rankedResults, "classId");
  for (const members of Object.values(classGroups)) {
    members.sort(byAverageDesc);
    assignDenseRanks(members, "classPosition");
    members.forEach((m) => { m.totalInClass = members.length; });
  }

  // Grade/stream rankings
  const gradeGroups = groupBy(rankedResults, "className");
  for (const members of Object.values(gradeGroups)) {
    members.sort(byAverageDesc);
    assignDenseRanks(members, "gradePosition");
    members.forEach((m) => { m.totalInGrade = members.length; });
  }

  // School rankings
  rankedResults.sort(byAverageDesc);
  assignDenseRanks(rankedResults, "schoolPosition");
  const totalInSchool = rankedResults.length;
  rankedResults.forEach((r) => { r.totalInSchool = totalInSchool; });

  const allResults = [...rankedResults, ...excludedResults];

  // ── Step 8: Bulk Upsert ResultSummary ─────────────────────────────────
  if (allResults.length > 0) {
    const bulkOps = allResults.map((r) => ({
      updateOne: {
        filter: { examId: r.examId, studentId: r.studentId },
        update: { $set: r },
        upsert: true,
      },
    }));
    await ResultSummary.bulkWrite(bulkOps, { ordered: false });
  }

  // ── Step 9: Write grades back to StudentScore ──────────────────────────
  if (scoreUpdateOps.length > 0) {
    await StudentScore.bulkWrite(scoreUpdateOps, { ordered: false });
  }

  // ── Step 10: Generate stats ────────────────────────────────────────────
  const stats = generateStats(allResults);

  return {
    processed: allResults.length,
    warnings,
    isPartial,
    stats,
  };
}

// ─── Publish Results ──────────────────────────────────────────────────────

/**
 * Mark results as published.
 *
 * @param {string}      examId
 * @param {string|null} classId
 * @param {string|null} publishedBy
 */
async function publishResults(examId, classId = null, publishedBy = null) {
  const exam = await Exam.findOne({ _id: examId, deletedAt: null });
  if (!exam) throw new Error("EXAM_NOT_FOUND");

  const filter = { examId };
  if (classId) filter.classId = classId;

  const result = await ResultSummary.updateMany(filter, {
    $set: {
      isPublished: true,
      publishedAt: new Date(),
      syncStatus:  "pending",
    },
  });

  await Exam.updateOne({ _id: examId }, {
    $set: {
      resultsPublished:   true,
      resultsPublishedAt: new Date(),
      publishedBy:        publishedBy,
      status:             "published",
    },
  });

  return { published: result.modifiedCount };
}

// ─── Unpublish Results ────────────────────────────────────────────────────

async function unpublishResults(examId, classId = null) {
  const filter = { examId };
  if (classId) filter.classId = classId;

  const result = await ResultSummary.updateMany(filter, {
    $set: {
      isPublished: false,
      syncStatus:  "pending",
    },
  });

  await Exam.updateOne({ _id: examId }, {
    $set: { resultsPublished: false },
  });

  return { unpublished: result.modifiedCount };
}

// ─── Get Exam Results ─────────────────────────────────────────────────────

async function getExamResults(examId, classId = null, options = {}) {
  const {
    page      = 1,
    limit     = 50,
    sortBy    = "classPosition",
    sortOrder = 1,
  } = options;

  const filter = { examId, deletedAt: null };
  if (classId) filter.classId = classId;

  const [total, results] = await Promise.all([
    ResultSummary.countDocuments(filter),
    ResultSummary.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  return {
    results,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

// ─── Get Rankings ─────────────────────────────────────────────────────────

async function getRankings(examId, scope = "class", classId = null) {
  const filter = { examId, deletedAt: null };

  if (scope === "class") {
    filter.classPosition  = { $ne: null };
    if (classId) filter.classId = classId;
  } else if (scope === "grade") {
    filter.gradePosition  = { $ne: null };
    if (classId) filter.classId = classId;
  } else {
    filter.schoolPosition = { $ne: null };
  }

  const sortField =
    scope === "school" ? "schoolPosition" :
    scope === "grade"  ? "gradePosition"  :
                         "classPosition";

  const results = await ResultSummary.find(filter)
    .sort({ [sortField]: 1 })
    .lean();

  // Backfill studentName, admissionNo and className for rows that predate
  // denormalisation. Without this, old ranking rows render with no class,
  // no number, and a bare student id instead of a name.
  await backfillRankingNames(results);

  return results;
}

/**
 * Patch studentName / admissionNo / className onto ResultSummary rows that were
 * processed before the fields were denormalised — in-memory for the caller AND
 * persisted so the next read skips the extra joins. `enrollmentNo` is the single
 * source of truth for the number; `admissionNo` is only read as a legacy fallback.
 */
async function backfillRankingNames(results) {
  const incomplete = results.filter(
    (r) => r.studentId && (!r.studentName || !r.admissionNo || !r.className)
  );
  if (incomplete.length === 0) return;

  const Student = require("../db/models/Student");
  const Class   = require("../db/models/Class");

  const sIds = [...new Set(incomplete.map((r) => r.studentId))];
  const schoolIds = [...new Set(incomplete.map((r) => r.schoolId).filter(Boolean))];

  const [students, classes] = await Promise.all([
    Student.find({ _id: { $in: sIds } })
      .select("_id studentName firstName lastName enrollmentNo admissionNo classId")
      .lean(),
    Class.find({ schoolId: { $in: schoolIds } }).select("_id name").lean(),
  ]);

  const sMap = new Map(students.map((s) => [String(s._id), s]));
  const cMap = new Map(classes.map((c) => [String(c._id), c.name]));
  const bulkOps = [];

  for (const r of incomplete) {
    const s = sMap.get(String(r.studentId));
    if (!s) continue;

    const name    = s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" ") || null;
    const admNo   = s.enrollmentNo || s.admissionNo || null;
    const clsName = cMap.get(String(s.classId)) || null;

    const $set = {};
    if (name    && !r.studentName) { r.studentName = name;    $set.studentName = name;    }
    if (admNo   && !r.admissionNo) { r.admissionNo = admNo;   $set.admissionNo = admNo;   }
    if (clsName && !r.className)   { r.className   = clsName; $set.className   = clsName; }

    if (Object.keys($set).length > 0) {
      bulkOps.push({ updateOne: { filter: { _id: r._id }, update: { $set } } });
    }
  }

  if (bulkOps.length > 0) {
    await ResultSummary.bulkWrite(bulkOps).catch(() => {});
  }
}

// ─── Get Single Student Result ────────────────────────────────────────────

async function getStudentResult(examId, studentId) {
  const result = await ResultSummary.findOne({
    examId,
    studentId,
    deletedAt: null,
  }).lean();

  if (!result) throw new Error("RESULT_NOT_FOUND");
  return result;
}

// ─── Get Exam Stats ───────────────────────────────────────────────────────

async function getExamStats(examId, classId = null) {
  const filter = { examId, deletedAt: null };
  if (classId) filter.classId = classId;

  const results = await ResultSummary.find(filter).lean();
  return generateStats(results);
}

// ─── Stats Generator ──────────────────────────────────────────────────────

function generateStats(results) {
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
      subjectStats:      [],
    };
  }

  const isFullyAbsent = (r) =>
    r.subjectBreakdown?.length > 0 &&
    r.subjectBreakdown.every((s) => s.isAbsent);

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

  // Subject analysis — per-subject aggregates from each student's breakdown,
  // using percentages so the UI can render them alongside the pass rate.
  const subjectAgg = new Map();
  for (const r of results) {
    for (const s of r.subjectBreakdown || []) {
      if (s.isAbsent || s.isExempt || s.score == null) continue;
      const key = String(s.subjectId || s.subjectName || "");
      if (!key) continue;
      if (!subjectAgg.has(key)) {
        subjectAgg.set(key, {
          subjectId: s.subjectId || key,
          subjectName: s.subjectName || key,
          total: 0, sum: 0, highest: -Infinity, lowest: Infinity, passed: 0,
        });
      }
      const agg = subjectAgg.get(key);
      agg.total += 1;
      const pct = s.percentage != null && Number.isFinite(Number(s.percentage))
        ? Number(s.percentage)
        : s.maxScore > 0 ? Math.round((Number(s.score) / Number(s.maxScore)) * 10000) / 100 : 0;
      agg.sum += pct;
      if (pct > agg.highest) agg.highest = pct;
      if (pct < agg.lowest)  agg.lowest  = pct;
      if (s.isPassing) agg.passed += 1;
    }
  }
  const subjectStats = [...subjectAgg.values()].map((a) => ({
    subjectId:   a.subjectId,
    subjectName: a.subjectName,
    average:     a.total > 0 ? Math.round((a.sum / a.total) * 100) / 100 : 0,
    highest:     a.total > 0 ? a.highest : 0,
    lowest:      a.total > 0 ? a.lowest  : 0,
    passRate:    a.total > 0 ? Math.round((a.passed / a.total) * 10000) / 100 : 0,
    total:       a.total,
  }));

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
    subjectStats,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  processResults,
  publishResults,
  unpublishResults,
  getExamResults,
  getRankings,
  getStudentResult,
  getExamStats,
};