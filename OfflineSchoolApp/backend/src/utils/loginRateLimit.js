// backend/src/utils/loginRateLimit.js
"use strict";

/**
 * Sign-in rate limits that count FAILURES, keyed by who is being guessed.
 *
 * ── The bug this replaces ─────────────────────────────────────────────────
 *
 * Both sign-in routes had one limiter: N requests per 15 minutes per IP,
 * successful sign-ins included. A school is one NAT address, and so is a
 * mobile operator's carrier-grade NAT for whole towns. After a power or
 * network cut, the eleventh teacher signing back in was refused for fifteen
 * minutes — and so was everyone after them — while an attacker was held to
 * exactly the same budget as the whole staff room.
 *
 * ── The shape now ─────────────────────────────────────────────────────────
 *
 * Every limiter here sets skipSuccessfulRequests: a sign-in that works costs
 * nothing, so any number of people behind one address can come back at once.
 *
 *   per account   failures against ONE identifier from one address. This is
 *                 the password-guessing limit. It is keyed by identifier AND
 *                 address so that a stranger elsewhere cannot lock a teacher
 *                 out by typing her email wrong ten times.
 *   per address   a much looser ceiling of failures from one address over ANY
 *                 identifiers — what stops one machine spraying a common
 *                 password across the staff list, or walking sequential
 *                 admission numbers, without ever tripping an account's limit.
 *
 * Addresses go through ipKeyGenerator (express-rate-limit 8), which groups an
 * IPv6 client by its /56 rather than letting it rotate through its own block.
 *
 * DISABLE_LOGIN_RATE_LIMIT=1 lifts all of it; only scripts/ sets it.
 */

const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;

const WINDOW_MS = 15 * 60 * 1000;

const skipForScripts = () => process.env.DISABLE_LOGIN_RATE_LIMIT === "1";

const addressOf = (req) => ipKeyGenerator(String(req.ip ?? ""));

/**
 * @param {object}   o
 * @param {number}   o.max         failures allowed in the window
 * @param {function} [o.identify]  req → normalised identifier, or "" for none;
 *                                 omitted for a per-address limiter
 * @param {object}   o.message     the 429 body
 */
const failedAttemptsLimiter = ({ max, identify, message }) =>
  rateLimit({
    windowMs:               WINDOW_MS,
    limit:                  max,
    standardHeaders:        true,
    legacyHeaders:          false,
    skipSuccessfulRequests: true,
    message,
    skip:                   skipForScripts,
    keyGenerator: (req) => {
      const address = addressOf(req);
      if (!identify) return `ip:${address}`;
      const who = identify(req);
      return who ? `id:${who}|${address}` : `ip:${address}`;
    },
  });

module.exports = { failedAttemptsLimiter, WINDOW_MS };
