// desktop/src/main/api/receiptCounter.js
"use strict";

/**
 * The receipt numbers this installation issues.
 *
 * ── Why it is a module of its own ─────────────────────────────────────────
 *
 * It lived in writes.js, next to the payment that needed it. Then the reversal
 * needed it too — a credit note is printed and handed over exactly like a
 * receipt — and writes/feePayments.js requiring writes.js made a cycle:
 * writes.js registers the handler files at the bottom and attaches this function
 * below that, so the handler destructured it before it existed. Required the
 * other way round it failed outright.
 *
 * A cycle like that is not worth working around by reordering two lines, because
 * the ordering would be load-bearing and nothing would say so. The shared thing
 * lives on its own instead.
 */

const { formatDeviceReceipt } = require("../../../../shared/receipts");

/**
 * The next receipt number for this school and year, on this installation.
 *
 * Counted per academic year, in the meta table, so it survives a restart. It is
 * never reconciled with the server's counter and does not need to be: the two
 * number spaces are distinguishable by shape and neither has to know about the
 * other. See shared/receipts.js for the format and why it is safe.
 *
 * One counter for every kind of paper — a payment and a reversal draw from the
 * same sequence, so a day's numbers run consecutively whatever the row is.
 */
const nextReceipt = (meta, { schoolId, academicYear }) => {
  const key = `receiptSeq:${schoolId}:${academicYear}`;
  const seq = Number(meta.get(key) ?? 0) + 1;
  meta.set(key, seq);
  return formatDeviceReceipt(academicYear, meta.deviceCode(), seq);
};

module.exports = { nextReceipt };
