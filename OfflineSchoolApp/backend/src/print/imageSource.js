// backend/src/print/imageSource.js
"use strict";

/**
 * The one way a printed document turns a stored logo or photo into an <img src>.
 *
 * ── Why there is one ──────────────────────────────────────────────────────
 *
 * Two helpers did this (print/document.js absoluteLogo and
 * reportCardData.service absoluteLogoUrl) and both had the same gap: they
 * passed through http(s): and data: and glued the request's origin onto
 * anything else. A school whose logo is still the legacy inline base64
 * (utils/logoStorage.js — converted only by scripts/migrate-school-logos.js)
 * stores "/9j/4AAQ…" or "iVBOR…", which came out as https://host/9j/4AAQ… — a
 * 404 on the ID card, the transcript and every report card.
 *
 * ── The two modes ─────────────────────────────────────────────────────────
 *
 * A LINK (the default): an absolute URL the page can load from wherever it is
 * opened — a print iframe, a blob tab, the phone's PDF engine. Report cards use
 * this, because a published card is stored whole (GeneratedReport) and an
 * image embedded in every stored card would multiply the database by the size
 * of a photo.
 *
 * EMBEDDED (`embed: true`): the file read from disk and written into the page
 * as a data: URI. ID cards, transcripts and class lists use this. They are
 * built on request and never stored here, but the phone caches them to print
 * offline (mobile/src/services/document.service.js), and a cached page that
 * links to the server prints with blank boxes where the photos were. Embedded,
 * the page is complete in itself: nothing to wait for before printing, no host
 * to get wrong, nothing to break when a photo is replaced.
 *
 * Only logos and photos are ever read from disk. Messages and applicant
 * documents are private and are never resolved here.
 *
 * A value that resolves to nothing returns null, and every template already
 * prints its empty state for null (the ID card's "affix photo" box, no logo).
 */

const fs   = require("fs");
const path = require("path");

const UPLOADS_ROOT = path.resolve(__dirname, "..", "uploads");
const EMBEDDABLE   = ["logos", "photos"];

/** An embedded image larger than this is linked instead. */
const MAX_EMBED_BYTES = 3 * 1024 * 1024;

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif",  ".webp": "image/webp",
};

/** Image type from magic bytes, for the legacy base64 that carries no prefix. */
const sniffMime = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf.slice(1, 4).toString("ascii") === "PNG") return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
};

/** Raw base64 image bytes (no data: prefix) → a data URI, or null. */
const inlineBase64 = (value) => {
  const v = String(value).replace(/\s+/g, "");
  if (v.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const mime = sniffMime(Buffer.from(v.slice(0, 64), "base64"));
  return mime ? `data:${mime};base64,${v}` : null;
};

/**
 * The upload a value names, as { dir, file } relative to uploads/, or null.
 * Accepts "/uploads/logos/x.png" and an absolute URL to the same path on any
 * host — a value written while the server answered as localhost still names
 * the right file.
 */
const uploadOf = (value) => {
  let p = String(value);
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return null; }
  }
  const m = /^\/?uploads\/([^/?#]+)\/([^?#]+)$/i.exec(p.split("?")[0]);
  if (!m) return null;
  let file;
  try { file = decodeURIComponent(m[2]); } catch { return null; }
  return { dir: m[1].toLowerCase(), file };
};

/** The bytes of a logo or photo on disk as a data URI, or null. */
const embedUpload = ({ dir, file }) => {
  if (!EMBEDDABLE.includes(dir)) return null;
  const base     = path.join(UPLOADS_ROOT, dir);
  const filePath = path.resolve(base, path.basename(file));
  if (!filePath.startsWith(base + path.sep)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_EMBED_BYTES) return null;
    const buf  = fs.readFileSync(filePath);
    const mime = sniffMime(buf) || MIME_BY_EXT[path.extname(filePath).toLowerCase()];
    return mime ? `data:${mime};base64,${buf.toString("base64")}` : null;
  } catch {
    return null;
  }
};

/** Is this upload's file actually on disk? */
const uploadExists = ({ dir, file }) => {
  try { return fs.statSync(path.join(UPLOADS_ROOT, dir, path.basename(file))).isFile(); }
  catch { return false; }
};

/**
 * Where a request was addressed, honouring the forwarded headers a proxy sets.
 * The first value of each, since a chain of proxies sends a list.
 */
const originOf = (req) => {
  const first = (v) => String(v || "").split(",")[0].trim();
  const proto = first(req?.headers?.["x-forwarded-proto"]) || req?.protocol || "http";
  const host  = first(req?.headers?.["x-forwarded-host"])  || req?.get?.("host") || "";
  return host ? `${proto}://${host}` : null;
};

/**
 * An <img src> for a stored logo or photo, or null.
 *
 * @param {string|null} value  as stored: /uploads/…, an http(s) URL, a data:
 *                             URI, or legacy raw base64
 * @param {object}  [opts]
 * @param {string}  [opts.origin]  absolute origin for links
 * @param {boolean} [opts.embed]   write the file into the page (see above)
 */
function resolveImageSrc(value, { origin = null, embed = false } = {}) {
  if (!value || typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;

  if (/^data:image\//i.test(v)) return v;

  const upload = uploadOf(v);
  if (upload) {
    if (embed) {
      const inline = embedUpload(upload);
      if (inline) return inline;
    }
    // A link to a file that is not there is a broken image on paper; the
    // template's empty state is the better thing to print.
    // An absolute URL is passed on as it is — it may be another server's.
    if (/^https?:\/\//i.test(v)) return v;
    if (EMBEDDABLE.includes(upload.dir) && !uploadExists(upload)) return null;
    return origin ? `${origin}/uploads/${upload.dir}/${encodeURIComponent(upload.file)}` : null;
  }

  if (/^https?:\/\//i.test(v)) return v;

  // Before the path test: base64 JPEG always begins "/9j/".
  const legacy = inlineBase64(v);
  if (legacy) return legacy;

  if (!origin) return null;
  return `${origin}${v.startsWith("/") ? "" : "/"}${v}`;
}

module.exports = { resolveImageSrc, originOf, MAX_EMBED_BYTES };
