// src/services/studentEnroll.service.js
"use strict";

/**
 * Direct enrollment of a student by an admin.
 *
 * The add-student screen used to carry its own copy of everything: a
 * `pending_students` table, a private sync loop with private retry/backoff, a
 * private event bus, and a hardcoded `BASE_URL` pointing at
 * https://your-api.example.com. Nothing it wrote could ever reach the server,
 * and because the row went into `pending_students` rather than `students`, the
 * new student never appeared in any count either.
 *
 * This writes the student into the canonical `students` table and queues one
 * mutation on the shared outbox. It is the same path every other write takes,
 * so it inherits the idempotency key, the backoff, the pending-changes screen,
 * and the reconciler that adopts the id the server assigns.
 */

import { getDatabase } from "../db/database";
import { safeAddColumn } from "../db/dbHelpers";
import { generateUUID } from "../utils/idHelpers";
import { MutationQueue, resolveId } from "./mutationQueue.service";

const ENDPOINT = "/students";

/** Columns the enrollment form needs that the base students table may lack. */
const EXTRA_COLUMNS = [
  ["_synced",        "INTEGER DEFAULT 0"],
  ["_synced_at",     "TEXT"],
  // Distinguishes "created on this device, never pushed" from a pulled
  // application whose approve/reject decision is pending. Without it the
  // backfill would try to PATCH an approval for a student the server has
  // never heard of.
  ["_operation",     "TEXT"],
  ["firstName",      "TEXT"],
  ["lastName",       "TEXT"],
  ["phone",          "TEXT"],
  ["dateOfBirth",    "TEXT"],
  ["address",        "TEXT"],
  ["guardianName",   "TEXT"],
  ["guardianPhone",  "TEXT"],
  ["guardianEmail",  "TEXT"],
  ["className",      "TEXT"],
  ["enrollment_no",  "TEXT"],
  ["sync_error",     "TEXT"],
];

export const ensureStudentColumns = async (db) => {
  for (const [col, def] of EXTRA_COLUMNS) {
    await safeAddColumn(db, "students", col, def);
  }
};

/**
 * Creates the student locally and queues the enrollment.
 *
 * Returns immediately — the row is usable and counted straight away, and the
 * outbox delivers it whenever the network allows.
 *
 * @returns {Promise<{ id: string, name: string, className: string }>}
 */
export const enrollStudentLocally = async ({
  schoolId,
  classId,
  className = null,
  firstName = "",
  lastName = "",
  email = null,
  phone = null,
  gender = null,
  dateOfBirth = null,
  address = null,
  guardianName = null,
  guardianPhone = null,
  guardianEmail = null,
}) => {
  if (!schoolId) throw new Error("schoolId is required");
  if (!classId)  throw new Error("Please choose a class");

  const name = [firstName, lastName].map((s) => (s || "").trim()).filter(Boolean).join(" ");
  if (!name) throw new Error("Student name is required");

  const db = await getDatabase();
  await ensureStudentColumns(db);

  const id = generateUUID();
  const ts = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO students (
       id, schoolId, school_id, classId, class_id, className,
       name, studentName, firstName, lastName,
       email, phone, gender, dateOfBirth, address,
       guardianName, guardianPhone, guardianEmail,
       status, is_active, _synced, _operation, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, 0, 'create', ?, ?)`,
    [
      id, schoolId, schoolId, String(classId), String(classId), className,
      name, name, firstName?.trim() || null, lastName?.trim() || null,
      email || null, phone || null, gender || null, dateOfBirth || null, address || null,
      guardianName || null, guardianPhone || null, guardianEmail || null,
      ts, ts,
    ]
  );

  await MutationQueue.enqueue({
    entityKey: `student-create:${id}`,
    method: "POST",
    endpoint: ENDPOINT,
    payload: {
      id,
      schoolId,
      classId: String(classId),
      firstName: firstName?.trim() || undefined,
      lastName:  lastName?.trim()  || undefined,
      name,
      email:         email         || undefined,
      phone:         phone         || undefined,
      gender:        gender        || undefined,
      dateOfBirth:   dateOfBirth   || undefined,
      address:       address       || undefined,
      guardianName:  guardianName  || undefined,
      guardianPhone: guardianPhone || undefined,
      guardianEmail: guardianEmail || undefined,
      // classId is a local id only if the class itself was created offline;
      // the id map substitutes the server's id at send time either way.
      __resolve: ["classId"],
      __local: { table: "students", ids: [id] },
      __reconcile: { kind: "studentEnroll", localId: id, table: "students" },
    },
  });

  console.log(`[enrollStudent] "${name}" saved locally (${id}) and queued`);
  return { id, name, className: className || "" };
};

/**
 * Pushes queued enrollments now. Safe to call when offline — the backfill is
 * local-only and the drain simply finds nothing it can send.
 */
export const pushEnrollments = async () => {
  try {
    const { backfillOutbox } = require("./syncBackfill.service");
    await backfillOutbox();
    return await MutationQueue.drain({ includeUploads: false });
  } catch (err) {
    console.warn("[enrollStudent] push failed:", err.message);
    return null;
  }
};

/**
 * Re-reads an enrolled student, following the id map so the row is still found
 * after the server assigned it a different id.
 *
 * @returns {Promise<{ id, name, status, enrollmentNo, synced, error } | null>}
 */
export const getEnrollmentStatus = async (localId) => {
  if (!localId) return null;
  const db = await getDatabase();

  const serverId = await resolveId(localId).catch(() => localId);

  const row = await db.getFirstAsync(
    `SELECT id, name, status, enrollmentNo, enrollment_no, _synced, _operation, sync_error
     FROM students WHERE id = ? OR id = ? LIMIT 1`,
    [String(localId), String(serverId)]
  ).catch(() => null);

  if (!row) return null;

  return {
    id:           row.id,
    name:         row.name,
    status:       row.status,
    enrollmentNo: row.enrollmentNo || row.enrollment_no || null,
    synced:       row._synced === 1,
    error:        row.sync_error || null,
  };
};

export default { enrollStudentLocally, pushEnrollments, getEnrollmentStatus, ensureStudentColumns };
