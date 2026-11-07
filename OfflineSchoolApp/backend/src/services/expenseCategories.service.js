// backend/src/services/expenseCategories.service.js
"use strict";

const { v5: uuidv5 } = require("uuid");

const ExpenseCategory = require("../db/models/ExpenseCategory");
const School          = require("../db/models/School");

/**
 * The expense headings a new school starts with.
 *
 * A school with no categories cannot record a single expense — the form needs
 * one — so the bursar's first visit to Expenses was an empty book and a
 * disabled "Record expense" button. These are the headings almost every school
 * spends under; a school renames, adds to or retires them as it likes.
 *
 * Codes are lower-case machine names, as the model documents ("utilities",
 * "maintenance"); labels follow the bilingual label / labelFr convention used
 * by fee items and salary components.
 */
const DEFAULT_EXPENSE_CATEGORIES = Object.freeze([
  { code: "utilities",   label: "Utilities",   labelFr: "Services publics" },
  { code: "maintenance", label: "Maintenance", labelFr: "Entretien" },
  { code: "stationery",  label: "Stationery",  labelFr: "Fournitures de bureau" },
  { code: "transport",   label: "Transport",   labelFr: "Transport" },
  { code: "events",      label: "Events",      labelFr: "Événements" },
]);

// Fixed namespace so a default's id is a pure function of (school, code).
const NAMESPACE = "6f1c0e3a-8d6b-5f4e-9a1b-2c3d4e5f6a7b";

/** The id the default `code` gets in `schoolId` — the same on every call. */
const defaultCategoryId = (schoolId, code) =>
  uuidv5(`expense-category:${schoolId}:${code}`, NAMESPACE);

/**
 * Give a school the default categories, once.
 *
 * ── When ───────────────────────────────────────────────────────────────────
 *
 * Only when the school has NEVER had a category: the count includes
 * soft-deleted rows. A school that retired "Events" on purpose still holds that
 * row with deletedAt set, so it is not seeded again — and a school that has
 * made its own categories keeps exactly what it made.
 *
 * ── Idempotent under a race ────────────────────────────────────────────────
 *
 * Two first reads at once both see zero. The ids are deterministic per
 * (school, code) and the (schoolId, code) index is unique, so the second
 * insert collides on every row and is ignored rather than writing a second set.
 *
 * Server-side only. The desktop does not seed its own mirror: it would have to
 * queue five POSTs with these same ids, and a school that is not empty on the
 * server would answer them 409, which blocks the outbox. The seeded rows reach
 * the desktop through the sync feed like any other category.
 *
 * @returns {Promise<number>} how many categories were created (0 if none)
 */
async function ensureDefaultExpenseCategories(schoolId) {
  if (!schoolId) return 0;
  const id = String(schoolId);

  if (await ExpenseCategory.exists({ schoolId: id })) return 0;
  // A super_admin's ?schoolId= could name anything; never seed a school that
  // does not exist.
  if (!(await School.exists({ _id: id }))) return 0;

  const rows = DEFAULT_EXPENSE_CATEGORIES.map((c) => ({
    _id: defaultCategoryId(id, c.code),
    schoolId: id,
    code: c.code,
    label: c.label,
    labelFr: c.labelFr,
    parentId: null,
    createdBy: null,
  }));

  try {
    const created = await ExpenseCategory.insertMany(rows, { ordered: false });
    return created.length;
  } catch (err) {
    // Duplicate keys only: somebody else seeded (or created) first.
    const writeErrors = err?.writeErrors ?? [];
    const allDuplicates = err?.code === 11000 ||
      (writeErrors.length > 0 && writeErrors.every((e) => (e.code ?? e.err?.code) === 11000));
    if (allDuplicates) return err?.insertedDocs?.length ?? 0;
    throw err;
  }
}

module.exports = {
  DEFAULT_EXPENSE_CATEGORIES,
  defaultCategoryId,
  ensureDefaultExpenseCategories,
};
