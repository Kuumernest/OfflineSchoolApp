// src/components/gate/gateRules.js
"use strict";

/**
 * The gate's small decisions that are not the compliance rule itself — which
 * payments the device feeds the engine, how old the synced data is, how an
 * amount is written — kept pure (no database, no React, no clock it is not
 * handed) so scripts/check-gate-offline.js can run them under plain node.
 *
 * The rule (is this pupil up to date?) lives in shared/compliance.js and is
 * NOT re-implemented here: this file only prepares its inputs and words its
 * answer.
 */

/** Same window as shared/compliance.js STALE_AFTER_HOURS. */
export const STALE_HOURS = 24;

/**
 * An HTTP status that is the server saying NO to this payment, as opposed to
 * "not now". Mirrors mutationQueue.service.js: 408/409/425/429 and 5xx are
 * transient (a row parked as failed with one of those simply ran out of
 * retries — the server never refused the money), and no status at all is the
 * network's fault.
 */
const isRefusal = (lastStatus) => {
  const s = Number(lastStatus);
  if (!Number.isFinite(s) || s < 400 || s >= 500) return false;
  return ![408, 409, 425, 429].includes(s);
};

/**
 * Was this payment's outbox entry refused by the server?
 *
 * `conflict` is always a refusal (the server answered with a clash). `failed`
 * counts only with a definitive 4xx: a payment stuck behind a dead network is
 * still pending, and calling it "rejected" at the gate would accuse a family
 * of a refused payment the server has never even seen.
 *
 * @param {{status?: string, last_status?: number|null}|null} outbox
 */
export const outboxRefused = (outbox) => {
  if (!outbox) return false;
  if (outbox.status === "conflict") return true;
  if (outbox.status !== "failed") return false;
  // An outbox from before last_status existed: the queue's own word stands.
  if (!("last_status" in outbox)) return true;
  return isRefusal(outbox.last_status);
};

/** Academic years compared by their digits: "2025-2026" = "2025/2026". */
export const sameYear = (a, b) => {
  if (!a || !b) return true;       // nothing to compare — do not drop money
  const d = (y) => String(y).replace(/\D/g, "");
  return d(a) === d(b);
};

/**
 * The payments handed to compliance() for one pupil.
 *
 *   snapshot rows          → confirmed (the server's own rows)
 *   local _synced = 0 rows → pending, or rejected when the outbox says the
 *                            server refused them
 *
 * Local rows that HAVE synced: the server confirmed them. When the snapshot
 * carries payment ids (it does since the server sends them), a synced local
 * row the snapshot does not hold — confirmed after the snapshot was made —
 * counts as confirmed; one it holds is not counted twice. From a server
 * whose snapshot carries no ids there is no way to tell the two apart, so
 * synced rows are left out — missing until the next pull, the safe
 * direction to be wrong in.
 *
 * Snapshot rows are matched against local rows by id, so the same payment is
 * never both confirmed and pending.
 *
 * @param {Array<{amount, receivedAt, _id?}>} snapshotPayments
 * @param {Array<{id, amount, received_at, _synced, academic_year?}>} localRows
 * @param {Map<string, {status, last_status?}>} outboxById  payment id → outbox row
 * @param {string|null} academicYear  the snapshot's year; other years' local rows are not this year's money
 */
export const buildPayments = (snapshotPayments, localRows, outboxById = new Map(), academicYear = null) => {
  const out = [];
  const known = new Set();
  let snapshotHasIds = false;
  for (const p of snapshotPayments ?? []) {
    if (!p) continue;
    if (p._id) { known.add(String(p._id)); snapshotHasIds = true; }
    out.push({ amount: Number(p.amount) || 0, receivedAt: p.receivedAt ?? null, state: "confirmed" });
  }
  for (const r of localRows ?? []) {
    if (!r) continue;
    if (known.has(String(r.id))) continue;
    if (!sameYear(r.academic_year, academicYear)) continue;
    if (Number(r._synced) === 1) {
      // Confirmed by the server after the snapshot was made (see above).
      if (snapshotHasIds) out.push({ amount: Number(r.amount) || 0, receivedAt: r.received_at ?? null, state: "confirmed" });
      continue;
    }
    const refused = outboxRefused(outboxById.get(String(r.id)) ?? null);
    out.push({
      amount: Number(r.amount) || 0,
      receivedAt: r.received_at ?? null,
      state: refused ? "rejected" : "pending",
    });
  }
  return out;
};

/** The payment id inside an outbox entity key, `feePayment:<id>`. */
export const paymentIdOfKey = (key) => {
  const m = /^feePayment:(.+)$/.exec(String(key ?? ""));
  return m ? m[1] : null;
};

/**
 * How long ago `then` was, as a unit and a whole count, for the "synced 3 h
 * ago" line. The words are the screen's (i18n); this only picks the unit.
 *
 * @returns {{unit: "now"|"minutes"|"hours"|"days", count: number} | null}
 */
export const ageOf = (then, now = new Date()) => {
  if (!then) return null;
  const ms = new Date(now).getTime() - new Date(then).getTime();
  if (!Number.isFinite(ms)) return null;
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1)  return { unit: "now", count: 0 };
  if (min < 60) return { unit: "minutes", count: min };
  const h = Math.floor(min / 60);
  if (h < 48)   return { unit: "hours", count: h };
  return { unit: "days", count: Math.floor(h / 24) };
};

/** Older than the engine's stale window, or never synced at all. */
export const isStale = (generatedAt, now = new Date()) => {
  if (!generatedAt) return true;
  const t = new Date(generatedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return new Date(now).getTime() - t > STALE_HOURS * 3_600_000;
};

/**
 * Whole XAF with thousands separators, then " FCFA" — the contract's wording,
 * the same in both languages apart from the separator (French groups with a
 * space). Written out rather than Intl so a Hermes build without ICU, and
 * this file under node, print the same thing.
 */
export const formatFcfa = (amount, language = "en") => {
  const n = Math.round(Number(amount) || 0);
  const sign = n < 0 ? "-" : "";
  const sep = String(language).toLowerCase().startsWith("fr") ? " " : ",";
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return `${sign}${digits} FCFA`;
};

/** The four statuses, and the look each takes: colour AND icon AND words. */
export const STATUS_LOOK = Object.freeze({
  compliant:     { tone: "success", icon: "checkmark-circle", key: "gate.status.compliant" },
  due:           { tone: "warning", icon: "time",             key: "gate.status.due" },
  non_compliant: { tone: "error",   icon: "alert-circle",     key: "gate.status.non_compliant" },
  authorized:    { tone: "indigo",  icon: "shield-checkmark", key: "gate.status.authorized" },
});

export const lookOf = (status) => STATUS_LOOK[status] ?? null;

export default {
  STALE_HOURS, outboxRefused, sameYear, buildPayments, paymentIdOfKey,
  ageOf, isStale, formatFcfa, STATUS_LOOK, lookOf,
};
