// src/services/results.service.js
"use strict";

import ExamService from "./exam.service";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESULTS SERVICE
 *
 * A thin, offline-aware facade over ExamService. It used to call axios
 * directly with no cache at all, so a published result the student had
 * already seen became unreadable the moment they lost signal.
 *
 * Reads resolve from the local cache when the network is unavailable and
 * carry `isStale: true` so the caller can label the data as last-known.
 * Writes that need server-side aggregation (processing) surface a
 * REQUIRES_CONNECTION error rather than failing opaquely; status changes
 * are queued on the durable outbox.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Process Results ───────────────────────────────────────
// POST /api/exams/:examId/process

export async function processResults(examId, classId = null) {
  if (!examId) throw new Error("processResults: examId required");
  return ExamService.processResults({ examId, classId });
}

// ── Get Exam Results List ─────────────────────────────────
// GET /api/results/:examId

export async function getExamResults(examId, params = {}) {
  if (!examId) throw new Error("getExamResults: examId required");
  const { results, isStale } = await ExamService.getResults({
    examId,
    schoolId: params.schoolId,
    classId:  params.classId,
  });
  return { success: true, data: results, results, isStale };
}

// ── Get Rankings ──────────────────────────────────────────
// GET /api/results/:examId/rankings?rankBy=class

export async function getRankings(examId, scope = "class", classId = null) {
  if (!examId) throw new Error("getRankings: examId required");
  return ExamService.getRankings(examId, undefined, scope, classId);
}

// ── Get Single Student Result ─────────────────────────────
// GET /api/results/:examId/student/:studentId

export async function getStudentResult(examId, studentId) {
  if (!examId || !studentId) {
    throw new Error("getStudentResult: examId and studentId required");
  }
  return ExamService.getStudentResult(examId, studentId);
}

// ── Get Exam Stats ────────────────────────────────────────
// GET /api/results/:examId/stats

export async function getExamStats(examId, classId = null) {
  if (!examId) throw new Error("getExamStats: examId required");
  void classId; // stats are exam-wide server-side
  return ExamService.getExamStats(examId);
}

// ── Publish Results ───────────────────────────────────────
// PATCH /api/exams/:examId/status { status: "published" }

export async function publishResults(examId, classId = null) {
  if (!examId) throw new Error("publishResults: examId required");
  void classId;
  return ExamService.updateExamStatus(examId, "published");
}

// ── Unpublish Results ─────────────────────────────────────
// PATCH /api/exams/:examId/status { status: "completed" }

export async function unpublishResults(examId, classId = null) {
  if (!examId) throw new Error("unpublishResults: examId required");
  void classId;
  return ExamService.updateExamStatus(examId, "completed");
}
