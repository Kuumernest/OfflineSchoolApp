// backend/src/routes/public.routes.js
"use strict";

/**
 * public.routes.js
 *
 * Responsibilities (no authentication required):
 *  - GET  /api/public/schools              — list active schools + their classes
 *  - GET  /api/public/schools/:id          — single school detail
 *  - POST /api/public/students/apply       — submit a new student application
 *
 * Upload strategy:
 *  The mobile app (Expo Go on Android) cannot use FormData file objects —
 *  the fetch bridge throws "Unsupported FormDataPart implementation".
 *  Instead the app reads files via expo-file-system, base64-encodes them,
 *  and sends everything as a single JSON POST.
 *
 *  This route accepts BOTH strategies so it works with:
 *   - Expo Go (Android)  → JSON + base64 files array
 *   - Bare React Native  → multipart/form-data (multer)
 *   - Web / curl / tests → multipart/form-data (multer)
 */

const express = require("express");
const router  = express.Router();
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");

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
        if (cached?.__esModule && cached.default) cached = cached.default;
      } catch (err) {
        console.warn(
          `⚠️  Model "${label}" not found at "${modulePath}":`, err.message
        );
      }
    }
    return cached;
  };
};

const getSchool             = lazyModel("../db/models/School",             "School");
const getStudentApplication = lazyModel("../db/models/StudentApplication", "StudentApplication");
const getClass              = lazyModel("../db/models/Class",              "Class");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — QUERY HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const notDeletedClause = () => ({
  $or: [
    { deletedAt: { $exists: false } },
    { deletedAt: null               },
    { deletedAt: ""                 },
    { deletedAt: 0                  },
    { deletedAt: false              },
  ],
});

const buildAndClauses = (...extra) => [
  notDeletedClause(),
  { isActive: { $ne: false } },
  ...extra.filter(Boolean),
];

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — RATE LIMITING
// ═════════════════════════════════════════════════════════════════════════════

const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS   = 10;
const rateLimitStore = new Map();

const applyRateLimit = (req, res, next) => {
  const ip  = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();

  let entry = rateLimitStore.get(ip);
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

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, RATE_WINDOW_MS);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — FILE HANDLING
// ═════════════════════════════════════════════════════════════════════════════

const UPLOAD_DIR = path.join(__dirname, "../uploads/applications");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("📁 Created upload directory:", UPLOAD_DIR);
}

const MAX_DOCUMENTS  = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png",
  "image/webp", "image/heic", "image/heif",
  "application/pdf",
]);

// ── Multer (multipart/form-data fallback) ─────────────────────────────────────

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
  limits:     { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIME_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new multer.MulterError(
          "LIMIT_UNEXPECTED_FILE",
          `File type "${file.mimetype}" is not allowed.`
        ));
  },
});

const multerErrorHandler = (err, req, res, next) => {
  if (
    err instanceof multer.MulterError ||
    err?.message?.includes("not allowed")
  ) {
    cleanupFiles(req.files);
    return sendError(res, 400, err.message);
  }
  next(err);
};

const cleanupFiles = (files = []) => {
  if (!Array.isArray(files)) return;
  files.forEach((f) => {
    const p = f?.path || f;
    if (p && typeof p === "string") fs.unlink(p, () => {});
  });
};

// ── Base64 decoder (Expo Go / JSON path) ──────────────────────────────────────

/**
 * Validates a single base64 file entry sent by the app.
 * Returns { ok: true, error: null } or { ok: false, error: string }.
 */
