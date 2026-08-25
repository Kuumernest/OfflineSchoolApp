// src/services/syncBackfill.service.js
"use strict";

/**
 * Turns dirty local rows into outbox mutations. It never talks to the
 * network itself.
 *
 * Why this exists
 * ---------------
 * The app used to carry two write paths side by side: a durable outbox, and
 * a per-entity sweeper that read `_synced = 0` and POSTed the row directly.
 * They overlapped. Attendance, for example, was enqueued on the outbox with
 * an Idempotency-Key AND swept by `pushUnsyncedAttendance` without one, so a
 * mutation sitting in backoff could still be sent — twice, unkeyed, ignoring
 * the retry policy the outbox had just applied.
 *
 * Now there is one sender (MutationQueue) and one producer (this module).
 * A dirty row is *evidence that work exists*, not a second transport: the
 * sweep converts it into a queued mutation and stops there. That keeps the
 * safety net — rows dirtied by an older build, or by a code path that forgot
 * to enqueue, are still picked up — without a second way to reach the wire.
 *
 * Entities are declared as specs rather than hand-written loops, and swept
 * in dependency order (classes before subjects, teachers before assignments)
 * so the outbox's FIFO ordering matches the server's referential needs.
 * Where a parent gets re-issued a server id, its reconciler records the
 * mapping and the child's queued payload is rewritten at send time.
 */

import { getDatabase } from "../db/database";
import { MutationQueue, registerReconciler, mapId } from "./mutationQueue.service";
import { API } from "./apiEndpoints";
import { getCurrentAuth, hasRole } from "../utils/authHelpers";
import { canonicalDay, VALID_DAYS } from "../utils/timetableMappers";
import { isServerGeneratedId } from "../utils/idHelpers";

const isAdmin   = () => hasRole(["super_admin", "school_admin", "admin"]);
const isTeacher = () => hasRole("teacher");
const isStudent = () => hasRole("student");

const NOT_DELETED = "(deleted_at IS NULL OR deleted_at = '')";
const IS_DIRTY    = "(_synced = 0 OR _synced IS NULL)";

/** Rows the server has never seen carry a locally generated id. */
const isServerId = (id) => typeof id === "string" && /^[0-9a-f]{24}$/i.test(id);

const safeParse = (raw, fallback) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

/** Receipts older than a day will never self-heal; stop retrying them. */
const STALE_MS = 24 * 60 * 60 * 1000;
const isStale = (updatedAt) =>
  Date.now() - new Date(updatedAt || 0).getTime() > STALE_MS;

