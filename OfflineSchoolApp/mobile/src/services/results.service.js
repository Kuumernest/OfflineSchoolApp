// src/services/results.service.js
"use strict";

import api from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RESULTS API SERVICE
 *
 * NOTE: axios { data } is destructured here, so every function returns
 * the raw API response body directly.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Process Results ───────────────────────────────────────
// POST /api/exams/:examId/process

export async function processResults(examId, classId = null) {
  if (!examId) throw new Error("processResults: examId required");
  const body = {};
  if (classId) body.classId = classId;
  const { data } = await api.post(`/exams/${examId}/process`, body);
  return data;
}

// ── Get Exam Results List ─────────────────────────────────
// GET /api/results/:examId

export async function getExamResults(examId, params = {}) {
  if (!examId) throw new Error("getExamResults: examId required");
  const { data } = await api.get(`/results/${examId}`, { params });
  return data;
}

// ── Get Rankings ──────────────────────────────────────────
// GET /api/results/:examId/rankings?rankBy=class

export async function getRankings(examId, scope = "class", classId = null) {
  if (!examId) throw new Error("getRankings: examId required");
  const params = { rankBy: scope };
  if (classId) params.classId = classId;
  const { data } = await api.get(`/results/${examId}/rankings`, { params });
  return data;
}

// ── Get Single Student Result ─────────────────────────────
// GET /api/results/:examId/student/:studentId

export async function getStudentResult(examId, studentId) {
  if (!examId || !studentId) {
    throw new Error("getStudentResult: examId and studentId required");
  }
  const { data } = await api.get(`/results/${examId}/student/${studentId}`);
  return data;
}

// ── Get Exam Stats ────────────────────────────────────────
// GET /api/results/:examId/stats

export async function getExamStats(examId, classId = null) {
  if (!examId) throw new Error("getExamStats: examId required");
  const params = {};
  if (classId) params.classId = classId;
  const { data } = await api.get(`/results/${examId}/stats`, { params });
  return data;
}

// ── Publish Results ───────────────────────────────────────
// PATCH /api/exams/:examId/status { status: "published" }

export async function publishResults(examId, classId = null) {
  if (!examId) throw new Error("publishResults: examId required");
  const body = { status: "published" };
  if (classId) body.classId = classId;
  const { data } = await api.patch(`/exams/${examId}/status`, body);
  return data;
}

// ── Unpublish Results ─────────────────────────────────────
// PATCH /api/exams/:examId/status { status: "completed" }

export async function unpublishResults(examId, classId = null) {
  if (!examId) throw new Error("unpublishResults: examId required");
  const body = { status: "completed" };
  if (classId) body.classId = classId;
  const { data } = await api.patch(`/exams/${examId}/status`, body);
  return data;
}