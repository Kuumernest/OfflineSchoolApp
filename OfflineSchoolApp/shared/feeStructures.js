// shared/feeStructures.js
"use strict";

/**
 * What makes a fee structure valid, defined once.
 *
 * ── Why this is shared rather than copied ─────────────────────────────────
 *
 * A fee structure is a school's price list, and everything downstream is
 * derived from it: what a family owes, which families to remind, who has earned
 * a late fee. The endpoint that creates one validates hard for that reason.
 *
 * The desktop has to validate identically, and not for tidiness. A write queued
 * while offline is replayed later, and a REFUSED write stops the whole outbox
 * and waits for a person — so a structure that passes locally and fails on the
 * server does not merely fail: it holds up every payment queued behind it. The
 * two answers have to agree, which means one definition rather than two that
 * drift.
 *
 * Required by backend/src/routes/fees.routes.js and by the desktop's write
 * handler, so a change here changes both at once.
 */

/**
 * A whole number, or null.
 *
 * XAF has no minor unit — there are no centimes — so an amount with a decimal
 * point is a mistake rather than a rounding question, and it is refused instead
 * of being rounded into something nobody typed.
 */
const asWholeAmount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
};

/**
 * A calendar day, as a Date.
 *
 * Accepts "2026-09-15" and rejects everything else, rather than handing whatever
 * arrived to new Date() — which turns "next friday" into an Invalid Date and
 * stores null, leaving a structure with no deadline whose families are never
 * reminded and never charged a late fee.
 *
 * Three outcomes, deliberately distinguishable:
 *
 *   a Date      a valid calendar day
 *   null        nothing was supplied
 *   undefined   something was supplied and it is not a date
 */
const asDueDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** The penalty rule from a request body, or an error string. */
const cleanPenalty = (raw) => {
  if (!raw || raw.mode === undefined || raw.mode === null || raw.mode === "none") {
    return { value: { mode: "none", amount: 0, graceDays: 0 }, error: null };
  }

  if (!["fixed", "percent"].includes(raw.mode)) {
    return { value: null, error: `penalty.mode must be none, fixed or percent` };
  }

  const amount = asWholeAmount(raw.amount);
  if (amount === null || amount < 0) {
    return { value: null, error: "penalty.amount must be a whole number" };
  }
  if (raw.mode === "percent" && amount > 100) {
    return { value: null, error: "A percentage penalty cannot exceed 100" };
  }

  const graceDays = asWholeAmount(raw.graceDays ?? 0);
  if (graceDays === null || graceDays < 0 || graceDays > 365) {
    return { value: null, error: "penalty.graceDays must be between 0 and 365" };
  }

  return { value: { mode: raw.mode, amount, graceDays }, error: null };
};

/**
 * The fee items from a request body, or an error string.
 *
 * The `code` on an error is part of the API contract — the amount failure has
 * one and the others deliberately do not — so it is carried here rather than
 * flattened into a message, which would change what the endpoint answers.
 *
 * @returns {{ value: object[]|null, error: string|null, code: string|null }}
 */
const cleanItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { value: null, error: "At least one fee item is required", code: null };
  }

  const clean = [];
  for (const item of items) {
    if (!item?.code || !item?.label) {
      return {
        value: null,
        error: "Every fee item needs a code and a label",
        code:  null,
      };
    }
    const amount = asWholeAmount(item?.amount);
    if (amount === null || amount < 0) {
      return {
        value: null,
        error: `"${item.label}" must be a whole number of XAF — the currency has no minor unit`,
        code:  "INVALID_AMOUNT",
      };
    }
    clean.push({
      code:       String(item.code).trim(),
      label:      String(item.label).trim(),
      labelFr:    item.labelFr ? String(item.labelFr).trim() : null,
      amount,
      isOptional: Boolean(item.isOptional),
    });
  }

  return { value: clean, error: null, code: null };
};

/**
 * The classes a structure bills, from either spelling.
 *
 * `classId` is still accepted as a single value so an older client is not
 * broken. An EMPTY list means every class in the school — not "no classes" —
 * which is why it is a meaningful value rather than a missing one.
 */
const normaliseClassIds = (body) => {
  if (Array.isArray(body.classIds)) {
    return [...new Set(body.classIds.map(String).map((s) => s.trim()).filter(Boolean))];
  }
  if (body.classId) return [String(body.classId).trim()];
  return [];
};

/**
 * Would these two active structures collide?
 *
 * ── Reproducing a multikey unique index ──────────────────────────────────
 *
 * FeeStructure has a unique index on (schoolId, academicYear, classIds, term)
 * limited to active, undeleted rows. classIds is an ARRAY, so the index is
 * multikey: the constraint is per individual class, not per list. Two
 * structures billing {cls-1, cls-2} and {cls-2, cls-3} for the same year and
 * term collide on cls-2, even though neither list equals the other.
 *
 * An empty list indexes as a single missing key, so two school-wide structures
 * for the same year and term collide with each other — and, being a different
 * key, NOT with a structure that names classes explicitly.
 *
 * Written out here because a local handler that got this wrong would queue a
 * structure the server refuses with 409 STRUCTURE_EXISTS, and that stops the
 * outbox.
 *
 * @param a {{ schoolId, academicYear, term, classIds }}
 * @param b likewise
 */
const clashesWith = (a, b) => {
  if (String(a.schoolId) !== String(b.schoolId)) return false;
  if (String(a.academicYear) !== String(b.academicYear)) return false;
  // null and undefined are the same absent term; "term_1" is not.
  if ((a.term ?? null) !== (b.term ?? null)) return false;

  const aClasses = a.classIds ?? [];
  const bClasses = b.classIds ?? [];

  // Both school-wide: one missing key each, so they are the same key.
  if (aClasses.length === 0 || bClasses.length === 0) {
    return aClasses.length === 0 && bClasses.length === 0;
  }

  return aClasses.some((c) => bClasses.map(String).includes(String(c)));
};

module.exports = {
  asWholeAmount,
  asDueDate,
  cleanPenalty,
  cleanItems,
  normaliseClassIds,
  clashesWith,
};
