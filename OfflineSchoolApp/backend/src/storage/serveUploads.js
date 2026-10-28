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

const mediaSignature      = require("../utils/mediaSignature");
const { getStore }        = require("./fileStore");
const { sendPlaceholder } = require("./placeholder");

const PLACEHOLDER_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

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
 */
const serveUploads = ({ uploadsRoot, mediaMime }) => {
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

    // ── Signature gate for private uploads ─────────────────────────────────
    // messages/ attachments are PII and now carry signed URLs (Message.js signs
    // them at read time — see utils/mediaSignature.js). The default is observe
    // mode: unsigned access is logged, nothing is blocked, because URLs already
    // sitting in clients' SQLite caches were received unsigned and every message
    // read since the signing change re-issues them. Give caches a signature
    // lifetime to refresh, then REQUIRE_MEDIA_SIGNATURE=1 enforces.
    // Judged on the path as it RESOLVES, not as it was typed: "./messages/x"
    // and "a/../messages/x" land on uploads/messages/x, but their first segment
    // is not "messages", so the raw string passed as unprotected and a private
    // attachment was served without a signature. A legitimate signed URL is
    // already canonical, so its signature verifies against the same string.
    const canonicalPath = path.relative(uploadsRoot, filePath).split(path.sep).join("/");
    if (mediaSignature.isProtectedPath(canonicalPath)) {
      const sig = req.query?.sig;
      if (!mediaSignature.verifyMediaSignature(canonicalPath, sig)) {
        if (process.env.REQUIRE_MEDIA_SIGNATURE === "1") {
          return res.status(401).json({
            error: "This link has expired. Ask for the file to be shared again.",
            code:  "MEDIA_SIGNATURE_REQUIRED",
          });
        }
        console.warn(`[media] unsigned access to protected path: ${relativePath}`);
      }
    }

    // ── Where the file lives (storage/fileStore.js) ─────────────────────────
    // The URL is the one stored in the record, whichever driver holds the file.
    // In a bucket: a short redirect to it — a signed URL, or the public one for
    // logos — so ranges, caching and the bandwidth are the bucket's. A logo or
    // photo that is gone is answered with a placeholder picture rather than a
    // broken image, from either driver.
    const ext      = path.extname(filePath).toLowerCase();
    const store    = getStore();
    const missingImage = () =>
      store.isImageDir(canonicalPath) && PLACEHOLDER_EXTS.has(ext) ? sendPlaceholder(res) : null;

    if (store.driver === "mongo") {
      return (async () => {
        const file = await store.stat(canonicalPath);
        if (!file) return missingImage() ?? res.status(404).json({ error: "File not found" });
        return sendStored(req, res, store, file, {
          cacheControl: store.isPublicDir?.(canonicalPath) ? "public, max-age=86400" : "private, max-age=3600",
        });
      })().catch(next);
    }

    if (store.driver !== "local") {
      return (async () => {
        if (!(await store.stat(canonicalPath))) {
          return missingImage() ?? res.status(404).json({ error: "File not found" });
        }
        res.set("Cache-Control", "private, max-age=300");
        return res.redirect(302, await store.url(canonicalPath));
      })().catch(next);
    }

    if (!fs.existsSync(filePath)) {
      const placeholder = missingImage();
      if (placeholder) return placeholder;
    }

    const mimeType = MEDIA_MIME[ext];
    if (!mimeType) return next();

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    const fileSize = fs.statSync(filePath).size;
    const range    = req.headers.range;

    const commonHeaders = {
      "Content-Type":                  mimeType,
      "Accept-Ranges":                 "bytes",
      "Cross-Origin-Resource-Policy":  "cross-origin",
      "Access-Control-Allow-Origin":   "*",
      "Access-Control-Allow-Headers":  "Range",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
      "Cache-Control":                 "public, max-age=86400",
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
  };
};

module.exports = { serveUploads, sendStored, PLACEHOLDER_EXTS };
