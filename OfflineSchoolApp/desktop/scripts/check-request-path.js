// desktop/scripts/check-request-path.js
"use strict";

/**
 * Assert that an axios request becomes the path the server would have seen.
 *
 * ── Why this is worth its own file ────────────────────────────────────────
 *
 * Because it is the failure mode with no symptom. Every other part of the
 * offline layer breaks loudly: a missing handler falls through to the network, a
 * bad query throws, a broken bridge logs. This one answers a slightly different
 * question than the screen asked, and returns a plausible number.
 *
 * A dropped academicYear does not error — it sums every year's charges, and a
 * bursar reads a balance that is too high to a parent standing at the counter.
 * A schoolId stringified as "undefined" matches no school and returns an empty
 * roster that looks exactly like a school with no pupils in it.
 *
 * The route matcher is checked here too, for the same reason: a pattern that
 * matches more than its author intended answers one endpoint's question with
 * another endpoint's shape.
 *
 *   node scripts/check-request-path.js
 */

const fs = require("fs");

const { requestPath } = require("../../shared/requestPath");
const { compile, handle } = require("../src/main/api");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- baseURL joins to url exactly once ---");

// This app's baseURL is "/api", so it is part of the route the handlers match.
check("the ordinary case",
  requestPath({ baseURL: "/api", url: "/admin/students" }),
  { path: "/api/admin/students", query: {} });

check("a url with no leading slash",
  requestPath({ baseURL: "/api", url: "admin/students" }).path,
  "/api/admin/students");

check("a baseURL with a trailing slash",
  requestPath({ baseURL: "/api/", url: "/admin/students" }).path,
  "/api/admin/students");

check("both, which must not produce a double slash",
  requestPath({ baseURL: "/api/", url: "admin/students" }).path,
  "/api/admin/students");

check("no baseURL at all",
  requestPath({ url: "/api/admin/students" }).path, "/api/admin/students");

// An absolute url is its own address. Concatenating baseURL onto it would give
// "/apihttps://..." — matching no route and silently going to the network.
check("an absolute url ignores baseURL",
  requestPath({ baseURL: "/api", url: "https://school.example.com/api/fees/structures" }).path,
  "/api/fees/structures");

check("including its query string",
  requestPath({ baseURL: "/api", url: "https://x.test/api/fees/structures?schoolId=s1" }).query,
  { schoolId: "s1" });

// Express treats these as the same route, so the matcher must too.
check("a trailing slash is normalised away",
  requestPath({ baseURL: "/api", url: "/admin/students/" }).path,
  "/api/admin/students");
check("but a bare root is left alone",
  requestPath({ url: "/" }).path, "/");

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- parameters, from wherever they came ---");

check("a query string in the url",
  requestPath({ baseURL: "/api", url: "/admin/students?schoolId=s1&status=approved" }).query,
  { schoolId: "s1", status: "approved" });

check("axios params",
  requestPath({ baseURL: "/api", url: "/admin/students", params: { schoolId: "s1" } }).query,
  { schoolId: "s1" });

check("both together",
  requestPath({ baseURL: "/api", url: "/admin/students?status=approved", params: { schoolId: "s1" } }).query,
  { status: "approved", schoolId: "s1" });

// axios appends params after the url's own query, and a later value wins.
check("params win on a collision, as axios serialises them",
  requestPath({ baseURL: "/api", url: "/x?year=2025", params: { year: "2026" } }).query,
  { year: "2026" });

// THE ONE THAT MATTERS MOST. "undefined" as a schoolId matches no school, and
// the empty list that comes back is indistinguishable from a school with no
// pupils — so it reads as data rather than as a bug.
check("an undefined param is omitted, never stringified",
  requestPath({ baseURL: "/api", url: "/x", params: { schoolId: "s1", classId: undefined } }).query,
  { schoolId: "s1" });

check("and so is null",
  requestPath({ baseURL: "/api", url: "/x", params: { schoolId: "s1", term: null } }).query,
  { schoolId: "s1" });

// A falsy value that is NOT absent has to survive: page 0 and an empty search
// box are both real requests.
check("zero survives",
  requestPath({ baseURL: "/api", url: "/x", params: { page: 0 } }).query, { page: "0" });
check("an empty string survives",
  requestPath({ baseURL: "/api", url: "/x", params: { search: "" } }).query, { search: "" });
check("false survives",
  requestPath({ baseURL: "/api", url: "/x", params: { active: false } }).query, { active: "false" });

check("numbers become strings, as they would on the wire",
  requestPath({ baseURL: "/api", url: "/x", params: { limit: 20 } }).query, { limit: "20" });

check("an encoded value is decoded",
  requestPath({ baseURL: "/api", url: "/x?name=Ada%20Nkeng" }).query, { name: "Ada Nkeng" });

check("no params and no query is an empty object, not undefined",
  requestPath({ baseURL: "/api", url: "/x" }).query, {});

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the route matcher matches exactly what it says ---");

const students = compile("GET /api/admin/students");
check("a literal route",
  students.regex.test("/api/admin/students"), true);
// The failure this prevents: /api/admin/students answering for
// /api/admin/students/p1/scores, with the wrong shape entirely.
check("and not a deeper path",
  students.regex.test("/api/admin/students/p1"), false);
check("nor a longer sibling",
  students.regex.test("/api/admin/studentsx"), false);
check("nor a prefix",
  students.regex.test("/api/admin"), false);

const ledger = compile("GET /api/fees/students/:studentId");
check("a parameter is captured",
  ledger.regex.exec("/api/fees/students/p1")?.[1], "p1");
