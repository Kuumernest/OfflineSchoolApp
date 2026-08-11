"use strict";

/**
 * public.routes.js
 *
 * Responsibilities (no authentication required):
 *  - GET  /api/public/schools              — list active schools + their classes
 *  - GET  /api/public/schools/:id          — single school detail
 *  - POST /api/public/students/apply       — submit a new student application
 *  - POST /api/public/students/apply/:id/documents — attach extra documents
 *
 * Fixes applied:
 *  - Issue 1: School deletedAt filter widened to match NOT_DELETED pattern
 *  - Issue 2: Class deletedAt filter widened consistently
 *  - Issue 3: Re-application merges old + new documents (no data loss)
 *  - Issue 4: Rate limiting added to POST /apply (10 req / 15 min per IP)
 *  - Issue 5: documentTypes parsing handles multiple key formats
 *  - Issue 6: normaliseClass now includes isActive, capacity, description
 */

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");
const multer         = require("multer");
const path           = require("path");
const fs             = require("fs");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — SHARED UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const sendSuccess = (res, data, status = 200) =>
  res.status(status).json({ success: true, ...data });

const sendError = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const lazyModel = (modulePath, label) => {
  let cached    = null;
  let attempted = false;
  return () => {
    if (!attempted) {
      attempted = true;
      try {
        cached = require(modulePath);
      } catch {
        console.warn(`⚠️  Optional model "${label}" not found at "${modulePath}"`);
      }
    }
    return cached;
  };
};

const getSchool             = lazyModel("../db/models/School",             "School");
const getStudentApplication = lazyModel("../db/models/StudentApplication", "StudentApplication");
const getClass              = lazyModel("../db/models/Class",              "Class");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — SHARED QUERY CLAUSES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * FIXED (Issue 1 & 2):
 * Matches the wide NOT_DELETED pattern from students.routes.js.
 * Previously used { $in: [null, undefined] } which missed "", 0, false.
 */
const NOT_DELETED = {
  $or: [
    { deletedAt: { $exists: false } },
    { deletedAt: null               },
    { deletedAt: ""                 },
    { deletedAt: 0                  },
    { deletedAt: false              },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — RATE LIMITING (Issue 4)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Simple in-memory rate limiter — no external dependency needed.
 * Limits each IP to MAX_REQUESTS per WINDOW_MS on protected endpoints.
 *
 * For production with multiple server instances, replace this with
 * express-rate-limit + a Redis store.
 */
const RATE_WINDOW_MS  = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS    = 10;              // per IP per window

const rateLimitStore  = new Map(); // ip → { count, resetAt }

/**
 * Middleware that rejects requests exceeding MAX_REQUESTS per WINDOW_MS.
 * Adds standard RateLimit-* headers to every response.
 */
const applyRateLimit = (req, res, next) => {
  const ip  = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  let entry = rateLimitStore.get(ip);

  // Reset window if expired
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }

  entry.count += 1;

  const remaining = Math.max(0, MAX_REQUESTS - entry.count);
  const resetSecs = Math.ceil((entry.resetAt - now) / 1000);

  res.set("RateLimit-Limit",     String(MAX_REQUESTS));
  res.set("RateLimit-Remaining", String(remaining));
  res.set("RateLimit-Reset",     String(resetSecs));

  if (entry.count > MAX_REQUESTS) {
    return res.status(429).json({
      success: false,
      message: `Too many requests. Please wait ${resetSecs} seconds before trying again.`,
    });
  }

  next();
};

// Periodically prune expired entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, RATE_WINDOW_MS);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — FILE UPLOAD CONFIGURATION
// ═════════════════════════════════════════════════════════════════════════════

const UPLOAD_DIR = path.join(__dirname, "../uploads/applications");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("📁 Created upload directory:", UPLOAD_DIR);
}

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext    = path.extname(file.originalname).toLowerCase() || ".bin";
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `File type "${file.mimetype}" is not allowed. ` +
          `Accepted: PDF, JPEG, PNG, WebP, HEIC`
        )
      );
    }
  },
});

const cleanupFiles = (files = []) => {
  files.forEach((f) => {
    if (f?.path) fs.unlink(f.path, () => {});
  });
};

