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
import {
  MutationQueue, registerReconciler, mapId, outboxRowsForTable, localIdsOf,
} from "./mutationQueue.service";
import { API } from "./apiEndpoints";
import { getCurrentAuth, hasRole } from "../utils/authHelpers";
import { canonicalDay, VALID_DAYS } from "../utils/timetableMappers";
import { isServerGeneratedId } from "../utils/idHelpers";
import { CREDENTIAL_ROW, credentialRowIds, repairCredentialRows } from "../db/credentialCache";
import { repairPupilSyncFlags } from "../db/pupilSync";

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

/**
 * Whether the server has this teacher, so a dirty row is an edit (PUT) and
 * not a create (POST). The id alone cannot say: the server keeps the id a
 * phone created a teacher under (POST /admin/teachers takes `id` as _id), so
 * a teacher made here is still `local_…` after it is accepted. Proof is
 * either of:
 *   - a server-shaped id (a UUID or ObjectId — what the server mints; this
 *     app's own ids are `local_…`);
 *   - `_synced_at`, set only when the server accepted the row: by the pull,
 *     the create's success (TeacherService.create or the reconciler), or a
 *     settled send. A teacher created here and never accepted has none.
 * When in doubt this says "known": a PUT for a teacher the server lacks is a
 * visible 404; a POST for one it has is a 409, or restores a removed account.
 */
export const teacherKnownToServer = (row) =>
  isServerGeneratedId(row?.id) || !!(row?._synced_at && String(row._synced_at).trim());

/**
 * Where a teacher's create stands, for deleting it (MutationQueue.createState
 * vocabulary): "sent", "inflight", "unsent" or "none".
 *
 * A teacher the server is known to have is "sent" whatever the queue says.
 * TeacherService.create() also POSTs directly while online, outside the
 * queue; it stamps `_create_sent_at` before that request and clears it only
 * on a refusal, so a direct send that got no answer reads as "inflight" —
 * it may have landed — and not as "none".
 */
export const teacherCreateState = async (row) => {
  if (teacherKnownToServer(row)) return "sent";
  const state = await MutationQueue.createState(`teacher:${row.id}`);
  if (state === "none" && row?._create_sent_at && String(row._create_sent_at).trim()) return "inflight";
  return state;
};

/**
 * Drop a teacher created on this phone that the server cannot have: the row,
 * its queued create (and any edit or delete queued for it), and the teacher
 * assignments that point at it — those were made against an id the server
 * has never seen, and once the teacher is gone they could only fail for ever.
 *
 * Returns false, dropping nothing, when any of those assignments may have
 * reached the server (synced, a server id, or a create attempted): the server
 * checks the teacher exists before it accepts an assignment, so the teacher
 * may have landed too, and its delete must go on the wire instead.
 *
 * The caller has already established the teacher's own create is "unsent" or
 * "none" (teacherCreateState).
 */
