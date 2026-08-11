// src/services/exam.service.js
"use strict";

import api from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXAM SERVICE — Mobile (React Native / Expo)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single source of truth for all exam-related API calls on mobile.
 *
 * Endpoint mapping:
 *   GET    /exams                              → getExams
 *   GET    /exams/dashboard                    → getDashboard
 *   GET    /exams/:examId                      → getExamById
 *   POST   /exams                              → createExam
 *   PUT    /exams/:examId                      → updateExam
 *   DELETE /exams/:examId                      → deleteExam
 *   PATCH  /exams/:examId/status               → updateExamStatus
 *   GET    /exams/:examId/submissions          → getSubmissions
 *   GET    /exams/:examId/scores               → getScores
 *   POST   /exams/:examId/scores/bulk          → saveBulkScores
 *   POST   /exams/:examId/process              → processResults
 *   GET    /exams/:examId/results              → getResults
 *   PATCH  /exams/:examId/subjects/:id/approve → approveSubmission
 *   PATCH  /exams/:examId/subjects/:id/reject  → rejectSubmission
 *   PATCH  /exams/:examId/subjects/:id/submit  → submitMarks
 *   GET    /results/:examId/stats              → getExamStats
 *   GET    /results/:examId/rankings           → getRankings
 *   GET    /results/:examId/student/:studentId → getStudentResult
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────
// EXAM LIST + DASHBOARD
// ─────────────────────────────────────────────────────────

/**
 * List exams for a school with optional filters.
 */
const getExams = async ({
  schoolId,
  status,
  classId,
  academicYear,
  term,
  page  = 1,
  limit = 50,
} = {}) => {
  const res = await api.get("/exams", {
    params: { schoolId, status, classId, academicYear, term, page, limit },
  });
  return res.data;
};

/**
 * Get exam dashboard statistics.
 * Returns counts by status + results overview.
 */
const getDashboard = async (schoolId) => {
  const res = await api.get("/exams/dashboard", {
    params: { schoolId },
  });
  return res.data;
};

// ─────────────────────────────────────────────────────────
// SINGLE EXAM
// ─────────────────────────────────────────────────────────

/**
 * Get a single exam by ID.
 * Returns { exam } with subjects attached.
 */
const getExamById = async (examId, schoolId) => {
  if (!examId) throw new Error("examId is required");
  const res = await api.get(`/exams/${examId}`, {
    params: { schoolId },
  });
  // Normalise both response shapes
  return { exam: res.data?.exam || res.data };
};

// ─────────────────────────────────────────────────────────
// CREATE / UPDATE / DELETE
// ─────────────────────────────────────────────────────────

/**
 * Create a new exam.
 * Returns { success, exam, serverId }
 */
const createExam = async (payload) => {
  const res = await api.post("/exams", payload);
  return res.data;
};

/**
 * Update an existing exam.
 * Returns { success, exam }
 */
const updateExam = async (examId, payload, schoolId) => {
  const res = await api.put(`/exams/${examId}`, {
    ...payload,
    ...(schoolId ? { schoolId } : {}),
  });
  return res.data;
};

/**
 * Soft-delete an exam.
 */
const deleteExam = async (examId, schoolId) => {
  const res = await api.delete(`/exams/${examId}`, {
    params: { schoolId },
  });
  return res.data;
};

/**
 * Change exam status.
 * Backend uses PATCH /:examId/status
 */
const updateExamStatus = async (examId, status, schoolId) => {
  const res = await api.patch(`/exams/${examId}/status`, {
    status,
    schoolId,
  });
  return res.data;
};

// ─────────────────────────────────────────────────────────
// SUBMISSIONS (ExamSubject records)
// ─────────────────────────────────────────────────────────

/**
 * Get ExamSubject list for an exam.
 * Optionally filtered by classId / subjectId / status.
 * Returns { submissions: ExamSubject[] }
 */
