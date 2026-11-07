// desktop/src/main/api/handlers/receipts.js
"use strict";

/**
 * A receipt for a payment the server has not seen yet — printed PROVISIONAL.
 *
 * ── The case ──────────────────────────────────────────────────────────────
 *
 * A bursar takes cash at the counter with the line down. The payment is
 * recorded here, given this installation's receipt number (receiptCounter.js),
 * and queued. Then they press Print, and GET /api/fees/receipt/:id went to a
 * server that could not be reached: the parent left with nothing.
 *
 * The owner's decision: a receipt may be printed before sync, clearly marked
 * provisional. So for a payment whose create is still in this machine's queue,
 * this answers with the shared receipt template (shared/receiptHtml.js) in its
 * provisional form — the same sheet the server prints, plus a heading, a boxed
 * statement and a watermark saying it is not yet confirmed.
 *
 * ── Only while unconfirmed ────────────────────────────────────────────────
 *
 * The test is the QUEUE, not the row's pending flag. Reversing a payment that
 * already synced stamps the original locally and marks it pending, but the
 * original is confirmed — its receipt is the server's. What makes a payment
 * unconfirmed is that the request creating it has not been accepted yet, and
 * that is exactly an outbox entry for this document. Once it is accepted the
 * entry is deleted (outbox.markSent), this declines, and the request goes to
 * the server for the official receipt as it always did. A blocked entry (the
 * server refused it) is still unconfirmed, and still prints provisional.
 *
 * The number does not change on confirmation: the server keeps a device-issued
 * receipt number (shared/receipts.js), so the provisional paper and the official
 * one carry the same RCT-…-CB6F-0041.
 *
 * ── From local data only ──────────────────────────────────────────────────
 *
 * The balance is the child's as this machine knows it — the server's receipt
 * route sums the same rows (every year, charges not voided, payments not
 * deleted), and totalsFor in handlers/fees.js is the mirror of that sum. The
 * logo is printed only when the school document holds it inline: a link this
 * machine cannot load prints as a broken-image box.
 */

const { displayName } = require("../../../../../shared/studentName");
const { buildReceiptHtml, receiptLabelsFor } = require("../../../../../shared/receiptHtml");
const { formatPrintDate } = require("../../../../../shared/printDocument");
const { totalsFor } = require("./fees");

/** The outbox entry that creates this payment, if it has not been accepted. */
const unconfirmedEntry = (queue, paymentId) =>
  (queue?.all?.() ?? []).find((row) =>
    row.collection === "feePayment" &&
    String(row.doc_id) === String(paymentId) &&
    String(row.method).toUpperCase() === "POST"
  ) ?? null;

/** Only a logo this machine holds in full; never a link it may not be able to load. */
const localLogo = (school) => {
  const logo = typeof school?.logo === "string" ? school.logo.trim() : "";
  if (logo.startsWith("data:image/")) return logo;
  const raw = typeof school?.logoBase64 === "string" ? school.logoBase64.trim() : "";
  if (!raw) return null;
  if (raw.startsWith("data:image/")) return raw;
  const mime = raw.startsWith("iVBOR") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${raw}`;
};

const nameOfUser = (user) => {
  if (!user) return null;
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return user.name || full || null;
};

/**
 * Everything the template needs, read from the mirror. Exposed for the check.
 *
 * @returns {object|null} null when this payment is not one to print here
 */
const provisionalReceipt = ({ paymentId, lang = "en" }, { docs, queue }) => {
  const payment = docs.get("feePayment", String(paymentId));
  if (!payment || payment.deletedAt) return null;

  const entry = unconfirmedEntry(queue, payment._id);
  if (!entry) return null;                       // confirmed: the server's receipt

  const schoolId = String(payment.schoolId);
  const school   = docs.get("school", schoolId) ?? {};
  const pupil    = docs.get("student", String(payment.studentId));
  const klass    = pupil?.classId ? docs.get("class", String(pupil.classId)) : null;

  const recorder = payment.receivedBy || entry.user_id || null;

  const data = {
    school: {
      name:    school.name    ?? null,
      address: school.address ?? null,
      phone:   school.phone   ?? null,
      email:   school.email   ?? null,
      motto:   school.motto   ?? null,
    },
    student: {
      name:         (pupil && displayName(pupil)) || null,
      enrollmentNo: pupil?.enrollmentNo ?? null,
      className:    klass?.name ?? pupil?.className ?? null,
    },
    payment,
    // Every year, as the server's receipt sums it.
    totals: totalsFor(docs, { schoolId, studentId: String(payment.studentId), academicYear: null }),
    recordedBy: recorder ? nameOfUser(docs.get("user", String(recorder))) : null,
  };

  const language = String(lang || "en").toLowerCase().startsWith("fr") ? "fr" : "en";
  return buildReceiptHtml({
    data,
    labels:      receiptLabelsFor(language),
    lang:        language,
    printedOn:   formatPrintDate(new Date(payment.receivedAt ?? Date.now()), language),
    logoSrc:     localLogo(school),
    provisional: true,
  });
};

module.exports = [
  {
    route: "GET /api/fees/receipt/:paymentId",

    handler: ({ params, query }, ctx) => {
      // The server's own gate. Without it, decline and let the server answer.
      if (!ctx.session?.permissions?.includes("fees.view")) return null;

      const payment = ctx.docs.get("feePayment", String(params.paymentId));
      if (!payment) return null;
      const schoolId = query.schoolId ? String(query.schoolId).trim() : ctx.session?.schoolId;
      if (schoolId && String(payment.schoolId) !== String(schoolId)) return null;

      const html = provisionalReceipt({ paymentId: params.paymentId, lang: query.lang }, ctx);
      if (!html) return null;

      // The body is the HTML string, exactly as the server sends it; the
      // screen asked for text and passes it straight to the printer.
      return { status: 200, data: html };
    },
  },
];

module.exports.provisionalReceipt = provisionalReceipt;
module.exports.unconfirmedEntry   = unconfirmedEntry;
