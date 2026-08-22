"use strict";

require("dotenv").config();

const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const morgan      = require("morgan");
const compression = require("compression");
const mongoose    = require("mongoose");
const path        = require("path");
const fs          = require("fs");

const connectDatabase = require("./config/database");
const errorHandler    = require("../middleware/errorHandler");
const auth            = require("../middleware/auth");

const app  = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────────────────────────────────────
// DISABLE ETAG GLOBALLY
// ─────────────────────────────────────────────────────────────────────────────

app.set("etag", false);

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD DIRECTORY BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

const UPLOAD_DIRS = [
  "uploads/content/syllabus",
  "uploads/content/notes",
  "uploads/content/video",
  "uploads/content/audio",
  "uploads/content/document",
  "uploads/content/image",
  "uploads/logos",
  "uploads/photos",
];

UPLOAD_DIRS.forEach((dir) => {
  const fullPath = path.join(__dirname, dir);
  fs.mkdirSync(fullPath, { recursive: true });
});

console.log("📁 Upload directories verified");

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA MIME TYPES
// ─────────────────────────────────────────────────────────────────────────────

const MEDIA_MIME = {
  ".mp4":  "video/mp4",
  ".webm": "video/webm",
  ".mov":  "video/quicktime",
  ".ogg":  "video/ogg",
  ".m4v":  "video/x-m4v",
  ".mkv":  "video/x-matroska",
  ".avi":  "video/x-msvideo",
  ".3gp":  "video/3gpp",
  ".ts":   "video/mp2t",
  ".mp3":  "audio/mpeg",
  ".wav":  "audio/wav",
  ".aac":  "audio/aac",
  ".m4a":  "audio/x-m4a",
  ".oga":  "audio/ogg",
  ".flac": "audio/flac",
};

const MEDIA_EXTS = new Set(Object.keys(MEDIA_MIME));

// ─────────────────────────────────────────────────────────────────────────────
// CORE MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use(compression());
app.use(morgan("dev"));

app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : true,
  credentials:    true,
  methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Range"],
  exposedHeaders: ["Content-Range", "Content-Length", "Accept-Ranges"],
}));

