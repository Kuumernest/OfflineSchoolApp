// mobile/src/services/expense.service.js
"use strict";

/**
 * Expenses on the phone — the offline half of money going out.
 *
 * The case this exists for is the mirror of fee collection: someone buys fuel
 * for the generator or pays a supplier at a market stall, with the receipt in
 * hand and no signal. The record must be made there and then, survive the app
 * being killed, and reach the server exactly once.
 *
 * It follows fee.service.js deliberately, because the same three decisions are
 * load-bearing here:
 *
 *   1. The expense id is generated HERE and sent as `_id`. The server answers a
 *      replay with the row it already has, so the outbox can retry the same
 *      POST forever and the money is only recorded once.
 *
 *   2. A mistake the server has seen is voided, never deleted — the void is
 *      itself a queued mutation carrying its reason. A mistake it has NOT seen
 *      is cancelled instead, because a record that does not exist cannot be
 *      voided; see cancelUnsentExpense.
 *
 *   3. No total is stored. It is summed on read from whatever this device
 *      knows — including rows that have not synced — so the figure shown
 *      offline already accounts for what was just spent.
 *
 * Payroll and salaries are deliberately absent. Payslip numbers come from a
 * server counter and "which salary was in force in March" is a date query
 * against rows the server closes to the millisecond; two phones generating the
 * same month offline would mint colliding numbers against a salary history
 * neither could reconstruct. Those stay web-only, and payroll.js on the phone
 * reads without writing.
 */

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import { generateUUID }      from "../utils/idHelpers";
import { MutationQueue }     from "./mutationQueue.service";
import api                   from "./api";

const CATEGORIES = "expense_categories";
const EXPENSES   = "expenses";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const ensureSchema = async (db) => {
  // Categories are read-only on the phone. Creating one is a rare setup act
  // with a uniqueness rule the server owns, and a phone that invented one
  // offline could only discover the clash after the fact.
  await ensureTableSchema(CATEGORIES, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${CATEGORIES} (
      id         TEXT PRIMARY KEY,
      school_id  TEXT,
      code       TEXT,
      label      TEXT,
      label_fr   TEXT,
      is_active  INTEGER NOT NULL DEFAULT 1,
      _synced    INTEGER NOT NULL DEFAULT 1
    )`);
  }, db);

  await ensureTableSchema(EXPENSES, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${EXPENSES} (
      id            TEXT PRIMARY KEY,
      school_id     TEXT,
      category_id   TEXT NOT NULL,
      academic_year TEXT,
      amount        INTEGER NOT NULL,
      description   TEXT,
      vendor        TEXT,
      method        TEXT NOT NULL DEFAULT 'cash',
      reference     TEXT,
      incurred_at   TEXT,
      voided_at     TEXT,
      void_reason   TEXT,
      /* Separate from _synced: a row can be safely on the server and still
         have a void waiting to go out. One flag could not say that. */
      _void_pending INTEGER NOT NULL DEFAULT 0,
      _synced       INTEGER NOT NULL DEFAULT 0,
      _synced_at    TEXT
    )`);
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_expenses_incurred ON ${EXPENSES}(incurred_at)`
    ).catch(() => {});
    await database.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_expenses_unsynced ON ${EXPENSES}(_synced)`
    ).catch(() => {});
  }, db);
};

const nowIso = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// RECORDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an expense. Writes locally first, then queues the send.
 *
 * @returns {Promise<{ id: string, source: "local" }>}
 */
