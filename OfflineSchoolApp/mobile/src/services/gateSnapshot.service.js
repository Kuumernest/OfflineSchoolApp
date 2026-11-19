// mobile/src/services/gateSnapshot.service.js
"use strict";

/**
 * What a gate phone holds to verify pupils with no signal.
 *
 * GET /gate/snapshot sends every pupil on the register — with or without a
 * card, because a child who forgot theirs is looked up by name — plus the
 * minimal fee facts shared/compliance.js reads (charges, confirmed payments,
 * the agreement, gate passes). It is stored here whole and replaced whole on
 * each pull, stamped with the server's generatedAt, so the screen can always
 * say how old its answer is.
 *
 * Only for an account holding gate.verify: the snapshot carries fee figures,
 * and an operator without that permission must not see them at all — not on
 * screen, and not sitting in this phone's database either.
 *
 * Nothing here throws into the UI. A gate with a broken cache must still let
 * children through; every helper answers null / [] instead.
 */

import { getDatabase }        from "../db/database";
import { ensureTableSchema }  from "../db/schemaManager";
import { tableExists, withTransaction } from "../db/dbHelpers";
import { hasPermission }      from "../utils/authHelpers";
// Loaded when first used, not at import: it brings in expo-file-system, and
// a service many modules import (and the Node checks load) should not.
const photoCache = () => require("./photoCache.service");
import api                    from "./api";
import { compliance }         from "../../../shared/compliance";
import { buildPayments, paymentIdOfKey } from "../components/gate/gateRules";

const STUDENTS = "gate_students";
const META     = "gate_meta";

/**
 * Teachers and admins hold gate.verify by default (backend config). The role
 * list is only for a session stored before the permission list shipped —
 * hasPermission() trusts the server's list whenever it has one.
 */
const VERIFY_FALLBACK_ROLES = ["super_admin", "school_admin", "teacher"];

/**
 * Forget the gate's fee snapshot — on sign-out. It is money data pulled under
 * gate.verify; the next account on this phone pulls its own if it may.
 * Never throws.
 */
export const clearSnapshot = async () => {
  try {
    const db = await getDatabase();
    if (await tableExists(db, STUDENTS).catch(() => false)) await db.runAsync(`DELETE FROM ${STUDENTS}`);
    if (await tableExists(db, META).catch(() => false)) await db.runAsync(`DELETE FROM ${META}`);
  } catch { /* nothing to forget */ }
};

export const canVerify = () => {
  try { return hasPermission("gate.verify", VERIFY_FALLBACK_ROLES); } catch { return false; }
};

export const ensureSnapshotSchema = async (db) => {
  await ensureTableSchema(STUDENTS, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${STUDENTS} (
      student_id    TEXT PRIMARY KEY,
      school_id     TEXT,
      token         TEXT,
      name          TEXT,
      enrollment_no TEXT,
      class_name    TEXT,
      photo_url     TEXT,
      facts_json    TEXT
    )`);
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_gate_students_token ON ${STUDENTS}(token)`
    ).catch(() => {});
  }, db);
  await ensureTableSchema(META, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${META} (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`);
  }, db);
};

const db0 = async () => {
  try {
    const db = await getDatabase();
    await ensureSnapshotSchema(db);
    return db;
  } catch (err) {
    console.warn("[gateSnapshot] database unavailable:", err?.message);
    return null;
  }
};

/**
 * Pull the snapshot and store it. Throws on a network failure (the caller
 * decides whether to say so); never leaves a half-written table — the delete
 * and the inserts are one transaction, so a pull interrupted halfway keeps
 * the previous snapshot rather than a register missing half the school.
 *
 * @returns {Promise<{count: number, generatedAt: string|null} | null>} null when not permitted
 */
export const pullSnapshot = async ({ schoolId }) => {
  if (!canVerify()) return null;
  const { data } = await api.get("/gate/snapshot", { params: { schoolId } });
  const snap = data?.data ?? null;
  if (!snap || !Array.isArray(snap.students)) return { count: 0, generatedAt: null };

  const db = await getDatabase();
  await ensureSnapshotSchema(db);

  const generatedAt = snap.generatedAt ? new Date(snap.generatedAt).toISOString() : new Date().toISOString();

  await withTransaction(db, async () => {
    await db.runAsync(`DELETE FROM ${STUDENTS}`);
    for (const s of snap.students) {
      if (!s?.studentId) continue;
      const facts = {
        charges:        s.charges ?? [],
        payments:       s.payments ?? [],
        plan:           s.plan ?? null,
        authorizations: s.authorizations ?? [],
        classId:        s.classId ?? null,
      };
      await db.runAsync(
        `INSERT OR REPLACE INTO ${STUDENTS}
           (student_id, school_id, token, name, enrollment_no, class_name, photo_url, facts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(s.studentId), schoolId ?? null, s.token ?? null, s.name ?? null,
         s.enrollmentNo ?? null, s.className ?? null, s.photoUrl ?? null, JSON.stringify(facts)]
      );
    }
    await db.runAsync(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('generatedAt', ?)`, [generatedAt]);
    await db.runAsync(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('academicYear', ?)`, [snap.academicYear ?? null]);
    await db.runAsync(`INSERT OR REPLACE INTO ${META} (key, value) VALUES ('schoolId', ?)`, [schoolId ?? null]);
  });

  // Faces for offline, in the background: the screen must not wait on a few
  // hundred downloads, and a photo that fails simply shows initials.
  const urls = snap.students.map((s) => s?.photoUrl).filter(Boolean);
  if (urls.length) Promise.resolve().then(() => photoCache().warmPhotos(urls)).catch(() => {});

  return { count: snap.students.length, generatedAt };
};

