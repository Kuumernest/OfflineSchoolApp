// desktop/scripts/check-desktop-launch.js
"use strict";

/**
 * The real desktop app, launched, under a virtual display: does the window
 * load, render, and reach its server?
 *
 * The packaged app used to open to a blank window (file:// broke the assets,
 * the router and every network request; src/main/appProtocol.js). This runs
 * Electron itself in smoke mode (src/main/main.js) against a stand-in school
 * server, and reads what the window saw from inside:
 *
 *   1. server set:     app://school/…, React rendered, fetch("/api/health")
 *                      reaches the server — with no Origin header
 *   2. a deep link:    /students/42 is served and routed, not "file not found"
 *   3. no server set:  the first-run screen, and /api answers 503 NO_SERVER
 *
 * Needs the web app built (npm --prefix ../web run build), the Electron
 * binary, and xvfb-run on Linux. Not part of `npm run check`: CI runners have
 * neither a display nor the binary by default.
 *
 *   node scripts/check-desktop-launch.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const DESKTOP = path.join(__dirname, "..");
const DIST    = path.join(DESKTOP, "..", "web", "dist", "index.html");
const RESULT  = path.join(DESKTOP, "smoke-result.txt");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const launch = (env) => new Promise((resolve) => {
  try { fs.unlinkSync(RESULT); } catch { /* none yet */ }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "school-desktop-"));
  const child = spawn("xvfb-run", ["-a", process.execPath, path.join(__dirname, "launch.js"), "--smoke"], {
    cwd: DESKTOP,
    env: {
      ...process.env,
      SCHOOL_DESKTOP_SMOKE: "7000",
      SCHOOL_DESKTOP_NO_SANDBOX: "1",
      // A profile of its own: no server address or data left from another run.
      XDG_CONFIG_HOME: profile, HOME: profile,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const killer = setTimeout(() => child.kill("SIGKILL"), 60000);
  child.on("exit", () => {
    clearTimeout(killer);
    fs.rmSync(profile, { recursive: true, force: true });
    let text = "";
    try { text = fs.readFileSync(RESULT, "utf8"); } catch { /* no result */ }
    const line = (k) => (text.match(new RegExp(`^${k}\\s+(.*)$`, "m")) || [])[1] ?? null;
    let renderer = null;
    try { renderer = JSON.parse(line("renderer")); } catch { /* reported below */ }
    resolve({ text, log, renderer, line });
  });
});

(async () => {
  if (!fs.existsSync(DIST)) { console.error(`web/dist is not built: ${DIST}`); process.exit(2); }
  if (spawnSync("which", ["xvfb-run"]).status !== 0) { console.error("xvfb-run is not installed"); process.exit(2); }

  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, origin: req.headers.origin ?? null, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/api/echo"
        ? JSON.stringify({ received: Buffer.concat(chunks).toString() })
        : JSON.stringify({ status: "ok", database: "connected" }));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const SERVER = `http://127.0.0.1:${server.address().port}`;

  console.log("--- 1. a desktop with its server set ---");
  let run = await launch({ SCHOOL_SERVER_URL: SERVER });
  const r1 = run.renderer;
  if (!r1) console.log(run.text || run.log.slice(-2000));
  check("the window is on app://school/, and the app rendered (not a blank window)",
    [r1?.href?.startsWith("app://school/"), r1?.mounted], [true, true]);
  check("  a request from the page to /api reached the school's server, and got its answer",
    [r1?.health?.status, JSON.parse(r1?.health?.body || "{}").status, seen.some((s) => s.url === "/api/health")],
    [200, "ok", true]);
  check("  with no Origin header (nothing for CORS to refuse)",
    seen.filter((s) => s.url === "/api/health").every((s) => s.origin === null), true);
  check("  XMLHttpRequest — what axios uses in the window — gets there too", r1?.xhr?.status, 200);
  check("  a POST with a JSON body arrives with its body",
    [r1?.post?.status, JSON.parse(r1?.post?.body || "{}").received], [200, '{"probe":1}']);
  check("  and the local API is registered (the shared modules resolved)", Number(run.line("local routes")) > 50, true);

  console.log("--- 2. a deep link ---");
  run = await launch({ SCHOOL_SERVER_URL: SERVER, SCHOOL_DESKTOP_START_PATH: "/students/42" });
  check("app://school/students/42 is served and routed by the app (it renders; signed out, it may go to /login)",
    [run.renderer?.mounted, run.renderer?.href?.startsWith("app://school/")], [true, true]);

  console.log("--- 3. a new desktop, no server yet ---");
  run = await launch({ SCHOOL_SERVER_URL: "" });
  const r3 = run.renderer;
  check("the first-run screen asks for the server address",
    [r3?.mounted, /server/i.test(r3?.text || "")], [true, true]);
  check("  and /api answers 503 NO_SERVER rather than going anywhere",
    [r3?.health?.status, JSON.parse(r3?.health?.body || "{}").code], [503, "NO_SERVER"]);

  console.log("--- 4. the server unreachable (offline) ---");
  run = await launch({ SCHOOL_SERVER_URL: "http://127.0.0.1:9" });
  check("a request fails as a network error (axios ERR_NETWORK, the app's offline handling), not a made-up status",
    [Boolean(run.renderer?.health?.error), Boolean(run.renderer?.xhr?.error), run.renderer?.mounted], [true, true, true]);

  server.close();
  try { fs.unlinkSync(RESULT); } catch { /* fine */ }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