check("by name", ledger.names, ["studentId"]);
// [^/]+ rather than .+, or an id of "p1/extra" would be captured and the
// handler would answer for a path it does not implement.
check("one segment only",
  ledger.regex.test("/api/fees/students/p1/extra"), false);
check("and it cannot be empty",
  ledger.regex.test("/api/fees/students/"), false);

// A dot in a literal segment is a dot, not "any character".
const dotted = compile("GET /api/a.b/c");
check("a literal dot is escaped",
  [dotted.regex.test("/api/a.b/c"), dotted.regex.test("/api/axb/c")],
  [true, false]);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- and the dispatcher declines rather than guessing ---");

// No context is passed: any handler that ran would throw on it, and handle()
// turns a throw into "not answered here" — so these prove routing, not luck.
check("an unknown path", handle({ method: "GET", path: "/api/nope", query: {} }, {}), null);
check("a known path with the wrong method",
  handle({ method: "DELETE", path: "/api/admin/students", query: {} }, {}), null);
check("a missing method defaults to GET rather than throwing",
  handle({ path: "/api/nope", query: {} }, {}), null);
check("a missing path does not throw",
  handle({ method: "GET", query: {} }, {}), null);

// A handler that throws must fall through to the network, not surface a local
// exception as an HTTP failure.
check("a handler that throws falls through",
  handle({ method: "GET", path: "/api/admin/students", query: { schoolId: "s1" } }, {}), null);

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- every shared module this package imports actually resolves ---");

// A require with one "../" too few does not fail loudly. Inside a handler, the
// dispatcher catches the throw and turns it into "not answered here" — so the
// endpoint quietly goes to the network and everything looks fine while the
// offline path is dead.
//
// That happened once, in handlers/approvals.js: handlers/ is a directory deeper
// than api/, and the import had been copied from writes.js with four levels
// instead of five. The symptom was two parity checks reporting "answered by the
// network", which reads like a deliberate decline.
//
// Two answers to it. Those requires moved to the top of their files, where a bad
// path fails at load; and this, which checks every one of them at once.
{
  const fsMod   = require("fs");
  const pathMod = require("path");
  const broken  = [];
  let checked   = 0;

  const walk = (dir) => {
    for (const entry of fsMod.readdirSync(dir, { withFileTypes: true })) {
      const p = pathMod.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith(".js")) continue;

      const src = fsMod.readFileSync(p, "utf8");
      for (const m of src.matchAll(/require\("([^"]*shared\/[^"]+)"\)/g)) {
        checked++;
        try {
          require.resolve(pathMod.resolve(pathMod.dirname(p), m[1]));
        } catch {
          broken.push(`${pathMod.relative(process.cwd(), p)} -> ${m[1]}`);
        }
      }
    }
  };
  walk(pathMod.join(__dirname, "..", "src"));

  // Guards against the check passing by finding nothing to check.
  check("some shared imports were found", checked > 0, true);
  check("and every one resolves", broken, []);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- the paths still resolve once this is an installed application ---");

// The whole packaging arrangement rests on one correspondence, and nothing in the
// code declares it:
//
//   in the repo      OfflineSchoolApp/desktop/  sits beside  shared/  and  web/
//   when installed   resources/app/             sits beside  resources/shared/
//                                                       and  resources/web/
//
// Because desktop/ and app/ are each one path segment, every relative path
// already written resolves correctly in both — so no code has to know whether it
// is packaged, and there is no build-time copy of shared/ to drift.
//
// It is arithmetic, so it is checked as arithmetic. Getting it wrong produces an
// installer that builds cleanly and then cannot find its own interface, which is
// discovered by a school rather than by a test.
{
  const pathMod = require("path");

  // Exactly the strings the code uses today.
  const WEB_FROM_MAIN       = "../../../web/dist/index.html";
  const SHARED_FROM_HANDLER = "../../../../../shared/students.js";

  const cases = [
    {
      name:     "running from the repo",
      main:     "/repo/OfflineSchoolApp/desktop/src/main",
      handlers: "/repo/OfflineSchoolApp/desktop/src/main/api/handlers",
      web:      "/repo/OfflineSchoolApp/web/dist/index.html",
      shared:   "/repo/OfflineSchoolApp/shared/students.js",
    },
    {
      // Files unpacked on disk.
      name:     "installed, app unpacked",
      main:     "/prog/resources/app/src/main",
      handlers: "/prog/resources/app/src/main/api/handlers",
      web:      "/prog/resources/web/dist/index.html",
      shared:   "/prog/resources/shared/students.js",
    },
    {
      // Files inside an asar archive. This one is the reason the check exists:
      // app.asar is ONE path segment just like app, so the resolved path leaves
      // the archive and lands on the real resources/shared — which require()
      // loads normally. Believing otherwise would have meant disabling asar for
      // no reason.
      name:     "installed, app in an asar archive",
      main:     "/prog/resources/app.asar/src/main",
      handlers: "/prog/resources/app.asar/src/main/api/handlers",
      web:      "/prog/resources/web/dist/index.html",
      shared:   "/prog/resources/shared/students.js",
    },
  ];

  for (const c of cases) {
    check(`${c.name}: web/dist`,
      pathMod.posix.resolve(c.main, WEB_FROM_MAIN), c.web);
    check(`${c.name}: shared/`,
      pathMod.posix.resolve(c.handlers, SHARED_FROM_HANDLER), c.shared);
  }

  // And the packaging config must actually put them where that expects.
  const builder = fs.readFileSync(
    pathMod.join(__dirname, "..", "electron-builder.yml"), "utf8"
  );
  check("the config ships shared/ into resources/shared",
    /to:\s*shared\b/.test(builder), true);
  check("and web/dist into resources/web/dist",
    /to:\s*web\/dist\b/.test(builder), true);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