/** When the stored snapshot was made, and for which year. Null if none. */
export const snapshotMeta = async () => {
  const db = await db0();
  if (!db) return null;
  try {
    const rows = await db.getAllAsync(`SELECT key, value FROM ${META}`);
    const m = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));
    if (!m.generatedAt) return null;
    const c = await db.getFirstAsync(`SELECT COUNT(*) AS n FROM ${STUDENTS}`).catch(() => null);
    return { generatedAt: m.generatedAt, academicYear: m.academicYear ?? null, schoolId: m.schoolId ?? null, count: c?.n ?? 0 };
  } catch {
    return null;
  }
};

const toStudent = (r) => r ? ({
  student_id:   r.student_id,
  student_name: r.name ?? null,
  admission_no: r.enrollment_no ?? null,
  class_name:   r.class_name ?? null,
  photo_url:    r.photo_url ?? null,
  token:        r.token ?? null,
  school_id:    r.school_id ?? null,
}) : null;

// Scoped by school like gate.service.js lookup(): the table is cleared whole
// on each pull, but a lookup that ignored the column would resolve another
// school's pupil the moment that stopped being true.
export const findByToken = async (token, schoolId) => {
  const db = await db0();
  if (!db || !token) return null;
  const r = await db.getFirstAsync(
    `SELECT * FROM ${STUDENTS} WHERE token = ? AND (school_id = ? OR school_id IS NULL)`,
    [String(token), schoolId ?? null]
  ).catch(() => null);
  return toStudent(r);
};

export const findById = async (studentId) => {
  const db = await db0();
  if (!db || !studentId) return null;
  const r = await db.getFirstAsync(
    `SELECT * FROM ${STUDENTS} WHERE student_id = ?`, [String(studentId)]
  ).catch(() => null);
  return toStudent(r);
};

/**
 * Name / admission-number search over what this phone holds: the snapshot,
 * and the older card roster for an operator without gate.verify (who has no
 * snapshot). Works with no signal, which is the point — a child who forgot
 * their card at 07:30 is the case it exists for.
 */
