// backend/src/storage/serveUploads.js
"use strict";

/**
 * GET /uploads/{*path} — every uploaded file, at the URL its record stores.
 *
 * Moved out of server.js unchanged in what it checks (a malformed path, a path
 * outside uploads/, the signature on a private message attachment) so it can
 * be tested on its own. What it now does with the file depends on the store
 * (storage/fileStore.js):
 *
 *   mongo   streamed from GridFS, with range support (sendStored)
 *   bucket  a 302 to the file — a signed URL, or the bucket's public URL for
 *           logos — so ranges, caching and bandwidth are the bucket's
 *   local   streamed from disk with range support, as before; a type this
 *           handler does not stream falls through to express.static
 *
 * A logo or photo whose file is gone gets a placeholder picture, from either.
 */

const fs   = require("fs");
const path = require("path");

const { getStore }        = require("./fileStore");
const { sendPlaceholder } = require("./placeholder");

const PLACEHOLDER_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/**
 * Logos are public and content-addressed (a new logo is a new name), so any
 * cache may keep one for a year. Everything else is for the signed-in user's
 * own browser only, and only for an hour.
 */
const cacheControlFor = (store, key) =>
  store.isPublicDir(key) ? "public, max-age=31536000, immutable" : "private, max-age=3600";

/**
 * Send a GridFS file (as stat/statId describe it), honouring a byte range.
 * `cacheControl` is the caller's: public for logos, private for the rest.
 */
