// mobile/src/services/receipt.service.js
"use strict";

/**
 * A receipt to print or share, for a payment taken on this phone.
 *
 * ── Two papers, one template ──────────────────────────────────────────────
 *
 * A payment the server has confirmed prints the server's official receipt
 * (document.service getReceiptHtml), cached so it reprints with no signal.
 *
 * A payment still in this phone's queue has no official receipt yet — and the
 * parent is standing at the desk. The owner's decision: a receipt may be
 * printed before sync, clearly marked provisional. So it is built here, from
 * what this phone holds, with the SAME template the server uses
 * (src/print/shared/ is a byte-for-byte copy of OfflineSchoolApp/shared, which
 * Metro cannot reach; scripts/check-provisional-receipt.js holds them equal).
 * It looks like the official receipt apart from the marking: a heading, a
 * boxed statement and a watermark, all in words, so a black-and-white printer
 * keeps them.
 *
 * The phone issues no receipt number (fee.service.js explains why), so the
 * provisional paper carries a provisional reference made from the payment id
 * — P-1A2B3C4D — and the server's official receipt for that payment names the
 * same reference as the one it replaces.
 */

import { File } from "expo-file-system";

import { getPayment, getStudentAccount } from "./fee.service";
import { getStudentById }                from "./student.service";
import { getSchoolInfo }                 from "./school.service";
import { getReceiptHtml }                from "./document.service";
import { useAuthStore }                  from "../store/auth.store";
import { isDataUri, isInlineBase64, isLocalFileUri, toDisplayUri } from "../utils/logoUri";

import { buildReceiptHtml, receiptLabelsFor } from "../print/shared/receiptHtml";
import { formatPrintDate }                    from "../print/shared/printDocument";
import { provisionalReference }               from "../print/shared/receipts";

export { provisionalReference };

/**
 * The school logo as something a PDF engine can draw with no connection: a
 * data: URI, or nothing. A link prints a broken-image box when offline, which
 * is worse than no logo.
 */
const logoForPrint = async (school) => {
  const local = school?.logoLocal;
  if (isLocalFileUri(local)) {
    try {
      const file = new File(local);
      const b64  = typeof file.base64Async === "function" ? await file.base64Async() : file.base64();
      if (b64) {
        const mime = /\.png$/i.test(local) ? "image/png" : "image/jpeg";
        return `data:${mime};base64,${b64}`;
      }
    } catch { /* no logo is fine */ }
  }
  const logo = school?.logo;
  if (isDataUri(logo)) return String(logo).trim();
  if (isInlineBase64(logo)) return toDisplayUri(logo);
  return null;
};

/**
 * The provisional receipt for a payment this phone has not sent yet.
 *
 * @returns {Promise<string|null>} the HTML, or null when the payment is
 *          unknown here or already confirmed (print the official one instead)
 */
export const buildProvisionalReceiptHtml = async ({ paymentId, lang = "en" }) => {
  const payment = await getPayment(paymentId);
  if (!payment || payment.isSynced) return null;

  const language = String(lang || "en").toLowerCase().startsWith("fr") ? "fr" : "en";

  const [pupil, account, school] = await Promise.all([
    getStudentById(payment.studentId).catch(() => null),
    // Every year, as the server's receipt sums it; per child — this child's
    // rows only, whoever else shares the guardian.
    getStudentAccount(payment.studentId, null),
    payment.schoolId
      ? getSchoolInfo(payment.schoolId, { skipRemote: true }).catch(() => null)
      : null,
  ]);

  const user = useAuthStore.getState?.()?.user ?? null;
  const recordedBy = user?.name
    || [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim()
    || null;

  return buildReceiptHtml({
    data: {
      school: {
        name:    school?.name    || user?.schoolName || null,
        address: school?.address || null,
        phone:   school?.phone   || null,
        email:   school?.email   || null,
        motto:   school?.motto   || null,
      },
      student: {
        name:         pupil?.name ?? null,
        enrollmentNo: pupil?.enrollmentNo ?? null,
        className:    pupil?.className ?? null,
      },
      payment,
      totals: account.totals,
      recordedBy,
    },
    labels:      receiptLabelsFor(language),
    lang:        language,
    printedOn:   formatPrintDate(new Date(payment.receivedAt ?? Date.now()), language),
    logoSrc:     await logoForPrint(school),
    provisional: true,
  });
};

/**
 * The receipt to print for a payment: provisional while it is queued, the
 * server's official one once it is confirmed.
 *
 * @returns {Promise<{ html: string, provisional: boolean, stale?: boolean }>}
 */
export const getReceiptForPrint = async ({ paymentId, schoolId, lang = "en" }) => {
  const provisional = await buildProvisionalReceiptHtml({ paymentId, lang });
  if (provisional) return { html: provisional, provisional: true };

  const official = await getReceiptHtml({ schoolId, paymentId, lang });
  return { html: official.html, provisional: false, stale: official.stale };
};

export default { buildProvisionalReceiptHtml, getReceiptForPrint, provisionalReference };
