// mobile/src/services/fee.service.js
"use strict";

/**
 * Fees on the phone — the offline half of the ledger.
 *
 * The case this exists for: a bursar takes cash at a desk with no signal. The
 * payment must be recorded there and then, survive the app being killed, and
 * reach the server exactly once when the phone next sees a network.
 *
 * Three decisions make that work, and all three are load-bearing:
 *
 *   1. The payment id is generated HERE, before anything touches the network,
 *      and sent as `_id`. The server upserts on it, so the outbox can retry the
 *      same POST forever and the money is only taken once. A server-generated
 *      id would create a second payment on every retry.
 *
 *   2. The receipt number is NOT generated here. Two phones offline would both
 *      mint "0007". The row shows a provisional marker until the server
 *      assigns the real number and the reconciler adopts it.
 *
 *   3. Nothing stores a balance. It is summed from charges and payments on
 *      read — including the rows that have not synced yet — so the figure the
 *      bursar sees offline already accounts for the cash just taken.
 */

import { getDatabase }        from "../db/database";
import { ensureTableSchema }  from "../db/schemaManager";
import { generateUUID }       from "../utils/idHelpers";
import { MutationQueue }      from "./mutationQueue.service";
import api                    from "./api";

const CHARGES  = "fee_charges";
const PAYMENTS = "fee_payments";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const ensureSchema = async (db) => {
  await ensureTableSchema(CHARGES, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${CHARGES} (
      id             TEXT PRIMARY KEY,
      school_id      TEXT,
      student_id     TEXT NOT NULL,
      academic_year  TEXT,
      term           TEXT,
      code           TEXT,
      label          TEXT,
      amount         INTEGER NOT NULL DEFAULT 0,
      waived_amount  INTEGER NOT NULL DEFAULT 0,
      voided_at      TEXT,
      created_at     TEXT,
      _synced        INTEGER NOT NULL DEFAULT 1
    )`);
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_fee_charges_student
       ON ${CHARGES}(student_id, academic_year)`
    ).catch(() => {});
  }, db);

  await ensureTableSchema(PAYMENTS, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${PAYMENTS} (
      id             TEXT PRIMARY KEY,
      school_id      TEXT,
      student_id     TEXT NOT NULL,
      academic_year  TEXT,
      term           TEXT,
      amount         INTEGER NOT NULL,
      method         TEXT NOT NULL DEFAULT 'cash',
      reference      TEXT,
      note           TEXT,
      receipt_no     TEXT,
      received_at    TEXT,
      reverses_id    TEXT,
      reversed_by_id TEXT,
      _synced        INTEGER NOT NULL DEFAULT 0,
      _synced_at     TEXT
    )`);
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_fee_payments_student
       ON ${PAYMENTS}(student_id, academic_year)`
    ).catch(() => {});
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_fee_payments_unsynced
       ON ${PAYMENTS}(_synced)`
    ).catch(() => {});
  }, db);
};

const nowIso = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// RECORDING A PAYMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take a payment. Writes locally first, then queues the send.
 *
 * The local write and the enqueue happen before any network call is attempted,
 * which is the whole point: killing the app between the two leaves a row the
 * backfill sweep will pick up, and killing it after leaves a durable outbox
 * entry. Nothing is lost by being offline.
 *
 * @returns {Promise<{ id: string, receiptNo: null, source: "local" }>}
 */
export const recordPayment = async ({
  schoolId,
  studentId,
  academicYear,
  term = null,
  amount,
  method = "cash",
  reference = null,
  note = null,
}) => {
  if (!studentId)    throw new Error("studentId is required");
  if (!academicYear) throw new Error("academicYear is required");

  // Whole XAF only. The franc has no minor unit, and a decimal here would be
  // rejected by the server after the bursar had already handed back change.
  const value = Number(amount);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("Amount must be a whole number of XAF greater than zero");
  }

  const db = await getDatabase();
  await ensureSchema(db);

  const id         = generateUUID();
  const receivedAt = nowIso();

  await db.runAsync(
    `INSERT INTO ${PAYMENTS}
       (id, school_id, student_id, academic_year, term, amount, method,
        reference, note, receipt_no, received_at, _synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0)`,
    [id, schoolId, studentId, academicYear, term, value, method,
     reference, note, receivedAt]
  );

  await MutationQueue.enqueue({
    // One key per payment. Deliberately NOT keyed by student: enqueue()
    // coalesces unsent mutations that share a key, and coalescing two payments
    // would silently discard one of them.
    //
    // The `feePayment:` prefix matches the backfill spec's `${key}:${id}`, so
    // the sweep recognises a payment already queued instead of enqueuing it
    // a second time.
    entityKey: `feePayment:${id}`,
    method:    "POST",
    endpoint:  "/fees/payments",
    payload: {
      _id: id,                       // the idempotency key
      schoolId, studentId, academicYear, term,
      amount: value, method, reference, note,
      receivedAt,                    // when the money changed hands
      source: "mobile",
      __reconcile: { kind: "feePayment", localId: id },
    },
  });

  return { id, receiptNo: null, source: "local" };
};

// ─────────────────────────────────────────────────────────────────────────────
// READING
// ─────────────────────────────────────────────────────────────────────────────

const mapPayment = (row) => ({
  _id:          row.id,
  studentId:    row.student_id,
  academicYear: row.academic_year,
  term:         row.term,
  amount:       row.amount,
  method:       row.method,
  reference:    row.reference,
  note:         row.note,
  receiptNo:    row.receipt_no,
  receivedAt:   row.received_at,
  reversesId:   row.reverses_id,
  reversedById: row.reversed_by_id,
  /** False until the server has it — the UI shows this as "pending". */
  isSynced:     row._synced === 1,
});

const mapCharge = (row) => ({
  _id:          row.id,
  studentId:    row.student_id,
  academicYear: row.academic_year,
  term:         row.term,
  code:         row.code,
  label:        row.label,
  amount:       row.amount,
  waivedAmount: row.waived_amount,
  voidedAt:     row.voided_at,
});

/**
 * A student's account, computed from whatever this device knows.
 *
 * Unsynced payments are included in the sum. A bursar who has just taken cash
 * must see the reduced balance immediately — showing the pre-payment figure
 * until the next sync is how the same fee gets collected twice.
 */
export const getStudentAccount = async (studentId, academicYear = null) => {
  const db = await getDatabase();
  await ensureSchema(db);

  const yearClause = academicYear ? " AND academic_year = ?" : "";
  const yearArgs   = academicYear ? [academicYear] : [];

  const [charges, payments] = await Promise.all([
    db.getAllAsync(
      `SELECT * FROM ${CHARGES} WHERE student_id = ?${yearClause} ORDER BY created_at ASC`,
      [studentId, ...yearArgs]
    ),
    db.getAllAsync(
      `SELECT * FROM ${PAYMENTS} WHERE student_id = ?${yearClause} ORDER BY received_at ASC`,
      [studentId, ...yearArgs]
    ),
  ]);

  const live    = (charges ?? []).filter((c) => !c.voided_at);
  const charged = live.reduce((s, c) => s + (c.amount ?? 0), 0);
  const waived  = live.reduce((s, c) => s + (c.waived_amount ?? 0), 0);
  // Reversals are stored negative, so a plain sum already nets them off.
  const paid    = (payments ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);

  return {
    charges:  (charges  ?? []).map(mapCharge),
    payments: (payments ?? []).map(mapPayment),
    totals:   { charged, waived, paid, balance: charged - waived - paid },
    /** How many rows are still waiting to reach the server. */
    pending:  (payments ?? []).filter((p) => p._synced !== 1).length,
  };
};

/** Payments this device has taken that the server has not acknowledged. */
export const listPendingPayments = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  const rows = await db.getAllAsync(
    `SELECT * FROM ${PAYMENTS} WHERE _synced = 0 ORDER BY received_at ASC`
  );
  return (rows ?? []).map(mapPayment);
};

// ─────────────────────────────────────────────────────────────────────────────
// PULL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh one student's ledger from the server.
 *
 * Server rows overwrite local ones, EXCEPT payments this device has not sent
 * yet — those are the authority until they sync, and clobbering them would
 * erase cash that has already been handed over.
 */
export const pullStudentAccount = async ({ schoolId, studentId, academicYear }) => {
  const { data } = await api.get(`/fees/students/${studentId}`, {
    params: { schoolId, academicYear },
  });
  const account = data?.data ?? data;
  if (!account) return { charges: 0, payments: 0 };

  const db = await getDatabase();
  await ensureSchema(db);

  for (const c of account.charges ?? []) {
    await db.runAsync(
      `INSERT OR REPLACE INTO ${CHARGES}
         (id, school_id, student_id, academic_year, term, code, label,
          amount, waived_amount, voided_at, created_at, _synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [c._id, schoolId, c.studentId, c.academicYear, c.term ?? null,
       c.code ?? null, c.label ?? null, c.amount ?? 0, c.waivedAmount ?? 0,
       c.voidedAt ?? null, c.createdAt ?? nowIso()]
    ).catch(() => {});
  }

  for (const p of account.payments ?? []) {
    // Never overwrite a row still queued on this device.
    const local = await db.getFirstAsync(
      `SELECT _synced FROM ${PAYMENTS} WHERE id = ?`, [p._id]
    );
    if (local && local._synced === 0) continue;

    await db.runAsync(
      `INSERT OR REPLACE INTO ${PAYMENTS}
         (id, school_id, student_id, academic_year, term, amount, method,
          reference, note, receipt_no, received_at, reverses_id,
          reversed_by_id, _synced, _synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [p._id, schoolId, p.studentId, p.academicYear, p.term ?? null,
       p.amount, p.method ?? "cash", p.reference ?? null, p.note ?? null,
       p.receiptNo ?? null, p.receivedAt ?? nowIso(), p.reversesId ?? null,
       p.reversedById ?? null, nowIso()]
    ).catch(() => {});
  }

  return {
    charges:  (account.charges  ?? []).length,
    payments: (account.payments ?? []).length,
  };
};

export default {
  recordPayment,
  getStudentAccount,
  listPendingPayments,
  pullStudentAccount,
};
