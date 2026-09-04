// backend/scripts/check-orphans.js
"use strict";

/**
 * Nothing ships that nothing runs.
 *
 * ── Why a check and not a tidy-up ─────────────────────────────────────────────
 *
 * Dead code next to live code is not untidy, it is a trap, and it has caught us
 * twice:
 *
 *   middleware/upload.js was where image/svg+xml was removed from the upload
 *   allow-list. Nothing imports that module — its own comment says
 *   teacher.routes.js uses it, and teacher.routes.js has its own multer with its
 *   own list, which still accepted SVG. The fix was reported, believed, and had
 *   no effect for a week.
 *
 *   src/db/models/Grade.js was required by exactly one module,
 *   src/modules/sync/sync.service.js, which the server never loads. The sync
 *   feed names its models as strings and resolves them through
 *   mongoose.models, so `grade` was a mirrored collection that could never be
 *   served. No exception, no log: grades simply never reached a device.
 *
 * Both are the same failure. A person reading the code cannot tell whether what
 * they are reading runs. This asserts it instead.
 *
 * ── What it proves ────────────────────────────────────────────────────────────
 *
 *   1. Every model the sync feed names is registered by a file the server
 *      actually loads. This is the check that would have caught `grade`, and it
 *      is deliberately stricter than check-sync-feed's version — that one
 *      requires every model file itself before asserting they are registered,
 *      which cannot fail this way.
 *
 *   2. No module under src/ or middleware/ is unreachable from any entry point,
 *      except the ones named in ALLOWED below, each with a reason.
 *
 * Pure static analysis: no database, no network, no server. Runs in about a
 * second.
 *
 *   node scripts/check-orphans.js
 */

const fs   = require("fs");
const path = require("path");

const BACKEND = path.resolve(__dirname, "..");
const norm = (p) => path.resolve(p).replace(/\\/g, "/");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Modules that are unreachable on purpose. Each needs a reason, because a bare
// list becomes a place to hide things.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED = {
  // (empty — the dead modules this check first found were deleted rather than
  // listed. Add an entry only for something genuinely kept and not run.)
};

// ─────────────────────────────────────────────────────────────────────────────
// Reachability
// ─────────────────────────────────────────────────────────────────────────────

const EXTS = ["", ".js", ".json"];

const resolveSpec = (fromFile, spec) => {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const target = path.resolve(path.dirname(fromFile), spec);
  for (const e of EXTS) {
    const p = target + e;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return norm(p);
  }
  const idx = path.join(target, "index.js");
  return fs.existsSync(idx) ? norm(idx) : null;
};

/**
 * Every relative-looking string literal, not just the argument of require().
 *
 * server.js reaches its routers through loadRoute("./routes/auth.routes"), so a
 * check that only understood require() would call every router unreachable and
 * be useless.
 */
const SPEC_RE = /["'`](\.{1,2}\/[^"'`\n]+)["'`]/g;

/**
 * A module that reads its own directory and requires what it finds.
 *
 * db/models/index.js does exactly this, and no static resolver can follow it —
 * the path is computed. Treating the siblings as reachable is the truthful
 * model of what happens at boot, and it is narrow: it applies only to a module
 * that both readdirSync's __dirname and requires a path built from it.
 */
const isDirectoryLoader = (text) =>
  /readdirSync\(\s*__dirname/.test(text) &&
  /require\(\s*path\.join\(\s*__dirname/.test(text);

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, out);
    else if (e.name.endsWith(".js")) out.push(norm(fp));
  }
  return out;
};

// Entry points: the server, and every script — a helper used only by a
// maintenance script is live code, not an orphan.
const entries = [
  norm(path.join(BACKEND, "src/server.js")),
  norm(path.join(BACKEND, "src/instrument.js")),
  ...walk(path.join(BACKEND, "scripts")),
];

const reachable = new Set();
const queue = entries.filter((f) => fs.existsSync(f));

while (queue.length) {
  const f = queue.pop();
  if (reachable.has(f)) continue;
  reachable.add(f);
  if (!f.endsWith(".js")) continue;

  let text;
  try { text = fs.readFileSync(f, "utf8"); } catch { continue; }

  for (const m of text.matchAll(SPEC_RE)) {
    const hit = resolveSpec(f, m[1]);
    if (hit && !reachable.has(hit)) queue.push(hit);
  }

  if (isDirectoryLoader(text)) {
    for (const sibling of fs.readdirSync(path.dirname(f))) {
      if (!sibling.endsWith(".js")) continue;
      const p = norm(path.join(path.dirname(f), sibling));
      if (!reachable.has(p)) queue.push(p);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("--- every model the sync feed names is one the server loads ---");

const syncFeed  = require("../src/config/syncFeed");
const MODELS    = path.join(BACKEND, "src/db/models");

// Which file registers which model NAME. A file may register more than one:
// Attendance.js registers StudentAttendance and TeacherAttendance and nothing
// called "Attendance", which is how attendance came to be un-mirrored.
const registeredBy = new Map();
for (const file of fs.readdirSync(MODELS)) {
  if (!file.endsWith(".js") || file === "index.js") continue;
  const text = fs.readFileSync(path.join(MODELS, file), "utf8");
  for (const m of text.matchAll(/mongoose\.model\(\s*["']([A-Za-z0-9_]+)["']/g)) {
    registeredBy.set(m[1], norm(path.join(MODELS, file)));
  }
}

const unservable = syncFeed.FEED.filter((entry) => {
  const file = registeredBy.get(entry.model);
  return !file || !reachable.has(file);
}).map((entry) => entry.collection + " (" + entry.model + ")");

check("no mirrored collection resolves to a model the server never loads", unservable, []);
check("and the feed was actually read", syncFeed.FEED.length > 20, true);

// Guards the guard: if the model scan broke, the check above would pass by
// comparing an empty list against an empty list.
check("the model registry was populated", registeredBy.size > 40, true);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n--- nothing under src/ or middleware/ is unreachable ---");

const candidates = [
  ...walk(path.join(BACKEND, "src")),
  ...walk(path.join(BACKEND, "middleware")),
];

const relOf = (f) => f.replace(norm(BACKEND) + "/", "");

const orphans = candidates
  .filter((f) => !reachable.has(f))
  .map(relOf)
  .filter((rel) => !(rel in ALLOWED))
  .sort();

if (orphans.length) {
  console.log("\n       These files are not reachable from the server or any script.");
  console.log("       Delete them, wire them up, or add them to ALLOWED with a reason:\n");
  for (const o of orphans) console.log("         " + o);
  console.log("");
}

check("no unreachable modules", orphans, []);
check("and the walk found the tree", candidates.length > 100, true);

// Every allowance still has to exist, or the list becomes archaeology.
const staleAllowances = Object.keys(ALLOWED)
  .filter((rel) => !fs.existsSync(path.join(BACKEND, rel)));
check("every ALLOWED entry names a file that exists", staleAllowances, []);

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(`  (${reachable.size} modules reachable from ${entries.length} entry points)`);
process.exit(fail ? 1 : 0);
