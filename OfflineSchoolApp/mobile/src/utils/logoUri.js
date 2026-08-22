// src/utils/logoUri.js
"use strict";

/**
 * One place that knows how to turn a stored school logo into something
 * <Image> can render.
 *
 * A logo can arrive in four shapes, and every screen used to guess at this
 * on its own — two of them hardcoded `data:image/jpeg;base64,${logo}`, which
 * silently renders nothing once the server starts sending a URL instead:
 *
 *   file:///…                  already cached on this device (offline-ready)
 *   http(s)://…                absolute remote URL
 *   /uploads/logos/x.jpg       server-relative path
 *   /9j/4AAQ… or iVBOR…        legacy inline base64
 *
 * Note the trap in the last one: base64 JPEG always begins "/9j/", so a
 * leading slash does NOT mean "path". Reference detection is anchored to
 * known prefixes instead.
 */

import { API_URL } from "../services/api";

/** Longest value we treat as a reference; real paths and URLs are tiny. */
const MAX_REFERENCE_LEN = 512;

const clean = (value) =>
  typeof value === "string" ? value.trim() : "";

/** A local file already on this device. */
export const isLocalFileUri = (value) => clean(value).startsWith("file://");

/** An absolute remote URL. */
export const isAbsoluteUrl = (value) => /^https?:\/\//i.test(clean(value));

/** A server-relative static path. Anchored so "/9j/…" cannot match. */
export const isRelativeUploadPath = (value) => {
  const v = clean(value);
  return v.length <= MAX_REFERENCE_LEN && /^\/uploads\//i.test(v);
};

/** Anything the app should fetch over the network rather than decode. */
export const isRemoteLogo = (value) =>
  isAbsoluteUrl(value) || isRelativeUploadPath(value);

/** Already a data: URI. */
export const isDataUri = (value) => clean(value).startsWith("data:");

/** Inline image bytes — the legacy shape. */
export const isInlineBase64 = (value) => {
  const v = clean(value);
  if (!v) return false;
  return !isLocalFileUri(v) && !isRemoteLogo(v) && !isDataUri(v);
};

/**
 * The static file host — API_URL without its trailing /api segment, since
 * uploads are served from the server root, not under /api.
 */
export const staticBaseUrl = () => String(API_URL || "").replace(/\/api\/?$/, "");

/**
 * Absolute URL for a remote logo, or null when the value is not remote.
 */
export const toAbsoluteUrl = (value) => {
  const v = clean(value);
  if (!v) return null;
  if (isAbsoluteUrl(v)) return v;
  if (isRelativeUploadPath(v)) {
    return `${staticBaseUrl()}${v.startsWith("/") ? v : `/${v}`}`;
  }
  return null;
};

/** Guesses the mime type of raw base64 image data from its first characters. */
const base64Mime = (value) => {
  const v = clean(value);
  if (v.startsWith("iVBOR")) return "image/png";      // PNG
  if (v.startsWith("R0lGOD")) return "image/gif";     // GIF
  if (v.startsWith("UklGR")) return "image/webp";     // WebP (RIFF)
  return "image/jpeg";                                // "/9j/…" and default
};

/**
 * Turns any stored logo value into a uri for <Image source={{ uri }} />.
 *
 * Pass the locally cached copy first when you have one — it is the only form
 * that renders with no connection.
 *
 * @param {...(string|null|undefined)} candidates tried in order
 * @returns {string|null}
 */
export const toDisplayUri = (...candidates) => {
  for (const candidate of candidates) {
    const v = clean(candidate);
    if (!v) continue;

    if (isLocalFileUri(v) || isDataUri(v) || isAbsoluteUrl(v)) return v;
    if (isRelativeUploadPath(v)) return toAbsoluteUrl(v);
    return `data:${base64Mime(v)};base64,${v}`;
  }
  return null;
};

export default { toDisplayUri, toAbsoluteUrl, isRemoteLogo, isInlineBase64, isLocalFileUri };
