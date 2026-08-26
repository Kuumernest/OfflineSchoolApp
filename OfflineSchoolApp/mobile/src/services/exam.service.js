// src/services/exam.service.js
"use strict";

import api from "./api";
import { MutationQueue } from "./mutationQueue.service";
import { generateUUID } from "../utils/idHelpers";
import * as ExamCache from "./examCache.service";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXAM SERVICE — Mobile (React Native / Expo)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Offline-first. This module used to be a bare axios passthrough, which made
 * every exam screen fail with no signal — including mark entry, the one exam
 * task most likely to happen in a room with no connectivity.
 *
 * Read  → hit the network, refresh the local cache, return fresh data.
 *         If the request fails, serve the cache and flag `isStale: true`.
 * Write → apply locally first, then enqueue on the durable outbox so the
 *         mutation survives app restarts. Returns `queued: true` when the
 *         write has not reached the server yet.
 *
 * The one exception is result *processing* (ranking, grade computation):
 * it aggregates every class's marks server-side and cannot be derived from
 * one device, so it reports a clear offline error instead of pretending.
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
// OFFLINE PLUMBING
// ─────────────────────────────────────────────────────────

/** True when the failure was connectivity, not a rejection by the server. */
const isOfflineError = (err) =>
  !!err?.isOffline || !err?.response ||
  err?.code === "ECONNABORTED" ||
  (err?.response?.status >= 500);

const offlineOnly = (action) => {
  const err = new Error(
    `${action} needs a connection — it is computed on the server from every ` +
    `class's marks. Your saved marks are queued and will upload automatically.`
  );
  err.code = "REQUIRES_CONNECTION";
  return err;
};

/**
 * Network-first read with a cache fallback.
 *
 * @param {() => Promise<T>}       fetcher  performs the request
 * @param {(data:T) => Promise<*>} cacheFn  persists the response
 * @param {() => Promise<T|null>}  readFn   reads the local copy
 * @param {string}                 label    for logs
 */
