// OfflineSchoolApp/shared/receipts.js
"use strict";

/**
 * Receipt numbers, including the ones issued while offline.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 *
 * The server issues receipt numbers from an atomic counter: RCT-2026-2027-0041.
 * A counter is exactly the thing two machines cannot share without talking, so a
 * bursar taking money at the counter with no connection cannot have one.
 *
 * Leaving the number blank until the payment syncs is not an option. The parent
 * is standing there and leaves with a piece of paper; if that paper has no
 * number, or a number that later changes, then the school's record and the
 * parent's receipt disagree — and the parent's copy is the one that gets
 * produced in an argument six months later.
 *
 * ── The answer ────────────────────────────────────────────────────────────
 *
 * A device-issued number carries the installation's code:
 *
 *   server issued   RCT-2026-2027-0041
 *   device issued   RCT-2026-2027-CB6F-0041
 *
 * The two formats cannot collide, because the server's has no letter group and
 * a device's always does. Two devices cannot collide with each other, because
 * the code is per installation. So a receipt printed offline is final: when the
 * payment reaches the server, the server KEEPS this number instead of issuing
 * its own, and the paper stays correct.
 *
 * It is also legible about where it came from, which matters when reconciling:
 * a bursar looking at a printed book can see at a glance which receipts were
 * written on the office machine while the line was down.
 *
 * ── Why the validation is strict ──────────────────────────────────────────
 *
 * The server accepts a receipt number from a client, which is a thing to be
 * careful about: it is a value the school's records are indexed by, and it is
 * arriving from outside. So the pattern below is exact, the academic year in it
 * must match the payment's own, and anything that does not fit is ignored rather
 * than corrected — in which case the server issues its own as it always did.
 *
 * The unique index on { schoolId, receiptNo } is what makes the whole
 * arrangement safe rather than merely orderly: if any of this reasoning is
 * wrong, the database refuses the second one.
 */

/**
 * A device-issued number: RCT-<year>-<year>-<CODE>-<seq>
 *
 * The academic year is two four-digit years, the code is four uppercase hex
 * characters, and the sequence is at least four digits.
 */
const DEVICE_RECEIPT = /^RCT-(\d{4}-\d{4})-([0-9A-F]{4})-(\d{4,})$/;

/** A server-issued number, for telling the two apart when reconciling. */
const SERVER_RECEIPT = /^RCT-(\d{4}-\d{4})-(\d{4,})$/;

/**
 * Is this a receipt number a device issued for this academic year?
 *
 * @param   {unknown} value
 * @param   {string}  academicYear  The year the payment is for.
 * @returns {{ code: string, seq: number } | null}
 */
const parseDeviceReceipt = (value, academicYear) => {
  if (typeof value !== "string") return null;

  const match = DEVICE_RECEIPT.exec(value.trim());
  if (!match) return null;

  // The year inside the number must be the year the payment claims. Otherwise a
  // client could file a payment under one year carrying a number that reads as
  // another, and the year is what the counter and every report are keyed by.
  if (match[1] !== String(academicYear)) return null;

  return { code: match[2], seq: Number(match[3]) };
};

/** Was this issued by the server rather than a device? */
const isServerReceipt = (value) =>
  typeof value === "string" && SERVER_RECEIPT.test(value.trim());

/**
 * Format one.
 *
 * @param {string} academicYear  e.g. "2026-2027"
 * @param {string} deviceCode    four uppercase hex characters
 * @param {number} seq           this device's own count, from 1
 */
const formatDeviceReceipt = (academicYear, deviceCode, seq) =>
  `RCT-${academicYear}-${String(deviceCode).toUpperCase()}-${String(seq).padStart(4, "0")}`;

module.exports = {
  DEVICE_RECEIPT,
  SERVER_RECEIPT,
  parseDeviceReceipt,
  isServerReceipt,
  formatDeviceReceipt,
};
