// backend/src/utils/photoStorage.js
"use strict";

/**
 * Student passport photos, stored as files.
 *
 * Mirrors logoStorage deliberately rather than sharing it: photos live under a
 * different directory, carry a different size limit, and are deleted on a
 * different schedule. Folding them into the logo helper would mean one function
 * whose behaviour depends on which caller reached it, and the two would drift.
 *
 * The bytes never go in the Student document. A passport photo is 100–300 KB;
 * inline, every roster read, every class list and every sync would carry it,
 * which is the exact problem logoStorage was written to undo for school logos.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const { sniffImage, stripDataUri } = require("./logoStorage");

const UPLOADS_ROOT  = path.resolve(__dirname, "..", "uploads");
const PHOTO_DIR     = path.join(UPLOADS_ROOT, "photos");
const PUBLIC_PREFIX = "/uploads/photos";

/**
 * 3 MB.
 *
 * Higher than the logo limit because this arrives straight from a phone camera
 * without the chance to prepare it, and a rejected upload at the counter with a
 * parent waiting is worse than a slightly large file. The clients downscale
 * before sending, so this is a backstop rather than the normal size.
 */
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

const ensurePhotoDir = () => {
  if (!fs.existsSync(PHOTO_DIR)) {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
  }
};

/** True for a stored reference rather than inline image data. */
const isPhotoReference = (value) =>
  typeof value === "string" && value.startsWith(PUBLIC_PREFIX);

/**
 * Writes a base64 photo to disk and returns its public path.
 *
 * Content-addressed like logos: re-uploading identical bytes is a no-op, and a
 * changed photo gets a new URL, so clients and caches can treat the URL as
 * immutable. That matters on a printed ID card — a cached stale photo would
 * mean laminating the wrong face.
 *
 * @param {string} studentId
 * @param {string} base64  raw base64, with or without a data: prefix
 * @returns {{ publicPath: string, bytes: number, mime: string, filename: string }}
 */
const savePhotoFromBase64 = (studentId, base64) => {
  const clean = stripDataUri(base64);
  if (!clean) throw new Error("Photo payload is empty");

  let buf;
  try {
    buf = Buffer.from(clean, "base64");
  } catch {
    throw new Error("Photo is not valid base64");
  }

  if (!buf.length) throw new Error("Photo decoded to zero bytes");
  if (buf.length > MAX_PHOTO_BYTES) {
    throw new Error(
      `Photo is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is ` +
      `${MAX_PHOTO_BYTES / 1024 / 1024} MB`
    );
  }

  // Sniffed from the magic bytes, not from a client-sent mime type or a file
  // extension — both are attacker-controlled and neither says what the bytes
  // actually are.
  const kind = sniffImage(buf);
  if (!kind) throw new Error("Photo is not a JPEG, PNG, GIF or WebP image");

  ensurePhotoDir();

  const hash     = crypto.createHash("md5").update(buf).digest("hex").slice(0, 12);
  const safeId   = String(studentId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "student";
  const filename = `${safeId}-${hash}.${kind.ext}`;
  const abs      = path.join(PHOTO_DIR, filename);

  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);

  return {
    publicPath: `${PUBLIC_PREFIX}/${filename}`,
    bytes:      buf.length,
    mime:       kind.mime,
    filename,
  };
};

/**
 * Removes a photo file. Never throws.
 *
 * Path-checked before unlinking: the stored value reaches here from a database
 * field, and a value that is not one of ours must not become an arbitrary file
 * delete.
 */
const deletePhotoFile = (publicPath) => {
  try {
    if (!isPhotoReference(publicPath)) return false;

    const filename = path.basename(publicPath);
    const abs      = path.join(PHOTO_DIR, filename);

    // Confirms the resolved path is still inside PHOTO_DIR, so a crafted
    // "../../.." in the stored value cannot escape it.
    if (path.dirname(path.resolve(abs)) !== path.resolve(PHOTO_DIR)) return false;

    if (fs.existsSync(abs)) { fs.unlinkSync(abs); return true; }
    return false;
  } catch {
    return false;
  }
};

module.exports = {
  PHOTO_DIR,
  PUBLIC_PREFIX,
  MAX_PHOTO_BYTES,
  ensurePhotoDir,
  isPhotoReference,
  savePhotoFromBase64,
  deletePhotoFile,
};
