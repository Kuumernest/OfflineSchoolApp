// backend/src/utils/logoStorage.js
"use strict";

/**
 * School logos as files instead of inline base64.
 *
 * A logo used to be stored as a base64 string inside the School document —
 * ~160 KB, roughly 99% of the record. Every read of a school paid for the
 * image: fetching one document from the remote cluster took ~5 s, and the
 * mobile client polls school info, so a static picture was re-read constantly.
 *
 * Now the bytes live on disk under uploads/logos and the document holds only
 * a short public path. Reading a school is back to a few hundred bytes, and
 * the image is served by the existing static handler, which supports range
 * requests and lets clients cache it.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const UPLOADS_ROOT = path.resolve(__dirname, "..", "uploads");
const LOGO_DIR     = path.join(UPLOADS_ROOT, "logos");
const PUBLIC_PREFIX = "/uploads/logos";

/** Max decoded logo size we will accept (2 MB). */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT SNIFFING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identifies an image by its magic bytes rather than trusting a client-sent
 * mime type or extension.
 *
 * @param {Buffer} buf
 * @returns {{ ext: string, mime: string } | null}
 */
const sniffImage = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { ext: "png", mime: "image/png" };
  }
  // GIF: "GIF8"
  if (buf.slice(0, 4).toString("ascii") === "GIF8") {
    return { ext: "gif", mime: "image/gif" };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Longest value we treat as a reference. Real paths and URLs are tiny; this
 * also bounds how much of a value the light API path is willing to echo.
 */
const MAX_REFERENCE_LEN = 512;

/**
 * True when the stored value is a path/URL rather than image bytes.
 *
 * The naive test — "starts with /" — is wrong here in a way that matters:
 * base64-encoded JPEG *always* begins `/9j/`, because the JPEG magic bytes
 * FF D8 FF encode to that. A 160 KB blob would be misread as a path, and the
 * migration would skip exactly the rows it exists to convert.
 *
 * So a reference must match a known shape and be short.
 */
const isLogoReference = (value) => {
  if (!value || typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.length > MAX_REFERENCE_LEN) return false;

  if (v.startsWith("http://") || v.startsWith("https://")) return true;
  // Local static paths only — anchored, so "/9j/…" cannot qualify.
  return /^\/uploads\//i.test(v);
};

/**
 * True when the stored value looks like inline image data — the legacy shape.
 * Deliberately conservative: anything that is not a reference and is long
 * enough to be an image is treated as inline data.
 */
const isInlineLogo = (value) => {
  if (!value || typeof value !== "string") return false;
  const v = value.trim();
  if (!v || isLogoReference(v)) return false;
  return v.length > 256;
};

/** Strips a `data:image/png;base64,` prefix if present. */
const stripDataUri = (value) =>
  String(value || "").trim().replace(/^data:[^;,]*;base64,/, "");

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────────────────────

const ensureLogoDir = () => {
  if (!fs.existsSync(LOGO_DIR)) {
    fs.mkdirSync(LOGO_DIR, { recursive: true });
  }
  return LOGO_DIR;
};

/**
 * Resolves a stored public path to an absolute file path, refusing anything
 * that escapes the logo directory.
 *
 * @returns {string|null}
 */
const resolveLogoFile = (publicPath) => {
  if (!publicPath || typeof publicPath !== "string") return null;
  const trimmed = publicPath.trim();
  if (!trimmed.startsWith(PUBLIC_PREFIX)) return null;

  const name = path.basename(trimmed);          // discard any traversal
  const abs  = path.resolve(LOGO_DIR, name);
  if (!abs.startsWith(LOGO_DIR)) return null;   // defence in depth
  return abs;
};

/**
 * Writes a base64 logo to disk and returns its public path.
 *
 * The filename embeds a content hash, so re-uploading the same image is a
 * no-op and a changed image gets a new URL — which is what lets clients and
 * any cache in between treat logo URLs as immutable.
 *
 * @param {string} schoolId
 * @param {string} base64      raw base64, with or without a data: prefix
 * @returns {{ publicPath: string, bytes: number, mime: string, filename: string }}
 * @throws {Error} when the payload is not a recognised image or is too large
 */
const saveLogoFromBase64 = (schoolId, base64) => {
  const clean = stripDataUri(base64);
  if (!clean) throw new Error("Logo payload is empty");

  let buf;
  try {
    buf = Buffer.from(clean, "base64");
  } catch {
    throw new Error("Logo is not valid base64");
  }
  if (!buf.length) throw new Error("Logo decoded to zero bytes");
  if (buf.length > MAX_LOGO_BYTES) {
    throw new Error(
      `Logo is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is ` +
      `${MAX_LOGO_BYTES / 1024 / 1024} MB`
    );
  }

  const kind = sniffImage(buf);
  if (!kind) throw new Error("Logo is not a JPEG, PNG, GIF or WebP image");

  ensureLogoDir();

  const hash     = crypto.createHash("md5").update(buf).digest("hex").slice(0, 12);
  const safeId   = String(schoolId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "school";
  const filename = `${safeId}-${hash}.${kind.ext}`;
  const abs      = path.join(LOGO_DIR, filename);

  // Content-addressed: identical bytes mean the file is already correct.
  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, buf);
  }

  return {
    publicPath: `${PUBLIC_PREFIX}/${filename}`,
    bytes:      buf.length,
    mime:       kind.mime,
    filename,
  };
};

/**
 * Deletes a logo file previously written by saveLogoFromBase64.
 * Never throws — a missing or unexpected path is simply ignored.
 */
const deleteLogoFile = (publicPath) => {
  try {
    const abs = resolveLogoFile(publicPath);
    if (abs && fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      return true;
    }
  } catch (err) {
    console.warn("[logoStorage] delete failed:", err.message);
  }
  return false;
};

/** Byte size of a stored logo file, or null when it cannot be read. */
const logoFileSize = (publicPath) => {
  try {
    const abs = resolveLogoFile(publicPath);
    if (abs && fs.existsSync(abs)) return fs.statSync(abs).size;
  } catch { /* ignore */ }
  return null;
};

module.exports = {
  LOGO_DIR,
  PUBLIC_PREFIX,
  MAX_LOGO_BYTES,
  MAX_REFERENCE_LEN,
  sniffImage,
  isLogoReference,
  isInlineLogo,
  stripDataUri,
  ensureLogoDir,
  resolveLogoFile,
  saveLogoFromBase64,
  deleteLogoFile,
  logoFileSize,
};