const getSubmissions = async ({
  examId,
  schoolId,
  classId,
  subjectId,
  status,
} = {}) => {
  if (!examId) throw new Error("examId is required");

  const res = await api.get(`/exams/${examId}/submissions`, {
    params: { schoolId, classId, subjectId, status },
  });

  // Normalise response shape
  const raw = res.data?.submissions || res.data?.data || [];
  return { submissions: Array.isArray(raw) ? raw : [] };
};

// ─────────────────────────────────────────────────────────
// SCORES
// ─────────────────────────────────────────────────────────

/**
 * Get scores for an exam / subject / class.
 * Returns { scores: StudentScore[] }
 */
const getScores = async ({
  examId,
  subjectId,
  classId,
  schoolId,
} = {}) => {
  if (!examId) throw new Error("examId is required");

  const res = await api.get(`/exams/${examId}/scores`, {
    params: { subjectId, classId, schoolId },
  });

  const raw = res.data?.scores || res.data?.data || [];
  return { scores: Array.isArray(raw) ? raw : [] };
};

/**
 * Save bulk scores for a subject / class.
 * Auto-marks ExamSubject as "submitted".
 * Triggers result recomputation (fire-and-forget on backend).
 *
 * @param {{
 *   examId:        string,
 *   classId:       string,
 *   subjectId:     string,
 *   examSubjectId: string,
 *   scores: Array<{
 *     studentId:     string,
 *     score:         number | null,
 *     maxScore:      number,
 *     isAbsent:      boolean,
 *     teacherRemark: string | null,
 *   }>,
 *   schoolId: string,
 * }}
 */
const saveBulkScores = async ({
  examId,
  classId,
  subjectId,
  examSubjectId,
  scores,
  schoolId,
}) => {
  if (!examId)    throw new Error("examId is required");
  if (!classId)   throw new Error("classId is required");
  if (!subjectId) throw new Error("subjectId is required");

  const res = await api.post(`/exams/${examId}/scores/bulk`, {
    classId,
    subjectId,
    examSubjectId,
    scores,
    schoolId,
  });
  return res.data;
};

// ─────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────

/**
 * Get computed results for an exam.
 * Tries /exams/:examId/results first, falls back to /results/:examId.
 * Returns { results: ResultSummary[] }
 */
const getResults = async ({ examId, schoolId, classId } = {}) => {
  if (!examId) throw new Error("examId is required");

  try {
    // Prefer exam-scoped route (exam.routes.js)
    const res = await api.get(`/exams/${examId}/results`, {
      params: { schoolId, classId },
    });
    const raw = res.data?.results || res.data?.data || [];
    return { results: Array.isArray(raw) ? raw : [] };
  } catch {
    // Fallback to results.routes.js
    const res = await api.get(`/results/${examId}`, {
      params: { schoolId, classId },
    });
    const raw = res.data?.data || res.data?.results || [];
    return { results: Array.isArray(raw) ? raw : [] };
  }
};

/**
 * Trigger result processing for an exam.
 * Calculates grades, averages, rankings.
 */
const processResults = async ({ examId, classId, schoolId }) => {
  if (!examId) throw new Error("examId is required");

  const res = await api.post(`/exams/${examId}/process`, {
    classId,
    schoolId,
  });
  return res.data;
};

/**
 * Get exam statistics (pass rate, average, grade distribution).
 */
const getExamStats = async (examId, schoolId) => {
  if (!examId) throw new Error("examId is required");

  const res = await api.get(`/results/${examId}/stats`, {
    params: { schoolId },
  });
  return res.data;
};

/**
 * Get rankings for an exam.
 * scope: "class" | "grade" | "school"
 */
const getRankings = async (examId, schoolId, scope = "class", classId) => {
  if (!examId) throw new Error("examId is required");

  const res = await api.get(`/results/${examId}/rankings`, {
    params: { schoolId, rankBy: scope, classId },
  });
  return res.data;
};

/**
 * Get a single student's result for an exam.
 */