export const dropUnsentTeacher = async (db, row) => {
  const id = row?.id;
  if (!id) return false;

  let deps = [];
  if (await tableExists(db, "teacher_assignments")) {
    const cols = new Set(
      ((await db.getAllAsync("PRAGMA table_info(teacher_assignments)").catch(() => [])) ?? []).map((c) => c.name)
    );
    const teacherCols = ["teacher_id", "teacherId"].filter((c) => cols.has(c));
    if (teacherCols.length) {
      deps = (await db.getAllAsync(
        `SELECT * FROM teacher_assignments WHERE ${teacherCols.map((c) => `${c} = ?`).join(" OR ")}`,
        teacherCols.map(() => id)
      ).catch(() => null)) ?? null;
      if (deps === null) return false;   // could not look: do not guess
    }
  }

  for (const dep of deps) {
    if (isServerGeneratedId(dep.id)) return false;
    if (dep._synced_at && String(dep._synced_at).trim()) return false;
    const s = await MutationQueue.createState(`assignment:${dep.id}`);
    if (s === "sent" || s === "inflight") return false;
  }

  for (const dep of deps) {
    await MutationQueue.cancelUnsent(`assignment:${dep.id}`);
    await MutationQueue.cancelUnsent(`assignment-delete:${dep.id}`);
    await db.runAsync("DELETE FROM teacher_assignments WHERE id = ?", [dep.id]).catch(() => {});
  }
  for (const k of [`teacher:${id}`, `teacher-update:${id}`, `teacher-delete:${id}`]) {
    await MutationQueue.cancelUnsent(k);
  }
  await db.runAsync("DELETE FROM users WHERE id = ? AND LOWER(role) = 'teacher'", [id]);
  return true;
};

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

  /**
   * A dirty class nothing has queued — the safety net, since ClassService
   * queues its own create, edit, toggle and delete. Classes keep the id the
   * device chose, and POST /admin/classes answers a repeat with the row it
   * already holds, so for a class the server has this is a harmless replay
   * that settles the flag; for one it lacks, it is the create, carrying every
   * field the form took (it used to send only id, name and level).
   */
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
      section:  row.section || "",
      ...(row.classTeacherId ? { classTeacherId: row.classTeacherId } : {}),
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
      ...(Number(row.coefficient) > 0 ? { coefficient: Number(row.coefficient) } : {}),
    }),
    skip: (row) => !(row.class_id || row.classId),
  },

  /**
   * A dirty teacher row: an edit of a teacher the server has (PUT), or a
   * teacher created on this device and never accepted (POST). Never a
   * sign-in's credential cache: that row is the server's own account (an
   * online sign-in just answered for it), and POSTing it made the server
   * answer 409 — parked for good — or, for a teacher the school had removed,
   * RESTORE the account with a new password (db/credentialCache.js,
   * check-credential-rows.js).
   *
   * Every dirty row used to be POSTed, so an edit made on the phone also went
   * out as a create, with the same two outcomes (check-teacher-edits.js). The
   * dirty flag says only that work exists; whether it is a create or an edit
   * is teacherKnownToServer(). An edit is keyed like TeacherService.update()'s
   * own PUT, so the two coalesce rather than both being sent.
   */
  {
    key: "teacher",
    table: "users",
    adminOnly: true,
    where: `role = 'teacher' AND ${IS_DIRTY} AND ${NOT_DELETED} AND NOT ${CREDENTIAL_ROW}`,
    entityKey: (row) => (teacherKnownToServer(row) ? `teacher-update:${row.id}` : `teacher:${row.id}`),
    method:    (row) => (teacherKnownToServer(row) ? "PUT" : "POST"),
    endpoint:  (row) =>
      teacherKnownToServer(row) ? API.admin.teachers.detail(row.id) : API.admin.teachers.list,
    guardEdits: true,
    reconcile: "teacher",
    payload: (row, { schoolId }) => (teacherKnownToServer(row)
      // PUT /admin/teachers/:id updates name and email and nothing else: it
      // never reactivates a teacher the school has removed.
      ? { name: row.name, email: row.email }
      : {
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
    // The device's id goes with it: POST /admin/teacher-assignments keeps it
    // and answers a repeat with the row it already made, so a retry after a
    // lost answer is a replay, not a second assignment.
    payload: (row, { schoolId }) => ({
      id:        row.id,
      teacherId: row.teacherId || row.teacher_id,
      classId:   row.classId   || row.class_id,
      subjectId: row.subjectId || row.subject_id,
      schoolId:  row.schoolId  || row.school_id || schoolId,
    }),
    skip: (row) => !(row.subjectId || row.subject_id),
  },

  /**
   * periods.service records what a dirty row needs in `operation`: 'create'
   * for one this device made (the server has never seen it), otherwise an
   * edit of one it has. This always POSTed, so every offline edit of an
   * existing period created a second period instead. POST /admin/periods
   * mints its own id; the reconciler adopts it.
   */
  {
    key: "period",
    table: "periods",
    adminOnly: true,
    idColumn: "id",
    // periods tracks pending work with `dirty`, not `_synced`, so the
    // generic flag-clearing is skipped and its reconciler does it.
    noLocalFlag: true,
    where: "dirty = 1 AND (deletedat IS NULL OR deletedat = '')",
    method:   (row) => (row.operation === "create" ? "POST" : "PUT"),
    endpoint: (row) =>
      row.operation === "create" ? API.admin.periods.list : API.admin.periods.detail(row.id),
    guardEdits: true,
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

  /**
   * Questions and quizzes are ObjectId-keyed on the server, which keeps the
   * device's id only as client_id; the reconciler swaps the local id for the
   * server's. So the id says which request a dirty row needs: a local id has
   * never been created (POST), a server id has, and is being edited (PUT).
   *
   * Both used to be POSTed whatever the row was. An edit to a synced quiz
   * went out as a create carrying id=<server id>; the server, matching
   * client_id, found nothing and made a SECOND quiz, and the original never
   * changed. Publishing was an edit like any other, so it never landed.
   */
  {
    key: "question",
    table: "questions",
    where: `${IS_DIRTY} AND ${NOT_DELETED}`,
    method:   (row) => (isServerId(row.id) ? "PUT" : "POST"),
    endpoint: (row) => (isServerId(row.id) ? API.quiz.question(row.id) : API.quiz.questions),
    guardEdits: true,
    reconcile: "question",
    payload: (row, { schoolId }) => ({
      id:            row.id,
      schoolId:      row.schoolId || schoolId,
      category_id:   row.category_id || null,
      subject_id:    row.subject_id  || null,
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
    method:   (row) => (isServerId(row.id) ? "PUT" : "POST"),
    endpoint: (row) => (isServerId(row.id) ? API.quiz.detail(row.id) : API.quiz.list),
    guardEdits: true,
    reconcile: "quiz",
    // questions[].question_id: a question written offline is queued (and
    // re-id'd) ahead of the quiz that uses it.
    resolve: ["class_id", "subject_id", "questions[].question_id"],
    // POST /quiz/quizzes always creates a draft. A quiz published before it
    // was ever sent is published by a PUT queued right behind its create;
    // the id map points it at the id the create is given.
    followUp: (row) =>
      !isServerId(row.id) && row.is_published === 1
        ? { key: "quiz-publish", method: "PUT", endpoint: API.quiz.detail(row.id), payload: { is_published: true } }
        : null,
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
    guardEdits: true,
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
    // Only a decision made ON THIS PHONE: `_local_decision` is written by the
    // applications screen when it approves or rejects offline (db/pupilSync).
    // Status alone said nothing — every pulled pupil is 'approved', and with
    // a stray dirty flag each one was PUT to /approve on every admin sync.
    // `_operation = 'create'` rows belong to the spec above: a pupil enrolled
    // here has no application on the server to decide.
    where:
      `${IS_DIRTY} AND _local_decision IN ('approved', 'rejected') ` +
      `AND (_operation IS NULL OR _operation != 'create')`,
    method: "PUT",
    endpoint: (row) =>
      row._local_decision === "approved"
        ? API.admin.students.approve(row.id)
        : API.admin.students.reject(row.id),
    reconcile: "studentDecision",
    payload: (row) => ({
      classId: row.class_id || row.classId || null,
      reason:  row.rejection_reason || row.reject_reason || null,
      __endpoints:
        row._local_decision === "approved"
          ? API.admin.students.approveFallbackChain(row.id)
          : API.admin.students.rejectFallbackChain(row.id),
    }),
    // The server refuses an approval without a class (400 "classId is
    // required"). The offline approve cannot be made without one, so this
    // only holds a row whose class was lost since; it goes once it has one.
    skip: (row) => row._local_decision === "approved" && !(row.class_id || row.classId),
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
  // A teacher made on this phone and never sent is dropped with its queued
  // create, not created and then deactivated (TeacherService.delete does the
  // same when the delete is made; this catches rows older builds left).
  { key: "teacher",    table: "users",               endpoint: API.admin.teachers.list,    adminOnly: true, extraWhere: "role = 'teacher'",
    dropUnsent: async (db, row) => {
      const state = await teacherCreateState(row);
      if (state !== "unsent" && state !== "none") return false;
      return dropUnsentTeacher(db, row);
    } },
  { key: "assignment", table: "teacher_assignments", endpoint: API.admin.assignments.list, adminOnly: true },
  // A quiz or question still under its local id was never created upstream
  // (the create's reconciler swaps in the server id). Deleting it used to
  // send DELETE /quiz/quizzes/<uuid>, which the ObjectId-keyed route cannot
  // even look up; now it is simply removed here.
  { key: "quiz",       table: "quizzes",             endpoint: API.quiz.list,
    dropUnsent: async (db, row) => {
      if (isServerId(row.id)) return false;
      await MutationQueue.cancelUnsent(`quiz-publish:${row.id}`);
      for (const t of ["quiz_questions", "quiz_analytics"]) {
        await db.runAsync(`DELETE FROM ${t} WHERE quiz_id = ?`, [row.id]).catch(() => {});
      }
      await db.runAsync("DELETE FROM quizzes WHERE id = ?", [row.id]);
      return true;
    } },
  { key: "question",   table: "questions",           endpoint: API.quiz.questions,
    dropUnsent: async (db, row) => {
      if (isServerId(row.id)) return false;
      for (const t of ["question_options", "quiz_questions", "question_analytics"]) {
        await db.runAsync(`DELETE FROM ${t} WHERE question_id = ?`, [row.id]).catch(() => {});
      }
      await db.runAsync("DELETE FROM questions WHERE id = ?", [row.id]);
      return true;
    } },
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

/**
 * A period still dirty after its send settled was edited while the send was
 * in flight. The server now holds what it answered with, so that becomes the
 * copy a discard of the later edit goes back to (periods.service
 * discardLocal). No answer body: the copy is dropped and a discard asks for a
 * full pull instead. Its own statement — an older table without the column
 * must not undo the settle.
 */
const keepSentPeriodImage = async (db, id, doc) => {
  const image = doc && typeof doc === "object" && doc.name
    ? JSON.stringify({
        name: doc.name, starttime: doc.startTime, endtime: doc.endTime,
        sortorder: doc.sortOrder ?? 0, isbreak: doc.isBreak ? 1 : 0,
        isactive: doc.isActive !== false ? 1 : 0, version: doc.version ?? 1,
        updated_at: doc.updatedAt ?? null,
      })
    : null;
  await db.runAsync(
    "UPDATE periods SET server_image = ? WHERE id = ? AND dirty = 1", [image, id]
  ).catch(() => {});
};

export const registerReconcilers = () => {
  if (_registered) return;
  _registered = true;

  // Clean only if nothing was edited since the request was built (args.since,
  // see guardEdits). An edit made while the create was in flight leaves the
  // row dirty under its new server id, and the next sweep PUTs it.
  const CLEAN_IF_UNEDITED = "CASE WHEN COALESCE(updated_at, '') = COALESCE(?, '') THEN 1 ELSE 0 END";

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
      // _synced_at is set either way: the server has the row now, so a later
      // sweep of it is an edit (teacherKnownToServer). The flag clears only
      // if nothing was edited since the request was built (args.since).
      const clean = args.since === undefined ? "1" : CLEAN_IF_UNEDITED;
      await db.runAsync(
        `UPDATE users SET _synced = ${clean}, _synced_at = ? WHERE id = ?`,
        [...(args.since === undefined ? [] : [args.since]), new Date().toISOString(), localId]
      ).catch(() => {});
    }
    // Deleted on this phone while the create was in flight. Its DELETE was
    // queued behind the create, but a create backing off between retries can
    // be overtaken: the DELETE meets a 404 and settles, then the create lands.
    // If no DELETE is still waiting, one goes now, behind this create.
    const id = serverId ? String(serverId) : localId;
    // The staff number the server issued with the create: a teacher made
    // offline shows "pending" until here, then the school's number.
    const staffNo = String(raw?.staffNo ?? "").trim();
    if (id && staffNo) {
      await db.runAsync("UPDATE users SET staff_no = ? WHERE id = ?", [staffNo, id]).catch(() => {});
    }
    const gone = id && await db.getFirstAsync(
      "SELECT 1 AS d FROM users WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at != ''", [id]
    ).catch(() => null);
    if (gone && !(await MutationQueue.hasPending(`teacher-delete:${id}`))) {
      await MutationQueue.enqueue({
        entityKey: `teacher-delete:${id}`,
        method:    "DELETE",
        endpoint:  API.admin.teachers.detail(id),
        payload:   {
          __local:     { table: "users", ids: [id] },
          __reconcile: { kind: "softDelete", table: "users", localId: id },
        },
      });
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

  registerReconciler("period", async ({ response, args }) => {
    const db = await getDatabase();
    const localId = args.localId;
    if (!localId) return;
    // Edited while this was in flight: still dirty, and no longer a create —
    // the server has the row now — so the next sweep PUTs the edit.
    const guarded = args.since !== undefined;
    const settle = guarded
      ? `dirty = CASE WHEN COALESCE(updated_at, '') = COALESCE(?, '') THEN 0 ELSE 1 END,
         operation = CASE WHEN COALESCE(updated_at, '') = COALESCE(?, '') THEN NULL ELSE 'update' END`
      : "dirty = 0, operation = NULL";
    const settleParams = guarded ? [args.since, args.since] : [];

    // POST /admin/periods answers { data: period } under an id it chose.
    const created  = response?.data?.data;
    const serverId = created?._id || created?.id ? String(created._id || created.id) : null;

    if (serverId && serverId !== String(localId)) {
      await mapId(localId, serverId, "periods");
      const pulled = await db.getFirstAsync("SELECT id FROM periods WHERE id = ?", [serverId]).catch(() => null);
      if (pulled) {
        // The server's copy already arrived by a pull: keep it, drop ours.
        await db.runAsync("DELETE FROM periods WHERE id = ?", [localId]).catch(() => {});
      } else {
        await db.runAsync(
          `UPDATE periods SET id = ?, ${settle} WHERE id = ?`, [serverId, ...settleParams, localId]
        ).catch(() => {});
      }
      // Slots placed in this period while it only had the local id.
      await db.runAsync("UPDATE timetable SET period_id = ? WHERE period_id = ?", [serverId, localId]).catch(() => {});
      await db.runAsync("UPDATE timetable_slots SET periodId = ? WHERE periodId = ?", [serverId, localId]).catch(() => {});
      await keepSentPeriodImage(db, serverId, created);
      return;
    }

    await db.runAsync(`UPDATE periods SET ${settle} WHERE id = ?`, [...settleParams, localId]).catch(() => {});
    await keepSentPeriodImage(db, localId, created);
  });

  registerReconciler("periodDelete", async ({ args }) => {
    const db = await getDatabase();
    await db.runAsync(
      "UPDATE periods SET dirty = 0, operation = NULL WHERE id = ?", [args.localId]
    ).catch(() => {});
  });

  // A discarded period change is undone from the server's copy the period
  // row keeps (periods.service discardLocal). Lazily required, as the queue
  // and the periods service both are from here.
  require("./mutationQueue.service").registerDiscardHandler(
    "periods",
    async ({ localId }) => require("./periods.service").PeriodsService.discardLocal(localId),
    { kinds: ["period", "periodDelete"] }
  );

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
    // Without a snapshot (a row queued by an older build) it is marked clean,
    // as before.
    const clean = args.since === undefined ? "1" : CLEAN_IF_UNEDITED;
    const cleanParams = args.since === undefined ? [] : [args.since];

    if (serverId && serverId !== localId) {
      await mapId(localId, serverId, "questions");
      const { withFkOff, withTransaction } = require("../db/dbHelpers");
      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          await db.runAsync(`UPDATE questions SET id = ?, _synced = ${clean}, _synced_at = ? WHERE id = ?`, [serverId, ...cleanParams, ts, localId]);
          for (const t of ["question_options", "quiz_questions", "attempt_answers", "question_analytics"]) {
            await db.runAsync(`UPDATE ${t} SET question_id = ? WHERE question_id = ?`, [serverId, localId]).catch(() => {});
          }
        });
      }).catch((err) => console.warn("[backfill] question reconcile:", err.message));
    } else {
      await db.runAsync(`UPDATE questions SET _synced = ${clean}, _synced_at = ? WHERE id = ?`, [...cleanParams, ts, localId]).catch(() => {});
    }
  });

  registerReconciler("quiz", async ({ response, args }) => {
    const serverId = serverIdFrom(response, "quiz", "data");
    const localId  = args.localId;
    if (!localId) return;
    const db = await getDatabase();
    const ts = new Date().toISOString();
    const clean = args.since === undefined ? "1" : CLEAN_IF_UNEDITED;
    const cleanParams = args.since === undefined ? [] : [args.since];

    if (serverId && serverId !== localId) {
      await mapId(localId, serverId, "quizzes");
      const { withFkOff, withTransaction } = require("../db/dbHelpers");
      await withFkOff(db, async () => {
        await withTransaction(db, async () => {
          await db.runAsync(`UPDATE quizzes SET id = ?, _synced = ${clean}, _synced_at = ? WHERE id = ?`, [serverId, ...cleanParams, ts, localId]);
          for (const t of ["quiz_questions", "quiz_attempts", "quiz_analytics"]) {
            await db.runAsync(`UPDATE ${t} SET quiz_id = ? WHERE quiz_id = ?`, [serverId, localId]).catch(() => {});
          }
        });
      }).catch((err) => console.warn("[backfill] quiz reconcile:", err.message));
    } else {
      await db.runAsync(`UPDATE quizzes SET _synced = ${clean}, _synced_at = ? WHERE id = ?`, [...cleanParams, ts, localId]).catch(() => {});
    }
  });

  registerReconciler("announcement", async ({ args }) => {
    const db = await getDatabase();
    const ts = new Date().toISOString();
    if (args.since === undefined) {
      await db.runAsync(
        `UPDATE announcements SET _synced = 1, _synced_at = ?, _operation = NULL WHERE id = ?`,
        [ts, args.localId]
      ).catch(() => {});
      return;
    }
    // Edited while this was in flight: the server now HAS the row (whatever
    // this was), so what is left is an update — or the delete, if that was
    // the edit — and the row stays dirty for the next sweep.
    await db.runAsync(
      `UPDATE announcements
          SET _synced_at = ?,
              _operation = CASE WHEN COALESCE(updated_at, '') = COALESCE(?, '') THEN NULL
                                WHEN _operation = 'delete' THEN 'delete' ELSE 'update' END,
              _synced    = CASE WHEN COALESCE(updated_at, '') = COALESCE(?, '') THEN 1 ELSE 0 END
        WHERE id = ?`,
      [ts, args.since, args.since, args.localId]
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

  /**
   * A homework submission reached the server; adopt the id it minted.
   *
   * Submissions are subdocuments, so the server assigns the _id on push and
   * this device's generated id has no meaning upstream. Grading addresses a
   * submission by id, so without this mapping every grade would be sent to
   * an id the server has never seen and come back "Submission not found".
   */
  registerReconciler("homeworkSubmission", async ({ response, args }) => {
    const localId = args?.localId;
    if (!localId) return;

    const db = await getDatabase();
    const ts = new Date().toISOString();
    const created = response?.data?.submission ?? null;
    const serverId = created?._id ?? created?.id ?? null;

    if (serverId && String(serverId) !== String(localId)) {
      await mapId(localId, String(serverId), "homework_submissions");
      await db.runAsync(
        `UPDATE homework_submissions
         SET id = ?, _synced = 1, updated_at = ? WHERE id = ?`,
        [String(serverId), ts, localId]
      ).catch(async () => {
        // The server's row already arrived by sync — drop the local one.
        await db.runAsync(
          `DELETE FROM homework_submissions WHERE id = ?`, [localId]
        ).catch(() => {});
      });
    } else {
      await db.runAsync(
        `UPDATE homework_submissions SET _synced = 1, updated_at = ? WHERE id = ?`,
        [ts, localId]
      ).catch(() => {});
    }
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

  // Suspend / restore / move / delete / correct, queued by student.service.
  try { require("./student.service").registerStudentReconcilers?.(); } catch (err) {
    console.warn("[backfill] student change handlers unavailable:", err?.message);
  }

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

    // The decision is the server's now: the marker goes with the flag, so it
    // is never sent again.
    await db.runAsync(
      `UPDATE students SET _synced = 1, _local_decision = NULL, updated_at = ? WHERE id = ?`,
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

/** Ids of `table` rows that an unsent outbox mutation names in __local. */
const coveredIds = async (table) => {
  let entries = [];
  try { entries = await outboxRowsForTable(table); } catch { entries = []; }
  const ids = new Set();
  for (const e of entries) {
    for (const id of localIdsOf(e.payload?.__local)) ids.add(String(id));
  }
  return ids;
};

/**
 * The rows each spec would send, as data: what the per-user migration counts
 * as a real unsent change (docs/40 §1 caution — `_synced = 0` alone is not
 * one). Same `where` and `skip` as the sweep below; role filters are left to
 * the caller.
 */
export const dirtySelectors = () => [
  ...SPECS.map((s) => ({
    key: s.key, table: s.table, where: s.where, skip: s.skip ?? null, idColumn: s.idColumn || "id",
  })),
  ...DELETE_SPECS.map((s) => ({
    key: `${s.key}-delete`, table: s.table, idColumn: "id", skip: null,
    where: ["(deleted_at IS NOT NULL AND deleted_at != '')", IS_DIRTY, ...(s.extraWhere ? [s.extraWhere] : [])].join(" AND "),
  })),
  { key: "timetable-delete", table: "timetable", idColumn: "_id", skip: null,
    where: `(deleted_at IS NOT NULL AND deleted_at != '') AND ${IS_DIRTY}` },
  { key: "period-delete", table: "periods", idColumn: "id", skip: null,
    where: "dirty = 1 AND deletedat IS NOT NULL AND deletedat != ''" },
];

/**
 * Per-user local data (docs/40): once the migration has started on this
 * phone, an account on the shared file sends only its own rows — never a held
 * one, never one already placed in somebody's store. Null (no gate, exactly
 * the old behaviour) on a phone where it has not started.
 */
const ownerGate = async (db) => {
  try {
    return await require("./perUserData.service").legacyBackfillGate(db);
  } catch (err) {
    console.warn("[backfill] owner gate unavailable — sending nothing from the shared file:", err?.message);
    return () => false;
  }
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
  // Prefix without the colon: a spec may key a row under a sibling name
  // (teacher edits as teacher-update:<id>); membership is exact below.
  const queued = await MutationQueue.pendingKeys(spec.key);
  // Rows a queued mutation already carries, whatever its key. The services
  // enqueue under their own keys — attendance:class:<school>:<class>:…, a
  // class edit as class-update:<id> — and name the rows they cover in
  // __local.ids. Matching only `${spec.key}:${id}` missed every one of them,
  // so the sweep queued a second copy: each register was POSTed twice.
  // Receipts are separate mutations on the same rows and are not covered.
  const covered = spec.silent ? new Set() : await coveredIds(spec.table);

  let n = 0;
  for (const row of rows) {
    const localId = row[idCol];
    if (!localId) continue;
    if (spec.skip?.(row)) continue;
    if (ctx.gate && !ctx.gate(spec.table, row, idCol)) continue;

    const entityKey = spec.entityKey ? spec.entityKey(row) : `${spec.key}:${localId}`;
    if (queued.has(entityKey)) continue;   // already waiting its turn
    if (covered.has(String(localId))) continue;

    try {
      const extra = spec.hydrate ? await spec.hydrate(db, row) : {};
      // guardEdits: the row's updated_at as sent. An edit made while this
      // mutation waits (or is in flight) changes it, and then the success
      // must not mark the row clean — the later edit is still unsent.
      const since = spec.guardEdits ? { since: row.updated_at ?? null } : {};
      const payload = {
        ...spec.payload(row, ctx),
        ...extra,
        // `_synced` is cleared generically for tables that have the column;
        // specs whose reconciler owns the flag (periods uses `dirty`) opt out.
        ...(spec.silent || spec.noLocalFlag
          ? {}
          : { __local: { table: spec.table, ids: [localId], idColumn: idCol, ...since } }),
        ...(spec.resolve ? { __resolve: spec.resolve } : {}),
        ...(spec.reconcile
          ? { __reconcile: { kind: spec.reconcile, localId, table: spec.table, ...since, ...(spec.reconcileArgs ?? {}) } }
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

      // A second request the first one cannot carry, queued right behind it
      // so the same drain sends both, in order.
      const follow = spec.followUp?.(row);
      if (follow) {
        await MutationQueue.enqueue({
          entityKey: `${follow.key}:${localId}`,
          method:    follow.method,
          endpoint:  follow.endpoint,
          payload:   follow.payload,
        });
        n++;
      }
    } catch (err) {
      console.warn(`[backfill] ${spec.key} ${localId}:`, err.message);
    }
  }
  return n;
};

const enqueueDeletes = async (db, spec, gate = null) => {
  if (!roleAllows(spec)) return 0;
  if (!(await tableExists(db, spec.table))) return 0;

  const where = [
    "(deleted_at IS NOT NULL AND deleted_at != '')",
    IS_DIRTY,
    ...(spec.extraWhere ? [spec.extraWhere] : []),
  ].join(" AND ");

  const rows = await db.getAllAsync(`SELECT * FROM ${spec.table} WHERE ${where}`).catch(() => []);
  if (!rows?.length) return 0;

  const queued = await MutationQueue.pendingKeys(`${spec.key}-delete:`);
  let n = 0;

  for (const row of rows) {
    if (gate && !gate(spec.table, row, "id")) continue;
    const entityKey = `${spec.key}-delete:${row.id}`;
    if (queued.has(entityKey)) continue;
    // Created on this phone and never sent: there is nothing upstream to
    // delete. The create is cancelled and the row dropped, nothing sent.
    if (spec.dropUnsent) {
      const state = await MutationQueue.createState(`${spec.key}:${row.id}`);
      if ((state === "unsent" || state === "none") && (await spec.dropUnsent(db, row))) {
        await MutationQueue.cancelUnsent(`${spec.key}:${row.id}`);
        continue;
      }
    }
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
const enqueueTimetableDeletes = async (db, gate = null) => {
  if (!isAdmin()) return 0;
  if (!(await tableExists(db, "timetable"))) return 0;

  const rows = await db.getAllAsync(
    `SELECT * FROM timetable
     WHERE (deleted_at IS NOT NULL AND deleted_at != '') AND ${IS_DIRTY}`
  ).catch(() => []);
  if (!rows?.length) return 0;

  const queued = await MutationQueue.pendingKeys("timetable-delete:");
  let n = 0;

  for (const row of rows) {
    const id = row._id;
    if (!id) continue;
    if (gate && !gate("timetable", row, "_id")) continue;

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
 * Period deletes. periods marks pending work with `dirty` and the delete with
 * `deletedat`, so the generic sweep (deleted_at + _synced) never saw them,
 * and the period spec filters deleted rows out: a period deleted offline was
 * never deleted upstream. A period this device created and never sent is
 * dropped locally instead — periods.service does that at delete time; this
 * catches one whose create is still only queued.
 */
const enqueuePeriodDeletes = async (db, gate = null) => {
  if (!isAdmin()) return 0;
  if (!(await tableExists(db, "periods"))) return 0;

  const rows = await db.getAllAsync(
    `SELECT * FROM periods
     WHERE dirty = 1 AND deletedat IS NOT NULL AND deletedat != ''`
  ).catch(() => []);
  if (!rows?.length) return 0;

  const queued = await MutationQueue.pendingKeys("period-delete:");
  let n = 0;

  for (const row of rows) {
    if (!row.id) continue;
    if (gate && !gate("periods", row, "id")) continue;
    const state = await MutationQueue.createState(`period:${row.id}`);
    if (row.operation === "create" && (state === "unsent" || state === "none")) {
      await MutationQueue.cancelUnsent(`period:${row.id}`);
      await db.runAsync("DELETE FROM periods WHERE id = ?", [row.id]).catch(() => {});
      continue;
    }

    const entityKey = `period-delete:${row.id}`;
    if (queued.has(entityKey)) continue;

    await MutationQueue.enqueue({
      entityKey,
      method: "DELETE",
      endpoint: API.admin.periods.detail(row.id),
      payload: { __reconcile: { kind: "periodDelete", localId: row.id } },
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
/**
 * What older builds left on a phone whose sign-in cache rows were dirty: a
 * queued or parked POST /admin/teachers (`teacher:<id>`) for an account that
 * signed in here — the server has it, an online sign-in proved so; sending it
 * can only 409 or restore a removed account — and the dirty flag itself. Both
 * go, for credential rows only (repairCredentialRows says which); a genuine
 * offline create carries no credential and is untouched. Idempotent; cheap
 * when there is nothing to do.
 */
const repairCredentialCache = async (db) => {
  const ids = await credentialRowIds(db);
  if (!ids.size) return;
  let dropped = 0;
  for (const id of ids) dropped += await MutationQueue.cancelUnsent(`teacher:${id}`);
  const keep = new Set();
  for (const k of await MutationQueue.pendingKeys("teacher-")) {
    const m = /^teacher-(?:update|delete):(.+)$/.exec(k);
    if (m) keep.add(m[1]);
  }
  const cleared = await repairCredentialRows(db, keep);
  if (dropped || cleared.length) {
    console.log(`[backfill] credential cache: dropped ${dropped} queued teacher create(s), cleared ${cleared.length} flag(s)`);
  }
};

/**
 * What older builds left behind for teacher EDITS: every dirty teacher row
 * was POSTed as a create, and TeacherService.update()'s own PUT named its row
 * as `__local.id`, which nothing read — so the flag never cleared and each
 * sync POSTed the edit again. On a phone like that sit `teacher:<id>` POSTs
 * (parked on the server's 409, or still queued) for teachers the server has.
 * Sending one can only 409, or RESTORE a teacher the school removed.
 *
 * Each such POST, for a teacher teacherKnownToServer() says the server has,
 * is removed — never the edit it carried:
 *   - a PUT for the teacher is still queued → it carries the edit (it was
 *     queued first and coalesced every later edit); the POST was a copy;
 *   - the row is still dirty → the sweep below PUTs it from the row, which
 *     is the latest;
 *   - the row is clean but holds other values (a pull overwrote it) → the
 *     POST is the only copy of the edit, so it is re-queued as the PUT,
 *     under the account that queued it.
 * A POST for a teacher never accepted (a genuine offline create) is left
 * alone. Idempotent; one indexed query when there is nothing to do.
 */
const repairTeacherEditCreates = async (db) => {
  const posts = await db.getAllAsync(
    `SELECT entity_key, payload, owner_id FROM mutation_outbox
      WHERE entity_key LIKE 'teacher:%' AND status != 'synced' AND UPPER(method) = 'POST'`
  ).catch(() => []);
  if (!posts?.length) return;

  const queued = await MutationQueue.pendingKeys("teacher-update:");
  let dropped = 0, requeued = 0;
  for (const post of posts) {
    const id = String(post.entity_key).slice("teacher:".length);
    const row = await db.getFirstAsync(
      "SELECT id, name, email, _synced, _synced_at FROM users WHERE id = ? AND LOWER(role) = 'teacher'", [id]
    ).catch(() => null);
    if (!row || !teacherKnownToServer(row)) continue;   // a genuine create, or nothing to judge by

    const sent = safeParse(post.payload, {});
    const dirty = row._synced === 0 || row._synced === null;
    const differs = (sent.name && sent.name !== row.name) ||
      (sent.email && String(sent.email).toLowerCase() !== String(row.email ?? "").toLowerCase());
    const editElsewhere = queued.has(`teacher-update:${id}`) || dirty;

    dropped += await MutationQueue.cancelUnsent(post.entity_key);
    if (!editElsewhere && differs) {
      await MutationQueue.enqueue({
        entityKey: `teacher-update:${id}`,
        method:    "PUT",
        endpoint:  API.admin.teachers.detail(id),
        ownerId:   post.owner_id ?? null,
        payload:   {
          ...(sent.name ? { name: sent.name } : {}),
          ...(sent.email ? { email: sent.email } : {}),
          __local: { table: "users", ids: [id], idColumn: "id" },
        },
      });
      requeued++;
    }
  }
  if (dropped || requeued) {
    console.log(`[backfill] teacher edits: dropped ${dropped} create(s) for known teachers, re-queued ${requeued} as edits`);
  }
};

export const backfillOutbox = async () => {
  registerReconcilers();

  const db = await getDatabase();
  const { schoolId } = getCurrentAuth();
  const gate = await ownerGate(db);
  const ctx = { schoolId, student: isStudent(), gate };

  let total = 0;
  const byKey = {};

  await repairCredentialCache(db).catch((err) => console.warn("[backfill] credential rows:", err?.message));
  await repairTeacherEditCreates(db).catch((err) => console.warn("[backfill] teacher edits:", err?.message));
  // Before the specs read students._synced: pulled pupils the old pull left
  // "unsent" are settled, so the decision sweep never sees them.
  await repairPupilSyncFlags(db).catch((err) => console.warn("[backfill] pupil flags:", err?.message));

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
    const n = await enqueueDeletes(db, spec, gate).catch(() => 0);
    if (n) { byKey[`${spec.key}-delete`] = n; total += n; }
  }

  const ttDeletes = await enqueueTimetableDeletes(db, gate).catch(() => 0);
  if (ttDeletes) { byKey["timetable-delete"] = ttDeletes; total += ttDeletes; }

  const periodDeletes = await enqueuePeriodDeletes(db, gate).catch(() => 0);
  if (periodDeletes) { byKey["period-delete"] = periodDeletes; total += periodDeletes; }

  if (total) console.log(`[backfill] Queued ${total} mutation(s):`, byKey);
  return { total, byKey };
};

export default { backfillOutbox, registerReconcilers, dirtySelectors };
