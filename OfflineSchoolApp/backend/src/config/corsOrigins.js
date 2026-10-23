// backend/src/config/corsOrigins.js
"use strict";

/**
 * Which browser origins may call this API with credentials.
 *
 * ALLOWED_ORIGINS is the exact list, comma-separated: the production web
 * console and nothing else. Some deployments also need a FAMILY of origins —
 * a dev backend serving every Cloudflare Pages preview build, each on its own
 * subdomain — which no exact list can name in advance. ALLOWED_ORIGIN_PATTERNS
 * holds those as regular expressions, separated by whitespace (not commas:
 * a regex can contain one, as in `{1,3}`).
 *
 * Every pattern must be anchored with ^ and $. An unanchored one matches
 * inside a longer origin, so `offlineschoolapp\.pages\.dev` would also let in
 * https://offlineschoolapp.pages.dev.attacker.example. That is refused at boot
 * rather than trusted. Escape the dots, too: an unescaped `.` matches any
 * character, so `a.pages.dev` also matches `a-pages.dev`, a domain anyone can
 * register.
 *
 * There is no wildcard. With credentials on, "*" is refused by browsers anyway;
 * reflecting any origin is what development does, and only there.
 */

const exactOrigins = (env) =>
  String(env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

/** { patterns: RegExp[], problems: string[] } — problems are fatal in production. */
function originPatterns(env) {
  const sources = String(env.ALLOWED_ORIGIN_PATTERNS ?? "").split(/\s+/).filter(Boolean);
  const patterns = [], problems = [];
  for (const src of sources) {
    if (!src.startsWith("^") || !src.endsWith("$")) {
      problems.push(`ALLOWED_ORIGIN_PATTERNS entry "${src}" must start with ^ and end with $`);
      continue;
    }
    try {
      patterns.push(new RegExp(src));
    } catch (err) {
      problems.push(`ALLOWED_ORIGIN_PATTERNS entry "${src}" is not a valid regular expression: ${err.message}`);
    }
  }
  return { patterns, problems };
}

/** The `origin` option for the cors middleware. */
function corsOrigin(env = process.env) {
  if (env.NODE_ENV !== "production") return true;

  const exact = new Set(exactOrigins(env));
  const { patterns } = originPatterns(env);
  if (!patterns.length) return [...exact];

  return (origin, callback) => {
    // No Origin header: not a cross-origin browser request, nothing to allow.
    if (!origin) return callback(null, false);
    callback(null, exact.has(origin) || patterns.some((p) => p.test(origin)));
  };
}

module.exports = { corsOrigin, originPatterns, exactOrigins };