export const searchLocal = async ({ q, schoolId, limit = 20 }) => {
  const text = String(q ?? "").trim();
  if (text.length < 2) return [];
  const db = await db0();
  if (!db) return [];
  const like = `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const out = new Map();

  const snap = await db.getAllAsync(
    `SELECT * FROM ${STUDENTS}
      WHERE (school_id = ? OR school_id IS NULL)
        AND (name LIKE ? ESCAPE '\\' OR enrollment_no LIKE ? ESCAPE '\\')
      ORDER BY name LIMIT ?`,
    [schoolId ?? null, like, like, limit]
  ).catch(() => []);
  for (const r of snap ?? []) out.set(r.student_id, toStudent(r));

  if (out.size < limit && (await tableExists(db, "gate_roster").catch(() => false))) {
    const roster = await db.getAllAsync(
      `SELECT * FROM gate_roster
        WHERE (school_id = ? OR school_id IS NULL)
          AND (student_name LIKE ? ESCAPE '\\' OR admission_no LIKE ? ESCAPE '\\')
        ORDER BY student_name LIMIT ?`,
      [schoolId ?? null, like, like, limit]
    ).catch(() => []);
    for (const r of roster ?? []) {
      if (out.has(r.student_id)) continue;
      out.set(r.student_id, {
        student_id: r.student_id, student_name: r.student_name ?? null,
        admission_no: r.admission_no ?? null, class_name: r.class_name ?? null,
        photo_url: r.photo_url ?? null, token: r.token ?? null, school_id: r.school_id ?? null,
      });
    }
  }
  return [...out.values()].slice(0, limit);
};

/**
 * This phone's own payments for a pupil that the server has not confirmed:
 * pending, or rejected when the outbox says the server refused them.
 *
 * Both tables are guarded: fee_payments exists only on a phone that has
 * taken a payment (a bursar's), mutation_outbox may predate last_status.
 */
const localPaymentRows = async (db, studentId) => {
  if (!(await tableExists(db, "fee_payments").catch(() => false))) return { rows: [], outbox: new Map() };
  const rows = await db.getAllAsync(
    // Synced rows too: buildPayments counts one the snapshot does not hold
    // (confirmed after it was made) and skips one it does.
    `SELECT id, amount, received_at, academic_year, _synced FROM fee_payments
      WHERE student_id = ?`,
    [String(studentId)]
  ).catch(() => []);
  const outbox = new Map();
  const unsent = (rows ?? []).filter((r) => Number(r._synced) !== 1);
  if (!unsent.length || !(await tableExists(db, "mutation_outbox").catch(() => false))) {
    return { rows: rows ?? [], outbox };
  }
  const keys = unsent.map((r) => `feePayment:${r.id}`);
  const marks = keys.map(() => "?").join(",");
  let entries = await db.getAllAsync(
    `SELECT entity_key, status, last_status FROM mutation_outbox WHERE entity_key IN (${marks})`, keys
  ).catch(() => null);
  if (entries === null) {
    // An outbox from before last_status: the queue's status alone.
    entries = await db.getAllAsync(
      `SELECT entity_key, status FROM mutation_outbox WHERE entity_key IN (${marks})`, keys
    ).catch(() => []);
  }
  for (const e of entries ?? []) {
    const id = paymentIdOfKey(e.entity_key);
    if (!id) continue;
    // Several entries for one payment (a retry re-queued): a refusal on any
    // live one is the answer; otherwise the latest stands.
    const prev = outbox.get(id);
    if (!prev || e.status === "conflict" || e.status === "failed") outbox.set(id, e);
  }
  return { rows, outbox };
};

/**
 * A pupil's compliance, computed on this phone from the snapshot and this
 * phone's unconfirmed payments. Null when the pupil is not in the snapshot or
 * the account may not see fees.
 *
 * @returns {Promise<(import("../../../shared/compliance").ComplianceResult & {source: "device", academicYear: string|null}) | null>}
 */
export const verifyLocal = async (studentId, { asOf = new Date() } = {}) => {
  if (!studentId || !canVerify()) return null;
  try {
    const db = await db0();
    if (!db) return null;
    const row = await db.getFirstAsync(
      `SELECT facts_json FROM ${STUDENTS} WHERE student_id = ?`, [String(studentId)]
    ).catch(() => null);
    if (!row?.facts_json) return null;
    const facts = JSON.parse(row.facts_json);
    const meta = await snapshotMeta();
    const { rows, outbox } = await localPaymentRows(db, studentId);
    const payments = buildPayments(facts.payments, rows, outbox, meta?.academicYear ?? null);
    const result = compliance({
      charges: facts.charges ?? [],
      payments,
      plan: facts.plan ?? null,
      authorizations: facts.authorizations ?? [],
      asOf,
      // Always passed: this answer is from cached data, and the engine marks
      // it stale after 24 h. Null (no stamp) counts as stale, as it should.
      dataAsOf: meta?.generatedAt ?? null,
    });
    return { ...result, source: "device", academicYear: meta?.academicYear ?? null };
  } catch (err) {
    console.warn("[gateSnapshot] local verification failed:", err?.message);
    return null;
  }
};

/**
 * The server's answer for one pupil, when there is signal. Short timeout: the
 * card already shows the device's answer, this only upgrades it, and a gate
 * must never wait on it.
 *
 * Asked whatever this phone's permission list says: the server decides
 * gate.verify from the account's CURRENT permissions, and a list stored at
 * sign-in may be older. A refusal comes back as { forbidden: true } so the
 * card can say why there are no fees; any other failure is null.
 */
export const verifyRemote = async ({ studentId, schoolId, timeout = 4000 }) => {
  if (!studentId) return null;
  try {
    const { data } = await api.get(`/gate/verify/${encodeURIComponent(studentId)}`, {
      params: { schoolId }, timeout,
    });
    const d = data?.data;
    if (!d?.compliance) return null;
    return { student: d.student ?? null, compliance: { ...d.compliance, source: "server" } };
  } catch (err) {
    if (err?.response?.status === 403) return { forbidden: true };
    return null;
  }
};

/**
 * The server's name search (GET /gate/search), mapped to the local row shape.
 * Online only, and only a supplement: an operator without gate.verify has no
 * snapshot, so a pupil without a card is not on this phone at all. Null when
 * the request failed — the local results stand.
 */
export const searchRemote = async ({ q, schoolId, limit = 20 }) => {
  const text = String(q ?? "").trim();
  if (text.length < 2) return [];
  try {
    const { data } = await api.get("/gate/search", { params: { q: text, schoolId, limit }, timeout: 5000 });
    return (Array.isArray(data?.data) ? data.data : []).map((s) => ({
      student_id: String(s._id), student_name: s.name ?? null, admission_no: s.enrollmentNo ?? null,
      class_name: s.className ?? null, photo_url: s.photoUrl ?? null, token: null, school_id: schoolId ?? null,
    }));
  } catch {
    return null;
  }
};

/**
 * Older verifications from the server (GET /gate/history) — online only; the
 * phone itself keeps only today's scans.
 */
export const remoteHistory = async ({ schoolId, limit = 50 }) => {
  try {
    const { data } = await api.get("/gate/history", { params: { schoolId, limit }, timeout: 8000 });
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return null;
  }
};

export default {
  canVerify, ensureSnapshotSchema, pullSnapshot, snapshotMeta, findByToken, findById,
  searchLocal, searchRemote, verifyLocal, verifyRemote, remoteHistory,
};
