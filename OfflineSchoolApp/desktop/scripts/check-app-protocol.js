// desktop/scripts/check-app-protocol.js
"use strict";

/**
 * The app:// scheme (src/main/appProtocol.js) and the server address
 * (src/main/serverAddress.js), without Electron: a temporary dist directory, a
 * real HTTP server standing in for the school's, and Node's fetch in place of
 * net.fetch.
 *
 *   node scripts/check-app-protocol.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { createAppProtocolHandler } = require("../src/main/appProtocol");
const { normaliseServerUrl, checkServer } = require("../src/main/serverAddress");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  // ── a built web app ───────────────────────────────────────────────────────
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), "app-protocol-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><div id=root></div><script src=\"/assets/app-1.js\"></script>");
  fs.writeFileSync(path.join(dist, "assets", "app-1.js"), "console.log('app')");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "outside dist");

  // ── the school's server ───────────────────────────────────────────────────
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.startsWith("/api/health")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ status: "ok" })); }
      if (req.url === "/api/zipped") {
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
      }
      if (req.url === "/api/denied") { res.writeHead(409, { "content-type": "application/json" }); return res.end(JSON.stringify({ code: "DUPLICATE_NAME" })); }
      if (req.url.startsWith("/uploads/")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255])); }
      if (req.url === "/not-api/health") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>a router page</html>"); }
      res.writeHead(201, { "content-type": "application/json", "x-request-path": req.url });
      res.end(JSON.stringify({ echoed: body.toString("utf8").slice(0, 200) }));
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  let serverUrl = base;
  const handle = createAppProtocolHandler({ distDir: dist, serverUrl: () => serverUrl, fetchImpl: fetch });
  const ask = (url, init) => handle(new Request(url, init));

  // ═══ the app itself ═══
  console.log("--- the app ---");
  let r = await ask("app://school/");
  check("app://school/ → index.html, not cached", [r.status, r.headers.get("content-type"), r.headers.get("cache-control"), (await r.text()).includes('id=root')],
    [200, "text/html; charset=utf-8", "no-cache", true]);
  r = await ask("app://school/assets/app-1.js");
  check("an asset by its absolute path (what file:// broke): served, as JavaScript, cached for good",
    [r.status, r.headers.get("content-type"), r.headers.get("cache-control").includes("immutable")], [200, "text/javascript; charset=utf-8", true]);
  const pages = await Promise.all(["app://school/login", "app://school/students/42/edit", "app://school/dashboard?tab=2"].map((u) => ask(u).then((x) => x.text())));
  check("any page path → index.html, so BrowserRouter routes it (deep links, reloads, redirects to /login)",
    pages.every((t) => t.includes("id=root")), true);
  check("a missing asset is a 404, not index.html served as a script", (await ask("app://school/assets/gone-9.js")).status, 404);
  const tries = await Promise.all(["app://school/../secret.txt", "app://school/%2e%2e/secret.txt", "app://school/assets/%2e%2e/%2e%2e/secret.txt"]
    .map((u) => ask(u).then(async (x) => [x.status, (await x.text()).includes("outside dist")])));
  check("nothing outside dist, however the path is spelled", tries.map(([, leaked]) => leaked), [false, false, false]);
  check("another host on the scheme → 404", (await ask("app://elsewhere/")).status, 404);

  // ═══ the server ═══
  console.log("--- relayed to the school's server ---");
  seen.length = 0;
  r = await ask("app://school/api/health?x=1", { headers: { authorization: "Bearer tok-1", origin: "app://school", cookie: "c=1", referer: "app://school/login" } });
  const got = seen[0];
  check("GET /api/… → the server, same path and query, its answer passed back",
    [got?.method, got?.url, r.status, (await r.json()).status], ["GET", "/api/health?x=1", 200, "ok"]);
  check("  Authorization kept; Origin, Referer and Cookie not sent (so no CORS, no null origin)",
    [got?.headers.authorization, "origin" in (got?.headers || {}), "referer" in (got?.headers || {}), "cookie" in (got?.headers || {})],
    ["Bearer tok-1", false, false, false]);
  seen.length = 0;
  r = await ask("app://school/api/admin/classes", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify({ name: "Form 1" }) });
  check("POST with a JSON body: body relayed, 201 back",
    [seen[0]?.method, seen[0]?.headers["content-type"], seen[0]?.body.toString(), r.status], ["POST", "application/json", '{"name":"Form 1"}', 201]);
  seen.length = 0;
  const form = new FormData();
  form.append("title", "Syllabus");
  form.append("file", new Blob([Buffer.from([1, 2, 3, 250, 0, 9])], { type: "application/pdf" }), "syllabus.pdf");
  const formReq = new Request("http://x/", { method: "POST", body: form });
  const formType = formReq.headers.get("content-type");
  const formBytes = Buffer.from(await formReq.arrayBuffer());
  r = await ask("app://school/api/teacher/content", { method: "POST", headers: { "content-type": formType }, body: formBytes });
  check("a multipart upload: content type (with its boundary) and every byte relayed",
    [seen[0]?.headers["content-type"] === formType, Buffer.compare(seen[0]?.body ?? Buffer.alloc(0), formBytes) === 0, r.status], [true, true, 201]);
  r = await ask("app://school/uploads/photos/p1.png");
  check("/uploads/… relayed too, binary intact (an <img src> works)",
    [r.status, r.headers.get("content-type"), [...Buffer.from(await r.arrayBuffer())]], [200, "image/png", [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]]);
  r = await ask("app://school/api/zipped");
  check("a gzipped answer arrives decoded, without a content-encoding the window would decode twice",
    [r.headers.get("content-encoding"), await r.json()], [null, { zipped: true }]);
  r = await ask("app://school/api/denied");
  check("a refusal passes through as itself (409 and its code), for the app to handle",
    [r.status, (await r.json()).code], [409, "DUPLICATE_NAME"]);

  serverUrl = "";
  r = await ask("app://school/api/health");
  check("no server address yet → 503 NO_SERVER", [r.status, (await r.json()).code], [503, "NO_SERVER"]);
  serverUrl = "http://127.0.0.1:9";   // nothing listens there
  r = await ask("app://school/api/health");
  check("server unreachable → a network error (axios ERR_NETWORK), not an invented status", r.type, "error");
  serverUrl = base;

  // ═══ the address ═══
  console.log("--- the server address ---");
  check("normalised to the origin; a trailing /api (as web and mobile use) is taken off",
    ["https://api.example.cm", "https://api.example.cm/", "https://api.example.cm/api", "api.example.cm/api/", "HTTPS://Api.Example.cm:8443/api"].map((u) => normaliseServerUrl(u).url),
    ["https://api.example.cm", "https://api.example.cm", "https://api.example.cm", "https://api.example.cm", "https://api.example.cm:8443"]);
  check("  plain http only on this machine or a school network",
    [normaliseServerUrl("http://192.168.1.20:5000").ok, normaliseServerUrl("http://localhost:5000/api").url, normaliseServerUrl("http://api.example.cm").ok],
    [true, "http://localhost:5000", false]);
  check("  refused: empty, not a web address, another scheme, credentials in it",
    ["", "http://", "ftp://x.cm", "https://u:p@x.cm"].map((u) => normaliseServerUrl(u).ok), [false, false, false, false]);
  check("checking a real server: ok, and the address as it will be stored",
    await checkServer(`${base}/api`, fetch), { ok: true, url: base });
  check("  nothing listening: not ok, with a sentence",
    (await checkServer("http://127.0.0.1:9", fetch, 2000)).ok, false);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
