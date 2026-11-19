// src/services/photoCache.service.js
"use strict";

/**
 * Pupil passport photos kept on the phone, so the gate screen, the profile
 * and an offline report card show a face with no connection.
 *
 * The same idea as logoCache.service.js, with two differences that matter:
 *
 *   - A photo is a PRIVATE upload (backend storage/fileAccess.js): the
 *     download carries the signed-in user's token.
 *   - The server answers a lost file with a placeholder PNG (status 200,
 *     storage/placeholder.js). Photos are always stored as JPEG
 *     (storage/imageResize.js), so a .jpg that arrives as a PNG is the
 *     placeholder and is discarded rather than kept under the real name.
 *
 * Names are the server's own — "<pupil id>-<12-hex content hash>.jpg"
 * (utils/photoStorage.js) — so a replaced photo is a NEW name and a cached
 * file can never be the wrong face. This is a cache of the server's file, not
 * a second copy of record: deleting the directory loses nothing.
 *
 * Never throws. A failure returns null and the caller shows initials.
 */

import { Paths, File, Directory } from "expo-file-system";
import { absoluteFileUrl, authHeaders } from "../utils/storedFile";

const DIR_NAME = "student-photos";

/** The server's photo name in a stored value, or null for anything else. */
const NAME = /\/uploads\/photos\/([A-Za-z0-9_-]+-[0-9a-f]{12}\.(?:jpe?g|png|gif|webp))(?:[?#].*)?$/i;
export const photoFileName = (photoUrl) => {
  const m = NAME.exec(String(photoUrl || ""));
  return m ? m[1] : null;
};

const photoDir = () => {
  const dir = new Directory(Paths.document, DIR_NAME);
  try {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  } catch (err) {
    console.warn("[photoCache] could not create photo dir:", err.message);
  }
  return dir;
};

const fileFor = (name) => new File(photoDir(), name);

/** The local file:// uri for a photo already on the phone, or null. Synchronous. */
export const cachedPhotoUri = (photoUrl) => {
  const name = photoFileName(photoUrl);
  if (!name) return null;
  try {
    const f = fileFor(name);
    return f.exists && f.size > 0 ? f.uri : null;
  } catch {
    return null;
  }
};

const readBase64 = async (file) =>
  typeof file.base64Async === "function" ? file.base64Async() : file.base64();

const inFlight = new Map();

/**
 * Make sure the photo is on the phone; resolves its file:// uri, or null.
 * One download per name at a time, however many screens ask.
 */
export const cachePhoto = (photoUrl) => {
  const name = photoFileName(photoUrl);
  if (!name) return Promise.resolve(null);
  const have = cachedPhotoUri(photoUrl);
  if (have) return Promise.resolve(have);
  if (inFlight.has(name)) return inFlight.get(name);

  const job = (async () => {
    const dest = fileFor(name);
    try {
      if (dest.exists) dest.delete();   // a zero-byte leftover
      const headers = await authHeaders();
      if (!headers.Authorization) return null;   // never fetch a private file unsigned
      const got = await File.downloadFileAsync(absoluteFileUrl(photoUrl), dest, { headers, idempotent: true });
      const file = new File(got?.uri || dest.uri);
      if (!file.exists || file.size === 0) { try { file.delete(); } catch { /* ignore */ } return null; }

      // The placeholder for a lost file (always PNG) under a .jpg name.
      if (!/\.png$/i.test(name)) {
        const b64 = await readBase64(file);
        if (String(b64).startsWith("iVBORw0KGgo")) {
          try { file.delete(); } catch { /* ignore */ }
          return null;
        }
      }
      return file.uri;
    } catch (err) {
      console.warn("[photoCache] cachePhoto failed:", err.message);
      try { if (dest.exists) dest.delete(); } catch { /* ignore */ }
      return null;
    } finally {
      inFlight.delete(name);
    }
  })();
  inFlight.set(name, job);
  return job;
};

/**
 * The photo as a data: URI, for HTML that is printed offline (a report card,
 * an ID card) — a file:// or server link in a print job is a blank box.
 * Resolves "" when the photo is not on the phone and cannot be fetched.
 */
export const photoDataUri = async (photoUrl) => {
  if (!photoUrl) return "";
  if (/^data:image\//i.test(photoUrl)) return photoUrl;
  const uri = cachedPhotoUri(photoUrl) || await cachePhoto(photoUrl);
  if (!uri) return "";
  try {
    const b64 = await readBase64(new File(uri));
    const name = photoFileName(photoUrl) || "";
    const mime = /\.png$/i.test(name) ? "image/png"
      : /\.webp$/i.test(name) ? "image/webp"
      : /\.gif$/i.test(name) ? "image/gif" : "image/jpeg";
    return b64 ? `data:${mime};base64,${b64}` : "";
  } catch {
    return "";
  }
};

/**
 * Warm the cache for many pupils (after a roster pull). Sequential and
 * capped: a class of fifty is fifty small downloads, not fifty at once on a
 * school's shared connection.
 */
export const warmPhotos = async (photoUrls, { limit = 400 } = {}) => {
  let fetched = 0;
  for (const url of [...new Set((photoUrls || []).filter(Boolean))].slice(0, limit)) {
    if (cachedPhotoUri(url)) continue;
    if (await cachePhoto(url)) fetched++;
  }
  return fetched;
};

/** Remove every cached photo — on sign-out, with the rest of the account's data. */
export const clearPhotos = () => {
  try {
    const dir = new Directory(Paths.document, DIR_NAME);
    if (dir.exists) dir.delete();
  } catch { /* ignore */ }
};

export default { photoFileName, cachedPhotoUri, cachePhoto, photoDataUri, warmPhotos, clearPhotos };
