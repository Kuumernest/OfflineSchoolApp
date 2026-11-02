// backend/src/print/receipt.js
"use strict";

/**
 * A fee receipt, as the server prints it.
 *
 * The template is shared/receiptHtml.js: the desktop and the phone print a
 * PROVISIONAL receipt from it for a payment that has not reached this server
 * yet, and the two papers must look the same apart from the marking. What is
 * left here is the server's half — resolving the school logo into the page.
 *
 * The official receipt never carries the provisional marking; this wrapper
 * does not pass `provisional`, so it cannot.
 */

const shared = require("../../../shared/receiptHtml");
const { replacedProvisionalReference } = require("../../../shared/receipts");
const { absoluteLogo } = require("./document");

/**
 * The provisional paper this official receipt supersedes, when it may have had
 * a different identifier: a payment taken on the phone, which issues no
 * receipt number and prints its provisional receipt under the payment's own id
 * (shared/receipts.js provisionalReference). The staff route and the guardian
 * portal both print through here, so both say it.
 */
const buildReceiptHtml = ({ data, labels, lang, printedOn, origin }) =>
  shared.buildReceiptHtml({
    data: {
      ...data,
      replacesProvisional: data.replacesProvisional ?? replacedProvisionalReference(data.payment),
    },
    labels,
    lang,
    printedOn,
    logoSrc: absoluteLogo(data.school?.logo, origin),
  });

module.exports = { buildReceiptHtml };
