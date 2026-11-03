// OfflineSchoolApp/shared/receiptHtml.js
"use strict";

/**
 * A fee receipt — the official one and the provisional one, from one template.
 *
 * The receipt NUMBER has always been minted server-side on payment; this is the
 * piece of paper that carries it. It is the only document the school prints
 * that a parent keeps — so it states the balance remaining as well as the
 * amount paid. A receipt that says only "60 000 received" invites the argument
 * about what is still owed; one that says "60 000 received, 40 000 remaining"
 * ends it at the counter.
 *
 * A reversed payment prints too, marked. Refusing to print it would leave the
 * parent holding the original receipt for money that has since been returned,
 * with nothing on paper to say so.
 *
 * ── Provisional receipts ──────────────────────────────────────────────────
 *
 * The owner's decision: a receipt may be printed before the payment has
 * reached the school's server, clearly marked provisional. The desktop renders
 * it from its local copy when it has no connection (desktop/src/main/api/
 * handlers/receipts.js), and the phone renders it for a payment still in its
 * queue (mobile/src/services/receipt.service.js).
 *
 * It is THIS template with `provisional` set, never a second one, so the two
 * papers look the same apart from the marking. The marking is words, not
 * colour — a heading, a boxed statement and a watermark — because the printer
 * in a school office is very often black and white. The official receipt is
 * byte-for-byte what it was before provisional receipts existed: every
 * provisional addition is empty when `provisional` is not set.
 *
 * ── The wording lives here ────────────────────────────────────────────────
 *
 * As backend/src/print/labels.js explains, the template owns its own wording:
 * a client sending strings would print blank headings the first time it was a
 * version behind. labels.js spreads RECEIPT_LABELS into its catalogue, so the
 * server and both clients print the same words.
 */

const {
  buildDocument, renderHeading, renderFacts, renderSignatures, esc, orDash,
} = require("./printDocument");
const { provisionalReference } = require("./receipts");

const RECEIPT_LABELS = {
  en: {
    receipt:         "Fee receipt",
    receiptReversal: "Receipt — payment reversed",
    feePayment:      "School fees",
    reversalOf:      "Reversal of a fee payment",
    accountAfter:    "Account after this payment",
    charged:         "Total charged",
    waived:          "Less waivers",
    paidToDate:      "Paid to date",
    balance:         "Balance remaining",
    receivedBy:      "Received by",
    bursar:          "Bursar",
    receiptNo:       "Receipt no.",
    // The fact box labelled its date with labels.date, which no catalogue had,
    // so the date printed under a blank heading.
    date:            "Date",
    amount:          "Amount",
    description:     "Description",
    receiptNote:
      "Keep this receipt. It is the school's record that this payment was made.",

    // Payment methods. The stored values are codes ("mobile_money"); a receipt
    // a parent keeps should not show an underscore.
    methods: {
      cash: "Cash", mobile_money: "Mobile money", bank: "Bank transfer",
      cheque: "Cheque", waiver: "Waiver", other: "Other",
    },

    // ── Provisional ──
    provisionalBanner:
      "PROVISIONAL RECEIPT — not yet confirmed by the school's server",
    provisionalExplain:
      "This payment was recorded on this device and has not yet reached the " +
      "school's server. The official receipt will be available once the device syncs.",
    provisionalWatermark:   "PROVISIONAL",
    provisionalTitle:       "Provisional fee receipt",
    provisionalReversal:    "Provisional receipt — payment reversed",
    provisionalReceiptNo:   "Provisional receipt no.",
    provisionalReference:   "Provisional reference",
    provisionalAccount:     "Account as known on this device",
    provisionalNote:
      "Provisional. Keep this paper until you receive the official receipt, " +
      "which the school issues once this payment reaches its server.",
    recordedBy:             "Recorded by",
    voidBanner:
      "VOID — this payment was reversed before it reached the school's server. " +
      "This paper is not proof of payment.",
    voidWatermark:          "VOID",
    replacesProvisional:
      "Replaces any provisional receipt issued for this payment (provisional reference {ref}).",
    replacesProvisionalReceipt:
      "Replaces provisional receipt {no}.",
  },

  fr: {
    receipt:         "Reçu de frais",
    receiptReversal: "Reçu — paiement annulé",
    feePayment:      "Frais de scolarité",
    reversalOf:      "Annulation d'un paiement",
    accountAfter:    "Situation après ce paiement",
    charged:         "Total facturé",
    waived:          "Moins les remises",
    paidToDate:      "Payé à ce jour",
    balance:         "Solde restant",
    receivedBy:      "Reçu par",
    bursar:          "Économe",
    receiptNo:       "N° de reçu",
    date:            "Date",
    amount:          "Montant",
    description:     "Description",
    receiptNote:
      "Conservez ce reçu. Il atteste que ce paiement a bien été effectué.",

    methods: {
      cash: "Espèces", mobile_money: "Mobile money", bank: "Virement bancaire",
      cheque: "Chèque", waiver: "Remise", other: "Autre",
    },

    provisionalBanner:
      "REÇU PROVISOIRE — pas encore confirmé par le serveur de l'école",
    provisionalExplain:
      "Ce paiement a été enregistré sur cet appareil et n'a pas encore atteint " +
      "le serveur de l'école. Le reçu officiel sera disponible dès que l'appareil sera synchronisé.",
    provisionalWatermark:   "PROVISOIRE",
    provisionalTitle:       "Reçu de frais provisoire",
    provisionalReversal:    "Reçu provisoire — paiement annulé",
    provisionalReceiptNo:   "N° de reçu provisoire",
    provisionalReference:   "Référence provisoire",
    provisionalAccount:     "Situation connue sur cet appareil",
    provisionalNote:
      "Provisoire. Conservez ce document jusqu'à réception du reçu officiel, " +
      "que l'école délivre dès que ce paiement atteint son serveur.",
    recordedBy:             "Enregistré par",
    voidBanner:
      "ANNULÉ — ce paiement a été annulé avant d'atteindre le serveur de l'école. " +
      "Ce document ne prouve pas un paiement.",
    voidWatermark:          "ANNULÉ",
    replacesProvisional:
      "Remplace tout reçu provisoire délivré pour ce paiement (référence provisoire {ref}).",
    replacesProvisionalReceipt:
      "Remplace le reçu provisoire {no}.",
  },
};

