// backend/scripts/check-routers-load.js
"use strict";

/**
 * Every router loads, exports routes, and releases the event loop.
 *
 * ── What is being proved ──────────────────────────────────────────────────
 *
 * Each src/routes/*.routes.js file can be required on its own, exports an
 * Express router that carries at least one route, and leaves nothing behind
 * that would keep a process alive: no referenced timer, server, socket or
 * child process. The last point is the reason this file exists. A router
 * that starts a referenced setInterval at module load is invisible to a
 * server that never exits, and fatal to anything else that requires it — a
 * verification, a script, a worker — which then hangs until it is killed.
 * The Stage 18B router-load verification hung exactly so on the public
 * router's rate-limit sweeper.
 *
 * ── How it ends ───────────────────────────────────────────────────────────
 *
 * Naturally. There is no process.exit() and no timeout: the verdict goes into
 * process.exitCode and the process ends when the loop is empty, which is the
 * assertion. If a router ever holds the loop again, this script hangs, and a
 * CI runner's own limit reports it — a hang is the failure, not a number
 * chosen here.
 *
 *   node scripts/check-routers-load.js
 */

const fs   = require("fs");
const path = require("path");

const ROOT   = path.join(__dirname, "..");
const ROUTES = path.join(ROOT, "src", "routes");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

/** Routes on a router, nested routers walked. */
const routeCount = (router) => {
  let n = 0;
  const walk = (stack) => { for (const layer of stack ?? []) { if (layer.route) n++; else if (layer.name === "router" && layer.handle?.stack) walk(layer.handle.stack); } };
  walk(router?.stack);
  return n;
};

/**
 * What keeps the process alive, stdio excluded. process.getActiveResourcesInfo()
 * is the one view that includes referenced timers — Node keeps timers in its
 * own list, not among the libuv handles _getActiveHandles() returns, so a
 * handle-only check waves through exactly the setInterval this file exists to
 * catch. An unref'd timer is not reported, which is the point.
 */
const STDIO = new Set(["PipeWrap", "TTYWrap", "FSReqCallback"]);
const holdingResources = () => process.getActiveResourcesInfo().filter((r) => !STDIO.has(r));

(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const files = fs.readdirSync(ROUTES).filter((f) => f.endsWith(".routes.js")).sort();
  console.log(`\n--- ${files.length} routers in src/routes ---`);
  const loaded = [];
  for (const f of files) {
    let router = null, err = null;
    try { router = require(path.join(ROUTES, f)); } catch (e) { err = e.message; }
    const isRouter = typeof router === "function" && Array.isArray(router.stack);
    loaded.push({ f, ok: !err && isRouter, routes: isRouter ? routeCount(router) : 0, err });
  }
  check("every router file loads", loaded.filter((r) => r.err).map((r) => `${r.f}: ${r.err}`), []);
  check("every export is an Express router", loaded.filter((r) => !r.ok && !r.err).map((r) => r.f), []);
  check("every router carries at least one route", loaded.filter((r) => r.ok && r.routes === 0).map((r) => r.f), []);
  console.log(`       ${loaded.reduce((s, r) => s + r.routes, 0)} routes across ${loaded.length} routers`);

  // Give module-load side effects one turn to settle, then look at what holds the loop.
  setImmediate(() => {
    check("after loading, nothing holds the event loop (no referenced timer, server, socket or child)", holdingResources(), []);
    console.log("");
    console.log(`  ${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
    // No process.exit(): the process ends when the loop is empty. That it does is the last assertion.
  });
})();
