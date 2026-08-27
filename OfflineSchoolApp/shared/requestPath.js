// OfflineSchoolApp/shared/requestPath.js
"use strict";

/**
 * Turning an axios request into the path and parameters the SERVER would see.
 *
 * ── Why this is its own file ──────────────────────────────────────────────
 *
 * It is the one piece of the offline adapter with logic in it, and the one place
 * a mistake is invisible. Everything else in that adapter is plumbing that fails
 * loudly; this quietly produces the wrong path or drops a parameter, and the
 * local handler then answers a slightly different question than the one the
 * screen asked. A missing academicYear does not throw — it returns every year's
 * charges, and a bursar reads a balance that is too high.
 *
 * Plain JavaScript, and outside the web package, so it can be exercised from
 * Node without a browser, a bundler or a test framework. The TypeScript adapter
 * imports it rather than containing it.
 *
 * ── The rules, and where they come from ──────────────────────────────────
 *
 * axios composes a request from baseURL, url and params, and serialises them in
 * a particular way. Anything reproducing its result has to agree on:
 *
 *   - baseURL joins to url with exactly one slash, whichever side has it
 *   - an absolute url ignores baseURL entirely
 *   - a query string already in the url is kept
 *   - params override anything of the same name in that query string, because
 *     that is the order axios serialises them in
 *   - null and undefined params are omitted rather than sent as "null"
 */

/**
 * @param   {{baseURL?: string, url?: string, params?: object}} config
 * @returns {{path: string, query: Record<string,string>}}
 */
const requestPath = (config = {}) => {
  const base = String(config.baseURL ?? "").replace(/\/+$/, "");
  const raw  = String(config.url ?? "");

  // An absolute URL is its own address; baseURL plays no part. Guarded rather
  // than concatenated, or "/api" + "https://..." would produce nonsense that
  // matches no route and silently falls through to the network.
  let joined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    joined = parsed.pathname + (parsed.search || "");
  } else {
    joined = `${base}${raw.startsWith("/") || raw === "" ? "" : "/"}${raw}`;
  }

  const queryAt = joined.indexOf("?");
  const path    = queryAt === -1 ? joined : joined.slice(0, queryAt);
  const inline  = queryAt === -1 ? ""     : joined.slice(queryAt + 1);

  const query = {};
  for (const [key, value] of new URLSearchParams(inline)) query[key] = value;

  // params last: axios appends them, and a later value wins.
  const params = config.params;
  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params)) {
      // Omitted, not stringified. "undefined" as a schoolId would match no
      // school and return an empty list that looks like a school with no pupils.
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // axios's default serialiser repeats the key; a local handler reading
        // one value would silently see only the last. Joined so at least the
        // handler can tell there were several — and no route uses one yet.
        query[key] = value.map(String).join(",");
        continue;
      }
      query[key] = String(value);
    }
  }

  // Trailing slashes are normalised away, because Express treats /students and
  // /students/ as the same route and the local matcher must too.
  const normalised = path.length > 1 ? path.replace(/\/+$/, "") : path;

  return { path: normalised, query };
};

module.exports = { requestPath };