/**
 * The words a receipt shares with every other printed document. The server's
 * catalogue (backend/src/print/labels.js) already has them and passes its own;
 * a client printing with no server needs them from here.
 * backend/scripts/check-receipt-template.js holds the two equal.
 */
const COMMON_LABELS = {
  en: {
    printedOn: "Printed", student: "Student", class: "Class",
    academicYear: "Academic year", admissionNo: "Admission no.",
  },
  fr: {
    printedOn: "Imprimé le", student: "Élève", class: "Classe",
    academicYear: "Année scolaire", admissionNo: "Matricule",
  },
};

/** Falls back to English for anything not offered, never to a blank sheet. */
const receiptLabelsFor = (lang) => {
  const key = RECEIPT_LABELS[String(lang || "").toLowerCase().slice(0, 2)] ? String(lang).toLowerCase().slice(0, 2) : "en";
  return { ...COMMON_LABELS[key], ...RECEIPT_LABELS[key] };
};

const fmtMoney = (value, lang) => {
  const n = Number(value ?? 0);
  try {
    return new Intl.NumberFormat(lang === "fr" ? "fr-CM" : "en-CM", {
      style: "currency", currency: "XAF",
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n);
  } catch {
    // The franc has no minor unit, so a plain integer is a correct fallback.
    return `${Math.round(n)} XAF`;
  }
};

/**
 * The provisional marking, in black and white.
 *
 * A thick double rule around the statement, the statement in capitals, and a
 * watermark of words across the sheet: each survives a monochrome printer and
 * a photocopy, which a tint would not. The watermark is position:fixed so it
 * repeats on every printed page.
 */
const PROVISIONAL_CSS = `<style>
  .prov-mark {
    position: fixed; top: 42%; left: 0; right: 0; text-align: center;
    transform: rotate(-28deg); font-size: 64px; font-weight: 700;
    letter-spacing: 0.12em; color: rgba(20, 24, 31, 0.13);
    pointer-events: none; z-index: 0; white-space: nowrap;
  }
  .prov-banner {
    border: 4px double #14181f; padding: 8px 10px; margin: 0 0 12px;
    text-align: center; page-break-inside: avoid;
  }
  .prov-banner__title {
    font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .prov-banner__text { font-size: 10px; margin-top: 3px; }
  .prov-banner__void {
    font-size: 12px; font-weight: 700; margin-top: 6px; padding-top: 5px;
    border-top: 2px solid #14181f; text-transform: uppercase;
  }
</style>`;

/**
 * @param {object}  o
 * @param {object}  o.data         { school, student, payment, totals,
 *                                   recordedBy?, replacesProvisional?,
 *                                   replacesProvisionalReceipt? }
 * @param {object}  o.labels       RECEIPT_LABELS[lang], or a catalogue containing it
 * @param {string}  o.lang
 * @param {string}  o.printedOn    the date line, already formatted
 * @param {string?} o.logoSrc      a resolved image source, or nothing
 * @param {boolean} [o.provisional] the payment has not been confirmed by the server
 */
const buildReceiptHtml = ({ data, labels, lang, printedOn, logoSrc = null, provisional = false }) => {
  const { school, student, payment, totals } = data;

  const reversed = Boolean(payment.reversesId) || Number(payment.amount) < 0;

  // An original taken back before it ever reached the server. Printing it as
  // an ordinary provisional receipt would hand a parent paper for money the
  // school has already returned.
  const voided = Boolean(provisional) && !reversed && Boolean(payment.reversedById);

  // The phone issues no receipt number, so its provisional paper is identified
  // by the payment id instead — and the desktop's carries both, so that either
  // can be matched against the official receipt.
  const reference = provisional ? provisionalReference(payment._id) : null;
  const number    = payment.receiptNo || (provisional ? reference : null);

  const title = provisional
    ? (reversed ? labels.provisionalReversal : labels.provisionalTitle)
    : (reversed ? labels.receiptReversal : labels.receipt);

  const numberLabel = !provisional
    ? labels.receiptNo
    : payment.receiptNo ? labels.provisionalReceiptNo : labels.provisionalReference;

  const mark = provisional
    ? `${PROVISIONAL_CSS}
      <div class="prov-mark" aria-hidden="true">${esc(voided ? labels.voidWatermark : labels.provisionalWatermark)}</div>`
    : "";

  const banner = provisional
    ? `
      <div class="prov-banner" role="note">
        <div class="prov-banner__title">${esc(labels.provisionalBanner)}</div>
        <div class="prov-banner__text">${esc(labels.provisionalExplain)}</div>
        ${voided ? `<div class="prov-banner__void">${esc(labels.voidBanner)}</div>` : ""}
      </div>`
    : "";

  const facts = [
    { label: numberLabel,        value: number ?? "" },
    { label: labels.date,        value: printedOn },
    { label: labels.student,     value: student.name ?? "" },
    { label: labels.admissionNo, value: student.enrollmentNo ?? "" },
    { label: labels.class,       value: student.className ?? "" },
    { label: labels.academicYear,value: payment.academicYear ?? "" },
  ];
  if (provisional && payment.receiptNo && reference) {
    facts.push({ label: labels.provisionalReference, value: reference });
  }
  if (provisional && data.recordedBy) {
    facts.push({ label: labels.recordedBy, value: data.recordedBy });
  }

  // On the official receipt for a payment that may have had provisional paper
  // under a different identifier: say which one this supersedes. A device
  // number the server refused names that paper exactly, so it is said instead
  // of the payment-id reference, not as well.
  const replacesLine = data.replacesProvisionalReceipt
    ? String(labels.replacesProvisionalReceipt ?? "").replace("{no}", data.replacesProvisionalReceipt)
    : data.replacesProvisional
      ? String(labels.replacesProvisional ?? "").replace("{ref}", data.replacesProvisional)
      : "";
  const replaces = !provisional && replacesLine
    ? `
      <p class="muted" style="margin-top:4px;font-size:8.5px">
        ${esc(replacesLine)}
      </p>`
    : "";

  const body = `
    <div class="sheet">${mark}
      ${renderHeading(school, logoSrc)}${banner}

      <h2 class="doc-title">
        ${esc(title)}
      </h2>
      <div class="doc-sub">${orDash(number)}</div>

      ${renderFacts(facts)}

      <table>
        <thead>
          <tr>
            <th>${esc(labels.description)}</th>
            <th class="num">${esc(labels.amount)}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              ${esc(reversed ? labels.reversalOf : labels.feePayment)}
              ${payment.method
                ? ` &nbsp;·&nbsp; ${esc(labels.methods?.[payment.method] ?? payment.method)}`
                : ""}
              ${payment.reference ? ` &nbsp;·&nbsp; ${esc(payment.reference)}` : ""}
            </td>
            <td class="num" style="font-weight:700">
              ${esc(fmtMoney(payment.amount, lang))}
            </td>
          </tr>
        </tbody>
      </table>

      <!-- The account as it stands after this payment. This is the half a
           parent actually came for. -->
      <div class="section">
        <div class="section__title">${esc(provisional ? labels.provisionalAccount : labels.accountAfter)}</div>
        <table>
          <tbody>
            <tr>
              <td>${esc(labels.charged)}</td>
              <td class="num">${esc(fmtMoney(totals.charged, lang))}</td>
            </tr>
            ${totals.waived > 0 ? `
            <tr>
              <td>${esc(labels.waived)}</td>
              <td class="num">${esc(fmtMoney(totals.waived, lang))}</td>
            </tr>` : ""}
            <tr>
              <td>${esc(labels.paidToDate)}</td>
              <td class="num">${esc(fmtMoney(totals.paid, lang))}</td>
            </tr>
            <tr>
              <td style="font-weight:700">${esc(labels.balance)}</td>
              <td class="num ${totals.balance > 0 ? "fail" : "pass"}"
                  style="font-weight:700">
                ${esc(fmtMoney(totals.balance, lang))}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      ${renderSignatures([labels.receivedBy, labels.bursar])}

      <p class="muted" style="margin-top:12px;font-size:8.5px">
        ${esc(provisional ? labels.provisionalNote : labels.receiptNote)}
      </p>${replaces}
    </div>
  `;

  return buildDocument({
    title: provisional
      ? `${labels.provisionalWatermark} — ${title} — ${number ?? ""}`
      : `${labels.receipt} — ${payment.receiptNo ?? ""}`,
    body,
    footerLeft:  provisional
      ? `${labels.provisionalWatermark} · ${labels.printedOn} ${printedOn}`
      : `${labels.printedOn} ${printedOn}`,
    footerRight: school.name ?? "",
  });
};

module.exports = { RECEIPT_LABELS, COMMON_LABELS, receiptLabelsFor, buildReceiptHtml, fmtMoney };
