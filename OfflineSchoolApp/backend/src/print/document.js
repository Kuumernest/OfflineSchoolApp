// backend/src/print/document.js
"use strict";

/**
 * The shared skeleton for everything the school prints.
 *
 * This lives on the server, not in the clients, for one reason: there are two
 * clients. A browser prints HTML and the phone turns HTML into a PDF through
 * expo-print, so both want the same string — and a copy of these templates in
 * each project is a copy that drifts. The first fix to a column width lands in
 * one and not the other, and nobody notices until two teachers compare printouts
 * of the same class.
 *
 * The page itself is now defined in shared/printDocument.js, because a receipt
 * has to be printed where this server cannot be reached (a provisional receipt
 * on the desktop or the phone, before the payment has synced) and it must be the
 * same sheet. What stays here is the server's own half: turning a stored logo
 * into an image source.
 *
 * The clients keep what is genuinely theirs: how to put a string in front of a
 * printer.
 */

const shared = require("../../../shared/printDocument");

// Every printed sheet built here — ID card, transcript, class list, receipt —
// is generated on request and may be cached by the phone to print offline, so
// its logo and photos are written into the page (print/imageSource.js). The
// name is kept for the callers; it no longer only makes a URL absolute.
const { resolveImageSrc } = require("./imageSource");
const absoluteLogo = (logo, origin) => resolveImageSrc(logo, { origin, embed: true });

/** The masthead every document carries, with the server resolving the logo. */
const renderHeading = (school, origin) =>
  shared.renderHeading(school, absoluteLogo(school.logo, origin));

module.exports = {
  esc:              shared.esc,
  orDash:           shared.orDash,
  absoluteLogo,
  renderHeading,
  renderFacts:      shared.renderFacts,
  renderSignatures: shared.renderSignatures,
  renderVerify:     shared.renderVerify,
  buildDocument:    shared.buildDocument,
};
