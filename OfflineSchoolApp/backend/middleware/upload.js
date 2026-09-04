"use strict";

const multer = require("multer");
const path   = require("path");
const fs     = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED MIME TYPES  per content type
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_MIMES = {
  syllabus : [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  notes    : [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
  ],
  video    : [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
    "video/x-msvideo",       // .avi
    "video/x-matroska",      // .mkv
  ],
  audio    : [
    "audio/mpeg",            // .mp3
    "audio/ogg",
    "audio/wav",
    "audio/mp4",
    "audio/webm",
    "audio/aac",
    "audio/x-m4a",
  ],
  image    : [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
    // image/svg+xml is deliberately absent. SVG can carry <script>, and these
    // files are served from this origin by /uploads — a teacher upload would
    // become a stored cross-site-scripting vector against every staff member
    // who opens the file in a browser. Vector uploads are rare in a school
    // workflow; the risk is not worth the capability.
  ],
  document : [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    "application/rtf",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// MAX FILE SIZES  per content type  (bytes)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILE_SIZES = {
  video    : 500 * 1024 * 1024,   // 500 MB
  audio    : 100 * 1024 * 1024,   // 100 MB
  image    :  10 * 1024 * 1024,   //  10 MB
  syllabus :  50 * 1024 * 1024,   //  50 MB
  notes    :  50 * 1024 * 1024,   //  50 MB
  document :  50 * 1024 * 1024,   //  50 MB
};

const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100 MB fallback

// ─────────────────────────────────────────────────────────────────────────────
// DISK STORAGE
// destination — writes to uploads/content/{type}/
//               multer reads req.body fields BEFORE calling destination()
//               so req.body.type is already populated here.
// filename    — timestamp prefix + sanitised original name
// ─────────────────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const type = (req.body?.type || "document").toLowerCase();
    const dir  = path.join(__dirname, "..", "uploads", "content", type);

    // Create the directory if it does not exist yet
    // (mkdirSync with recursive:true is idempotent — safe on every request)
    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (mkdirErr) {
      cb(mkdirErr);
    }
  },

  filename(req, file, cb) {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g,           "_")   // spaces → underscores
      .replace(/[^a-zA-Z0-9_\-]/g, "") // strip special chars
      .slice(0, 80);                    // guard against very long names

    // e.g. 1718000000000-lecture_notes.pdf
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// FILE FILTER
// Validates the uploaded file's MIME type against the content type.
// Called by multer before writing anything to disk.
// ─────────────────────────────────────────────────────────────────────────────

const fileFilter = (req, file, cb) => {
  const type         = (req.body?.type || "document").toLowerCase();
  const allowedMimes = ALLOWED_MIMES[type];

  // Unknown content type — let the route handler reject it with a clear message
  if (!allowedMimes) {
    return cb(null, true);
  }

  if (!allowedMimes.includes(file.mimetype)) {
    return cb(
      Object.assign(
        new Error(
          `File type "${file.mimetype}" is not allowed for ` +
          `content type "${type}". ` +
          `Allowed types: ${allowedMimes.join(", ")}`
        ),
        { code: "INVALID_MIME" }
      ),
      false // do NOT save the file
    );
  }

  cb(null, true); // accept
};

// ─────────────────────────────────────────────────────────────────────────────
// MULTER INSTANCE
// Global file-size limit is set to the largest possible type (500 MB for video).
// Per-type limits are enforced AFTER multer runs in multerForContent below.
// This two-stage approach lets us return a helpful error message that names
// the type-specific limit rather than a generic "File too large".
// ─────────────────────────────────────────────────────────────────────────────

let _instance = null;

const getInstance = () => {
  if (!_instance) {
    _instance = multer({
      storage,
      fileFilter,
      limits: {
        fileSize : 500 * 1024 * 1024, // global ceiling — video max
        files    : 1,                 // one file per request
      },
    });
  }
  return _instance;
};

// ─────────────────────────────────────────────────────────────────────────────
// multerForContent  middleware
//
// Usage (in a router):
//   router.post("/content", multerForContent, asyncHandler(async (req, res) => { … }))
//
// What it does:
//   1. Runs multer.single("file") — parses multipart body, writes file to disk,
//      populates req.file and req.body.
//   2. Checks per-type file-size limit AFTER multer writes the file.
//      If the file exceeds the type limit it is deleted and a 413 is returned.
//   3. Calls next() on success so the route handler can access req.file + req.body.
//
// Safe to include on routes where the client sends application/json —
// multer detects the absence of a multipart boundary and skips processing,
// so req.body is still populated by express.json() upstream.
// ─────────────────────────────────────────────────────────────────────────────

const multerForContent = (req, res, next) => {
  getInstance().single("file")(req, res, (err) => {

    // ── Multer / file-system errors ───────────────────────────────────────
    if (err) {
      // Built-in multer errors
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          success : false,
          error   : "File exceeds the maximum allowed size for any content type (500 MB).",
          code    : "LIMIT_FILE_SIZE",
        });
      }

      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          success : false,
          error   : "Only one file may be uploaded per request.",
          code    : "LIMIT_FILE_COUNT",
        });
      }

      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          success : false,
          error   : 'Unexpected form field. The file field must be named "file".',
          code    : "LIMIT_UNEXPECTED_FILE",
        });
      }

      // Custom MIME validation error (set in fileFilter above)
      if (err.code === "INVALID_MIME") {
        return res.status(415).json({
          success : false,
          error   : err.message,
          code    : "INVALID_MIME",
        });
      }

      // Destination directory creation failure or other fs error
      if (err.code === "ENOENT" || err.code === "EACCES") {
        console.error("[multerForContent] filesystem error:", err.message);
        return res.status(500).json({
          success : false,
          error   : "Server could not create upload directory.",
          code    : err.code,
        });
      }

      // Anything else
      console.error("[multerForContent] unexpected error:", err.message);
      return res.status(400).json({
        success : false,
        error   : err.message || "File upload error.",
      });
    }

    // ── Per-type size enforcement ─────────────────────────────────────────
    if (req.file) {
      const type    = (req.body?.type || "document").toLowerCase();
      const maxSize = MAX_FILE_SIZES[type] ?? DEFAULT_MAX_SIZE;

      if (req.file.size > maxSize) {
        // Delete the already-written file before rejecting
        fs.unlink(req.file.path, (unlinkErr) => {
          if (unlinkErr && unlinkErr.code !== "ENOENT") {
            console.warn(
              "[multerForContent] could not delete oversized file:",
              unlinkErr.message
            );
          }
        });

        const mb = Math.round(maxSize / 1024 / 1024);
        return res.status(413).json({
          success : false,
          error   : `File too large for content type "${type}". Maximum allowed: ${mb} MB.`,
          code    : "LIMIT_FILE_SIZE_TYPE",
        });
      }

      // Log successful upload for debugging
      console.log(
        `[multerForContent] ✅ file saved: ${req.file.path} ` +
        `(${(req.file.size / 1024).toFixed(1)} KB, ${req.file.mimetype})`
      );
    }

    // ── All good — continue to route handler ─────────────────────────────
    next();
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  multerForContent,   // ← used by teacher.routes.js  POST /content
  ALLOWED_MIMES,      // ← exported for tests / documentation
  MAX_FILE_SIZES,     // ← exported for tests / documentation
  DEFAULT_MAX_SIZE,   // ← exported for tests / documentation
};