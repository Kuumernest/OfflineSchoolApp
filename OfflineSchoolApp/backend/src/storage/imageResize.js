// backend/src/storage/imageResize.js
"use strict";

/**
 * Logos and photos are shrunk before they are stored.
 *
 * Uploads now live in the app's own MongoDB (storage/fileStore.js, GridFS),
 * and the Atlas free tier holds 512 MB for everything. A phone photo is 2–5 MB
 * and is never shown larger than an ID-card box, so each image is cut to what
 * the app actually displays and re-encoded:
 *
 *   logo   at most 512 px on its longer side, WebP (keeps transparency)
 *   photo  at most 400 px, JPEG (prints everywhere, ID cards included)
 *
 * both at quality 80, turned upright from the camera's orientation tag, with
 * every bit of metadata dropped (EXIF, GPS position, camera serial). A file
 * over MAX_IMAGE_BYTES, or one that is not a JPEG, PNG, GIF or WebP image
 * that actually decodes, is refused.
 */

const sharp = require("sharp");

/** Largest image accepted, before shrinking (5 MB). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const PROFILES = {
  logo:  { maxSide: 512, format: "webp", ext: "webp", mime: "image/webp" },
  photo: { maxSide: 400, format: "jpeg", ext: "jpg",  mime: "image/jpeg" },
};

const QUALITY = 80;

/** What sharp may decode: the formats the app has always accepted. */
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);

const refuse = (msg) => Object.assign(new Error(msg), { code: "BAD_IMAGE" });

/**
 * @param {Buffer} buf     the uploaded bytes
 * @param {"logo"|"photo"} kind
 * @param {string} [label] "Logo" / "Photo", for the messages
 * @returns {Promise<{ buffer: Buffer, ext: string, mime: string, width: number, height: number }>}
 * @throws {Error} code BAD_IMAGE — too large, or not an image we accept
 */
const shrinkImage = async (buf, kind, label = "Image") => {
  const profile = PROFILES[kind];
  if (!profile) throw new Error(`Unknown image kind: ${kind}`);
  if (!Buffer.isBuffer(buf) || !buf.length) throw refuse(`${label} is empty`);
  if (buf.length > MAX_IMAGE_BYTES) {
    throw refuse(
      `${label} is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is ` +
      `${MAX_IMAGE_BYTES / 1024 / 1024} MB`
    );
  }

  let meta;
  try {
    // limitInputPixels: a tiny file that claims to be 50 000 × 50 000 pixels
    // would otherwise be decoded into gigabytes of memory.
    meta = await sharp(buf, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw refuse(`${label} is not a JPEG, PNG, GIF or WebP image`);
  }
  if (!ACCEPTED_FORMATS.has(meta.format)) {
    throw refuse(`${label} is not a JPEG, PNG, GIF or WebP image`);
  }

  let out;
  try {
    let img = sharp(buf, { limitInputPixels: 50_000_000, animated: false })
      .rotate()                                   // upright, then the tag goes
      .resize({ width: profile.maxSide, height: profile.maxSide, fit: "inside", withoutEnlargement: true });
    // A photo has no transparency to keep: flatten onto white so a PNG with
    // an alpha channel does not come out black.
    img = profile.format === "jpeg"
      ? img.flatten({ background: "#ffffff" }).jpeg({ quality: QUALITY, mozjpeg: true })
      : img.webp({ quality: QUALITY });
    // sharp writes no metadata unless asked (withMetadata) — EXIF, GPS and
    // ICC profiles are all left behind.
    out = await img.toBuffer({ resolveWithObject: true });
  } catch {
    throw refuse(`${label} could not be read as an image`);
  }

  return {
    buffer: out.data,
    ext:    profile.ext,
    mime:   profile.mime,
    width:  out.info.width,
    height: out.info.height,
  };
};

module.exports = { shrinkImage, MAX_IMAGE_BYTES, PROFILES, QUALITY };
