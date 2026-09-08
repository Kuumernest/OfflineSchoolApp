// web/scripts/check-api-paths.mjs
//
// A path that repeats its own base URL.
//
// The guardian portal has its own axios instance, because it holds a different
// token from the staff client:
//
//   const BASE   = (import.meta.env.VITE_API_URL ?? "/api") + "/portal";
//   const client = axios.create({ baseURL: BASE });
//
// Every read was written against that base — client.get("/me"), "/fees",
// "/results" — and then the six messaging calls were written with the full
// path instead:
//
//   client.get("/portal/messages/conversations")
//     →  GET /api/portal/portal/messages/conversations
//
// All six 404. The conversation list, the recipient picker, opening a thread,
// sending, and the read receipt: every write and read in portal messaging.
//
// What made it survive review is that it fails silently in the shape of a
// working screen. A 404 throws, React Query holds no data, the render falls to
// `rows.length === 0`, and the parent is told "No conversations yet." — which
// is a sentence about their correspondence, not about a routing mistake. The
// server was right, every backend suite passed, and the screen said there was
// nothing there.
//
// Nothing else could catch it. TypeScript checks the shape of a string, not
// where it points; the i18n check reads keys; a lint rule has no idea what a
// baseURL is. So: for each axios instance created with a baseURL ending in a
// path segment, no call on that instance may begin with the same segment.
//
// Run: npm run api:check   (and in CI before a release)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname, relative }    from "node:path";
import { fileURLToPath }                       from "node:url";

const root   = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if ([".ts", ".tsx"].includes(extname(name))) files.push(full);
  }
})(srcDir);

let problems = 0;
let instances = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");

  // The instance's base. Either a literal, or a const whose definition ends in
  // a quoted "/segment" — which is how the portal's is written:
  //     const BASE = (import.meta.env.VITE_API_URL ?? "/api") + "/portal";
  let base = null;

  const literal = /axios\.create\(\s*\{[^}]*baseURL:\s*[`"]([^`"]+)[`"]/.exec(text);
  if (literal) {
    base = literal[1];
  } else {
    const named = /axios\.create\(\s*\{[^}]*baseURL:\s*([A-Za-z_$][\w$]*)/.exec(text);
    if (named) {
      const decl = new RegExp(`const\\s+${named[1]}\\s*=([^;]+);`).exec(text);
      // Every quoted segment in the declaration, in order — the fallback and
      // the suffix both count. Joining them rather than taking the last one
      // matters only for the message this prints, and a diagnostic that names
      // the wrong URL sends the next reader looking in the wrong place.
      const parts = decl ? [...decl[1].matchAll(/[`"](\/[^`"]*)[`"]/g)] : [];
      if (parts.length) base = parts.map((p) => p[1]).join("").replace(/\/+/g, "/");
    }
  }

  if (!base) continue;

  // The trailing segment is the one a call could repeat. A base of
  // "/api/portal" is repeated by a call starting "/portal/…".
  const segment = "/" + base.split("/").filter(Boolean).pop();
  if (segment === "/") continue;

  instances += 1;

  const lines = text.split(/\r?\n/);
  const found = [];

  for (const m of text.matchAll(
    /\bclient\.(get|post|put|patch|delete)\(\s*[`"]([^`"]+)[`"]/g
  )) {
    if (!m[2].startsWith(segment + "/") && m[2] !== segment) continue;
    found.push({
      line: text.slice(0, m.index).split(/\r?\n/).length,
      path: m[2],
    });
  }

  const rel = relative(root, file).replace(/\\/g, "/");

  if (found.length) {
    problems += found.length;
    console.error(
      `\n  ${rel}\n` +
      `  baseURL ends in "${segment}", so these ${found.length} call(s) send it twice:`
    );
    for (const f of found) {
      console.error(`      ${rel}:${f.line}  "${f.path}"  →  ${base}${f.path}`);
      console.error(`          ${(lines[f.line - 1] ?? "").trim()}`);
    }
  }
}

if (problems === 0) {
  console.log(`  API paths OK - ${instances} client(s) checked, no doubled base segments`);
  process.exit(0);
}

console.error(
  `\n  ${problems} call(s) repeat their client's base segment. Drop the segment\n` +
  `  from the path — the baseURL already carries it.\n`
);
process.exit(1);
