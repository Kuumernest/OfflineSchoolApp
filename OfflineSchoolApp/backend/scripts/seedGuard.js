// backend/scripts/seedGuard.js
"use strict";

/**
 * A script that creates accounts with a known password must not reach a
 * real school's database by accident (docs/40 0.7).
 *
 * Refused, before any connection is made, when NODE_ENV is "production", or
 * when the database does not look local or test:
 *   - local: the host is localhost, 127.0.0.1 or ::1 (not the Compose
 *     `mongo` host, which is the production stack's own database);
 *   - test: the database name says so ("test", "…_test", "test_…", "…-test").
 * `--i-know` overrides both, for someone who has read this.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** { host, db } of a MongoDB URI, or null when it is not one. */
const parseUri = (uri) => {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)(?:\/([^?]*))?/i.exec(String(uri ?? "").trim());
  if (!m) return null;
  const hosts = m[1].split(",").map((h) => h.replace(/:\d+$/, "").toLowerCase());
  return { hosts, db: decodeURIComponent(m[2] || "") };
};

const looksTest = (db) => /(^|[_-])test([_-]|$)/i.test(db) || /^test/i.test(db);

/**
 * @returns {{ ok: boolean, reason: string|null }}
 */
const checkSeedTarget = ({ uri, env = process.env, argv = process.argv } = {}) => {
  if (argv.includes("--i-know")) return { ok: true, reason: null };
  if (String(env.NODE_ENV || "").toLowerCase() === "production") {
    return { ok: false, reason: "NODE_ENV is production" };
  }
  const p = parseUri(uri);
  if (!p) return { ok: false, reason: "no MongoDB URI, or not one this script recognises" };
  const local = p.hosts.every((h) => LOCAL_HOSTS.has(h));
  if (local || looksTest(p.db)) return { ok: true, reason: null };
  return { ok: false, reason: `the database (${p.hosts.join(",")}/${p.db || "(default)"}) is neither local nor named as a test database` };
};

/** Stop the script, before it connects, unless the target is safe. */
const refuseUnlessSafe = (opts = {}) => {
  const r = checkSeedTarget(opts);
  if (r.ok) return;
  console.error(`Refused: this script creates accounts with a known password, and ${r.reason}.`);
  console.error("Point it at a local or test database, or pass --i-know if you are sure.");
  process.exit(1);
};

module.exports = { checkSeedTarget, refuseUnlessSafe, parseUri };
