// backend/src/routes/verify.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const documentVerify = require("../services/documentVerify.service");
const { renderVerifyForm, renderVerifyResult } = require("../print/verifyPage");

/**
 * Public document verification.
 *
 * No authentication, by design: the person checking a transcript is a
 * registrar at ANOTHER school, and a check that requires an account here is a
 * check nobody performs. The code itself is the credential — random, 57 bits,
 * printed only on the document it vouches for.
 *
 * Everything answers as HTML, not JSON. The URL is reached by pointing a
 * phone camera at a QR code; whatever renders must be readable by a person
 * with no app and no instructions.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Its own limiter, not the application-form one: 30 lookups per window is a
 * busy registrar's afternoon, while still capping an enumeration attempt at
 * a rate that would need longer than the universe has to find one code.
 */
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS   = 30;
const hits = new Map();

const rateLimit = (req, res, next) => {
  const ip  = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  let entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    hits.set(ip, entry);
  }
  entry.count += 1;

  if (entry.count > MAX_REQUESTS) {
    const wait = Math.ceil((entry.resetAt - now) / 1000);
    return res
      .status(429)
      .type("html")
      .send(`<p style="font-family:sans-serif">Too many attempts. Try again in ${wait}s.</p>`);
  }
  next();
};

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now > entry.resetAt) hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

/** GET /api/verify — the manual-entry form, or a result when ?code= is sent. */
router.get("/verify", rateLimit, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html");

  const code = String(req.query.code ?? "").trim();
  if (!code) return res.send(renderVerifyForm());

  return res.send(renderVerifyResult(await documentVerify.verify(code)));
}));

/** GET /api/verify/:code — what the QR on the document points at. */
router.get("/verify/:code", rateLimit, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html");

  // The result page's retry form submits ?code= relative to this URL; the
  // typed code must beat the one already in the path.
  const code = String(req.query.code ?? req.params.code ?? "").trim();
  return res.send(renderVerifyResult(await documentVerify.verify(code)));
}));

module.exports = router;