app.use(express.json({       limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER AUTO-REQUEST SILENCER
// ─────────────────────────────────────────────────────────────────────────────

const BROWSER_AUTO_REQUESTS = [
  "/favicon.ico",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/robots.txt",
  "/sitemap.xml",
];

app.get(BROWSER_AUTO_REQUESTS, (_req, res) => res.status(204).end());

// ─────────────────────────────────────────────────────────────────────────────
// RANGE-AWARE MEDIA STREAMING
// ✅ Fixed: /*path → /{*path} for Node 24 compatibility
// ─────────────────────────────────────────────────────────────────────────────

app.get("/uploads/{*path}", (req, res, next) => {
  const rawParam     = req.params.path || req.params[0] || "";
  const relativePath = decodeURIComponent(
    Array.isArray(rawParam) ? rawParam.join("/") : String(rawParam)
  );

  const filePath    = path.resolve(__dirname, "uploads", relativePath);
  const uploadsRoot = path.resolve(__dirname, "uploads");

  if (!filePath.startsWith(uploadsRoot)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MEDIA_MIME[ext];
  if (!mimeType) return next();

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const fileSize = fs.statSync(filePath).size;
  const range    = req.headers.range;

  const commonHeaders = {
    "Content-Type":                  mimeType,
    "Accept-Ranges":                 "bytes",
    "Cross-Origin-Resource-Policy":  "cross-origin",
    "Access-Control-Allow-Origin":   "*",
    "Access-Control-Allow-Headers":  "Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Cache-Control":                 "public, max-age=86400",
  };

  if (!range) {
    res.writeHead(200, { ...commonHeaders, "Content-Length": fileSize });
    const stream = fs.createReadStream(filePath);
    stream.on("error", (err) => {
      console.error("[media] full stream error:", err.message);
      if (!res.headersSent) res.status(500).end();
    });
    return stream.pipe(res);
  }

  const parts        = range.replace(/bytes=/, "").split("-");
  const start        = parseInt(parts[0], 10);
  const requestedEnd = parts[1] !== "" && parts[1] !== undefined
    ? parseInt(parts[1], 10)
    : Math.min(start + 10 * 1024 * 1024 - 1, fileSize - 1);

  if (isNaN(start) || start < 0 || start >= fileSize) {
    res.set("Content-Range", `bytes */${fileSize}`);
    return res.status(416).end();
  }

  const end       = Math.min(requestedEnd, fileSize - 1);
  const chunkSize = end - start + 1;

  res.writeHead(206, {
    ...commonHeaders,
    "Content-Range":  `bytes ${start}-${end}/${fileSize}`,
    "Content-Length": chunkSize,
  });

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", (err) => {
    console.error("[media] range stream error:", err.message);
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────────────────────────────────────

app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    index:  false,
    maxAge: "7d",
    etag:   false,
    setHeaders: (res, filePath) => {
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      res.set("Access-Control-Allow-Origin",  "*");
      const ext = path.extname(filePath).toLowerCase();
      if (MEDIA_EXTS.has(ext)) {
        res.set("Accept-Ranges", "bytes");
      }
    },
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE LOADER
// ✅ Fixed: "/{*any}" for Node 24 + path-to-regexp v8
// ─────────────────────────────────────────────────────────────────────────────

const loadRoute = (routePath) => {
  try {
    const route = require(routePath);

    if (typeof route !== "function") {
      throw new Error(
        `Module exported ${typeof route} instead of a router function`
      );
    }

    console.log(`  ✅ Loaded: ${routePath}`);
    return route;

  } catch (err) {
    console.error(
      `  ❌ Failed to load route: ${routePath}\n     ${err.message}`
    );

    const fallback = express.Router();

    // ✅ Node 24 / path-to-regexp v8 requires named wildcard parameter
    fallback.all("/{*any}", (_req, res) => {
      res.status(503).json({
        success: false,
        error:   `Route module unavailable: ${path.basename(routePath)}`,
        detail:  process.env.NODE_ENV !== "production" ? err.message : undefined,
      });
    });

    return fallback;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NO-CACHE MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const noCache = (req, res, next) => {
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];
  res.set({
    "Cache-Control":     "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma":            "no-cache",
    "Expires":           "0",
    "Surrogate-Control": "no-store",
  });
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// OPTIONAL AUTHENTICATE
// ─────────────────────────────────────────────────────────────────────────────

const optionalAuthenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    req.user = null;
    return next();
  }
  return auth.authenticate(req, res, next);
};

// ─────────────────────────────────────────────────────────────────────────────
// LOAD ROUTE MODULES ONCE
// ─────────────────────────────────────────────────────────────────────────────

const studentRoutes      = loadRoute("./routes/students.routes");
const announcementRoutes = loadRoute("./routes/announcement.routes");

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({
    message:   "School App API Online",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbLabel = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    status:    "ok",
    database:  dbLabel[dbState] ?? "unknown",
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
    memory:    process.memoryUsage().heapUsed,
    env:       process.env.NODE_ENV || "development",
  });
});

app.use("/api/auth", loadRoute("./routes/auth.routes"));
app.use("/api",      loadRoute("./routes/public.routes"));

// ─────────────────────────────────────────────────────────────────────────────
// GUARDIAN PORTAL
//
// Mounted HERE, above the `app.use("/api", optionalAuthenticate, …)` line
// further down, and that placement is the whole point. optionalAuthenticate
// hands any request carrying a Bearer header to the staff authenticate
// middleware, which looks up a User by the token's `id`. A portal token has no
// `id` — it identifies a student, not a user — so mounting the portal below
// that line answered every signed-in guardian with "User no longer exists".
//
// The router carries its own audience-checked token guard, so it is not
// unprotected; it simply must not pass through the staff one.
// ─────────────────────────────────────────────────────────────────────────────
app.use("/api/portal", loadRoute("./routes/portal.routes"));

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ANNOUNCEMENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get(
  "/api/students/announcements",
  auth.authenticate,
  noCache,
  announcementRoutes.handleStudentAnnouncements
);

app.post(
  "/api/students/announcements/:id/read",
  auth.authenticate,
  noCache,
  async (req, res) => {
    try {
      const Announcement = require("./db/models/Announcement");
      // findByAnyId, not findById: this route is registered ahead of the
      // students router and handles the phone's nanoid announcement ids.
      const announcement = await Announcement.findByAnyId(req.params.id);
      if (!announcement) {
        return res.status(404).json({ message: "Announcement not found" });
      }

      const userId = req.user._id?.toString();
      const result = await Announcement.updateOne(
        { _id: announcement._id, "readBy.user": { $ne: userId } },
        { $push: { readBy: { user: userId, readAt: new Date() } } }
      );

      res.json({
        success:     true,
        message:     "Marked as read",
        alreadyRead: result.modifiedCount === 0,
      });
    } catch (err) {
      console.error("POST /students/announcements/:id/read error:", err.message);
      res.status(500).json({ message: "Failed to mark as read" });
    }
  }
);

app.post(
  "/api/students/announcements/:id/acknowledge",
  auth.authenticate,
  noCache,
  async (req, res) => {
    try {
      const Announcement = require("./db/models/Announcement");
      const announcement = await Announcement.findById(req.params.id);
      if (!announcement) {
        return res.status(404).json({ message: "Announcement not found" });
      }
      const userId     = req.user._id?.toString();
      const alreadyAck = (announcement.acknowledgedBy || []).some(
        (r) => r.user?.toString() === userId
      );
      if (!alreadyAck) {
        announcement.acknowledgedBy.push({
          user:           req.user._id,
          acknowledgedAt: new Date(),
        });
        const alreadyRead = (announcement.readBy || []).some(
          (r) => r.user?.toString() === userId
        );
        if (!alreadyRead) {
          announcement.readBy.push({ user: req.user._id, readAt: new Date() });
        }
        await announcement.save();
      }
      res.json({ success: true, message: "Acknowledged" });
    } catch (err) {
      console.error("POST /students/announcements/:id/acknowledge:", err.message);
      res.status(500).json({ message: "Failed to acknowledge" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENT NUMBER ROUTE
// ─────────────────────────────────────────────────────────────────────────────

app.post(
  "/api/students/:id/enrollment-number",
  auth.authenticate,
  async (req, res) => {
    try {
      const ADMIN_ROLES = ["super_admin", "school_admin", "admin"];
      if (!ADMIN_ROLES.includes(req.user?.role)) {
        return res.status(403).json({
          success: false,
          message: "Admin access required",
        });
      }

      const Student        = require("./db/models/Student");
      const User           = require("./db/models/User");
      const bcrypt         = require("bcryptjs");
      const { v4: uuidv4 } = require("uuid");

      const student = await Student.findById(req.params.id).lean();
      if (!student) {
        return res.status(404).json({ success: false, message: "Student not found" });
      }

      const schoolId =
        req.user?.schoolId ||
        req.body?.schoolId ||
        student.schoolId   ||
        null;

      let userDoc = student.userId
        ? await User.findById(student.userId)
        : null;

      if (!userDoc && (student.email || student.studentEmail)) {
        const email = (student.email || student.studentEmail || "").toLowerCase();
        if (email) userDoc = await User.findOne({ email, role: "student" });
      }

      if (userDoc?.enrollmentNo) {
        // enrollmentNo is the Student schema's field; admissionNo is not a
        // declared path, so a $set on it was silently discarded and the
        // number never landed on the student record.
        if (!student.enrollmentNo) {
          await Student.findByIdAndUpdate(student._id, {
            $set: { enrollmentNo: userDoc.enrollmentNo },
          });
        }
        return res.json({ success: true, enrollmentNo: userDoc.enrollmentNo });
      }

      let schoolCode = "SCH";
      try {
        const School = require("./db/models/School");
        const school = schoolId
          ? await School.findById(schoolId).select("code").lean()
          : null;
        if (school?.code) {
          schoolCode = school.code.trim().toUpperCase().slice(0, 5);
        } else if (schoolId) {
          schoolCode = String(schoolId)
            .replace(/[^A-Z0-9]/gi, "")
            .slice(0, 3)
            .toUpperCase() || "SCH";
        }
      } catch { /* School model optional */ }

      const year   = new Date().getFullYear();
      const prefix = `${schoolCode}-${year}-`;

      const last = await User.findOne(
        { enrollmentNo: { $regex: `^${prefix}` }, role: "student" },
        { enrollmentNo: 1 },
        { sort: { enrollmentNo: -1 } }
      ).lean();

      let nextNum = 1;
      if (last?.enrollmentNo) {
        const parts = last.enrollmentNo.split("-");
        const seq   = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(seq)) nextNum = seq + 1;
      }

      const enrollmentNo = `${prefix}${String(nextNum).padStart(4, "0")}`;

      if (userDoc) {
        userDoc.enrollmentNo = enrollmentNo;
        await userDoc.save();
      } else {
        const displayName =
          [student.firstName, student.lastName].filter(Boolean).join(" ").trim() ||
          student.name || "Student";
        const email = (
          student.email || student.studentEmail || ""
        ).toLowerCase().trim();

        userDoc = await User.create({
          _id:               uuidv4(),
          name:              displayName,
          email:             email || undefined,
          role:              "student",
          schoolId,
          isActive:          true,
          enrollmentNo,
          password:          await bcrypt.hash(enrollmentNo, 12),
          mustResetPassword: true,
        });

        await Student.findByIdAndUpdate(student._id, {
          $set: { userId: userDoc._id },
        });
      }

      if (!student.enrollmentNo) {
        await Student.findByIdAndUpdate(student._id, {
          $set: { enrollmentNo },
        });
      }

      console.log(
        `✅ Enrollment number generated: ${enrollmentNo} → student ${student._id}`
      );
      return res.json({ success: true, enrollmentNo });

    } catch (err) {
      console.error("[enrollment-number] error:", err.message);
      return res.status(500).json({
        success: false,
        message: "Failed to generate enrollment number",
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENCY
//
// Must be mounted BEFORE every authenticated route that accepts writes.
// It used to sit below the student and user routers, so a retried mutation
// against those (exactly what the mobile outbox does on a flaky link) was
// replayed instead of deduplicated.
//
// Uses optionalAuthenticate, not authenticate: /api/students is deliberately
// optional-auth, and hard-authenticating here would break it. The middleware
// no-ops when there is no req.user, and every route below still enforces its
// own auth.
// ─────────────────────────────────────────────────────────────────────────────

app.use("/api", optionalAuthenticate, require("../middleware/idempotency"));

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use("/api/students", optionalAuthenticate, studentRoutes);
app.use("/api/student",  auth.authenticate,    studentRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// USERS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use("/api/users", auth.authenticate, loadRoute("./routes/user.routes"));

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use("/api/sync",
  auth.authenticate,
  loadRoute("./routes/sync.routes")
);

app.use("/api/announcements",
  auth.authenticate,
  noCache,
  announcementRoutes
);

app.use("/api/attendance",
  auth.authenticate,
  loadRoute("./routes/attendance.routes")
);

app.use("/api/homework",
  auth.authenticate,
  loadRoute("./routes/homework.routes")
);

app.use("/api/quiz",
  auth.authenticate,
  loadRoute("./routes/quiz.routes")
);

app.use("/api/results",
  auth.authenticate,
  loadRoute("./routes/results.routes")
);

app.use("/api/templates",
  auth.authenticate,
  loadRoute("./routes/template.routes")
);

app.use("/api/generated-reports",
  auth.authenticate,
  loadRoute("./routes/generated.report.routes")
);

app.use("/api/exams",
  auth.authenticate,
  loadRoute("./routes/exam.routes")
);

// Fees. The router applies its own bursar-only authorisation, so authenticate
// here is only establishing who is asking.
app.use("/api/fees",
  auth.authenticate,
  loadRoute("./routes/fees.routes")
);

// Expenses and payroll. Admin-only, enforced inside the router.
app.use("/api/finance",
  auth.authenticate,
  loadRoute("./routes/finance.routes")
);

// End-of-year rollover. Admin-only, enforced inside the router.
app.use("/api/promotion",
  auth.authenticate,
  loadRoute("./routes/promotion.routes")
);

// Printable documents — class lists, transcripts. Staff-only, and teachers are
// included because a class list is theirs to print.
app.use("/api/documents",
  auth.authenticate,
  loadRoute("./routes/documents.routes")
);

// Spreadsheet exports. Per-export role checks live inside the router.
app.use("/api/exports",
  auth.authenticate,
  loadRoute("./routes/export.routes")
);

// The school gate: QR sign-in and sign-out. Staff-only, enforced inside.
app.use("/api/gate",
  auth.authenticate,
  loadRoute("./routes/gate.routes")
);

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use("/api/teacher",
  auth.authenticate,
  loadRoute("./routes/teacher.routes")
);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use("/api/admin/periods",
  auth.authenticate,
  loadRoute("./routes/periods.routes")
);

app.use("/api/admin/timetable",
  auth.authenticate,
  loadRoute("./routes/timetable.routes")
);

app.use("/api/admin",
  auth.authenticate,
  loadRoute("./routes/admin.routes")
);

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG ROUTES  (development only)
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== "production") {

  app.get("/api/debug/routes", (_req, res) => {
    const routes = [];
    const walk   = (stack, prefix = "") => {
      stack.forEach((layer) => {
        if (layer.route) {
          const methods = Object.keys(layer.route.methods)
            .join(", ")
            .toUpperCase();
          routes.push({ path: prefix + layer.route.path, methods });
        } else if (layer.name === "router" && layer.handle?.stack) {
          const regexpStr = layer.regexp.source;
          const match     = regexpStr
            .replace(/\\\//g, "/")
            .replace("^", "")
            .replace("/?(?=\\/|$)", "")
            .replace("/?$", "")
            .replace(/\(\?:\(\[.*?\]\)\+\)/g, "*");
          walk(layer.handle.stack, prefix + match);
        }
      });
    };
    walk(app._router.stack);
    res.json({ total: routes.length, routes });
  });

  app.get("/api/debug/uploads", (_req, res) => {
    const result = {};
    UPLOAD_DIRS.forEach((dir) => {
      const fullPath = path.join(__dirname, dir);
      try {
        const files  = fs.readdirSync(fullPath);
        result[dir]  = { count: files.length, files: files.slice(0, 10) };
      } catch {
        result[dir]  = { error: "unreadable" };
      }
    });
    res.json(result);
  });

  app.get("/api/debug/env", (_req, res) => {
    res.json({
      NODE_ENV: process.env.NODE_ENV,
      PORT:     process.env.PORT,
    });
  });

  app.get("/api/debug/media/:type/:filename", (req, res) => {
    const { type, filename } = req.params;
    const filePath = path.join(
      __dirname, "uploads", "content", type, filename
    );
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found", filePath });
    }
    const stat  = fs.statSync(filePath);
    const ext   = path.extname(filename).toLowerCase();
    const mime  = MEDIA_MIME[ext] || "application/octet-stream";
    const range = req.headers.range;
    return res.json({
      filePath,
      fileSize:    stat.size,
      mimeType:    mime,
      rangeHeader: range || "(none)",
      isMedia:     MEDIA_EXTS.has(ext),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTER ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  let MulterError;
  try { MulterError = require("multer").MulterError; } catch { /* ignore */ }

  if (MulterError && err instanceof MulterError) {
    const statusMap = {
      LIMIT_FILE_SIZE:       413,
      LIMIT_FILE_COUNT:      400,
      LIMIT_UNEXPECTED_FILE: 400,
      LIMIT_PART_COUNT:      400,
      LIMIT_FIELD_KEY:       400,
      LIMIT_FIELD_VALUE:     400,
      LIMIT_FIELD_COUNT:     400,
    };
    return res.status(statusMap[err.code] ?? 400).json({
      success: false,
      error:   err.message,
      code:    err.code,
    });
  }

  if (err.code === "INVALID_MIME") {
    return res.status(415).json({
      success: false,
      error:   err.message,
      code:    err.code,
    });
  }

  next(err);
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  console.warn(`⚠️  404 — ${req.method} ${req.originalUrl}`);
  res.status(404).json({
    success: false,
    error:   "Route not found",
    path:    req.originalUrl,
    method:  req.method,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────────────────────

async function startServer() {
  try {
    console.log("════════════════════════════════════");
    console.log("🚀 Starting School App Server…");
    console.log(`   ENV  : ${process.env.NODE_ENV || "development"}`);
    console.log(`   PORT : ${PORT}`);
    console.log("════════════════════════════════════");

    console.log("🔌 Connecting to MongoDB…");
    await connectDatabase();
    console.log("✅ MongoDB connected");

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log("════════════════════════════════════");
      console.log(`🚀 Server running  →  http://0.0.0.0:${PORT}`);
      console.log(`❤️  Health check   →  http://localhost:${PORT}/api/health`);
      console.log("════════════════════════════════════");
      console.log("Route groups (in match order):");
      console.log("  PUBLIC   GET  /");
      console.log("  PUBLIC   GET  /api/health");
      console.log("  PUBLIC   ANY  /api/auth/*");
      console.log("  PUBLIC   ANY  /api/*              (public.routes)");
      console.log("  ─────────────────────────────────");
      console.log("  MEDIA    GET  /uploads/{*path}     ← range streaming");
      console.log("  STATIC   ANY  /uploads/*           ← express.static");
      console.log("  ─────────────────────────────────");
      console.log("  AUTH+NC  GET  /api/students/announcements      ← FIRST");
      console.log("  AUTH+NC  POST /api/students/announcements/:id/read");
      console.log("  AUTH+NC  POST /api/students/announcements/:id/acknowledge");
      console.log("  AUTH     POST /api/students/:id/enrollment-number");
      console.log("  ─────────────────────────────────");
      console.log("  OPT-AUTH ANY  /api/students/*");
      console.log("  AUTH     ANY  /api/student/*");
      console.log("  ─────────────────────────────────");
      console.log("  AUTH     ANY  /api/users/*");
      console.log("  AUTH     ANY  /api/sync/*");
      console.log("  AUTH+NC  ANY  /api/announcements/*");
      console.log("  AUTH     ANY  /api/attendance/*");
      console.log("  AUTH     ANY  /api/quiz/*");
      console.log("  AUTH     ANY  /api/results/*");
      console.log("  AUTH     ANY  /api/templates/*");
      console.log("  AUTH     ANY  /api/generated-reports/*");
      console.log("  AUTH     ANY  /api/exams/*");
      console.log("  ─────────────────────────────────");
      console.log("  AUTH     ANY  /api/teacher/*");
      console.log("  ─────────────────────────────────");
      console.log("  AUTH     ANY  /api/admin/periods/*");
      console.log("  AUTH     ANY  /api/admin/timetable/*");
      console.log("  AUTH     ANY  /api/admin/*");

      if (process.env.NODE_ENV !== "production") {
        console.log("  ─────────────────────────────────");
        console.log("  DEBUG    GET  /api/debug/routes");
        console.log("  DEBUG    GET  /api/debug/uploads");
        console.log("  DEBUG    GET  /api/debug/env");
        console.log("  DEBUG    GET  /api/debug/media/:type/:filename");
      }

      console.log("════════════════════════════════════");
    });

    // ── Notification dispatcher ───────────────────────────────────────────
    //
    // Nothing else drains the queue. Without this a fee receipt or a gate
    // arrival sits pending until somebody calls /api/gate/dispatch by hand,
    // which is exactly the kind of thing that looks fine in testing and
    // silently never delivers in production.
    //
    // unref() so the timer never holds the process open during a shutdown.
    const notifications = require("./services/notification");
    const NOTIFY_INTERVAL_MS = 60_000;

    const notifyTimer = setInterval(() => {
      notifications.dispatch({ limit: 25 })
        .then((r) => {
          if (r.sent || r.failed) {
            console.log(
              `[notify] sent ${r.sent}, failed ${r.failed}, ` +
              `skipped ${r.skipped}, ${r.remaining} still due`
            );
          }
        })
        .catch((err) => console.warn("[notify] dispatch failed:", err.message));
    }, NOTIFY_INTERVAL_MS);
    notifyTimer.unref();

    console.log(`📨 notification dispatcher every ${NOTIFY_INTERVAL_MS / 1000}s`);

    server.keepAliveTimeout = 65_000;
    server.headersTimeout   = 66_000;
    server.timeout          = 10 * 60 * 1000;

    console.log(
      `⏱️  keep-alive: ${server.keepAliveTimeout / 1000}s  ` +
      `headers-timeout: ${server.headersTimeout / 1000}s  ` +
      `request-timeout: ${server.timeout / 1000}s`
    );

    const shutdown = async (signal) => {
      console.log(`\n🛑 ${signal} received — shutting down gracefully…`);
      server.close(async () => {
        console.log("🔌 HTTP server closed");
        try {
          await mongoose.connection.close();
          console.log("🔌 MongoDB connection closed");
        } catch (dbErr) {
          console.error("⚠️  Error closing MongoDB:", dbErr.message);
        }
        console.log("✅ Graceful shutdown complete");
        process.exit(0);
      });
      setTimeout(() => {
        console.error("❌ Graceful shutdown timed out — forcing exit");
        process.exit(1);
      }, 10_000).unref();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));

    process.on("unhandledRejection", (reason) => {
      console.error("⚠️  Unhandled Rejection:", reason);
    });

    process.on("uncaughtException", (err) => {
      console.error("💥 Uncaught Exception:", err.message);
      console.error(err.stack);
      process.exit(1);
    });

  } catch (error) {
    console.error("❌ Server failed to start:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

startServer();