/**
 * FIXED (Issue 5):
 * documentTypes parsing now handles multiple key formats sent by
 * different clients (React Native, web fetch, axios, etc.)
 *
 * Priority:
 *  1. documentTypes[0]  — indexed (most common from RN FormData)
 *  2. documentTypes[]   — bracket notation without index
 *  3. docType           — single key (simple clients)
 *  4. documentType      — alternative single key
 *  5. "other"           — safe default
 *
 * @param {object} body   - req.body
 * @param {number} index  - file index in the upload array
 * @returns {string}
 */
const resolveDocType = (body, index) =>
  body[`documentTypes[${index}]`] ||
  body[`documentTypes[]`]          ||
  body.docType                     ||
  body.documentType                ||
  "other";

const fileToDocument = (file, docType = "other") => ({
  title:    file.originalname,
  filename: file.filename,
  path:     file.path,
  url:      `/uploads/applications/${file.filename}`,
  type:     docType,
  size:     file.size,
  mimeType: file.mimetype,
});

const MAX_DOCUMENTS = 5;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — CLASS NORMALISER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * FIXED (Issue 6):
 * Now includes isActive, capacity, and description so the mobile
 * app can filter or display these fields correctly.
 *
 * @param {object} c - Raw lean Class document
 * @returns {object}
 */
const normaliseClass = (c) => ({
  id:          String(c._id),
  _id:         String(c._id),
  name:        c.name,
  level:       c.level       || null,
  section:     c.section     || "",
  isActive:    c.isActive    ?? true,
  capacity:    c.capacity    ?? null,
  description: c.description || null,
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — SCHOOLS
// ═════════════════════════════════════════════════════════════════════════════

// ─── GET /api/public/schools ──────────────────────────────────────────────────

router.get("/public/schools", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");

  const School = getSchool();
  if (!School) {
    return sendSuccess(res, { schools: [], count: 0 });
  }

  const search = String(req.query.search || "").trim();

  /**
   * FIXED (Issue 1):
   * Was: { deletedAt: { $in: [null, undefined] } }
   * Now: uses NOT_DELETED which catches null, "", 0, false, $exists:false
   */
  const query = {
    $and: [
      { isActive: { $ne: false } },
      NOT_DELETED,
    ],
  };

  if (search) {
    query.$and.push({
      $or: [
        { name:    { $regex: search, $options: "i" } },
        { city:    { $regex: search, $options: "i" } },
        { state:   { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } },
      ],
    });
  }

  const schools = await School.find(query)
    .select("_id name address city state country phone email logo website")
    .sort({ name: 1 })
    .lean();

  console.log(`📡 GET /public/schools → ${schools.length} school(s)`);

  if (!schools.length) {
    return sendSuccess(res, { schools: [], count: 0 });
  }

  // Batch-load classes for all schools in one query (avoids N+1)
  const schoolIds       = schools.map((s) => String(s._id));
  const classesBySchool = new Map();

  const Class = getClass();
  if (Class) {
    /**
     * FIXED (Issue 2):
     * Was: { deletedAt: null }
     * Now: uses NOT_DELETED spread to catch all falsy deletedAt values
     */
    const allClasses = await Class.find({
      schoolId:  { $in: schoolIds },
      isActive:  { $ne: false },
      ...NOT_DELETED,
    })
      .select("_id schoolId name level section isActive capacity description")
      .sort({ name: 1, section: 1 })
      .lean();

    console.log(
      `📡 GET /public/schools → ${allClasses.length} class(es) ` +
      `across ${schoolIds.length} school(s)`
    );

    for (const cls of allClasses) {
      const key = String(cls.schoolId);
      if (!classesBySchool.has(key)) classesBySchool.set(key, []);
      classesBySchool.get(key).push(normaliseClass(cls));
    }
  }

  const results = schools.map((school) => ({
    ...school,
    _id:     String(school._id),
    id:      String(school._id),
    classes: classesBySchool.get(String(school._id)) || [],
  }));

  return sendSuccess(res, { schools: results, count: results.length });
}));

// ─── GET /api/public/schools/:id ─────────────────────────────────────────────

