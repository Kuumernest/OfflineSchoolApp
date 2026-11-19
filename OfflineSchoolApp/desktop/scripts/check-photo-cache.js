// desktop/scripts/check-photo-cache.js
"use strict";

/**
 * Offline pupil photos (src/main/appProtocol.js photoCache): filled from an
 * authorised 200, served when the server cannot be reached, never served in
 * place of an answer the server actually gave, never without a token.
 *
 *   node scripts/check-photo-cache.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");
const { createAppProtocolHandler } = require("../src/main/appProtocol");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const NAME = "stu1-0123456789ab.jpg";

(async () => {
  const tmp   = fs.mkdtempSync(path.join(os.tmpdir(), "photo-cache-"));
  const dist  = path.join(tmp, "dist");
  const cache = path.join(tmp, "photos");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>");

  let mode = "ok";
  const server = http.createServer((req, res) => {
    if (mode === "401") { res.writeHead(401, { "content-type": "application/json" }); return res.end("{}"); }
    if (mode === "placeholder") { res.writeHead(200, { "content-type": "image/png", "x-upload-missing": "1" }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); }
    if (mode === "404") { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
    if (!req.headers.authorization) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(JPEG);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  let serverUrl = base;
  const handle = createAppProtocolHandler({
    distDir: dist, serverUrl: () => serverUrl, fetchImpl: fetch, photoCacheDir: cache,
  });

  const get = (p, token = "abc") => handle(new Request(`app://school${p}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));

  // Online, authorised: passed through and kept.
  let res = await get(`/uploads/photos/${NAME}`);
  check("online photo is the server's", [res.status, Buffer.from(await res.arrayBuffer()).equals(JPEG)], [200, true]);
  check("and is now cached on disk", fs.existsSync(path.join(cache, NAME)), true);

  // Server unreachable: from the cache.
  serverUrl = "http://127.0.0.1:1";
  res = await get(`/uploads/photos/${NAME}`);
  check("offline photo comes from the cache", [res.status, res.headers.get("x-photo-cache")], [200, "hit"]);
  check("with the same bytes", Buffer.from(await res.arrayBuffer()).equals(JPEG), true);

  // No server address at all (503 NO_SERVER): from the cache too.
  serverUrl = "";
  res = await get(`/uploads/photos/${NAME}`);
  check("no server address still shows the cached photo", res.status, 200);

  // No token: never from the cache.
  serverUrl = "http://127.0.0.1:1";
  res = await get(`/uploads/photos/${NAME}`, null);
  check("no token offline is not served the cached photo", res.status === 200, false);

  // A photo never cached: the network error stands.
  res = await get(`/uploads/photos/other-0123456789ab.jpg`);
  check("uncached photo offline is still an error", res.status === 200, false);

  // Server reachable and refusing: its answer stands, not the cache.
  serverUrl = base;
  mode = "401";
  res = await get(`/uploads/photos/${NAME}`);
  check("a server 401 is not replaced by the cache", res.status, 401);
  mode = "404";
  res = await get(`/uploads/photos/${NAME}`);
  check("a server 404 (deleted photo) is not replaced by the cache", res.status, 404);

  // The server's placeholder for a lost file is shown but never cached.
  mode = "placeholder";
  res = await get(`/uploads/photos/lost-0123456789ab.jpg`);
  check("placeholder is passed through", res.status, 200);
  check("but not cached under the photo's name", fs.existsSync(path.join(cache, "lost-0123456789ab.jpg")), false);

  // Not a photo name: plain forwarding, nothing cached.
  mode = "ok";
  res = await get(`/uploads/messages/a.pdf`);
  check("non-photo uploads are not cached", fs.readdirSync(cache).filter((f) => f.includes("a.pdf")).length, 0);

  // Path tricks never reach the cache.
  res = await get(`/uploads/photos/..%2f..%2fsecret.jpg`);
  check("a traversal-shaped name is not treated as a photo", fs.readdirSync(cache).length, 1);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
