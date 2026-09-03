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
  REQUIRED,
  REQUIRED_IN_PRODUCTION,
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGODB_URI,
};