const sendStored = (req, res, store, file, { cacheControl }) => {
  const size  = file.size;
  const range = req.headers.range;
  const headers = {
    "Content-Type":                  file.contentType,
    "Accept-Ranges":                 "bytes",
    "Cache-Control":                 cacheControl,
    "ETag":                          `"${file.id}"`,
    "X-Content-Type-Options":        "nosniff",
    ...(cacheControl.startsWith("private") && { "Vary": "Authorization" }),
    "Cross-Origin-Resource-Policy":  "cross-origin",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
  if (req.headers["if-none-match"] === headers.ETag) {
    res.writeHead(304, headers);
    return res.end();
  }

  let start, end;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    start = m && m[1] !== "" ? parseInt(m[1], 10) : NaN;
    end   = m && m[2] !== "" ? parseInt(m[2], 10) : size - 1;
    if (m && m[1] === "" && m[2] !== "") { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    if (!Number.isFinite(start) || start < 0 || start >= size || end < start) {
      res.set("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, "Content-Length": size });
  }
  if (req.method === "HEAD" || size === 0) return res.end();

  const stream = store.openStream(file.id, range ? { start, end } : {});
  stream.on("error", (err) => {
    console.error("[files] stream error:", err.message);
    res.destroy(err);
  });
  return stream.pipe(res);
};

/**
 * @param {object} opts
 * @param {string} opts.uploadsRoot  the local uploads directory
 * @param {Object<string,string>} opts.mediaMime  extension → type this handler streams itself
 * @param {Function} opts.gate  storage/fileAccess.js makeFileGate(authenticate)
 */
const serveUploads = ({ uploadsRoot, mediaMime, gate }) => {
  uploadsRoot = path.resolve(uploadsRoot);
  const MEDIA_MIME = mediaMime;

  return (req, res, next) => {
    const rawParam = req.params.path || req.params[0] || "";

    // A malformed percent-encoding is a bad request, not a server error:
    // decodeURIComponent throws on a stray "%", and unguarded that surfaced as
    // a 500 through the error handler.
    let relativePath;
    try {
      relativePath = decodeURIComponent(
        Array.isArray(rawParam) ? rawParam.join("/") : String(rawParam)
      );
    } catch {
      return res.status(400).json({ error: "Malformed path" });
    }

    const filePath = path.resolve(uploadsRoot, relativePath);

    // The separator is the whole point. startsWith(uploadsRoot) alone also
    // accepts a sibling directory whose name merely begins with "uploads" —
    // "uploads-private", "uploads_backup" — and a resolve() into one of those
    // sailed past this check.
    if (!filePath.startsWith(uploadsRoot + path.sep)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const canonicalPath = path.relative(uploadsRoot, filePath).split(path.sep).join("/");

    // ── Who may read it (storage/fileAccess.js) ─────────────────────────────
    // Logos: anyone. Everything else: a signed link for this file, or a
    // signed-in user of its school, or a Super Admin. Judged on the path as
    // it RESOLVES, not as it was typed: "./messages/x" and "a/../messages/x"
    // land on uploads/messages/x, and a legitimate signed URL is already
    // canonical, so its signature verifies against the same string.
    //
    // A logo or photo that is gone is answered with a placeholder picture
    // rather than a broken image, before any login is asked for — there is
    // nothing to protect, and old /uploads/... URLs whose file was lost in a
    // deploy keep showing something.
    const ext      = path.extname(filePath).toLowerCase();
    const store    = getStore();
    const missingImage = () =>
      store.isImageDir(canonicalPath) && PLACEHOLDER_EXTS.has(ext) ? sendPlaceholder(res) : null;
    const notFound = () => missingImage() ?? res.status(404).json({ error: "File not found" });

    return (async () => {
      if (store.driver === "mongo") {
        const file = await store.stat(canonicalPath);
        if (!file) return notFound();
        if (!(await gate(req, res, canonicalPath, file))) return;
        return sendStored(req, res, store, file, { cacheControl: cacheControlFor(store, canonicalPath) });
      }

      if (store.driver !== "local") {
        if (!(await store.stat(canonicalPath))) return notFound();
        if (!(await gate(req, res, canonicalPath, null))) return;
        res.set("Cache-Control", "private, max-age=300");
        return res.redirect(302, await store.url(canonicalPath));
      }

      let isFile = false;
      try { isFile = fs.statSync(filePath).isFile(); } catch { /* missing */ }
      if (!isFile) return notFound();
      if (!(await gate(req, res, canonicalPath, null))) return;
      return streamLocal();
    })().catch(next);

    function streamLocal() {
      // A type this handler does not stream goes on to express.static —
      // only once the gate above has let it through.
      const mimeType = MEDIA_MIME[ext];
      if (!mimeType) return next();

      const fileSize = fs.statSync(filePath).size;
      const range    = req.headers.range;

      const commonHeaders = {
        "Content-Type":                  mimeType,
        "Accept-Ranges":                 "bytes",
        "Cross-Origin-Resource-Policy":  "cross-origin",
        "Access-Control-Allow-Origin":   "*",
        "Access-Control-Allow-Headers":  "Range",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
        "Cache-Control":                 cacheControlFor(store, canonicalPath),
      };

      if (!range) {
        res.writeHead(200, { ...commonHeaders, "Content-Length": fileSize });
        const stream = fs.createReadStream(filePath);
        stream.on("error", (err) => {
          console.error("[media] full stream error:", err.message);
          if (!res.headersSent) res.status(500).end();
        });
        return stream.pipe(res);
      }

      const parts        = range.replace(/bytes=/, "").split("-");
      const start        = parseInt(parts[0], 10);
      const requestedEnd = parts[1] !== "" && parts[1] !== undefined
        ? parseInt(parts[1], 10)
        : Math.min(start + 10 * 1024 * 1024 - 1, fileSize - 1);

      if (isNaN(start) || start < 0 || start >= fileSize) {
        res.set("Content-Range", `bytes */${fileSize}`);
        return res.status(416).end();
      }

      const end       = Math.min(requestedEnd, fileSize - 1);
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        ...commonHeaders,
        "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": chunkSize,
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.on("error", (err) => {
        console.error("[media] range stream error:", err.message);
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
    }
  };
};

/**
 * GET /files/:id — a GridFS file by its id, behind the same gate. 404 with
 * any other driver: only GridFS files have such an id.
 */
const serveFileById = ({ gate }) => (req, res, next) => (async () => {
  const store = getStore();
  const file  = store.driver === "mongo" ? await store.statId(req.params.id) : null;
  // Applicant documents only ever through their own authorised route.
  if (!file || file.key.startsWith("applications/")) return res.status(404).json({ error: "File not found" });
  if (!(await gate(req, res, file.key, file))) return;
  return sendStored(req, res, store, file, { cacheControl: cacheControlFor(store, file.key) });
})().catch(next);

module.exports = { serveUploads, serveFileById, sendStored, cacheControlFor, PLACEHOLDER_EXTS };
