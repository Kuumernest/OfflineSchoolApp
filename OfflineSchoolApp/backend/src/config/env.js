// backend/src/config/env.js
"use strict";

/**
 * Refuse to start without the things the app cannot work without.
 *
 * ── Why this file had to be rewritten ─────────────────────────────────────
 *
 * It existed, it checked one variable, and nothing ever required it — so the
 * check never ran. The consequence was specific and bad: with JWT_SECRET
 * missing the server booted, reported itself healthy, served every page, and
 * then threw on the first login attempt, because jsonwebtoken raises
 * "secretOrPrivateKey must have a value" at signing time rather than at import.
 *
 * A deployment that is broken for everybody should fail at the moment it
 * starts, in the logs of the person deploying it — not an hour later in front
 * of a school secretary who cannot sign in and has no way to know why.
 *
 * ── What is required, and what is only required in production ─────────────
 *
 * MONGODB_URI and JWT_SECRET are required everywhere: there is no useful
 * behaviour without a database or a way to sign a session.
 *
 * ALLOWED_ORIGINS is production-only, and its absence is a subtler failure
 * than it looks. server.js reads it to build the CORS allow-list; unset, that
 * list is empty, so a production API rejects its own web console. In
 * development CORS is open, so nothing there reveals it.
 *
 * A weak JWT_SECRET is refused in production too. A signing key short enough
 * to guess is the same as no authentication at all, and the default that ships
 * in .env.example is exactly the value most likely to reach a server.
 */

const REQUIRED = ["MONGODB_URI", "JWT_SECRET"];
const REQUIRED_IN_PRODUCTION = ["ALLOWED_ORIGINS"];

/** Values nobody should be able to deploy with. */
const REFUSED_SECRETS = new Set([
  "change-me", "changeme", "secret", "your-secret-key",
  "your_jwt_secret", "supersecret", "jwt-secret",
]);

/**
 * Email configuration, checked but never fatal.
 *
 * Returned as warnings rather than added to `problems`, deliberately. A school
 * runs this backend on a laptop in an office to take a register and record
 * fees; none of that needs an outbound mail provider, so refusing to start
 * over an unset API key would turn a missing convenience into a closed
 * school. The queue already degrades honestly without one: every notification
 * is still recorded, the portal still shows it, and the row says why nothing
 * was delivered.
 *
 * Production is held to more: a deployment that means to send email and is
 * missing half its configuration should say so loudly at boot rather than at
 * the moment a bursar presses Send. Still a warning — the same reasoning
 * applies to a production server whose job is the register.
 *
 * Never prints a value. BREVO_API_KEY is reported as present or not.
 */
// What Brevo actually needs before it will accept a message. BREVO_SENDER_NAME
// is NOT here: it is a display name, mail sends without it, and treating it as
// required is what previously turned a cosmetic omission into no email at all
// (see the note in services/email.brevo.js). It is reported as advice below.
const EMAIL_REQUIRED = ["BREVO_API_KEY", "BREVO_SENDER_EMAIL"];
const EMAIL_ADVISED  = ["BREVO_SENDER_NAME"];

function emailWarnings(env = process.env) {
  const set = (k) => Boolean(String(env[k] ?? "").trim());
  const missing = EMAIL_REQUIRED.filter((k) => !set(k));

  // Nothing configured at all is the ordinary offline-first case, and one line
  // is the right amount to say about it.
  if (missing.length === EMAIL_REQUIRED.length) {
    return [
      "Brevo email service is not configured. Transactional emails will be " +
      "unavailable; everything else works.",
    ];
  }

  const out = missing.map((k) => `${k} is not set — transactional email needs it`);

  for (const k of EMAIL_ADVISED) {
    if (!set(k)) {
      out.push(`${k} is not set — mail still sends, but without the school's name on it`);
    }
  }

  // A retired provider still in the environment is worth a word: it reads as
  // configuration and is now read by nothing.
  for (const stale of ["SENDGRID_API_KEY", "GMAIL_USER", "GMAIL_APP_PASSWORD"]) {
    if (set(stale)) {
      out.push(
        `${stale} is set but no longer used — this app sends through Brevo. ` +
        "It can be removed from the environment."
      );
    }
  }
  return out;
}

function validateEnv({ env = process.env, exit = true } = {}) {
  const problems = [];
  const production = env.NODE_ENV === "production";

  for (const key of REQUIRED) {
    if (!String(env[key] ?? "").trim()) {
      problems.push(`${key} is not set`);
    }
  }

  if (production) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!String(env[key] ?? "").trim()) {
        problems.push(
          `${key} is not set — in production this is the CORS allow-list, ` +
          `and an empty one rejects the web console itself`
        );
      }
    }

    const secret = String(env.JWT_SECRET ?? "");
    if (secret && secret.length < 32) {
      problems.push(
        `JWT_SECRET is ${secret.length} characters — use at least 32`
      );
    }
    if (REFUSED_SECRETS.has(secret.toLowerCase())) {
      problems.push("JWT_SECRET is still a placeholder value");
    }
  }

  // Printed here so it is seen even when everything required is present.
  const warnings = emailWarnings(env);
  if (warnings.length && exit) {
    for (const w of warnings) console.warn(`  ⚠️  ${w}`);
  }

  if (problems.length && exit) {
    console.error("\n  Cannot start — the environment is incomplete:\n");
    for (const p of problems) console.error(`    · ${p}`);
    console.error("\n  See backend/.env.example for the full list.\n");
    process.exit(1);
  }

  return problems;
}

module.exports = {
  validateEnv,
  emailWarnings,
  EMAIL_REQUIRED,
  EMAIL_ADVISED,
  REQUIRED,
  REQUIRED_IN_PRODUCTION,
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGODB_URI,
};