router.get("/public/schools/:id", asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");

  const School = getSchool();
  if (!School) return sendError(res, 404, "School not found");

  /**
   * FIXED (Issue 1):
   * Added NOT_DELETED to school lookup for consistency.
   */
  const school = await School.findOne({
    _id:      req.params.id,
    isActive: { $ne: false },
    ...NOT_DELETED,
  })
    .select("_id name address city state country phone email logo website")
    .lean();

  if (!school) return sendError(res, 404, "School not found");

  let classes = [];
  const Class = getClass();
  if (Class) {
    /**
     * FIXED (Issue 2):
     * Was: { deletedAt: null }
     * Now: uses NOT_DELETED spread
     */
    const rawClasses = await Class.find({
      schoolId:  String(school._id),
      isActive:  { $ne: false },
      ...NOT_DELETED,
    })
      .select("_id name level section isActive capacity description")
      .sort({ name: 1, section: 1 })
      .lean();

    classes = rawClasses.map(normaliseClass);
  }

  return sendSuccess(res, {
    school: {
      ...school,
      _id:     String(school._id),
      id:      String(school._id),
      classes,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — STUDENT APPLICATION
// ═════════════════════════════════════════════════════════════════════════════

// ─── POST /api/public/students/apply ─────────────────────────────────────────
/**
 * Rate limited: 10 requests per IP per 15 minutes (Issue 4).
 */
router.post(
  "/public/students/apply",
  applyRateLimit,
  upload.array("documents", MAX_DOCUMENTS),
  asyncHandler(async (req, res) => {
    const {
      studentName,
      guardianName,
      email,
      phone,
      classId,
      className,
      notes,
      schoolId,
    } = req.body;

    // ── Validate required fields ────────────────────────────────────────────
    const errors = [];
    if (!studentName?.trim())  errors.push("Student name is required");
    if (!guardianName?.trim()) errors.push("Guardian name is required");
    if (!phone?.trim())        errors.push("Phone number is required");
    if (!classId?.trim())      errors.push("Please select a class");
    if (!schoolId?.trim())     errors.push("Please select a school");

    if (!email?.trim()) {
      errors.push("Email address is required");
    } else if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      errors.push("Please enter a valid email address");
    }

    if (errors.length > 0) {
      cleanupFiles(req.files);
      return sendError(res, 400, errors[0], { errors });
    }

    // ── Check model availability ────────────────────────────────────────────
    const StudentApplication = getStudentApplication();
    if (!StudentApplication) {
      cleanupFiles(req.files);
      return sendError(res, 503, "Applications are not available at this time");
    }

    // ── Verify school exists and is active ──────────────────────────────────
    const School = getSchool();
    if (School) {
      const school = await School.findOne({
        _id:      schoolId.trim(),
        isActive: { $ne: false },
        ...NOT_DELETED,
      }).lean();

      if (!school) {
        cleanupFiles(req.files);
        return sendError(
          res, 404,
          "School not found or no longer accepting applications."
        );
      }
    }

    // ── Verify class belongs to the school and is active ────────────────────
    let verifiedClass = null;
    const Class = getClass();
    if (Class) {
      verifiedClass = await Class.findOne({
        _id:      classId.trim(),
        schoolId: schoolId.trim(),
        isActive: { $ne: false },
        ...NOT_DELETED,
      }).lean();

      if (!verifiedClass) {
        cleanupFiles(req.files);
        return sendError(
          res, 400,
          "The selected class is not available at this school. " +
          "Please go back and select a valid class."
        );
      }
    }

    const emailClean   = email.trim().toLowerCase();
    const resolvedName = verifiedClass?.name || className?.trim() || null;

    // ── Build document metadata from uploaded files ─────────────────────────
    // FIXED (Issue 5): uses resolveDocType() for robust key handling
    const uploadedFiles = (req.files || []).map((file, i) => {
      const docType = resolveDocType(req.body, i);
      return fileToDocument(file, docType);
    });

    // ── Duplicate detection ─────────────────────────────────────────────────
    const existing = await StudentApplication.findOne({
      email:    emailClean,
      schoolId: schoolId.trim(),
    }).lean();

    if (existing) {
      if (existing.status === "approved") {
        cleanupFiles(req.files);
        return sendError(
          res, 409,
          "An account with this email already exists at this school. " +
          "Please log in instead.",
          { status: "approved" }
        );
      }

      if (existing.status === "pending") {
        cleanupFiles(req.files);
        return sendError(
          res, 409,
          "An application with this email is already under review. " +
          "You will be notified once a decision is made.",
          { status: "pending" }
        );
      }

      /**
       * FIXED (Issue 3):
       * Was: documents: uploadedFiles  (overwrites all previous docs)
       * Now: merges existing docs + new uploads up to MAX_DOCUMENTS
       *
       * This prevents data loss when a student re-applies after rejection
       * without re-uploading their birth certificate etc.
       */
      const existingDocs  = existing.documents || [];
      const slotsLeft     = Math.max(0, MAX_DOCUMENTS - existingDocs.length);
      const docsToAdd     = uploadedFiles.slice(0, slotsLeft);

      // If the new upload would exceed the limit, clean up the excess files
      if (uploadedFiles.length > slotsLeft) {
        cleanupFiles(uploadedFiles.slice(slotsLeft).map((d) => ({ path: d.path })));
      }

      const mergedDocs = [...existingDocs, ...docsToAdd];

      await StudentApplication.findByIdAndUpdate(existing._id, {
        studentName:  studentName.trim(),
        guardianName: guardianName.trim(),
        phone:        phone.trim(),
        classId:      classId.trim(),
        className:    resolvedName,
        notes:        notes?.trim() || null,
        documents:    mergedDocs,    // ← merged, not replaced
        status:       "pending",
        reviewedBy:   null,
        reviewedAt:   null,
        rejectedAt:   null,
        rejectReason: null,
        studentId:    null,
        userId:       null,
      });

      console.log(
        `📋 Re-application: "${studentName.trim()}" ` +
        `(${emailClean}) → ${resolvedName} ` +
        `[${docsToAdd.length} new doc(s), ${mergedDocs.length} total] ` +
        `[school: ${schoolId}]`
      );

      return sendSuccess(res, {
        message:       "Application re-submitted successfully",
        applicationId: existing._id,
      }, 201);
    }

    // ── Create new application ──────────────────────────────────────────────
    const application = await StudentApplication.create({
      _id:          uuidv4(),
      studentName:  studentName.trim(),
      guardianName: guardianName.trim(),
      email:        emailClean,
      phone:        phone.trim(),
      classId:      classId.trim(),
      className:    resolvedName,
      notes:        notes?.trim() || null,
      documents:    uploadedFiles,
      status:       "pending",
      schoolId:     schoolId.trim(),
    });

    console.log(
      `📋 New application: "${application.studentName}" ` +
      `(${application.email}) → ${resolvedName} ` +
      `[${uploadedFiles.length} doc(s)] [school: ${schoolId}]`
    );

    return sendSuccess(res, {
      message:       "Application submitted successfully",
      applicationId: application._id,
    }, 201);
  })
);

// ─── POST /api/public/students/apply/:applicationId/documents ────────────────
/**
 * Attaches one additional document to an existing pending application.
 * Rate limited: 10 requests per IP per 15 minutes.
 */
router.post(
  "/public/students/apply/:applicationId/documents",
  applyRateLimit,
  upload.array("documents", 1),
  asyncHandler(async (req, res) => {
    const { applicationId } = req.params;

    // FIXED (Issue 5): uses resolveDocType() for robust key handling
    const docType = resolveDocType(req.body, 0);

    const StudentApplication = getStudentApplication();
    if (!StudentApplication) {
      cleanupFiles(req.files);
      return sendError(res, 503, "Applications are not available at this time");
    }

    if (!applicationId?.trim()) {
      cleanupFiles(req.files);
      return sendError(res, 400, "Application ID is required");
    }

    const application = await StudentApplication.findById(applicationId.trim());
    if (!application) {
      cleanupFiles(req.files);
      return sendError(res, 404, "Application not found");
    }

    if (application.status !== "pending") {
      cleanupFiles(req.files);
      return sendError(
        res, 400,
        "Cannot add documents to an application that has already been reviewed."
      );
    }

    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, "No file uploaded");
    }

    const currentCount = application.documents?.length || 0;
    if (currentCount + req.files.length > MAX_DOCUMENTS) {
      cleanupFiles(req.files);
      return sendError(
        res, 400,
        `Maximum ${MAX_DOCUMENTS} documents allowed per application. ` +
        `You already have ${currentCount}.`
      );
    }

    const newDocs = req.files.map((file) => fileToDocument(file, docType));
    application.documents.push(...newDocs);
    await application.save();

    console.log(
      `📎 Added ${newDocs.length} document(s) to application ${applicationId} ` +
      `(${application.documents.length}/${MAX_DOCUMENTS} total)`
    );

    return sendSuccess(res, {
      message:       "Documents added successfully",
      documentCount: application.documents.length,
    });
  })
);

// ═════════════════════════════════════════════════════════════════════════════
module.exports = router;