// backend/src/utils/email.js
"use strict";

/**
 * What counts as an email address, in one place.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * There were two definitions and they disagreed. The routes checked
 * /^[^\s@]+@[^\s@]+\.[^\s@]+$/ and answered 400 on a failure; the User model
 * checked /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/ and threw on a
 * failure. The model's was the stricter of the two, so an address the route
 * waved through could still be rejected at save() — reaching the caller as a
 * 500 with "User validation failed" rather than a message about their input.
 *
 * The gap was not theoretical. That \w{2,3} caps the last label at three
 * characters, which rejects .info, .name, .online, .store, .school, .africa
 * and every other long TLD, and the \w-only local part rejects the +tag form
 * (head+bursar@gmail.com) that Gmail users rely on. A school on a .school or
 * .africa domain could not add a single member of staff, and the error told
 * them the server had broken.
 *
 * ── Why it is deliberately permissive ─────────────────────────────────────
 *
 * Because a regex cannot tell a real address from a well-formed one, and the
 * cost of the two mistakes is not symmetric: a typo that passes here is caught
 * the moment the welcome email bounces, while a valid address wrongly refused
 * locks somebody out of a system that has no other way to reach them. RFC 5321
 * permits far more than this — quoted local parts, IP-literal domains — none of
 * which any school will type. This asks only for the shape.
 */

// One @, something either side of it, and a dot in the domain. Nothing else is
// checked on purpose.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidEmail = (email) =>
  typeof email === "string" && EMAIL_REGEX.test(email.trim());

module.exports = { EMAIL_REGEX, isValidEmail };
