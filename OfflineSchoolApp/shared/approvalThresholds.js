// OfflineSchoolApp/shared/approvalThresholds.js
"use strict";

/**
 * When a spend needs a second signature.
 *
 * ── Why this is shared ────────────────────────────────────────────────────
 *
 * The desktop application records expenses with no connection, and whether an
 * expense needs approval decides what it may honestly do: below the threshold it
 * can write the row and queue the request, and at or above it cannot, because
 * approval needs a second person who is not on that machine.
 *
 * So the rule has to be readable on both sides — and it is exactly the rule that
 * must not exist in two copies. The boundary is AT or above, not merely above,
 * and the note on requiresApprovalWith below explains why: a school that sets
 * 50,000 means an expense of exactly 50,000 is the kind it wants to see. Two
 * implementations would eventually disagree about that single case, and the
 * disagreement would be invisible — an expense of exactly the threshold slipping
 * into the accounts unsigned on one platform and not the other.
 *
 * backend/src/services/approvals.service.js requires these rather than defining
 * them, so there is still one answer.
 */

/**
 * An integer, or null. Not a rounding helper — a rejection.
 *
 * ── null and "" are rejected explicitly, and they have to be ──────────────
 *
 * Number(null) is 0 and Number("") is 0. Leaning on Number() alone therefore
 * turned an explicitly CLEARED threshold into zero, and zero is not the absence
 * of a threshold — it is the strictest possible one. The two readings are
 * opposites:
 *
 *     null   never require approval for this   (the shipped default)
 *     0      always require approval           (every refund countersigned)
 *
 * A school that had never opened the settings screen read correctly, because an
 * absent field is undefined and Number(undefined) is NaN. A school that opened
 * the screen, left the refund box empty and saved — the ordinary way to say "we
 * do not need approvals for refunds" — got the exact opposite, and every refund
 * of any size began requiring a second signature.
 */
const whole = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
};

/**
 * One threshold from a request body: a whole number of XAF, or null for never.
 *
 * ── Why this is here and not in the route ─────────────────────────────────
 *
 * PUT /api/approvals/thresholds had its own copy, and the desktop needed the
 * same rule — a threshold change can be made with no connection, and a value
 * this side accepted while the server refused it would be a 400 sitting at the
 * head of the outbox, stopping every write behind it.
 *
 * Note that this REJECTS a negative where resolveThresholds() below quietly
 * maps one to null. That is not an inconsistency to tidy: this guards what gets
 * written, so it should complain; that reads what is already stored, where a bad
 * value means "unset" and there is nobody left to complain to.
 *
 * @returns {{ value: number|null, error: string|null, code: string|null }}
 */
const parseThreshold = (value, name) => {
  if (value === null || value === undefined || value === "") {
    return { value: null, error: null, code: null };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return {
      value: null,
      error: `${name} must be a whole number of XAF, or empty for never`,
      code:  "INVALID_AMOUNT",
    };
  }
  return { value: n, error: null, code: null };
};

/**
 * The shipped state: no thresholds, so nothing needs approval.
 *
 * Deliberately off by default. A school that has not configured this has not
 * asked for a second signature, and turning one on for them would stop the fee
 * desk on the day they upgraded.
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  expenseThreshold: null,
  refundThreshold:  null,
  waiverThreshold:  null,
  payrollRequired:  false,
});

/**
 * A school's thresholds with the defaults applied.
 *
 * Accepts whatever the School document holds — possibly nothing, for a school
 * created before this existed — and returns a complete object, exactly as
 * communication/policy.service.js resolveSettings does.
 */
function resolveThresholds(raw) {
  const s = raw ?? {};
  const num = (v) => {
    const n = whole(v);
    return n === null || n < 0 ? null : n;
  };
  return {
    expenseThreshold: num(s.expenseThreshold),
    refundThreshold:  num(s.refundThreshold),
    waiverThreshold:  num(s.waiverThreshold),
    payrollRequired:  s.payrollRequired === true,
  };
}

const THRESHOLD_KEY = {
  expense: "expenseThreshold",
  refund:  "refundThreshold",
  waiver:  "waiverThreshold",
};

/**
 * The rule itself, given the thresholds — no database.
 *
 * Split out so the boundary can be asserted without a connection, because the
 * boundary is the part most likely to be wrong and least likely to be noticed:
 * AT or above, not merely above. A school that sets 50,000 means an expense of
 * exactly 50,000 is the kind it wants to see, and nobody reading "approval
 * required over 50,000" expects 50,000 itself to slip through.
 *
 * @param {object} thresholds from resolveThresholds()
 * @param {string} kind
 * @param {number} amount
 * @returns {{required: boolean, threshold: number|null}}
 */
function requiresApprovalWith(thresholds, kind, amount) {
  if (kind === "payroll") {
    return { required: thresholds.payrollRequired === true, threshold: null };
  }

  const threshold = thresholds[THRESHOLD_KEY[kind]] ?? null;
  if (threshold === null) return { required: false, threshold: null };

  const n = whole(amount) ?? 0;
  return { required: n >= threshold, threshold };
}

module.exports = {
  whole,
  DEFAULT_THRESHOLDS,
  resolveThresholds,
  THRESHOLD_KEY,
  requiresApprovalWith,
  parseThreshold,
};