export const recordExpense = async ({
  schoolId,
  categoryId,
  amount,
  description = null,
  vendor = null,
  method = "cash",
  reference = null,
  academicYear = null,
}) => {
  if (!categoryId) throw new Error("categoryId is required");

  // Whole XAF only. The franc has no minor unit, and a decimal would be
  // rejected by the server long after the money had left the drawer.
  const value = Number(amount);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("Amount must be a whole number of XAF greater than zero");
  }

  const db = await getDatabase();
  await ensureSchema(db);

  const id         = generateUUID();
  const incurredAt = nowIso();

  await db.runAsync(
    `INSERT INTO ${EXPENSES}
       (id, school_id, category_id, academic_year, amount, description,
        vendor, method, reference, incurred_at, _synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, schoolId, categoryId, academicYear, value, description,
     vendor, method, reference, incurredAt]
  );

  await MutationQueue.enqueue({
    // One key per expense. Keying by category would coalesce two purchases
    // into one and silently lose the other — the same trap fee payments avoid.
    entityKey: `expense:${id}`,
    method:    "POST",
    endpoint:  "/finance/expenses",
    payload: {
      _id: id,                       // the idempotency key
      schoolId, categoryId, academicYear,
      amount: value, description, vendor, method, reference,
      incurredAt,
      __reconcile: { kind: "expense", localId: id },
    },
  });

  return { id, source: "local" };
};

/**
 * Undo an expense the server has never seen.
 *
 * Not a void — you cannot void a record that does not exist. The outbox drains
 * in creation order but SKIPS rows in backoff, so a void enqueued after a
 * create whose first attempt failed can overtake it and arrive at a server that
 * has never heard of the expense. That answers 404, which the outbox classes as
 * permanent for a POST: the void is dropped, the phone shows the row voided,
 * the server shows it live, and the two ledgers disagree for good.
 *
 * Cancelling sidesteps the ordering problem instead of racing it. The queued
 * create is dropped first, so a failure between the two steps leaves the local
 * row with nothing to recreate it rather than a queued create with no row.
 *
 * @returns {Promise<{ cancelled: boolean }>} false when the create had already
 *   gone out, in which case the caller must void instead.
 */
export const cancelUnsentExpense = async ({ id }) => {
  if (!id) throw new Error("id is required");

  const db = await getDatabase();
  await ensureSchema(db);

  const row = await db.getFirstAsync(
    `SELECT _synced FROM ${EXPENSES} WHERE id = ?`, [id]
  );
  if (!row) return { cancelled: false };
  if (row._synced === 1) return { cancelled: false };

  await MutationQueue.cancelUnsent(`expense:${id}`);
  await db.runAsync(`DELETE FROM ${EXPENSES} WHERE id = ?`, [id]);

  return { cancelled: true };
};

/**
 * Void an expense, with its reason.
 *
 * Refuses a row this device has not sent yet — see cancelUnsentExpense for why
 * that case is a cancel rather than a void.
 */
export const voidExpense = async ({ schoolId, id, reason }) => {
  const why = String(reason ?? "").trim();
  if (!id)  throw new Error("id is required");
  if (!why) throw new Error("A reason is required to void an expense");

  const db = await getDatabase();
  await ensureSchema(db);

  const row = await db.getFirstAsync(
    `SELECT _synced FROM ${EXPENSES} WHERE id = ?`, [id]
  );
  if (row && row._synced !== 1) {
    throw new Error("UNSENT_EXPENSE");
  }

  await db.runAsync(
    `UPDATE ${EXPENSES}
        SET voided_at = ?, void_reason = ?, _void_pending = 1
      WHERE id = ?`,
    [nowIso(), why, id]
  );

  await MutationQueue.enqueue({
    entityKey: `expenseVoid:${id}`,
    method:    "POST",
    endpoint:  `/finance/expenses/${id}/void`,
    payload: {
      schoolId,
      reason: why,
      __reconcile: { kind: "expenseVoid", localId: id },
    },
  });

  return { id, source: "local" };
};

// ─────────────────────────────────────────────────────────────────────────────
// READING
// ─────────────────────────────────────────────────────────────────────────────

const mapExpense = (row) => ({
  _id:          row.id,
  categoryId:   row.category_id,
  academicYear: row.academic_year,
  amount:       row.amount,
  description:  row.description,
  vendor:       row.vendor,
  method:       row.method,
  reference:    row.reference,
  incurredAt:   row.incurred_at,
  voidedAt:     row.voided_at,
  voidReason:   row.void_reason,
  /** False until the server has it — the UI shows this as "pending". */
  isSynced:     row._synced === 1 && row._void_pending === 0,
});

const mapCategory = (row) => ({
  _id:      row.id,
  code:     row.code,
  label:    row.label,
  labelFr:  row.label_fr,
  isActive: row.is_active === 1,
});

export const listCategories = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  const rows = await db.getAllAsync(
    `SELECT * FROM ${CATEGORIES} WHERE is_active = 1 ORDER BY label ASC`
  );
  return (rows ?? []).map(mapCategory);
};

/**
 * Expenses this device knows about, newest first, with the running total.
 *
 * Voided rows stay in the list and drop out of the total — the same rule the
 * server and the web console follow, so the three never disagree.
 */
export const listExpenses = async ({ limit = 200 } = {}) => {
  const db = await getDatabase();
  await ensureSchema(db);

  const rows = await db.getAllAsync(
    `SELECT * FROM ${EXPENSES} ORDER BY incurred_at DESC LIMIT ?`, [limit]
  );
  const list  = (rows ?? []).map(mapExpense);
  const total = list.filter((e) => !e.voidedAt).reduce((s, e) => s + e.amount, 0);

  return { expenses: list, total, pending: list.filter((e) => !e.isSynced).length };
};

/** Rows this device has recorded that the server has not acknowledged. */
export const listPendingExpenses = async () => {
  const db = await getDatabase();
  await ensureSchema(db);
  const rows = await db.getAllAsync(
    `SELECT * FROM ${EXPENSES} WHERE _synced = 0 OR _void_pending = 1
      ORDER BY incurred_at ASC`
  );
  return (rows ?? []).map(mapExpense);
};

// ─────────────────────────────────────────────────────────────────────────────
// PULL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refresh categories and expenses from the server.
 *
 * Server rows overwrite local ones EXCEPT where this device still has an
 * unsent create or void — those are the authority until they sync, and
 * clobbering them would erase a record of money that has already gone out.
 */
export const pullExpenses = async ({ schoolId }) => {
  const db = await getDatabase();
  await ensureSchema(db);

  const [catRes, expRes] = await Promise.all([
    api.get("/finance/expense-categories", { params: { schoolId } }),
    api.get("/finance/expenses", { params: { schoolId } }),
  ]);

  const categories = catRes?.data?.data ?? [];
  const expenses   = expRes?.data?.data ?? [];

  for (const c of categories) {
    await db.runAsync(
      `INSERT OR REPLACE INTO ${CATEGORIES}
         (id, school_id, code, label, label_fr, is_active, _synced)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [c._id, schoolId, c.code ?? null, c.label ?? null, c.labelFr ?? null,
       c.isActive === false ? 0 : 1]
    ).catch(() => {});
  }

  for (const e of expenses) {
    const local = await db.getFirstAsync(
      `SELECT _synced, _void_pending FROM ${EXPENSES} WHERE id = ?`, [e._id]
    );
    if (local && (local._synced === 0 || local._void_pending === 1)) continue;

    await db.runAsync(
      `INSERT OR REPLACE INTO ${EXPENSES}
         (id, school_id, category_id, academic_year, amount, description,
          vendor, method, reference, incurred_at, voided_at, void_reason,
          _void_pending, _synced, _synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      [e._id, schoolId, e.categoryId, e.academicYear ?? null, e.amount,
       e.description ?? null, e.vendor ?? null, e.method ?? "cash",
       e.reference ?? null, e.incurredAt ?? nowIso(), e.voidedAt ?? null,
       e.voidReason ?? null, nowIso()]
    ).catch(() => {});
  }

  return { categories: categories.length, expenses: expenses.length };
};

export default {
  recordExpense,
  voidExpense,
  cancelUnsentExpense,
  listCategories,
  listExpenses,
  listPendingExpenses,
  pullExpenses,
};