const validateBase64File = (f, index) => {
  if (!f || typeof f !== "object") {
    return { ok: false, error: `File ${index + 1} is not a valid object` };
  }
  if (!f.base64 || typeof f.base64 !== "string") {
    return { ok: false, error: `File ${index + 1} is missing base64 data` };
  }
  if (!f.name || typeof f.name !== "string") {
    return { ok: false, error: `File ${index + 1} is missing a name` };
  }
  const mime = f.mimeType || "";
  if (mime && !ALLOWED_MIME_TYPES.has(mime) && !mime.startsWith("image/")) {
    return {
      ok:    false,
      error: `File "${f.name}" has an unsupported type: ${mime}`,
    };
  }
  // Rough size check: base64 is ~4/3 the binary size
  const approxBytes = Math.ceil((f.base64.length * 3) / 4);
  if (approxBytes > MAX_FILE_BYTES) {
    return { ok: false, error: `File "${f.name}" exceeds the 5 MB limit` };
  }
  return { ok: true, error: null };
};

/**
 * Decodes a base64 file entry, writes it to UPLOAD_DIR, and returns
 * a document metadata object compatible with the StudentApplication schema.
 */
const saveBase64File = (f) => {
  const ext      = path.extname(f.name).toLowerCase() || ".bin";
  const unique   = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const filename = `${unique}${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);

  const buffer = Buffer.from(f.base64, "base64");
  fs.writeFileSync(filePath, buffer);

  return {
    title:    f.name,
    filename,
    path:     filePath,
    url:      `/uploads/applications/${filename}`,
    type:     f.docType  || "other",
    size:     f.size     || buffer.length,
    mimeType: f.mimeType || "application/octet-stream",
  };
};

// ── Multipart → document metadata ─────────────────────────────────────────────

const resolveDocType = (body, index) =>
  body[`documentTypes[${index}]`] ||
  body[`documentTypes[]`]         ||
  body.docType                    ||
  body.documentType               ||
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

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — CLASS NORMALISER
// ═════════════════════════════════════════════════════════════════════════════

const normaliseClass = (c) => ({
  id:          String(c._id),
  _id:         String(c._id),
  name:        c.name        || "",
  level:       c.level       || null,
  section:     c.section     || "",
  isActive:    c.isActive    ?? true,
  capacity:    c.capacity    ?? null,
  description: c.description || null,
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — SCHOOLS
// ═════════════════════════════════════════════════════════════════════════════

router.get(
  "/public/schools",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");

    const School = getSchool();
    if (!School) {
      return sendSuccess(res, {
        schools: [], count: 0, total: 0, page: 1, limit: 20,
      });
    }

    const page   = Math.max(1, parseInt(req.query.page  ?? "1",  10));
    const limit  = Math.max(1, Math.min(100, parseInt(req.query.limit ?? "20", 10)));
    const skip   = (page - 1) * limit;
    const search = String(req.query.search || "").trim();

    const schoolAndClauses = buildAndClauses(
      search ? {
        $or: [
          { name:    { $regex: search, $options: "i" } },
          { city:    { $regex: search, $options: "i" } },
          { state:   { $regex: search, $options: "i" } },
          { address: { $regex: search, $options: "i" } },
        ],
      } : null
    );

    const [schools, total] = await Promise.all([
      School.find({ $and: schoolAndClauses })
        .select(
          "_id name address city state country " +
          "phone email logo website verified isVerified"
        )
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      School.countDocuments({ $and: schoolAndClauses }),
    ]);

    console.log(
      `📡 GET /public/schools → ${schools.length} school(s)` +
      ` (page ${page}/${Math.ceil(total / limit) || 1})`
    );

    if (!schools.length) {
      return sendSuccess(res, { schools: [], count: 0, total: 0, page, limit });
    }

    const schoolObjectIds = schools.map((s) => s._id);
    const schoolStrIds    = schools.map((s) => String(s._id));
    const classesBySchool = new Map();
    const Class           = getClass();

    if (Class) {
      const classAndClauses = buildAndClauses({
        $or: [
          { school:   { $in: schoolObjectIds } },
          { schoolId: { $in: schoolStrIds    } },
        ],
      });

      const allClasses = await Class.find({ $and: classAndClauses })
        .select(
          "_id school schoolId name level section " +
          "isActive capacity description"
        )
        .sort({ name: 1, section: 1 })
        .lean();

      console.log(
        `📡 GET /public/schools → ${allClasses.length} class(es)` +
        ` across ${schoolObjectIds.length} school(s)`
      );

      for (const cls of allClasses) {
        const key = String(cls.schoolId || cls.school || "");
        if (!key) continue;
        if (!classesBySchool.has(key)) classesBySchool.set(key, []);
        classesBySchool.get(key).push(normaliseClass(cls));
      }
    }

    const results = schools.map((school) => {
      const sid = String(school._id);
      return {
        id:       sid,
        _id:      sid,
        name:     school.name    || "",
        address:  school.address || "",
        city:     school.city    || "",
        state:    school.state   || "",
        country:  school.country || "",
        phone:    school.phone   || "",
        email:    school.email   || "",
        logo:     school.logo    || null,
        website:  school.website || null,
        verified: school.verified ?? school.isVerified ?? false,
        classes:  classesBySchool.get(sid) || [],
      };
    });

    return sendSuccess(res, {
      schools: results,
      count:   results.length,
      total,
      page,
      limit,
    });
  })
);

// ─── GET /api/public/schools/:id ─────────────────────────────────────────────

router.get(
  "/public/schools/:id",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");

    const School = getSchool();
    if (!School) return sendError(res, 404, "School not found");

    const school = await School.findOne({
      $and: buildAndClauses({ _id: req.params.id }),
    })
      .select(
        "_id name address city state country " +
        "phone email logo website verified isVerified"
      )
      .lean();

    if (!school) return sendError(res, 404, "School not found");

    let classes = [];
    const Class = getClass();

    if (Class) {
      const sid             = String(school._id);
      const classAndClauses = buildAndClauses({
        $or: [
          { school:   school._id },
          { schoolId: sid        },
        ],
      });

      const rawClasses = await Class.find({ $and: classAndClauses })
        .select(
          "_id school schoolId name level section " +
          "isActive capacity description"
        )
        .sort({ name: 1, section: 1 })
        .lean();

      classes = rawClasses.map(normaliseClass);
    }

    const sid = String(school._id);
    return sendSuccess(res, {
      school: {
        id:       sid,
        _id:      sid,
        name:     school.name    || "",
        address:  school.address || "",
        city:     school.city    || "",
        state:    school.state   || "",
        country:  school.country || "",
        phone:    school.phone   || "",
        email:    school.email   || "",
        logo:     school.logo    || null,
        website:  school.website || null,
        verified: school.verified ?? school.isVerified ?? false,
        classes,
      },
    });
  })
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — STUDENT APPLICATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Shared application handler — called after request body is parsed.
 *
 * Accepts two document sources (chosen automatically based on Content-Type):
 *
 *  A) JSON body with `files` array (Expo Go / Android)
 *       Content-Type: application/json
 *       Body: { studentName, ..., files: [{ name, mimeType, docType, base64 }] }
 *
 *  B) multipart/form-data (bare RN / web / curl)
 *       Content-Type: multipart/form-data
 *       Body: { studentName, ... } + file parts on field "documents"
 */
const handleApplyRequest = asyncHandler(async (req, res) => {
  const isJson =
    (req.headers["content-type"] || "").includes("application/json");

  const {
    studentName,
    guardianName,
    email,
    phone,
    classId,
    className,
    notes,
    schoolId,
    files: jsonFiles,   // present only in the JSON path
  } = req.body;

  // ── Field validation ────────────────────────────────────────────────────────
  const errors = [];
  if (!studentName?.trim())  errors.push("Student name is required");
  if (!guardianName?.trim()) errors.push("Guardian name is required");
  if (!phone?.trim())        errors.push("Phone number is required");
  if (!classId?.trim())      errors.push("Please select a class");
  if (!schoolId?.trim())     errors.push("Please select a school");
  if (!email?.trim()) {
    errors.push("Email address is required");
  } else if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
    errors.push("Invalid email address");
  }

  if (errors.length > 0) {
    if (!isJson) cleanupFiles(req.files);
    return sendError(res, 400, errors[0], { errors });
  }

  // ── Model availability ──────────────────────────────────────────────────────
  const StudentApplication = getStudentApplication();
  if (!StudentApplication) {
    if (!isJson) cleanupFiles(req.files);
    return sendError(res, 503, "Applications are not available at this time");
  }

  // ── Verify school ───────────────────────────────────────────────────────────
  const School = getSchool();
  if (School) {
    const school = await School.findOne({
      $and: buildAndClauses({ _id: schoolId.trim() }),
    }).lean();

    if (!school) {
      if (!isJson) cleanupFiles(req.files);
      return sendError(
        res, 404,
        "School not found or no longer accepting applications."
      );
    }
  }

  // ── Verify class ────────────────────────────────────────────────────────────
  let verifiedClass = null;
  const Class       = getClass();

  if (Class) {
    const classAndClauses = buildAndClauses({
      _id: classId.trim(),
      $or: [
        { school:   schoolId.trim() },
        { schoolId: schoolId.trim() },
      ],
    });
    verifiedClass = await Class.findOne({ $and: classAndClauses }).lean();

    if (!verifiedClass) {
      if (!isJson) cleanupFiles(req.files);
      return sendError(
        res, 400,
        "The selected class is not available at this school."
      );
    }
  }

  const emailClean   = email.trim().toLowerCase();
  const nameClean    = studentName.trim().toLowerCase();
  const resolvedName = verifiedClass?.name || className?.trim() || null;

  // ── Build document list ─────────────────────────────────────────────────────
  let savedDocs = [];

  if (isJson && Array.isArray(jsonFiles) && jsonFiles.length > 0) {
    // Path A: decode base64 and write to disk
    const fileList = jsonFiles.slice(0, MAX_DOCUMENTS);

    for (let i = 0; i < fileList.length; i++) {
      const f          = fileList[i];
      const validation = validateBase64File(f, i);

      if (!validation.ok) {
        console.warn(`⚠️  Skipping file ${i + 1}: ${validation.error}`);
        continue;
      }

      try {
        const doc = saveBase64File(f);
        savedDocs.push(doc);
        console.log(`📎 Saved (base64): ${doc.filename} (${doc.size} bytes)`);
      } catch (writeErr) {
        console.warn(`⚠️  Failed to save "${f.name}":`, writeErr.message);
        // Non-fatal — continue with remaining files
      }
    }
  } else if (!isJson && Array.isArray(req.files) && req.files.length > 0) {
    // Path B: multer already wrote files — build metadata only
    savedDocs = req.files.map((file, i) =>
      fileToDocument(file, resolveDocType(req.body, i))
    );
  }

  // ── Duplicate detection ─────────────────────────────────────────────────────
  //
  // Match on: email + schoolId + studentName (case-insensitive)
  //
  // This design enables siblings to share a parent email:
  //   - "Ken Tem"  applying with pluginbridge@gmail.com → new record ✅
  //   - "Mary Tem" applying with pluginbridge@gmail.com → new record ✅ (different name)
  //   - "Ken Tem"  applying again (pending)             → blocked   ❌
  //   - "Ken Tem"  re-applying after rejection          → allowed   ✅ (update)
  //   - "Ken Tem"  already approved/enrolled            → blocked   ❌
  //
  const nameRegex = new RegExp(
    `^${nameClean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "i"
  );

  const existing = await StudentApplication.findOne({
    email:       emailClean,
    schoolId:    schoolId.trim(),
    studentName: { $regex: nameRegex },
  }).lean();

  if (existing) {

    if (existing.status === "approved") {
      // This exact student is already enrolled
      if (!isJson) cleanupFiles(req.files);
      cleanupFiles(savedDocs.map((d) => ({ path: d.path })));
      return sendError(
        res, 409,
        "This student is already enrolled at this school. " +
        "Please log in with your enrollment number.",
        { status: "approved", detail: "already_enrolled" }
      );
    }

    if (existing.status === "pending") {
      // Application already under review
      if (!isJson) cleanupFiles(req.files);
      cleanupFiles(savedDocs.map((d) => ({ path: d.path })));
      return sendError(
        res, 409,
        "An application for this student is already under review. " +
        "You will be notified once it is processed.",
        {
          status:        "pending",
          applicationId: String(existing._id),
          detail:        "already_pending",
        }
      );
    }

    // status === "rejected" — re-application allowed
    const existingDocs = existing.documents || [];
    const slotsLeft    = Math.max(0, MAX_DOCUMENTS - existingDocs.length);
    const docsToAdd    = savedDocs.slice(0, slotsLeft);

    // Clean up excess files (multipart path only)
    if (!isJson && savedDocs.length > slotsLeft) {
      cleanupFiles(
        savedDocs.slice(slotsLeft).map((d) => ({ path: d.path }))
      );
    }

    const mergedDocs = [...existingDocs, ...docsToAdd];

    await StudentApplication.findByIdAndUpdate(existing._id, {
      studentName:  studentName.trim(),
      guardianName: guardianName.trim(),
      phone:        phone.trim(),
      classId:      classId.trim(),
      className:    resolvedName,
      notes:        notes?.trim() || null,
      documents:    mergedDocs,
      status:       "pending",
      reviewedBy:   null,
      reviewedAt:   null,
      rejectedAt:   null,
      rejectReason: null,
      studentId:    null,
      userId:       null,
    });

    console.log(
      `📋 Re-application after rejection: "${studentName.trim()}" ` +
      `(${emailClean}) → ${resolvedName} ` +
      `[${docsToAdd.length} new doc(s), ${mergedDocs.length} total]`
    );

    return sendSuccess(res, {
      message:       "Application re-submitted successfully",
      applicationId: String(existing._id),
    }, 201);
  }

  // ── Create new application ──────────────────────────────────────────────────
  // Reaches here for:
  //   - Brand new applicants
  //   - Siblings (different name, shared parent email)
  //     → each sibling gets their own StudentApplication record
  const application = await StudentApplication.create({
    studentName:  studentName.trim(),
    guardianName: guardianName.trim(),
    email:        emailClean,
    phone:        phone.trim(),
    classId:      classId.trim(),
    className:    resolvedName,
    notes:        notes?.trim() || null,
    documents:    savedDocs,
    status:       "pending",
    schoolId:     schoolId.trim(),
  });

  console.log(
    `📋 New application: "${application.studentName}" (${application.email})` +
    ` → ${resolvedName} [${savedDocs.length} doc(s)] [school: ${schoolId}]`
  );

  return sendSuccess(res, {
    message:       "Application submitted successfully",
    applicationId: String(application._id),
  }, 201);
});

// ─── POST /api/public/students/apply ─────────────────────────────────────────
//
// Smart middleware selector:
//  - JSON body (Expo Go / Android) → skip multer, go straight to handler
//  - multipart body (bare RN / web) → run multer first, then handler
//
router.post(
  "/public/students/apply",
  applyRateLimit,
  (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) {
      upload.array("documents", MAX_DOCUMENTS)(req, res, (err) => {
        if (err) return multerErrorHandler(err, req, res, next);
        next();
      });
    } else {
      // JSON path — body already parsed by express.json()
      next();
    }
  },
  handleApplyRequest
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — GLOBAL ERROR HANDLER
// ═════════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
  console.error("Unhandled error in public.routes.js:", err);
  cleanupFiles(req.files);
  return sendError(
    res,
    500,
    err.message || "An unexpected error occurred. Please try again.",
    process.env.NODE_ENV === "development" ? { stack: err.stack } : {}
  );
});

// ═════════════════════════════════════════════════════════════════════════════
module.exports = router;