const readThrough = async (fetcher, cacheFn, readFn, label) => {
  try {
    const fresh = await fetcher();
    await cacheFn(fresh).catch((err) =>
      console.warn(`[ExamService] cache write failed (${label}):`, err.message)
    );
    return { data: fresh, isStale: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    const cached = await readFn().catch(() => null);
    const empty =
      cached == null ||
      (Array.isArray(cached) && cached.length === 0);

    if (empty) {
      console.warn(`[ExamService] ${label}: offline and nothing cached`);
      const e = new Error(
        `No connection, and no saved ${label} on this device yet.`
      );
      e.code = "OFFLINE_NO_CACHE";
      e.cause = err;
      throw e;
    }

    console.log(`[ExamService] ${label}: offline — serving cached copy`);
    return { data: cached, isStale: true };
  }
};

// ─────────────────────────────────────────────────────────
// EXAM LIST + DASHBOARD
// ─────────────────────────────────────────────────────────

/**
 * List exams for a school with optional filters.
 * Returns { exams, isStale }.
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
  const filters = { schoolId, status, classId, academicYear, term };

  const { data, isStale } = await readThrough(
    async () => {
      const res = await api.get("/exams", {
        params: { ...filters, page, limit },
      });
      const raw = res.data?.exams || res.data?.data || [];
      return Array.isArray(raw) ? raw : [];
    },
    (exams) => ExamCache.cacheExams(exams),
    () => ExamCache.getExamsLocal(filters),
    "exams"
  );

  return { exams: data, isStale };
};

/**
 * Get exam dashboard statistics.
 * Counts are derived locally when offline so the screen still renders.
 */
const getDashboard = async (schoolId) => {
  try {
    const res = await api.get("/exams/dashboard", { params: { schoolId } });
    await ExamCache.putBlob(`dashboard:${schoolId}`, res.data).catch(() => {});
    return { ...res.data, isStale: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    const cached = await ExamCache.getBlob(`dashboard:${schoolId}`);
    if (cached?.data) {
      return { ...cached.data, isStale: true, cachedAt: cached.cachedAt };
    }

    // Nothing cached — derive the counts we can from local exams.
    const exams = await ExamCache.getExamsLocal({ schoolId }).catch(() => []);
    const byStatus = exams.reduce((acc, e) => {
      const k = e.status || "draft";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return {
      dashboard: { total: exams.length, byStatus },
      isStale: true,
      derivedOffline: true,
    };
  }
};

// ─────────────────────────────────────────────────────────
// SINGLE EXAM
// ─────────────────────────────────────────────────────────

/**
 * Get a single exam by ID.
 * Returns { exam, isStale } with subjects attached.
 */
const getExamById = async (examId, schoolId) => {
  if (!examId) throw new Error("examId is required");

  const { data, isStale } = await readThrough(
    async () => {
      const res = await api.get(`/exams/${examId}`, { params: { schoolId } });
      return res.data?.exam || res.data;
    },
    async (exam) => {
      if (!exam) return;
      await ExamCache.cacheExams([exam]);
      if (Array.isArray(exam.subjects) && exam.subjects.length) {
        await ExamCache.cacheExamSubjects(exam.subjects, examId);
      }
    },
    () => ExamCache.getExamByIdLocal(examId),
    "exam"
  );

  return { exam: data, isStale };
};

// ─────────────────────────────────────────────────────────
// CREATE / UPDATE / DELETE
// ─────────────────────────────────────────────────────────

/**
 * Create a new exam.
 *
 * The id is generated on the device (Exam._id is a String UUID server-side),
 * so the exam exists locally the moment it is created and the POST can be
 * retried safely — the server returns the same exam for a known id.
 *
 * Returns { success, exam, serverId, queued }
 */
const createExam = async (payload) => {
  const id = payload?.id || generateUUID();
  const body = { ...payload, id };

  await ExamCache.cacheExams([{ ...body, _id: id, updatedAt: new Date().toISOString() }])
    .catch((err) => console.warn("[ExamService] local exam write failed:", err.message));

  if (Array.isArray(payload?.subjects) && payload.subjects.length) {
    const subjects = payload.subjects.map((s) => ({ ...s, id: s.id || generateUUID() }));
    body.subjects = subjects;
    await ExamCache.cacheExamSubjects(
      subjects.map((s) => ({ ...s, _id: s.id, examId: id })), id
    ).catch(() => {});
  }

  try {
    const res = await api.post("/exams", body);
    const serverExam = res.data?.exam || res.data;
    if (serverExam) await ExamCache.cacheExams([serverExam]).catch(() => {});
    return { ...res.data, exam: serverExam, serverId: id, queued: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    await MutationQueue.enqueue({
      entityKey: `exam:${id}`,
      method: "POST",
      endpoint: "/exams",
      payload: { ...body, __local: { table: "exams", ids: [id] } },
    });

    console.log(`[ExamService] Exam "${body.name}" saved offline — queued for upload`);
    return {
      success: true,
      queued: true,
      serverId: id,
      exam: await ExamCache.getExamByIdLocal(id),
    };
  }
};

/**
 * Update an existing exam.
 * Returns { success, exam, queued }
 */
const updateExam = async (examId, payload, schoolId) => {
  if (!examId) throw new Error("examId is required");

  const body = { ...payload, ...(schoolId ? { schoolId } : {}) };

  await ExamCache.cacheExams([{
    ...(await ExamCache.getExamByIdLocal(examId)),
    ...body,
    _id: examId,
    updatedAt: new Date().toISOString(),
  }]).catch(() => {});

  try {
    const res = await api.put(`/exams/${examId}`, body);
    const serverExam = res.data?.exam || res.data;
    if (serverExam) await ExamCache.cacheExams([serverExam]).catch(() => {});
    return { ...res.data, queued: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    await MutationQueue.enqueue({
      entityKey: `exam:${examId}`,
      method: "PUT",
      endpoint: `/exams/${examId}`,
      payload: { ...body, __local: { table: "exams", ids: [String(examId)] } },
    });
    return { success: true, queued: true };
  }
};

/**
 * Soft-delete an exam.
 */
const deleteExam = async (examId, schoolId) => {
  if (!examId) throw new Error("examId is required");

  const { getDatabase } = require("../db/database");
  const db = await getDatabase();
  await ExamCache.ensureExamTables();
  await db.runAsync(
    "UPDATE exams SET deleted_at = ?, _synced = 0, updated_at = ? WHERE id = ?",
    [new Date().toISOString(), new Date().toISOString(), String(examId)]
  ).catch(() => {});

  try {
    const res = await api.delete(`/exams/${examId}`, { params: { schoolId } });
    return { ...res.data, queued: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    await MutationQueue.enqueue({
      entityKey: `exam:${examId}`,
      method: "DELETE",
      endpoint: `/exams/${examId}`,
      payload: { id: examId, schoolId, __local: { table: "exams", ids: [String(examId)] } },
    });
    return { success: true, queued: true };
  }
};

/**
 * Change exam status.
 * Backend uses PATCH /:examId/status
 */
const updateExamStatus = async (examId, status, schoolId) => {
  if (!examId) throw new Error("examId is required");

  const { getDatabase } = require("../db/database");
  const db = await getDatabase();
  await ExamCache.ensureExamTables();
  await db.runAsync(
    "UPDATE exams SET status = ?, _synced = 0, updated_at = ? WHERE id = ?",
    [status, new Date().toISOString(), String(examId)]
  ).catch(() => {});

  try {
    const res = await api.patch(`/exams/${examId}/status`, { status, schoolId });
    await db.runAsync("UPDATE exams SET _synced = 1 WHERE id = ?", [String(examId)]).catch(() => {});
    return { ...res.data, queued: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    await MutationQueue.enqueue({
      entityKey: `exam-status:${examId}`,
      method: "PATCH",
      endpoint: `/exams/${examId}/status`,
      payload: { status, schoolId, __local: { table: "exams", ids: [String(examId)] } },
    });
    return { success: true, queued: true };
  }
};

// ─────────────────────────────────────────────────────────
// SUBMISSIONS (ExamSubject records)
// ─────────────────────────────────────────────────────────

/**
 * Get ExamSubject list for an exam.
 * Returns { submissions, isStale }
 */
const getSubmissions = async ({
  examId,
  schoolId,
  classId,
  subjectId,
  status,
} = {}) => {
  if (!examId) throw new Error("examId is required");

  const { data, isStale } = await readThrough(
    async () => {
      const res = await api.get(`/exams/${examId}/submissions`, {
        params: { schoolId, classId, subjectId, status },
      });
      const raw = res.data?.submissions || res.data?.data || [];
      return Array.isArray(raw) ? raw : [];
    },
    (subs) => ExamCache.cacheExamSubjects(subs, examId),
    () => ExamCache.getExamSubjectsLocal({ examId, classId, subjectId, status }),
    "submissions"
  );

  return { submissions: data, isStale };
};

/**
 * Attach a subject to an exam (creates the ExamSubject record).
 *
 * The exam-create screen used to POST these one-by-one with raw axios, so
 * an exam authored offline came out with no subjects and therefore no mark
 * sheets. ExamSubject._id is a String UUID server-side, so the device can
 * mint the id and the POST becomes safely retryable.
 *
 * @returns {Promise<{ success: boolean, queued: boolean, id: string }>}
 */
const assignExamSubject = async ({
  examId, subjectId, classId, teacherId = null,
  subjectName = null, maxScore = 100, passMark = 50, weight = 100, schoolId,
}) => {
  if (!examId)    throw new Error("examId is required");
  if (!subjectId) throw new Error("subjectId is required");

  const id = generateUUID();
  const body = { id, subjectId, classId, teacherId, maxScore, passMark, weight, schoolId };

  await ExamCache.cacheExamSubjects([{
    _id: id, examId, subjectId, classId, schoolId, teacherId,
    subjectName, maxScore, passMark, weight, submissionStatus: "pending",
  }], examId).catch(() => {});

  try {
    const res = await api.post(`/exams/${examId}/subjects`, body);
    const created = res.data?.examSubject || res.data?.subject || res.data;
    if (created) await ExamCache.cacheExamSubjects([created], examId).catch(() => {});
    return { success: true, queued: false, id: created?._id || created?.id || id };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    await MutationQueue.enqueue({
      entityKey: `exam-subject:${id}`,
      method: "POST",
      endpoint: `/exams/${examId}/subjects`,
      payload: body,
    });
    return { success: true, queued: true, id };
  }
};

/**
 * Update one exam subject's settings — the coefficient lives here, stored
 * server-side as percentage-style `weight` (100 = ×1, 200 = ×2).
 *
 * Offline the change is written to the local cache and queued, keyed by the
 * exam subject so repeated edits replace each other rather than stacking.
 * `reprocessRequired` is true when marks already exist and averages are now
 * stale; offline it is assumed true, because the device cannot know.
 *
 * @returns {Promise<{ success: boolean, queued: boolean, reprocessRequired: boolean }>}
 */
const updateExamSubject = async ({
  examId, examSubjectId, updates, schoolId, cachedRow = null,
}) => {
  if (!examId)        throw new Error("examId is required");
  if (!examSubjectId) throw new Error("examSubjectId is required");

  const body = { ...updates, schoolId };

  try {
    const res = await api.put(`/exams/${examId}/subjects/${examSubjectId}`, body);
    const updated = res.data?.subject;
    if (updated) await ExamCache.cacheExamSubjects([updated], examId).catch(() => {});
    return {
      success: true, queued: false,
      reprocessRequired: Boolean(res.data?.reprocessRequired),
    };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    if (cachedRow) {
      await ExamCache.cacheExamSubjects(
        [{ ...cachedRow, ...updates, _id: examSubjectId, examId }], examId
      ).catch(() => {});
    }
    await MutationQueue.enqueue({
      entityKey: `exam-subject-update:${examSubjectId}`,
      method:    "PUT",
      endpoint:  `/exams/${examId}/subjects/${examSubjectId}`,
      payload:   body,
    });
    return { success: true, queued: true, reprocessRequired: true };
  }
};

// ─────────────────────────────────────────────────────────
// SCORES
// ─────────────────────────────────────────────────────────

/**
 * Get scores for an exam / subject / class.
 *
 * Locally-edited rows that have not synced yet always win over the server
 * copy — otherwise a refresh would silently discard marks the teacher just
 * typed. Such rows come back with `isPending: true`.
 *
 * Returns { scores, isStale }
 */
const getScores = async ({
  examId,
  subjectId,
  classId,
  schoolId,
} = {}) => {
  if (!examId) throw new Error("examId is required");

  let isStale = false;

  try {
    const res = await api.get(`/exams/${examId}/scores`, {
      params: { subjectId, classId, schoolId },
    });
    const raw = res.data?.scores || res.data?.data || [];
    await ExamCache.cacheScores(Array.isArray(raw) ? raw : [], {
      examId, subjectId, classId, schoolId,
    }).catch((err) => console.warn("[ExamService] cacheScores:", err.message));
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    isStale = true;
    console.log("[ExamService] scores: offline — serving cached mark sheet");
  }

  // Read back from SQLite either way, so unsynced local edits are included.
  const scores = await ExamCache.getScoresLocal({ examId, subjectId, classId })
    .catch(() => []);

  return { scores, isStale };
};

/**
 * Save bulk scores for a subject / class.
 *
 * Writes to SQLite first, then pushes. If the push cannot happen the
 * mutation goes on the durable outbox keyed by exam+class+subject, so a
 * later re-entry of the same mark sheet replaces the queued one instead of
 * stacking duplicates.
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
 *   enteredBy?: string,
 * }}
 * @returns {Promise<{ success: boolean, queued: boolean, saved: number }>}
 */
const saveBulkScores = async ({
  examId,
  classId,
  subjectId,
  examSubjectId,
  scores,
  schoolId,
  enteredBy = null,
}) => {
  if (!examId)    throw new Error("examId is required");
  if (!classId)   throw new Error("classId is required");
  if (!subjectId) throw new Error("subjectId is required");

  const localIds = await ExamCache.saveScoresLocal({
    examId, classId, subjectId, examSubjectId, schoolId, scores, enteredBy,
  });

  const body = { classId, subjectId, examSubjectId, scores, schoolId };

  try {
    const res = await api.post(`/exams/${examId}/scores/bulk`, body);

    // Confirmed by the server — clear the dirty flags.
    const { getDatabase } = require("../db/database");
    const db = await getDatabase();
    if (localIds.length) {
      const ph = localIds.map(() => "?").join(",");
      await db.runAsync(
        `UPDATE exam_scores SET _synced = 1, _synced_at = ? WHERE id IN (${ph})`,
        [new Date().toISOString(), ...localIds]
      ).catch(() => {});
    }

    return { ...res.data, success: true, queued: false, saved: localIds.length };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    await MutationQueue.enqueue({
      entityKey: `exam-scores:${examId}:${classId}:${subjectId}`,
      method: "POST",
      endpoint: `/exams/${examId}/scores/bulk`,
      payload: { ...body, __local: { table: "exam_scores", ids: localIds } },
    });

    console.log(
      `[ExamService] ${localIds.length} score(s) saved offline — queued for upload`
    );
    return { success: true, queued: true, saved: localIds.length };
  }
};

// ─────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────

/**
 * Get computed results for an exam.
 * Tries /exams/:examId/results first, falls back to /results/:examId,
 * and to the local cache when both are unreachable.
 * Returns { results, isStale }
 */
const getResults = async ({ examId, schoolId, classId } = {}) => {
  if (!examId) throw new Error("examId is required");

  const { data, isStale } = await readThrough(
    async () => {
      try {
        // Prefer exam-scoped route (exam.routes.js)
        const res = await api.get(`/exams/${examId}/results`, {
          params: { schoolId, classId },
        });
        const raw = res.data?.results || res.data?.data || [];
        return Array.isArray(raw) ? raw : [];
      } catch (err) {
        if (isOfflineError(err)) throw err;
        // Fallback to results.routes.js
        const res = await api.get(`/results/${examId}`, {
          params: { schoolId, classId },
        });
        const raw = res.data?.data || res.data?.results || [];
        return Array.isArray(raw) ? raw : [];
      }
    },
    (results) => ExamCache.cacheResults(results, examId),
    () => ExamCache.getResultsLocal({ examId, classId }),
    "results"
  );

  return { results: data, isStale };
};

/**
 * Trigger result processing for an exam.
 * Server-side aggregation across every class — cannot run on-device.
 */
const processResults = async ({ examId, classId, schoolId }) => {
  if (!examId) throw new Error("examId is required");

  try {
    const res = await api.post(`/exams/${examId}/process`, { classId, schoolId });
    // Processing rewrites results — refresh the cache while we are online.
    await getResults({ examId, schoolId, classId }).catch(() => {});
    return res.data;
  } catch (err) {
    if (isOfflineError(err)) throw offlineOnly("Processing results");
    throw err;
  }
};

/**
 * Get exam statistics (pass rate, average, grade distribution).
 */
const getExamStats = async (examId, schoolId) => {
  if (!examId) throw new Error("examId is required");
  const key = `stats:${examId}:${schoolId ?? ""}`;

  try {
    const res = await api.get(`/results/${examId}/stats`, { params: { schoolId } });
    await ExamCache.putBlob(key, res.data).catch(() => {});
    return { ...res.data, isStale: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const cached = await ExamCache.getBlob(key);
    if (!cached?.data) throw offlineOnly("Exam statistics");
    return { ...cached.data, isStale: true, cachedAt: cached.cachedAt };
  }
};

/**
 * Get rankings for an exam.
 * scope: "class" | "grade" | "school"
 */
const getRankings = async (examId, schoolId, scope = "class", classId) => {
  if (!examId) throw new Error("examId is required");
  const key = `rankings:${examId}:${scope}:${classId ?? ""}`;

  try {
    const res = await api.get(`/results/${examId}/rankings`, {
      params: { schoolId, rankBy: scope, classId },
    });
    await ExamCache.putBlob(key, res.data).catch(() => {});
    return { ...res.data, isStale: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const cached = await ExamCache.getBlob(key);
    if (!cached?.data) throw offlineOnly("Rankings");
    return { ...cached.data, isStale: true, cachedAt: cached.cachedAt };
  }
};

/**
 * Get a single student's result for an exam.
 */
const getStudentResult = async (examId, studentId, schoolId) => {
  if (!examId || !studentId) {
    throw new Error("examId and studentId are required");
  }

  try {
    const res = await api.get(
      `/results/${examId}/student/${studentId}`,
      { params: { schoolId } }
    );
    const result = res.data?.data || res.data?.result || res.data || null;
    if (result) await ExamCache.cacheResults([{ ...result, examId, studentId }], examId).catch(() => {});
    return result;
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const cached = await ExamCache.getStudentResultLocal(examId, studentId);
    if (!cached) {
      const e = new Error("No connection, and this result is not saved on the device yet.");
      e.code = "OFFLINE_NO_CACHE";
      throw e;
    }
    return { ...cached, isStale: true };
  }
};

/**
 * Get a student's report card data.
 */
const getStudentReportCard = async (examId, studentId, schoolId) => {
  if (!examId || !studentId) {
    throw new Error("examId and studentId are required");
  }
  const key = `reportcard:${examId}:${studentId}`;

  try {
    const res = await api.get(
      `/results/${examId}/student/${studentId}/reportcard`,
      { params: { schoolId } }
    );
    const data = res.data?.data || res.data || null;
    await ExamCache.putBlob(key, data).catch(() => {});
    return data;
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const cached = await ExamCache.getBlob(key);
    if (!cached?.data) throw offlineOnly("Report card");
    return { ...cached.data, isStale: true, cachedAt: cached.cachedAt };
  }
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

  try {
    const res = await api.get(`/results/${examId}`, {
      params: { schoolId, classId, page, limit },
    });
    const results = res.data?.data || [];
    await ExamCache.cacheResults(results, examId).catch(() => {});
    return {
      results,
      total:   res.data?.total || 0,
      page:    res.data?.page  || 1,
      pages:   res.data?.pages || 1,
      isStale: false,
    };
  } catch (err) {
    if (!isOfflineError(err)) throw err;
    const results = await ExamCache.getResultsLocal({ examId, classId }).catch(() => []);
    return {
      results,
      total: results.length,
      page: 1,
      pages: 1,
      isStale: true,
    };
  }
};

// ─────────────────────────────────────────────────────────
// SUBMISSION APPROVAL WORKFLOW
// ─────────────────────────────────────────────────────────

/**
 * Shared implementation for the three status transitions on an ExamSubject.
 * Each flips the local row immediately so the button responds, then either
 * pushes or queues.
 */
const transitionSubmission = async ({
  examId, examSubjectId, action, localStatus, body = {},
}) => {
  if (!examId || !examSubjectId) {
    throw new Error("examId and examSubjectId are required");
  }

  await ExamCache.setExamSubjectStatusLocal(examSubjectId, localStatus, {
    submittedAt: action === "submit" ? new Date().toISOString() : null,
    rejectReason: body.reason ?? null,
  });

  const endpoint = `/exams/${examId}/subjects/${examSubjectId}/${action}`;

  try {
    const res = await api.patch(endpoint, body);
    const { getDatabase } = require("../db/database");
    const db = await getDatabase();
    await db.runAsync(
      "UPDATE exam_subjects SET _synced = 1, _synced_at = ? WHERE id = ?",
      [new Date().toISOString(), String(examSubjectId)]
    ).catch(() => {});
    return { ...res.data, queued: false };
  } catch (err) {
    if (!isOfflineError(err)) throw err;

    await MutationQueue.enqueue({
      entityKey: `exam-subject-status:${examSubjectId}`,
      method: "PATCH",
      endpoint,
      payload: body,
    });
    return { success: true, queued: true };
  }
};

/**
 * Approve a teacher's submitted marks.
 * PATCH /exams/:examId/subjects/:examSubjectId/approve
 */
const approveSubmission = async ({ examId, examSubjectId, schoolId }) =>
  transitionSubmission({
    examId, examSubjectId,
    action: "approve", localStatus: "approved",
    body: { schoolId },
  });

/**
 * Reject a teacher's submitted marks with a reason.
 * PATCH /exams/:examId/subjects/:examSubjectId/reject
 */
const rejectSubmission = async ({ examId, examSubjectId, reason, schoolId }) => {
  if (!reason?.trim()) throw new Error("A rejection reason is required");
  return transitionSubmission({
    examId, examSubjectId,
    action: "reject", localStatus: "rejected",
    body: { reason, schoolId },
  });
};

/**
 * Teacher submits their marks for admin review.
 * PATCH /exams/:examId/subjects/:examSubjectId/submit
 */
const submitMarks = async ({ examId, examSubjectId, schoolId }) =>
  transitionSubmission({
    examId, examSubjectId,
    action: "submit", localStatus: "submitted",
    body: { schoolId },
  });

// ─────────────────────────────────────────────────────────
// PUBLISH RESULTS
// ─────────────────────────────────────────────────────────

/**
 * Publish results — changes exam status to "published"
 * and marks all ExamResult docs as isPublished: true.
 */
const publishResults = async (examId, schoolId) =>
  updateExamStatus(examId, "published", schoolId);

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
  assignExamSubject,
  updateExamSubject,

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

  // Offline helpers
  countUnsyncedScores: ExamCache.countUnsyncedScores,
};

export default ExamService;
