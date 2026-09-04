// backend/src/utils/mediaSignature.js
"use strict";

const crypto = require("crypto");

/**
 * Signed-URL gate for sensitive uploads.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * uploads/photos and uploads/messages are served by /uploads with no login.
 * A student photo or a conversation attachment is PII, and the filename is
 * sanitised, not secret — the timestamp prefix narrows a guess to seconds.
 *
 * ── The mechanism ──────────────────────────────────────────────────────────
 *
 * A URL is made unforgeable by appending an HMAC of the path and an expiry,
 * keyed with JWT_SECRET:
 *
 *     /uploads/messages/abc.pdf?sig=<expiryEpoch>.<mac>
 *
 * signMediaPath() produces that query string at the moment the API hands a
 * URL to a client; verifyMediaSignature() checks it at the moment the file is
 * served. A signature outlives neither its expiry nor the path it names —
 * point the same URL at a different file and the MAC no longer matches.
 *
 * ── The rollout ────────────────────────────────────────────────────────────
 *
 * Enforcement is OFF by default. REQUIRE_MEDIA_SIGNATURE=1 turns it on; until
 * then the gate runs in observe mode and only logs unsigned access. That is
 * deliberate: every URL already stored in the database (message attachments,
 * photo paths on student documents) was written unsigned, and flipping
 * enforcement before stored URLs are re-issued would break every image the
 * app has ever shown. signMediaPath() at the write paths plus this flag is
 * the whole migration.
 *
 * NOTE FOR DEPLOYMENT: the Docker nginx serves /uploads straight from the
 * volume (uploads_data:ro), bypassing the backend entirely. When the flag
 * goes to 1, that location must become a proxy_pass to the backend so the
 * gate is actually consulted.
 */

/** The upload directories whose contents are private by nature. */
//
// messages only, for now. photos is deliberately absent: a photo URL is
// content-addressed (student id + content hash — unguessable by
// construction), it is stored on documents and re-served for years, and the
// ID-card / report-card flows render it from the mobile's offline SQLite
// cache — a signature that expires is actively harmful there ("laminating the
// wrong face" is the failure mode photoStorage.js was built to avoid). If
// photos are ever enrolled, sign them at the read paths that absolutise
// photoUrl (results.controller, annualResults.routes, idCard print) and keep
// the signature out of anything that gets printed from a cache.
const PROTECTED_PREFIXES = ["messages"];

const isProtectedPath = (relativePath) => {
  const first = String(relativePath || "").split(/[\\/]/)[0];
  return PROTECTED_PREFIXES.includes(first);
};

const mac = (relativePath, expirySeconds) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET || "")
    .update(`${relativePath}|${expirySeconds}`)
    .digest("hex")
    .slice(0, 32);

/**
 * The signed path for one upload, query string included. `hours` defaults to
 * a week — long enough that a URL shown once stays renderable in the offline
 * cache, short enough that a leaked link dies on its own.
 */
const signMediaPath = (relativePath, { hours = 24 * 7 } = {}) => {
  const expiry = Math.floor(Date.now() / 1000) + hours * 3600;
  return `/uploads/${relativePath}?sig=${expiry}.${mac(relativePath, expiry)}`;
};

const verifyMediaSignature = (relativePath, sig) => {
  if (!sig || typeof sig !== "string") return false;
  const dot = sig.indexOf(".");
  if (dot <= 0) return false;
  const expiry = Number(sig.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return false;
  const expected = mac(relativePath, expiry);
  const given    = sig.slice(dot + 1);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Sign every protected attachment URL in a list, in place of the client's
 * cached copy, leaving anything else untouched.
 *
 * Shared by Message.toClientJSON and the admin audit view, because both hand
 * attachment URLs to clients but only the former serialises through the model
 * method — the audit path reads raw rows on purpose (deleted bodies included),
 * and its links must not be the ones that die when enforcement begins.
 */
const signAttachmentUrls = (attachments) =>
  (Array.isArray(attachments) ? attachments : []).map((a) => {
    const url = a?.url;
    if (typeof url !== "string" || !url.startsWith("/uploads/")) return a;

    // Strip any query (an old signature from a cached copy) before signing —
    // the MAC covers the path, so signing a path that still carries a query
    // produces a URL that verifies against a different string than it holds.
    const relative = url.replace(/^\/uploads\//, "").split("?")[0];
    if (!isProtectedPath(relative)) return a;

    return { ...a, url: signMediaPath(relative) };
  });

module.exports = {
  isProtectedPath,
  signMediaPath,
  verifyMediaSignature,
  signAttachmentUrls,
};
