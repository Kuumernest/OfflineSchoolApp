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
const { getStore } = require("../storage/fileStore");
const { shrinkImage, MAX_IMAGE_BYTES } = require("../storage/imageResize");

const UPLOADS_ROOT  = path.resolve(__dirname, "..", "uploads");
const PHOTO_DIR     = path.join(UPLOADS_ROOT, "photos");
const PUBLIC_PREFIX = "/uploads/photos";

/**
 * 5 MB, as uploaded.
 *
 * A photo arrives straight from a phone camera without the chance to prepare
 * it, and a rejected upload at the counter with a parent waiting is worse than
 * a slightly large file. It is shrunk before it is stored (at most 400 px,
 * JPEG, metadata stripped — storage/imageResize.js), so this bounds the
 * upload, not what is kept.
 */
const MAX_PHOTO_BYTES = MAX_IMAGE_BYTES;

const ensurePhotoDir = () => {
  if (!fs.existsSync(PHOTO_DIR)) {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
  }
};

/** True for a stored reference rather than inline image data. */
const isPhotoReference = (value) =>
  typeof value === "string" && value.startsWith(PUBLIC_PREFIX);

/**
 * Writes a base64 photo to the file store and returns its public path.
 *
 * Content-addressed like logos: re-uploading identical bytes is a no-op, and a
 * changed photo gets a new URL, so clients and caches can treat the URL as
 * immutable. That matters on a printed ID card — a cached stale photo would
 * mean laminating the wrong face.
 *
 * @param {string} studentId
 * @param {string} base64  raw base64, with or without a data: prefix
 * @param {object} [opts]
 * @param {string} [opts.schoolId]  the pupil's school, kept with the file
 * @returns {Promise<{ publicPath: string, bytes: number, mime: string, filename: string }>}
 */
const savePhotoFromBase64 = async (studentId, base64, { schoolId = null } = {}) => {
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
  if (!sniffImage(buf)) throw new Error("Photo is not a JPEG, PNG, GIF or WebP image");
  const image = await shrinkImage(buf, "photo", "Photo");

  const hash     = crypto.createHash("md5").update(image.buffer).digest("hex").slice(0, 12);
  const safeId   = String(studentId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "student";
  const filename = `${safeId}-${hash}.${image.ext}`;
  const store    = getStore();

  if (!(await store.stat(`photos/${filename}`))) {
    await store.put(`photos/${filename}`, image.buffer, { contentType: image.mime, schoolId });
  }

  return {
    publicPath: `${PUBLIC_PREFIX}/${filename}`,
    bytes:      image.buffer.length,
    mime:       image.mime,
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
const deletePhotoFile = async (publicPath) => {
  if (!isPhotoReference(publicPath)) return false;
  const name = path.basename(publicPath.split("?")[0]);
  if (!name || name === "." || name === "..") return false;
  return getStore().removeUrl(`${PUBLIC_PREFIX}/${name}`);
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
