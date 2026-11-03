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

/** Was this issued by a device, whatever its year? */
const isDeviceReceipt = (value) =>
  typeof value === "string" && DEVICE_RECEIPT.test(value.trim());

/**
 * A device-issued number the server is about to REFUSE, kept for the record.
 *
 * When parseDeviceReceipt says no — today, because the year inside the number
 * is not the payment's — the server issues its own number. The bursar may
 * already have printed a provisional receipt under the device's, so the server
 * stores what was claimed (FeePayment.claimedReceiptNo) and the official
 * receipt names it.
 *
 * Only a well-formed device number is kept: anything else is not a number any
 * paper could carry, and a free-text field from a client does not belong on a
 * receipt. Bounded in length for the same reason.
 *
 * @param   {unknown} value         the receiptNo the client sent
 * @param   {string}  academicYear  the year the payment is for
 * @returns {string|null}           the claimed number, when it is being replaced
 */
const rejectedDeviceReceipt = (value, academicYear) => {
  if (!isDeviceReceipt(value)) return null;
  if (parseDeviceReceipt(value, academicYear)) return null;   // kept, not replaced
  const claimed = value.trim();
  return claimed.length <= 40 ? claimed : null;
};

/**
 * Which device receipt NUMBER an official receipt should say it replaces: the
 * one the device claimed and the server refused, when it differs from the
 * number the server issued.
 */
const replacedProvisionalReceipt = (payment) => {
  const claimed = payment?.claimedReceiptNo;
  if (typeof claimed !== "string" || !claimed) return null;
  if (claimed === payment.receiptNo) return null;
  return claimed;
};

/**
 * The reference a PROVISIONAL receipt carries, from the payment's own id.
 *
 * A payment taken with no connection is printed before the server has seen it
 * (the owner's decision: provisional receipts may be printed before sync,
 * clearly marked). The phone issues no receipt number at all — two phones
 * offline would mint the same one — so its provisional paper needs something
 * else to tie it to the official receipt that follows.
 *
 * The payment id is that thing: the client chooses it, the server keeps it as
 * the row's _id, and so the official receipt can print the same reference and
 * say which provisional paper it replaces. Eight hex characters is enough to
 * tell one family's payments apart on paper; the id itself is what the
 * database is indexed by.
 *
 * @param   {unknown} id  the payment's _id
 * @returns {string|null} e.g. "P-1A2B3C4D"
 */
const provisionalReference = (id) => {
  const hex = String(id ?? "").replace(/[^0-9a-fA-F]/g, "").slice(0, 8).toUpperCase();
  return hex.length === 8 ? `P-${hex}` : null;
};

/**
 * Which provisional reference an OFFICIAL receipt should say it replaces.
 *
 * Only for a payment taken on a device (source "mobile" or "desktop") whose
 * official number is not the device's own. The desktop issues a device number
 * and the server keeps it, so its provisional and official papers already carry
 * the same number and need no cross-reference. The phone issues none, so its
 * provisional paper carries the reference and the official one names it.
 */
const replacedProvisionalReference = (payment) => {
  if (!payment) return null;
  if (payment.source !== "mobile" && payment.source !== "desktop") return null;
  if (isDeviceReceipt(payment.receiptNo)) return null;
  return provisionalReference(payment._id);
};

module.exports = {
  DEVICE_RECEIPT,
  replacedProvisionalReference,
  replacedProvisionalReceipt,
  rejectedDeviceReceipt,
  SERVER_RECEIPT,
  parseDeviceReceipt,
  isServerReceipt,
  isDeviceReceipt,
  formatDeviceReceipt,
  provisionalReference,
};
