// backend/src/utils/applicationDocuments.js
"use strict";

/**
 * Applicant documents: birth certificates, ID scans, report cards a family
 * attaches to an admission application.
 *
 * ── What was wrong ────────────────────────────────────────────────────────────
 *
 * The files landed under src/uploads/applications, which /uploads served to
 * anyone holding the link — no login, no school. The record kept the file's
 * absolute path on disk and handed it, with the public URL, to every client
 * that read the application. A filename made of a timestamp and Math.random()
 * is not a secret, and the URL travelled in logs, browser history and exports.
 *
 * ── The model now ─────────────────────────────────────────────────────────────
 *
 * The files stay where they are (the Docker volume mounts that directory), but
 * /uploads/applications answers 404 to everybody (server.js). The ONE way to a
 * document is
 *
 *     GET /api/students/applications/:applicationId/documents/:key
 *
 * where :key is the stored filename, and the route serves the file only if
 *
 *   • the caller is signed in, holds students.admit or students.viewFull, and
 *     the application (or the pupil record it became) is in their school; or
 *   • the URL carries a signature this module minted — which happens only in
 *     the response to such an authorised, school-scoped read, expires after
 *     LINK_HOURS, and is bound to that application and that key.
 *
 * The second form exists because the admin console opens documents in a new
 * tab, and a new tab carries no Authorization header. A signed link is a
 * capability handed to somebody who was already allowed to see the document;
 * it is short-lived and names one file of one application.
 *
 * What clients receive is `presentDocument`: title, type, size, mime type and
 * that URL. Never the path on disk, never the raw filename.
 */

const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");

const APPLICATIONS_DIR = path.resolve(__dirname, "..", "uploads", "applications");

/** Hours a minted link stays valid. Long enough to review a file; not a day. */
const LINK_HOURS = 1;

const CONTENT_TYPES = {
  ".jpg":  "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
  ".pdf":  "application/pdf",
};

/** The stored filename of one document — the only handle the API exposes. */
const documentKey = (doc) => {
  const raw = doc?.filename || String(doc?.url || "").split("?")[0] || "";
  const base = path.basename(String(raw));
  return base && base !== "." && base !== ".." ? base : null;
};

const originOf = (req) => {
  const proto = req?.headers?.["x-forwarded-proto"] || req?.protocol || "http";
  const host  = req?.headers?.["x-forwarded-host"]  || req?.get?.("host");
  return host ? `${String(proto).split(",")[0].trim()}://${host}` : "";
};

const mac = (applicationId, key, expiry) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET || "")
    .update(`applications|${applicationId}|${key}|${expiry}`)
    .digest("hex")
    .slice(0, 32);

/** The path (query included) a signed link for one document uses. */
const signedDocumentPath = (applicationId, key, { hours = LINK_HOURS } = {}) => {
  const expiry = Math.floor(Date.now() / 1000) + hours * 3600;
  return `/api/students/applications/${encodeURIComponent(String(applicationId))}` +
         `/documents/${encodeURIComponent(key)}?sig=${expiry}.${mac(applicationId, key, expiry)}`;
};

const verifyDocumentSignature = (applicationId, key, sig) => {
  if (!sig || typeof sig !== "string") return false;
  const dot = sig.indexOf(".");
  if (dot <= 0) return false;
  const expiry = Number(sig.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return false;
  const a = Buffer.from(mac(applicationId, key, expiry));
  const b = Buffer.from(sig.slice(dot + 1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * One document as a client may see it. Absolute when a request is at hand,
 * because the phone opens the link with the system browser and the admin
 * console opens it in a new tab; neither can resolve a relative API path.
 */
const presentDocument = (req, applicationId, doc, index = 0) => {
  const key = documentKey(doc);
  return {
    title:    doc?.title || doc?.name || `Document ${index + 1}`,
    type:     doc?.type  || "other",
    size:     doc?.size  ?? null,
    mimeType: doc?.mimeType || null,
    url:      key ? `${originOf(req)}${signedDocumentPath(applicationId, key)}` : null,
  };
};

const presentDocuments = (req, applicationId, docs) =>
  (Array.isArray(docs) ? docs : []).map((d, i) => presentDocument(req, applicationId, d, i));

/**
 * Replace every `documents` array inside a response payload with its
 * presentation, keyed by the enclosing record's id.
 *
 * Applied at the one place the students router answers from (its sendSuccess),
 * so a response site that was not thought of cannot hand out a path on disk.
 * Depth-limited: payloads here are records and lists of records, not trees.
 */
const redactDocumentsDeep = (req, value, depth = 0) => {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactDocumentsDeep(req, v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "documents" && Array.isArray(v)) {
      const id = value._id ?? value.id ?? null;
      out[k] = id ? presentDocuments(req, id, v) : v.map((d, i) => ({ ...presentDocument(null, "", d, i), url: null }));
    } else {
      out[k] = redactDocumentsDeep(req, v, depth + 1);
    }
  }
  return out;
};

/**
 * The file for one key, if it is inside the applications directory. The key
 * is reduced to a basename first, so a key cannot climb out of the directory.
 */
const resolveDocumentFile = (key) => {
  const base = path.basename(String(key || ""));
  if (!base || base === "." || base === "..") return null;
  const filePath = path.resolve(APPLICATIONS_DIR, base);
  if (!filePath.startsWith(APPLICATIONS_DIR + path.sep)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const ext = path.extname(base).toLowerCase();
  return { filePath, contentType: CONTENT_TYPES[ext] || "application/octet-stream" };
};

/** A filename safe to put in a Content-Disposition header. */
const safeDownloadName = (title, key) => {
  const ext  = path.extname(String(key || "")).toLowerCase();
  const stem = String(title || "document").replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "document";
  return stem.toLowerCase().endsWith(ext) ? stem : `${stem}${ext}`;
};

/**
 * What /uploads/applications answers to everybody: a uniform 404. Mounted by
 * server.js ahead of the media handler and express.static, and by the check
 * suite in front of the same static middleware, so the two cannot drift.
 */
const blockPublicApplicationsPath = (_req, res) =>
  res.status(404).json({ error: "File not found" });

module.exports = {
  APPLICATIONS_DIR,
  blockPublicApplicationsPath,
  LINK_HOURS,
  documentKey,
  signedDocumentPath,
  verifyDocumentSignature,
  presentDocument,
  presentDocuments,
  redactDocumentsDeep,
  resolveDocumentFile,
  safeDownloadName,
};