const roleAllows = (spec) => {
  if (spec.adminOnly) return isAdmin();
  if (!spec.roles) return true;
  return spec.roles.some((r) =>
    r === "admin" ? isAdmin() : r === "teacher" ? isTeacher() : r === "student" ? isStudent() : false
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// ENTITY SPECS
//
// Each spec says: which dirty rows to look for, what mutation they become,
// which payload fields may need a late id substitution, and which reconciler
// (if any) handles the server's response.
// ═════════════════════════════════════════════════════════════════════════════

const SPECS = [
  /**
   * Fee payments taken on this device.
   *
   * The service enqueues each payment as it is taken; this sweep is the safety
   * net for the one gap that leaves — the app being killed between the local
   * INSERT and the enqueue. Without it that payment sits marked unsynced
   * forever and the money never reaches the server.
   *
   * `noLocalFlag` because the reconciler owns `_synced`: it has to clear the
   * flag AND adopt the server's receipt number in the same step.
   */
  {
    key: "feePayment",
    table: "fee_payments",
    adminOnly: true,
    where: IS_DIRTY,
    endpoint: () => "/fees/payments",
    method: "POST",
    reconcile: "feePayment",
    noLocalFlag: true,
    payload: (row, { schoolId }) => ({
      _id:          row.id,
      schoolId:     row.school_id || schoolId,
      studentId:    row.student_id,
      academicYear: row.academic_year,
      term:         row.term || null,
      amount:       row.amount,
      method:       row.method || "cash",
      reference:    row.reference || null,
      note:         row.note || null,
      receivedAt:   row.received_at,
      source:       "mobile",
    }),
  },

  /**
   * Expenses recorded on this device.
   *
   * Same safety net as fee payments, for the same gap: the app being killed
   * between the local INSERT and the enqueue. Voids are NOT swept here — a
   * pending void lives on a row that is otherwise clean (`_synced = 1`), so it
   * would not match IS_DIRTY, and sweeping it would need the reason text the
   * enqueue already carries.
   */
  {
    key: "expense",
    table: "expenses",
    adminOnly: true,
    where: IS_DIRTY,
    endpoint: () => "/finance/expenses",
    method: "POST",
    reconcile: "expense",
    noLocalFlag: true,
    payload: (row, { schoolId }) => ({
      _id:          row.id,
      schoolId:     row.school_id || schoolId,
      categoryId:   row.category_id,
      academicYear: row.academic_year || null,
      amount:       row.amount,
      description:  row.description || null,
      vendor:       row.vendor || null,
      method:       row.method || "cash",
      reference:    row.reference || null,
      incurredAt:   row.incurred_at,
    }),
  },

  /**
   * Gate scans taken on this device.
   *
   * The same safety net as fee payments and expenses: the app being killed
   * between the local INSERT and the enqueue. `direction` is included because
   * the device decided it from the scans it held, and the server must not
   * re-derive it from a view that was missing them.
   */
  {
    key: "gateScan",
    table: "gate_events",
    adminOnly: true,
    where: IS_DIRTY,
    endpoint: () => "/gate/scan",
    method: "POST",
    reconcile: "gateScan",
    noLocalFlag: true,
    payload: (row, { schoolId }) => ({
      _id:       row.id,
      schoolId:  row.school_id || schoolId,
      token:     row.token,
      at:        row.at,
      direction: row.direction,
      station:   row.station || null,
    }),
  },

  {
    key: "class",
    table: "classes",
    adminOnly: true,
    where: `${IS_DIRTY} AND ${NOT_DELETED}`,
    endpoint: () => API.admin.classes.list,
    method: "POST",
    reconcile: "class",
    payload: (row, { schoolId }) => ({
      id:       row.id,
      name:     row.name,
      level:    row.level || null,
      schoolId: row.schoolId || row.school_id || schoolId,
    }),
  },

  {
    key: "subject",
    table: "subjects",
    adminOnly: true,
    where: `${IS_DIRTY} AND ${NOT_DELETED}`,
    endpoint: () => API.admin.subjects.list,
    method: "POST",
    reconcile: "subject",
    // classId may still be a local id when this is queued behind its class.
    resolve: ["classId"],
    payload: (row, { schoolId }) => ({
      id:       row.id,
      name:     row.name,
      code:     row.code || "",
      classId:  row.class_id || row.classId || null,
      schoolId: row.schoolId || row.school_id || schoolId,
    }),
    skip: (row) => !(row.class_id || row.classId),
  },

  {
    key: "teacher",
    table: "users",
    adminOnly: true,
    where: `role = 'teacher' AND ${IS_DIRTY} AND ${NOT_DELETED}`,
    endpoint: () => API.admin.teachers.list,
    method: "POST",
    reconcile: "teacher",
    payload: (row, { schoolId }) => ({
      id:       row.id,
      name:     row.name,
      email:    row.email,
      role:     "teacher",
      schoolId: row.schoolId || row.school_id || schoolId,
    }),
  },

  {
    key: "assignment",
    table: "teacher_assignments",
    adminOnly: true,
    where: `${IS_DIRTY} AND ${NOT_DELETED}`,
    endpoint: () => API.admin.assignments.list,
    method: "POST",
    reconcile: "assignment",
    resolve: ["teacherId", "classId", "subjectId"],
    payload: (row, { schoolId }) => ({
      teacherId: row.teacherId || row.teacher_id,
      classId:   row.classId   || row.class_id,
      subjectId: row.subjectId || row.subject_id,
      schoolId:  row.schoolId  || row.school_id || schoolId,
    }),
    skip: (row) => !(row.subjectId || row.subject_id),
  },

  {
    key: "period",
    table: "periods",
    adminOnly: true,
    idColumn: "id",
    // periods tracks pending work with `dirty`, not `_synced`, so the
    // generic flag-clearing is skipped and its reconciler does it.
    noLocalFlag: true,
    where: "dirty = 1 AND (deletedat IS NULL OR deletedat = '')",
    endpoint: () => API.admin.periods.list,
    method: "POST",
    reconcile: "period",
    payload: (row, { schoolId }) => ({
      id:        row.id,
      name:      row.name,
      startTime: row.starttime,
      endTime:   row.endtime,
      isBreak:   row.isbreak === 1,
      sortOrder: row.sortorder,
      isActive:  row.isactive !== 0,
      schoolId:  row.schoolId || schoolId,
    }),
  },

  {
    key: "timetable",
    table: "timetable",
    adminOnly: true,
    idColumn: "_id",
    where: `${IS_DIRTY} AND ${NOT_DELETED}`,
    resolve: ["classId", "subjectId", "teacherId", "periodId"],
    reconcile: "timetable",
    // Existing slots are updated in place; new ones are created.
    method: (row) => (isServerGeneratedId(row._id) ? "PUT" : "POST"),
    endpoint: (row) =>
      isServerGeneratedId(row._id)
        ? API.admin.timetable.detail(row._id)
        : API.admin.timetable.list,
    payload: (row, { schoolId }) => ({
      schoolId:  row.school_id || schoolId,
      classId:   row.class_id,
      subjectId: row.subject_id,
      teacherId: row.teacher_id,
      // The stored column may hold a legacy spelling; the server only
      // accepts a VALID_DAYS code.
      dayOfWeek: canonicalDay(row.day_of_week),
      periodId:  row.period_id,
      room:      row.room ?? null,
    }),
    skip: (row) => {
      const day = canonicalDay(row.day_of_week);
      if (!day || !VALID_DAYS.includes(day)) {
        console.warn(
          `[backfill] timetable ${row._id} skipped — unresolvable day "${row.day_of_week}"`
        );
        return true;
      }
      return false;
    },
  },

  {
    key: "attendance",
    table: "attendance",
    where: IS_DIRTY,
    endpoint: () => "/attendance/students",
    method: "POST",
    resolve: ["classId", "studentId"],
    payload: (row) => ({
      schoolId:  row.schoolId,
      classId:   row.classId || row.class_id,
      subjectId: row.subjectId,
      periodId:  row.periodId,
      studentId: row.studentId || row.student_id,
      date:      row.date,
      status:    row.status,
      note:      row.note,
    }),
    skip: (row) => !(row.studentId || row.student_id),
  },

  {
    key: "teacher_attendance",
    table: "teacher_attendance",
    where: IS_DIRTY,
    endpoint: () => "/attendance/teachers",
    method: "POST",
    resolve: ["teacherId"],
    payload: (row) => ({
      schoolId:     row.schoolId,
      teacherId:    row.teacherId,
      date:         row.date,
      status:       row.status,
      checkInTime:  row.checkInTime,
      checkOutTime: row.checkOutTime,
      note:         row.note,
    }),
    skip: (row) => !row.teacherId,
  },

  {
    key: "question",
    table: "questions",
    where: `${IS_DIRTY} AND ${NOT_DELETED}`,
    endpoint: () => API.quiz.questions,
    method: "POST",
    reconcile: "question",
    payload: (row, { schoolId }) => ({
      id:            row.id,
      schoolId:      row.schoolId || schoolId,
      category_id:   row.category_id || null,
      question_text: row.question_text,
      question_type: row.question_type,
      media_url:     row.media_url  || null,
      difficulty:    row.difficulty || "medium",
      points:        row.points     || 1.0,
      explanation:   row.explanation || null,
      is_active:     row.is_active === 1,
      created_by:    row.created_by || null,
    }),
    // Options live in a child table and must ride along with the question.
    hydrate: async (db, row) => {
      const options = await db.getAllAsync(
        "SELECT * FROM question_options WHERE question_id = ? ORDER BY display_order ASC",
        [row.id]
      ).catch(() => []);
      return {
        options: (options ?? []).map((o) => ({
          id: o.id,
          option_text: o.option_text,
          is_correct: o.is_correct === 1,
          match_pair: o.match_pair || null,
          display_order: o.display_order ?? 0,
        })),
      };
    },
  },

  {
    key: "quiz",
    table: "quizzes",
    where: `${IS_DIRTY} AND ${NOT_DELETED}`,
    endpoint: () => API.quiz.list,
    method: "POST",
    reconcile: "quiz",
    resolve: ["class_id", "subject_id"],
    payload: (row, { schoolId }) => ({
      id: row.id, schoolId: row.schoolId || schoolId,
      title: row.title, description: row.description || null,
      instructions: row.instructions || null,
      class_id: row.class_id, subject_id: row.subject_id,
      time_limit_minutes: row.time_limit_minutes || null,
      time_per_question:  row.time_per_question  || null,
      shuffle_questions:  row.shuffle_questions  === 1,
      shuffle_options:    row.shuffle_options    === 1,
      questions_per_page: row.questions_per_page || 1,
      allow_backtrack:    row.allow_backtrack    === 1,
      max_attempts:       row.max_attempts       || 1,
      passing_score:      row.passing_score      || 70,
      available_from:     row.available_from     || null,
      available_until:    row.available_until    || null,
      show_answers_after: row.show_answers_after || "on_completion",
      show_score:         row.show_score         === 1,
      show_explanation:   row.show_explanation   === 1,
      is_published:       row.is_published       === 1,
      created_by:         row.created_by         || null,
    }),
    skip: (row) => !row.class_id || !row.subject_id,
    hydrate: async (db, row) => {
      const questions = await db.getAllAsync(
        `SELECT question_id, display_order, points_override
         FROM quiz_questions WHERE quiz_id = ? ORDER BY display_order ASC`,
        [row.id]
      ).catch(() => []);
      return { questions: questions ?? [] };
    },
  },

  {
    key: "announcement",
    table: "announcements",
    // Announcements track intent in _operation rather than deleted_at.
    where: "_synced = 0 AND _operation IS NOT NULL",
    roles: ["admin", "teacher"],
    method: (row) =>
      row._operation === "create" ? "POST" : row._operation === "update" ? "PUT" : "DELETE",
    endpoint: (row) =>
      row._operation === "create" ? "/announcements" : `/announcements/${row.id}`,
    reconcile: "announcement",
    payload: (row) => ({
      id:            row.id,
      title:         row.title,
      body:          row.body,
      audience:      row.audience,
      targetClasses: safeParse(row.target_classes, []),
      priority:      row.priority,
      isPinned:      row.is_pinned === 1,
      publishAt:     row.publish_at,
      expiresAt:     row.expires_at,
    }),
  },

  // Read / acknowledge receipts. Real mutations, but not user work: they
  // are marked silent so a failed one never shows up as "changes need
  // attention", and they expire rather than accumulate.
  {
    key: "announcement-read",
    table: "announcements",
    where: "_read_pending = 1",
    silent: true,
    method: "POST",
    endpoint: (row, { student }) =>
      student ? `/students/announcements/${row.id}/read` : `/announcements/${row.id}/read`,
    reconcile: "announcementReceipt",
    reconcileArgs: { column: "_read_pending" },
    payload: () => ({}),
    skip: (row) => isStale(row.updated_at),
  },
  {
    key: "announcement-ack",
    table: "announcements",
    where: "_ack_pending = 1",
    silent: true,
    method: "POST",
    endpoint: (row, { student }) =>
      student
        ? `/students/announcements/${row.id}/acknowledge`
        : `/announcements/${row.id}/acknowledge`,
    reconcile: "announcementReceipt",
    reconcileArgs: { column: "_ack_pending" },
    payload: () => ({}),
    skip: (row) => isStale(row.updated_at),
  },

  // Admission decisions. The backend exposes these under one of several
  // paths depending on version, so the mutation carries a fallback chain
  // that the outbox walks on 404 — the discovery that used to live in a
  // separate sender.
  // A student enrolled directly on this device. Must be created upstream, not
  // approved — it has no server-side application to act on.
  {
    key: "student-create",
    table: "students",
    adminOnly: true,
    noLocalFlag: true,
    where: `${IS_DIRTY} AND _operation = 'create'`,
    method: "POST",
    endpoint: () => "/students",
    reconcile: "studentEnroll",
    resolve: ["classId"],
    payload: (row, { schoolId }) => ({
      id:            row.id,
      schoolId:      row.schoolId || row.school_id || schoolId,
      classId:       row.classId  || row.class_id,
      firstName:     row.firstName || undefined,
      lastName:      row.lastName  || undefined,
      name:          row.name || row.studentName,
      email:         row.email         || undefined,
      phone:         row.phone         || undefined,
      gender:        row.gender        || undefined,
      dateOfBirth:   row.dateOfBirth   || undefined,
      address:       row.address       || undefined,
      guardianName:  row.guardianName  || undefined,
      guardianPhone: row.guardianPhone || undefined,
      guardianEmail: row.guardianEmail || undefined,
    }),
    skip: (row) => !(row.classId || row.class_id),
  },

  {
    key: "student-decision",
    table: "students",
    adminOnly: true,
    // The reconciler owns the flag here because it must also write back the
    // enrolment number the server minted.
    noLocalFlag: true,
    // `_operation = 'create'` rows belong to the spec above. Without this
    // guard a locally-enrolled student (status 'approved', unsynced) would be
    // PUT to /admin/students/<id>/approve — an id the server has never
    // seen — and fail forever.
    where:
      `${IS_DIRTY} AND status IN ('approved', 'rejected') ` +
      `AND (_operation IS NULL OR _operation != 'create')`,
    method: "PUT",
    endpoint: (row) =>
      row.status === "approved"
        ? API.admin.students.approve(row.id)
        : API.admin.students.reject(row.id),
    reconcile: "studentDecision",
    payload: (row) => ({
      classId: row.class_id || row.classId || null,
      reason:  row.rejection_reason || row.reject_reason || null,
      __endpoints:
        row.status === "approved"
          ? API.admin.students.approveFallbackChain(row.id)
          : API.admin.students.rejectFallbackChain(row.id),
    }),
    skip: (row) => row.status === "approved" && !(row.class_id || row.classId),
  },

  {
    key: "quiz_attempt",
    table: "quiz_attempts",
    where: `${IS_DIRTY} AND status IN ('submitted', 'timed_out')`,
    endpoint: () => API.quiz.attempts,
    method: "POST",
    resolve: ["quiz_id"],
    payload: (row) => ({ ...row }),
    hydrate: async (db, row) => {
      const answers = await db.getAllAsync(
        "SELECT * FROM attempt_answers WHERE attempt_id = ?", [row.id]
      ).catch(() => []);
      for (const a of answers ?? []) {
        a.selections = await db.getAllAsync(
          "SELECT * FROM attempt_answer_selections WHERE attempt_answer_id = ?", [a.id]
        ).catch(() => []);
      }
      return { answers: answers ?? [] };
    },
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// SOFT DELETES
//
// A soft-deleted row that has not synced needs a DELETE on the wire. Same
// idea as above: the sweep queues it, the outbox sends it, and a 404 counts
// as already-done (MutationQueue classifies that as "resolved").
// ═════════════════════════════════════════════════════════════════════════════

const DELETE_SPECS = [
  { key: "class",      table: "classes",             endpoint: API.admin.classes.list,     adminOnly: true },
  { key: "subject",    table: "subjects",            endpoint: API.admin.subjects.list,    adminOnly: true },
  { key: "teacher",    table: "users",               endpoint: API.admin.teachers.list,    adminOnly: true, extraWhere: "role = 'teacher'" },
  { key: "assignment", table: "teacher_assignments", endpoint: API.admin.assignments.list, adminOnly: true },
  { key: "quiz",       table: "quizzes",             endpoint: API.quiz.list },
  { key: "question",   table: "questions",           endpoint: API.quiz.questions },
  { key: "exam",       table: "exams",               endpoint: "/exams",                   adminOnly: true },
];

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILERS
//
// Registered once, at import. Each adopts the id the server chose and
// records the mapping so mutations already queued behind this one are
// rewritten before they are sent.
// ═════════════════════════════════════════════════════════════════════════════

const serverIdFrom = (response, ...paths) => {
  const d = response?.data;
  if (!d) return null;
  for (const p of paths) {
    const v = d?.[p]?._id || d?.[p]?.id;
    if (v) return String(v);
  }
  return d._id ? String(d._id) : d.id ? String(d.id) : null;
};

let _registered = false;

export const registerReconcilers = () => {
  if (_registered) return;
  _registered = true;

  registerReconciler("class", async ({ response, args }) => {
    const serverId = serverIdFrom(response, "class", "data");
    const localId  = args.localId;
    if (!serverId || !localId) return;
    await mapId(localId, serverId, "classes");
    // Reuses the proven cascade (subjects, students, assignments, quizzes).
    const { SyncManager } = require("./syncManager");
    const db = await getDatabase();
    await SyncManager._reconcileClassId(db, localId, serverId);
  });

  registerReconciler("subject", async ({ response, args }) => {
    const serverId = serverIdFrom(response, "subject", "data");
    const localId  = args.localId;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    if (serverId && localId && serverId !== localId) {
      await mapId(localId, serverId, "subjects");
      await db.runAsync(
        "UPDATE subjects SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?",
        [serverId, ts, localId]
      ).catch(() => {});
    } else if (localId) {
      await db.runAsync(
        "UPDATE subjects SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, localId]
      ).catch(() => {});
    }
  });

  registerReconciler("teacher", async ({ response, args }) => {
    const raw = response?.data?.teacher || response?.data?.user || response?.data?.data;
    const serverId = raw?._id || raw?.id || serverIdFrom(response);
    const localId  = args.localId;
    const db = await getDatabase();
    if (serverId && localId && String(serverId) !== String(localId)) {
      await mapId(localId, String(serverId), "users");
      const { SyncManager } = require("./syncManager");
      await SyncManager._replaceTeacherId(db, localId, String(serverId));
    } else if (localId) {
      await db.runAsync(
        "UPDATE users SET _synced = 1, _synced_at = ? WHERE id = ?",
        [new Date().toISOString(), localId]
      ).catch(() => {});
    }
  });

  registerReconciler("assignment", async ({ response, args }) => {
    const serverId = serverIdFrom(response, "assignment", "data");
    const localId  = args.localId;
    if (!localId) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    if (serverId && serverId !== localId) {
      await mapId(localId, serverId, "teacher_assignments");
      await db.runAsync(
        `UPDATE teacher_assignments SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?`,
        [serverId, ts, localId]
      ).catch(async () => {
        // A row with the server id already exists — drop the local duplicate.
        await db.runAsync("DELETE FROM teacher_assignments WHERE id = ?", [localId]).catch(() => {});
      });
    } else {
      await db.runAsync(
        "UPDATE teacher_assignments SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, localId]
      ).catch(() => {});
    }
  });

  registerReconciler("period", async ({ args }) => {
    const db = await getDatabase();
    await db.runAsync(
      "UPDATE periods SET dirty = 0, operation = NULL WHERE id = ?", [args.localId]
    ).catch(() => {});
  });

  registerReconciler("timetable", async ({ response, args }) => {
    const db = await getDatabase();
    const ts = new Date().toISOString();
    const localId = args.localId;
    if (!localId) return;

    const slot = response?.data?.slot || response?.data?.data;
    const serverId = slot?._id ? String(slot._id) : slot?.id ? String(slot.id) : null;

    if (serverId && serverId !== localId) {
      await mapId(localId, serverId, "timetable");
      await db.runAsync(
        "UPDATE timetable SET _id = ?, _synced = 1, _synced_at = ?, updated_at = ? WHERE _id = ?",
        [serverId, ts, ts, localId]
      ).catch(async () => {
        await db.runAsync("DELETE FROM timetable WHERE _id = ?", [localId]).catch(() => {});
      });
    } else {
      await db.runAsync(
        "UPDATE timetable SET _synced = 1, _synced_at = ? WHERE _id = ?", [ts, localId]
      ).catch(() => {});
    }
  });

  registerReconciler("question", async ({ response, args }) => {
    const serverId = serverIdFrom(response, "question", "data");
    const localId  = args.localId;
    if (!localId) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();

    if (serverId && serverId !== localId) {
      await mapId(localId, serverId, "questions");
      const { withFkOff, withTransaction } = require("../db/dbHelpers");
      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          await db.runAsync("UPDATE questions SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?", [serverId, ts, localId]);
          for (const t of ["question_options", "quiz_questions", "attempt_answers", "question_analytics"]) {
            await db.runAsync(`UPDATE ${t} SET question_id = ? WHERE question_id = ?`, [serverId, localId]).catch(() => {});
          }
        });
      }).catch((err) => console.warn("[backfill] question reconcile:", err.message));
    } else {
      await db.runAsync("UPDATE questions SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, localId]).catch(() => {});
    }
  });

  registerReconciler("quiz", async ({ response, args }) => {
    const serverId = serverIdFrom(response, "quiz", "data");
    const localId  = args.localId;
    if (!localId) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();

    if (serverId && serverId !== localId) {
      await mapId(localId, serverId, "quizzes");
      const { withFkOff, withTransaction } = require("../db/dbHelpers");
      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          await db.runAsync("UPDATE quizzes SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?", [serverId, ts, localId]);
          for (const t of ["quiz_questions", "quiz_attempts", "quiz_analytics"]) {
            await db.runAsync(`UPDATE ${t} SET quiz_id = ? WHERE quiz_id = ?`, [serverId, localId]).catch(() => {});
          }
        });
      }).catch((err) => console.warn("[backfill] quiz reconcile:", err.message));
    } else {
      await db.runAsync("UPDATE quizzes SET _synced = 1, _synced_at = ? WHERE id = ?", [ts, localId]).catch(() => {});
    }
  });

  registerReconciler("announcement", async ({ args }) => {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE announcements SET _synced = 1, _synced_at = ?, _operation = NULL WHERE id = ?`,
      [new Date().toISOString(), args.localId]
    ).catch(() => {});
  });

  /**
   * A fee payment reached the server.
   *
   * Two things happen here and both matter:
   *
   *   The row is marked synced, so the pending badge clears.
   *
   *   The receipt number is adopted from the response. The phone deliberately
   *   never invents one — two devices offline would both mint the same number
   *   and the receipt book would have duplicates — so until this runs the row
   *   simply has none, and the UI says "pending" rather than showing a number
   *   that might be wrong.
   *
   * The server answers a replayed send with the row it already stored, so a
   * retry adopts the same receipt number rather than a second one.
   */
  registerReconciler("feePayment", async ({ response, args }) => {
    const db = await getDatabase();

    // `response` is the axios response, so the body is response.data and the
    // payment itself is response.data.data — the server answers
    // { success, data: payment, totals }. Reading response.data.receiptNo
    // instead yields undefined and the receipt number silently never arrives,
    // which is a bug nothing would surface: the row still syncs, it just never
    // gets a number.
    const body    = response?.data ?? {};
    const payment = body.data ?? body;
    const receiptNo = payment?.receiptNo ?? null;

    await db.runAsync(
      `UPDATE fee_payments
          SET _synced = 1, _synced_at = ?, receipt_no = COALESCE(?, receipt_no)
        WHERE id = ?`,
      [new Date().toISOString(), receiptNo, args.localId]
    ).catch(() => {});
  });

  /**
   * An expense reached the server.
   *
   * Like the fee-payment reconciler, `response` is the axios response, so the
   * row is at response.data.data. A replayed send answers 200 with the row
   * already stored rather than a duplicate-key error, so a retry settles the
   * same way a first send does.
   */
  registerReconciler("expense", async ({ args }) => {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE expenses SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [new Date().toISOString(), args.localId]
    ).catch(() => {});
  });

  /**
   * A void reached the server.
   *
   * Clears only the void flag. `_synced` is left alone because it describes the
   * expense row itself, which was already sent — conflating the two would mark
   * an unsent expense as synced the moment someone voided it.
   */
  registerReconciler("expenseVoid", async ({ args }) => {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE expenses SET _void_pending = 0 WHERE id = ?`,
      [args.localId]
    ).catch(() => {});
  });

  /** A gate scan reached the server. */
  registerReconciler("gateScan", async ({ args }) => {
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE gate_events SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [new Date().toISOString(), args.localId]
    ).catch(() => {});
  });

  registerReconciler("announcementReceipt", async ({ args }) => {
    const column = args.column === "_ack_pending" ? "_ack_pending" : "_read_pending";
    const db = await getDatabase();
    await db.runAsync(
      `UPDATE announcements SET ${column} = 0 WHERE id = ?`, [args.localId]
    ).catch(() => {});
  });

  registerReconciler("studentEnroll", async ({ response, args }) => {
    const db = await getDatabase();
    const ts = new Date().toISOString();
    const localId = args.localId;
    if (!localId) return;

    const created =
      response?.data?.student || response?.data?.data || response?.data || null;
    const serverId = created?._id || created?.id || null;
    const enrollmentNo =
      created?.enrollmentNo || created?.enrollment_no ||
      response?.data?.enrollmentNo || null;

    // Credentials the server minted while creating the login account. They are
    // returned exactly once (POST /students response), so this is the only
    // chance to capture them — the add-student screen reads them back from
    // this row to show the "share credentials" card, like the web does.
    const tempPassword = response?.data?.tempPassword || null;
    const emailSent    = response?.data?.emailSent === true;

    // Adopt the id the server assigned so later edits target the right row.
    if (serverId && String(serverId) !== String(localId)) {
      await mapId(localId, String(serverId), "students");
      await db.runAsync(
        `UPDATE students SET id = ?, _synced = 1, _operation = NULL, updated_at = ?
         WHERE id = ?`,
        [String(serverId), ts, localId]
      ).catch(async () => {
        // A row with the server id already arrived via sync — drop the local one.
        await db.runAsync("DELETE FROM students WHERE id = ?", [localId]).catch(() => {});
      });
    } else {
      await db.runAsync(
        `UPDATE students SET _synced = 1, _operation = NULL, updated_at = ? WHERE id = ?`,
        [ts, localId]
      ).catch(() => {});
    }

    if (enrollmentNo) {
      const targetId = serverId || localId;
      await db.runAsync(
        `UPDATE students
         SET enrollmentNo = ?, enrollment_no = ?, admissionNo = ?, admissionNumber = ?
         WHERE id = ?`,
        [enrollmentNo, enrollmentNo, enrollmentNo, enrollmentNo, String(targetId)]
      ).catch(() => {});
    }

    if (tempPassword) {
      const targetId = serverId || localId;
      await db.runAsync(
        `UPDATE students SET temp_password = ?, email_sent = ? WHERE id = ?`,
        [tempPassword, emailSent ? 1 : 0, String(targetId)]
      ).catch(() => {});
    }

    console.log(
      `[backfill] Student enrolled upstream${enrollmentNo ? ` as ${enrollmentNo}` : ""}` +
        `${tempPassword && !emailSent ? " (credentials to share manually)" : ""}`
    );
  });

  registerReconciler("studentDecision", async ({ response, args }) => {
    const db = await getDatabase();
    const ts = new Date().toISOString();

    // An approval is where the server mints the enrolment number, so it has
    // to be written back or the roster keeps showing a blank.
    const enrollmentNo =
      response?.data?.enrollmentNo ||
      response?.data?.enrollment_no ||
      response?.data?.student?.enrollmentNo ||
      null;

    await db.runAsync(
      `UPDATE students SET _synced = 1, updated_at = ? WHERE id = ?`,
      [ts, args.localId]
    ).catch(() => {});

    if (enrollmentNo) {
      await db.runAsync(
        `UPDATE students
         SET enrollmentNo = ?, enrollment_no = ?,
             admissionNo  = ?, admissionNumber = ?, updated_at = ?
         WHERE id = ?`,
        [enrollmentNo, enrollmentNo, enrollmentNo, enrollmentNo, ts, args.localId]
      ).catch(() => {});
    }
  });

  registerReconciler("timetableDelete", async ({ args }) => {
    // The row is gone upstream, so the local tombstone can go too.
    const db = await getDatabase();
    await db.runAsync("DELETE FROM timetable WHERE _id = ?", [args.localId]).catch(() => {});
  });

  registerReconciler("softDelete", async ({ args }) => {
    const db = await getDatabase();
    const { table, localId } = args;
    if (!table || !localId) return;
    await db.runAsync(
      `UPDATE ${table} SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [new Date().toISOString(), localId]
    ).catch(() => {});
  });
};

// ═════════════════════════════════════════════════════════════════════════════
// SWEEP
// ═════════════════════════════════════════════════════════════════════════════

const tableExists = async (db, table) => {
  const row = await db.getFirstAsync(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]
  ).catch(() => null);
  return !!row;
};

const enqueueSpec = async (db, spec, ctx) => {
  if (!roleAllows(spec)) return 0;
  if (!(await tableExists(db, spec.table))) return 0;

  const idCol = spec.idColumn || "id";
  const rows = await db.getAllAsync(
    `SELECT * FROM ${spec.table} WHERE ${spec.where}`
  ).catch(() => []);
  if (!rows?.length) return 0;

  // One query instead of one per row.
  const queued = await MutationQueue.pendingKeys(`${spec.key}:`);

  let n = 0;
  for (const row of rows) {
    const localId = row[idCol];
    if (!localId) continue;
    if (spec.skip?.(row)) continue;

    const entityKey = `${spec.key}:${localId}`;
    if (queued.has(entityKey)) continue;   // already waiting its turn

    try {
      const extra = spec.hydrate ? await spec.hydrate(db, row) : {};
      const payload = {
        ...spec.payload(row, ctx),
        ...extra,
        // `_synced` is cleared generically for tables that have the column;
        // specs whose reconciler owns the flag (periods uses `dirty`) opt out.
        ...(spec.silent || spec.noLocalFlag
          ? {}
          : { __local: { table: spec.table, ids: [localId], idColumn: idCol } }),
        ...(spec.resolve ? { __resolve: spec.resolve } : {}),
        ...(spec.reconcile
          ? { __reconcile: { kind: spec.reconcile, localId, table: spec.table, ...(spec.reconcileArgs ?? {}) } }
          : {}),
      };

      await MutationQueue.enqueue({
        entityKey,
        method:   typeof spec.method === "function" ? spec.method(row) : spec.method,
        endpoint: spec.endpoint(row, ctx),
        payload,
        silent:   !!spec.silent,
      });
      n++;
    } catch (err) {
      console.warn(`[backfill] ${spec.key} ${localId}:`, err.message);
    }
  }
  return n;
};

const enqueueDeletes = async (db, spec) => {
  if (!roleAllows(spec)) return 0;
  if (!(await tableExists(db, spec.table))) return 0;

  const where = [
    "(deleted_at IS NOT NULL AND deleted_at != '')",
    IS_DIRTY,
    ...(spec.extraWhere ? [spec.extraWhere] : []),
  ].join(" AND ");

  const rows = await db.getAllAsync(`SELECT id FROM ${spec.table} WHERE ${where}`).catch(() => []);
  if (!rows?.length) return 0;

  const queued = await MutationQueue.pendingKeys(`${spec.key}-delete:`);
  let n = 0;

  for (const row of rows) {
    const entityKey = `${spec.key}-delete:${row.id}`;
    if (queued.has(entityKey)) continue;
    await MutationQueue.enqueue({
      entityKey,
      method: "DELETE",
      endpoint: `${spec.endpoint}/${row.id}`,
      payload: {
        __local: { table: spec.table, ids: [row.id] },
        __reconcile: { kind: "softDelete", table: spec.table, localId: row.id },
      },
    });
    n++;
  }
  return n;
};

/**
 * Timetable deletes need a case the generic delete sweep does not have: a
 * slot the server never saw is simply dropped locally, because there is
 * nothing upstream to delete.
 */
const enqueueTimetableDeletes = async (db) => {
  if (!isAdmin()) return 0;
  if (!(await tableExists(db, "timetable"))) return 0;

  const rows = await db.getAllAsync(
    `SELECT _id FROM timetable
     WHERE (deleted_at IS NOT NULL AND deleted_at != '') AND ${IS_DIRTY}`
  ).catch(() => []);
  if (!rows?.length) return 0;

  const queued = await MutationQueue.pendingKeys("timetable-delete:");
  let n = 0;

  for (const row of rows) {
    const id = row._id;
    if (!id) continue;

    if (!isServerGeneratedId(id)) {
      await db.runAsync("DELETE FROM timetable WHERE _id = ?", [id]).catch(() => {});
      continue;
    }

    const entityKey = `timetable-delete:${id}`;
    if (queued.has(entityKey)) continue;

    await MutationQueue.enqueue({
      entityKey,
      method: "DELETE",
      endpoint: API.admin.timetable.detail(id),
      payload: { __reconcile: { kind: "timetableDelete", localId: id } },
    });
    n++;
  }
  return n;
};

/**
 * Moves content deletes that older builds parked in `upload_queue` onto the
 * outbox. They are JSON mutations and never belonged in the binary-upload
 * table; content.service now enqueues them directly.
 */
const adoptQueuedContentDeletes = async (db) => {
  if (!(await tableExists(db, "upload_queue"))) return 0;

  const rows = await db.getAllAsync(
    `SELECT id, payload FROM upload_queue
     WHERE type = 'content_delete' AND status IN ('pending', 'failed')`
  ).catch(() => []);
  if (!rows?.length) return 0;

  let n = 0;
  for (const row of rows) {
    const contentId = safeParse(row.payload, {})?.contentId;
    if (contentId) {
      await MutationQueue.enqueue({
        entityKey: `content:${contentId}`,
        method: "DELETE",
        endpoint: `/teacher/content/${contentId}`,
        payload: { id: contentId },
      });
      n++;
    }
    await db.runAsync(`DELETE FROM upload_queue WHERE id = ?`, [row.id]).catch(() => {});
  }
  if (n) console.log(`[backfill] Adopted ${n} queued content delete(s) into the outbox`);
  return n;
};

/**
 * Sweeps every entity and returns how many mutations were queued.
 * Purely local — safe to run offline, and cheap when nothing is dirty.
 */
export const backfillOutbox = async () => {
  registerReconcilers();

  const db = await getDatabase();
  const { schoolId } = getCurrentAuth();
  const ctx = { schoolId, student: isStudent() };

  let total = 0;
  const byKey = {};

  const adopted = await adoptQueuedContentDeletes(db).catch(() => 0);
  if (adopted) { byKey["content-delete"] = adopted; total += adopted; }

  // Order is the dependency order: a child is queued after its parent, so
  // the outbox's FIFO drain satisfies the server's referential expectations.
  for (const spec of SPECS) {
    const n = await enqueueSpec(db, spec, ctx).catch((err) => {
      console.warn(`[backfill] spec "${spec.key}" failed:`, err.message);
      return 0;
    });
    if (n) { byKey[spec.key] = n; total += n; }
  }

  // Deletes last: removing a parent before its children are pushed would
  // strand them.
  for (const spec of DELETE_SPECS) {
    const n = await enqueueDeletes(db, spec).catch(() => 0);
    if (n) { byKey[`${spec.key}-delete`] = n; total += n; }
  }

  const ttDeletes = await enqueueTimetableDeletes(db).catch(() => 0);
  if (ttDeletes) { byKey["timetable-delete"] = ttDeletes; total += ttDeletes; }

  if (total) console.log(`[backfill] Queued ${total} mutation(s):`, byKey);
  return { total, byKey };
};

export default { backfillOutbox, registerReconcilers };