const getStudentResult = async (examId, studentId, schoolId) => {
  if (!examId || !studentId) {
    throw new Error("examId and studentId are required");
  }

  const res = await api.get(
    `/results/${examId}/student/${studentId}`,
    { params: { schoolId } }
  );

  // Normalise both response shapes
  return res.data?.data || res.data?.result || res.data || null;
};

/**
 * Get a student's report card data.
 */
const getStudentReportCard = async (examId, studentId, schoolId) => {
  if (!examId || !studentId) {
    throw new Error("examId and studentId are required");
  }

  const res = await api.get(
    `/results/${examId}/student/${studentId}/reportcard`,
    { params: { schoolId } }
  );
  return res.data?.data || res.data || null;
};

/**
 * Get all results (paginated).
 */
const getAllResults = async ({
  examId,
  schoolId,
  classId,
  page  = 1,
  limit = 50,
} = {}) => {
  if (!examId) throw new Error("examId is required");

  const res = await api.get(`/results/${examId}`, {
    params: { schoolId, classId, page, limit },
  });
  return {
    results: res.data?.data  || [],
    total:   res.data?.total || 0,
    page:    res.data?.page  || 1,
    pages:   res.data?.pages || 1,
  };
};

// ─────────────────────────────────────────────────────────
// SUBMISSION APPROVAL WORKFLOW
// ─────────────────────────────────────────────────────────

/**
 * Approve a teacher's submitted marks.
 * PATCH /exams/:examId/subjects/:examSubjectId/approve
 */
const approveSubmission = async ({
  examId,
  examSubjectId,
  schoolId,
}) => {
  if (!examId || !examSubjectId) {
    throw new Error("examId and examSubjectId are required");
  }

  const res = await api.patch(
    `/exams/${examId}/subjects/${examSubjectId}/approve`,
    { schoolId }
  );
  return res.data;
};

/**
 * Reject a teacher's submitted marks with a reason.
 * PATCH /exams/:examId/subjects/:examSubjectId/reject
 */
const rejectSubmission = async ({
  examId,
  examSubjectId,
  reason,
  schoolId,
}) => {
  if (!examId || !examSubjectId) {
    throw new Error("examId and examSubjectId are required");
  }
  if (!reason?.trim()) {
    throw new Error("A rejection reason is required");
  }

  const res = await api.patch(
    `/exams/${examId}/subjects/${examSubjectId}/reject`,
    { reason, schoolId }
  );
  return res.data;
};

/**
 * Teacher submits their marks for admin review.
 * PATCH /exams/:examId/subjects/:examSubjectId/submit
 */
const submitMarks = async ({
  examId,
  examSubjectId,
  schoolId,
}) => {
  if (!examId || !examSubjectId) {
    throw new Error("examId and examSubjectId are required");
  }

  const res = await api.patch(
    `/exams/${examId}/subjects/${examSubjectId}/submit`,
    { schoolId }
  );
  return res.data;
};

// ─────────────────────────────────────────────────────────
// PUBLISH RESULTS
// ─────────────────────────────────────────────────────────

/**
 * Publish results — changes exam status to "published"
 * and marks all ExamResult docs as isPublished: true.
 */
const publishResults = async (examId, schoolId) => {
  if (!examId) throw new Error("examId is required");

  const res = await api.patch(`/exams/${examId}/status`, {
    status: "published",
    schoolId,
  });
  return res.data;
};

// ─────────────────────────────────────────────────────────
// EXPORT — Named object for tree-shaking safety
// ─────────────────────────────────────────────────────────

export const ExamService = {
  // Exam CRUD
  getExams,
  getDashboard,
  getExamById,
  createExam,
  updateExam,
  deleteExam,
  updateExamStatus,

  // Submissions (ExamSubject records)
  getSubmissions,

  // Scores
  getScores,
  saveBulkScores,

  // Results
  getResults,
  processResults,
  getExamStats,
  getRankings,
  getStudentResult,
  getStudentReportCard,
  getAllResults,

  // Approval workflow
  approveSubmission,
  rejectSubmission,
  submitMarks,

  // Publishing
  publishResults,
};