// src/services/logoCache.service.js
"use strict";

/**
 * Keeps a school logo on the device so it renders with no connection.
 *
 * Moving logos out of the database and onto the server's filesystem made
 * reading a school cheap, but it also turned the logo into a URL — and a URL
 * is useless offline. So the image is downloaded once into the app's document
 * directory and the local path is what the UI actually renders.
 *
 * Filenames are content-addressed by the server (…-<hash>.jpg), so a cached
 * file is either the current logo or a stale name we can safely replace. That
 * means "is my copy current?" is a string comparison, with no HEAD request.
 *
 * Uses the SDK 54+ File/Directory API. The legacy helpers still re-exported
 * from `expo-file-system` are documented to throw at runtime, so they are not
 * an option here.
 */

import { Paths, File, Directory } from "expo-file-system";
import { toAbsoluteUrl, isRemoteLogo, isLocalFileUri } from "../utils/logoUri";

const DIR_NAME = "school-logos";

/** Resolves (creating if needed) the directory holding cached logos. */
const logoDir = () => {
  const dir = new Directory(Paths.document, DIR_NAME);
  try {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  } catch (err) {
    console.warn("[logoCache] could not create logo dir:", err.message);
  }
  return dir;
};

/** Filename for a logo URL — keeps the server's hashed name, prefixed by school. */
const fileNameFor = (schoolId, url) => {
  const tail = String(url).split("?")[0].split("/").pop() || "logo";
  const safeTail = tail.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
  const safeId = String(schoolId || "school").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
  return `${safeId}-${safeTail}`;
};

/**
 * Ensures the logo for `logoValue` exists on disk and returns its file:// uri.
 *
 * - Already a local file  → returned unchanged
 * - Not remote (base64)   → null, nothing to cache
 * - Remote               → downloaded once, then reused
 *
 * Never throws: on failure it returns null and the caller falls back to
 * whatever it already had.
 *
 * @param {string} schoolId
 * @param {string} logoValue  URL, path, base64, or file:// uri
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<string|null>} local file uri, or null
 */
export const cacheLogo = async (schoolId, logoValue, { force = false } = {}) => {
  if (isLocalFileUri(logoValue)) return String(logoValue).trim();
  if (!isRemoteLogo(logoValue)) return null;

  const url = toAbsoluteUrl(logoValue);
  if (!url) return null;

  try {
    const dir  = logoDir();
    const name = fileNameFor(schoolId, url);
    const dest = new File(dir, name);

    if (dest.exists && !force) {
      // Content-addressed name: same name means same bytes.
      if (dest.size > 0) return dest.uri;
      dest.delete();   // zero-byte leftover from an interrupted download
    }

    const downloaded = await File.downloadFileAsync(url, dest, { idempotent: true });
    const uri = downloaded?.uri || dest.uri;

    const check = new File(uri);
    if (!check.exists || check.size === 0) {
      console.warn("[logoCache] download produced an empty file — discarding");
      try { check.delete(); } catch { /* ignore */ }
      return null;
    }

    console.log(`[logoCache] Cached logo (${(check.size / 1024).toFixed(0)} KB) → ${name}`);
    return uri;
  } catch (err) {
    console.warn("[logoCache] cacheLogo failed:", err.message);
    return null;
  }
};

/**
 * Removes cached logo files for a school that are not `keepUri`.
 * Called after a successful refresh so old hashed names do not accumulate.
 */
export const pruneLogos = async (schoolId, keepUri = null) => {
  try {
    const dir = logoDir();
    if (!dir.exists) return 0;

    const safeId = String(schoolId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!safeId) return 0;

    const keepName = keepUri ? String(keepUri).split("/").pop() : null;
    let removed = 0;

    for (const entry of dir.list()) {
      const name = String(entry?.uri || "").split("/").pop();
      if (!name || !name.startsWith(`${safeId}-`)) continue;
      if (keepName && name === keepName) continue;
      try { entry.delete(); removed++; } catch { /* ignore */ }
    }

    if (removed) console.log(`[logoCache] Pruned ${removed} stale logo file(s)`);
    return removed;
  } catch (err) {
    console.warn("[logoCache] pruneLogos failed:", err.message);
    return 0;
  }
};

/** True when this uri points at a file that exists locally with content. */
export const isCached = (uri) => {
  try {
    if (!isLocalFileUri(uri)) return false;
    const f = new File(String(uri).trim());
    return f.exists && f.size > 0;
  } catch {
    return false;
  }
};

export default { cacheLogo, pruneLogos, isCached };
