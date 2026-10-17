// desktop/src/main/appProtocol.js
"use strict";

/**
 * The window's origin: app://school/.
 *
 * ── Why not loadFile ──────────────────────────────────────────────────────
 *
 * The window used to load web/dist/index.html from disk (file://). Four things
 * broke there, and the packaged app opened to a blank window:
 *
 *   - Vite builds absolute asset paths (/assets/index-….js); under file:// they
 *     point at the root of the drive.
 *   - BrowserRouter read the on-disk path as the URL and rendered "not found";
 *     a hard redirect went to file:///login.
 *   - A request the local mirror could not answer fell through to the window's
 *     own axios with baseURL "/api" — file:///api/…, which goes nowhere.
 *     Setting an absolute VITE_API_URL instead kept the origin in the path,
 *     and then no local route (^/api/…) matched: the offline layer went dark.
 *   - Any request the window did make carried Origin: null, which the
 *     server's CORS allow-list rightly refuses.
 *
 * ── What this does instead ────────────────────────────────────────────────
 *
 * A privileged custom scheme, served by the main process:
 *
 *   app://school/api/…, /uploads/…  forwarded to the school's server (the one
 *                                    setting, see serverUrl), from the main
 *                                    process — no browser origin, so no CORS,
 *                                    and nothing added to ALLOWED_ORIGINS
 *   app://school/<a file in dist>    that file
 *   app://school/<anything else>     index.html, so BrowserRouter routes it
 *
 * The web build is unchanged and keeps its relative "/api" base: the offline
 * adapter offers every request to the local mirror first, exactly as before,
 * and what it cannot answer goes to app://school/api/… and on to the server.
 * Uploads, downloads and <img src="/uploads/…"> work because the browser builds
 * the real request; this only relays it. Authentication is the request's own
 * Authorization header, checked by the server as in a browser.
 */

const fs   = require("fs");
const path = require("path");

const HOST = "school";
const ORIGIN = `app://${HOST}`;

/** Paths relayed to the server; everything else is the app itself. */
const FORWARDED = ["/api/", "/uploads/"];

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
};

// Not passed on to the server: what identifies this window rather than the
// request (origin, referer — app://school means nothing to it), cookies (the
// app authenticates with a bearer token), and hop-by-hop headers.
const DROP_REQUEST = ["origin", "referer", "cookie", "host", "connection", "content-length"];
// Not passed back: fetch has already decoded the body, so the encoding and
// the length describe bytes the window will never see.
const DROP_RESPONSE = ["content-encoding", "content-length", "transfer-encoding", "connection"];

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

/**
 * @param {object} p
 * @param {string}   p.distDir    the built web app (web/dist)
 * @param {() => string} p.serverUrl  the school's server, e.g. https://api.example.cm ("" if unset)
 * @param {(url: string, init: object) => Promise<Response>} p.fetchImpl  net.fetch in Electron
 * @returns {(request: Request) => Promise<Response>}
 */
function createAppProtocolHandler({ distDir, serverUrl, fetchImpl }) {
  const root = path.resolve(distDir);

  const serveStatic = async (pathname) => {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return new Response("Bad path", { status: 400 }); }
    const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
    // Never outside dist, whatever the path says.
    if (file !== root && !file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
    let target = file;
    const isFile = await fs.promises.stat(target).then((s) => s.isFile(), () => false);
    if (!isFile) {
      // A missing ASSET is a 404 — serving index.html as a script hides the
      // real failure. A missing PAGE is the app's to route.
      if (path.extname(rel)) return new Response("Not found", { status: 404 });
      target = path.join(root, "index.html");
    }
    const body = await fs.promises.readFile(target);
    const ext  = path.extname(target).toLowerCase();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": MIME[ext] || "application/octet-stream",
        // The shell is re-read on every start; hashed assets never change.
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  };

  const forward = async (request, url) => {
    const base = String(serverUrl() || "").replace(/\/+$/, "");
    if (!base) {
      return json(503, { success: false, code: "NO_SERVER", message: "This desktop has no server address yet." });
    }
    const headers = new Headers(request.headers);
    for (const h of DROP_REQUEST) headers.delete(h);
    const hasBody = !["GET", "HEAD"].includes(request.method);
    let res;
    try {
      res = await fetchImpl(base + url.pathname + url.search, {
        method: request.method,
        headers,
        ...(hasBody ? { body: request.body, duplex: "half" } : {}),
        redirect: "follow",
      });
    } catch {
      // Unreachable server, no connection, DNS: a network error to the
      // window, as a browser would see it — so axios reports ERR_NETWORK and
      // the app's offline handling applies, rather than a made-up status.
      return Response.error();
    }
    const out = new Headers(res.headers);
    for (const h of DROP_RESPONSE) out.delete(h);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  };

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("Not found", { status: 404 });
    if (FORWARDED.some((p) => url.pathname.startsWith(p))) return forward(request, url);
    return serveStatic(url.pathname);
  };
}

/** The scheme's privileges; registered before the app is ready. */
const SCHEME = {
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
};

module.exports = { createAppProtocolHandler, SCHEME, ORIGIN, FORWARDED };
