// backend/src/print/receipt.js
"use strict";

/**
 * A fee receipt.
 *
 * The receipt NUMBER has always been minted server-side on payment; this is the
 * piece of paper that carries it. It is deliberately the last thing built in
 * the printing pipeline rather than the first, because it is the only document
 * here that a parent keeps — so it states the balance remaining as well as the
 * amount paid. A receipt that says only "60 000 received" invites the argument
 * about what is still owed; one that says "60 000 received, 40 000 remaining"
 * ends it at the counter.
 *
 * A reversed payment prints too, marked. Refusing to print it would leave the
 * parent holding the original receipt for money that has since been returned,
 * with nothing on paper to say so.
 */

const {
  buildDocument, renderHeading, renderFacts, renderSignatures, esc, orDash,
} = require("./document");

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

const buildReceiptHtml = ({ data, labels, lang, printedOn, origin }) => {
  const { school, student, payment, totals } = data;

  const reversed = Boolean(payment.reversesId) || Number(payment.amount) < 0;

  const body = `
    <div class="sheet">
      ${renderHeading(school, origin)}

      <h2 class="doc-title">
        ${esc(reversed ? labels.receiptReversal : labels.receipt)}
      </h2>
      <div class="doc-sub">${orDash(payment.receiptNo)}</div>

      ${renderFacts([
        { label: labels.receiptNo,   value: payment.receiptNo ?? "" },
        { label: labels.date,        value: printedOn },
        { label: labels.student,     value: student.name ?? "" },
        { label: labels.admissionNo, value: student.enrollmentNo ?? "" },
        { label: labels.class,       value: student.className ?? "" },
        { label: labels.academicYear,value: payment.academicYear ?? "" },
      ])}

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
        <div class="section__title">${esc(labels.accountAfter)}</div>
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
        ${esc(labels.receiptNote)}
      </p>
    </div>
  `;

  return buildDocument({
    title: `${labels.receipt} — ${payment.receiptNo ?? ""}`,
    body,
    footerLeft:  `${labels.printedOn} ${printedOn}`,
    footerRight: school.name ?? "",
  });
};

module.exports = { buildReceiptHtml };
