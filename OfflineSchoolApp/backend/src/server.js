"use strict";

require("dotenv").config();

// Before the app, before the routers: the SDK instruments modules as they are
// loaded, so anything required ahead of it is invisible to it. Inert without
// SENTRY_DSN — see the note in that file about what is stripped before send.
const { Sentry, enabled: errorReporting } = require("./instrument");

/*
 * Before anything else. A server missing JWT_SECRET starts happily, reports
 * itself healthy and then throws on the first login — jsonwebtoken raises at
 * signing time, not at import — so the deployment looks fine to the person who
 * did it and is broken for everybody else. See config/env.js.
 */
require("./config/env").validateEnv();

const express     = require("express");
const cors        = require("cors");
const { corsOrigin } = require("./config/corsOrigins");
const helmet      = require("helmet");
const morgan      = require("morgan");
const compression = require("compression");
const mongoose    = require("mongoose");
const { checkReadiness, indexReadiness } = require("./services/readiness.service");
const path        = require("path");
const fs          = require("fs");

const connectDatabase = require("./config/database");

// Registers every model in src/db/models. The sync feed resolves models by
// NAME through mongoose.models, so a model no live module happens to require
// is missing from the feed and its collection is silently never mirrored —
// which was true of Grade. See the note in that file.
require("./db/models");
const errorHandler    = require("../middleware/errorHandler");
const auth            = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const {
  ensureStudentGateTokenIndex,
  ensureIdempotencyIndex,
} = require("./db/ensureStudentIndexes");
const { generateTempPassword } = require("./utils/tempPassword");

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
  "uploads/messages",
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

// Uploaded files: the uploads directory or a bucket (storage/fileStore.js).
const { getStore } = require("./storage/fileStore");

// ─────────────────────────────────────────────────────────────────────────────
// CORE MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use(compression());

/*
 * Behind a reverse proxy — which is how this is deployed — every request
 * arrives from the proxy's address. Without this, req.ip is the proxy for all
 * of them, so the login rate limiter counts the whole school as one client:
 * either it locks everybody out together or it never triggers.
 */
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// `dev` is colourised and writes a line per request including 304s. Production
// gets the Apache combined format, which is what log collectors parse.
// The URL as logged, with any ?sig= (a signed media or document link — a
// capability that opens a file for an hour) reduced to its name. A log line
// is read by more people, for longer, than the link was meant for.
morgan.token("url", (req) =>
  String(req.originalUrl || req.url || "").replace(/([?&]sig=)[^&]+/g, "$1[redacted]")
);
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.use(cors({
  // ALLOWED_ORIGINS, plus any ALLOWED_ORIGIN_PATTERNS, in production;
  // reflect-all otherwise. See config/corsOrigins.js.
  origin:         corsOrigin(),
  credentials:    true,
  methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Idempotency-Key is read by middleware/idempotency.js. A browser client
  // that sends it would have the header stripped by the preflight without
  // this, and would silently lose the protection it was asking for.
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Range", "Idempotency-Key"],
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

// ── Applicant documents are never served from here ──────────────────────────
// Birth certificates and ID scans a family attached to an admission
// application land under uploads/applications. They are reached through
// GET /api/students/applications/:id/documents/:key, which authorises the
// caller (or a link minted for one) — see utils/applicationDocuments.js. Both
// the streaming handler below and express.static after it would otherwise hand
// the file to anyone holding the URL, so the prefix is closed ahead of both.
// A uniform 404, because "forbidden" would confirm the file exists.
app.use("/uploads/applications", require("./utils/applicationDocuments").blockPublicApplicationsPath);

app.get("/uploads/{*path}", require("./storage/serveUploads").serveUploads({
  uploadsRoot: path.join(__dirname, "uploads"),
  mediaMime:   MEDIA_MIME,
}));

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

// Readiness, beside the liveness above: 200 only when the database answers a
// ping, 503 otherwise (services/readiness.service.js). The Docker healthcheck
// reads this one.
//
// In production it is also 503 while a unique or TTL index is missing or
// incompatible (INDEXES_INCOMPLETE): the boot check's result, re-checked in
// the background at most every 5 minutes while it is failing, so provisioning
// shows up here without a restart.
const INDEX_RECHECK_MS = 5 * 60 * 1000;
let indexRecheck = null;
app.get("/api/health/ready", async (_req, res) => {
  const { ready, database } = await checkReadiness(mongoose.connection);
  const indexCheck = require("./services/indexCheck.service");
  const state = indexCheck.indexState();
  if (ready && state.criticalProblems > 0 && !indexRecheck &&
      Date.now() - state.checkedAt.getTime() > INDEX_RECHECK_MS) {
    indexRecheck = indexCheck.verifyDeclaredIndexes({ log: () => {} })
      .catch(() => null)
      .finally(() => { indexRecheck = null; });
  }
  const idx = indexReadiness(state, { production: process.env.NODE_ENV === "production" });
  const ok = ready && idx.ok;
  res.status(ok ? 200 : 503).json({
    status:    ok ? "ready" : "unavailable",
    ...(ready && !idx.ok ? { reason: "INDEXES_INCOMPLETE" } : {}),
    database,
    indexes:   idx.indexes,
    ...(idx.criticalProblems ? { criticalIndexProblems: idx.criticalProblems } : {}),
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", loadRoute("./routes/auth.routes"));
app.use("/api",      loadRoute("./routes/public.routes"));
// Public document verification (QR on transcripts and report cards). Mounted
// with the other unauthenticated routes: the person checking a document is a
// stranger to this system, and that is the feature.
app.use("/api",      loadRoute("./routes/verify.routes"));

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

/**
 * The student audience, stated once.
 *
 * /api/students/announcements/* is the STUDENT surface of the announcement
 * feature: the mobile client picks it by role (see announcement.service.js,
 * `isStudent(user) ? /students/announcements/… : /announcements/…`), and the
 * students router guards its own copies with the same `studentOnly` test. These
 * inline copies predate that guard and carried authentication only, so any
 * staff account — of any school — could post a read receipt onto an
 * announcement it had nothing to do with. Tenancy now bounds the row; the role
 * belongs here too, matching the router.
 */
const studentOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "student") {
    return res.status(403).json({
      success: false,
      message: `Students only. Your role "${req.user?.role}" is not permitted.`,
    });
  }
  next();
};

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
  studentOnly,
  async (req, res) => {
    try {
      const { findAnnouncementById } = require("./utils/announcementScope");
      // findByAnyId inside the helper, not findById: this route is registered
      // ahead of the students router and handles the phone's nanoid
      // announcement ids. The helper also applies the school filter — a receipt
      // goes only into the caller's own school's rows, and another school's id
      // answers 404 rather than confirming it exists.
      const announcement = await findAnnouncementById(req.params.id, req);
      if (!announcement) {
        return res.status(404).json({ message: "Announcement not found" });
      }

      const userId = req.user._id?.toString();
      const Announcement = require("./db/models/Announcement");
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
  studentOnly,
  async (req, res) => {
    try {
      const { findAnnouncementById } = require("./utils/announcementScope");
      const announcement = await findAnnouncementById(req.params.id, req);
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

// Issuing an enrolment number creates the student's LOGIN — it mints or
// updates their User account and their password. students.manage, therefore,
// and the guard is declared with the route rather than hand-rolled inside the
// handler.
//
// This one was missed in the role sweep and it is worth saying why: the sweep
// scanned src/routes, and this route is defined here in server.js. It still
// carried the dead "admin" string that every other guard had shed. The check
// script now reads this file too.
app.post(
  "/api/students/:id/enrollment-number",
  auth.authenticate,
  requirePermission("students.manage"),
  async (req, res) => {
    try {
      const Student        = require("./db/models/Student");
      const User           = require("./db/models/User");
      const { v4: uuidv4 } = require("uuid");

      // ── Tenancy ─────────────────────────────────────────────────────────
      // A school-scoped caller may only provision logins for their OWN
      // students, and the login belongs to the STUDENT's school — not to
      // whoever the caller is or whatever the body named. The old
      // caller-first fallback let a students.manage holder point a brand-new
      // User at another school's Student record and walk away with a working
      // login for it. The lookup answers 404 for a foreign id, exactly as
      // GET /api/users/:id does.
      const callerSchoolId = req.user?.schoolId ? String(req.user.schoolId) : null;
      const student = await Student.findOne({
        _id: req.params.id,
        ...(callerSchoolId ? { schoolId: callerSchoolId } : {}),
      }).lean();
      if (!student) {
        return res.status(404).json({ success: false, message: "Student not found" });
      }

      const schoolId = student.schoolId || null;

      let userDoc = student.userId
        ? await User.findById(student.userId)
        : null;

      if (!userDoc && (student.email || student.studentEmail)) {
        const email = (student.email || student.studentEmail || "").toLowerCase();
        if (email) {
          userDoc = await User.findOne({
            email,
            role:    "student",
            // The existing login must belong to the student's own school. A
            // same-named account at another school is that school's business.
            ...(schoolId ? { schoolId } : {}),
          });
        }
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

      // services/admissionNumber.service.js — one shape and one sequence for
      // every admission path. A number the student record already carries is
      // kept: this route gives an existing pupil a login, not a new identity.
      const { nextAdmissionNo } = require("./services/admissionNumber.service");
      let candidate = student.enrollmentNo || student.admissionNo || await nextAdmissionNo(schoolId);

      // ── The first password is random, never the enrollment number ────────
      // This used to be bcrypt.hash(enrollmentNo, 12): the credential was the
      // enrollment number itself — printed on documents, read aloud across an
      // office, reconstructable by anybody who can see a class list. Every
      // other provisioning path in the app (generateTempPassword in
      // students.routes and admin.routes) mints a random one; this route now
      // does too. It comes back in the response so the caller can hand it over
      // once — nothing server-side needs to remember it, the fifteen-minute
      // token rule still applies while mustResetPassword is set, and from the
      // next change on the stale-token gate in middleware/auth.js applies.
      const tempPassword = generateTempPassword();

      // ── Race-safe numbering ─────────────────────────────────────────────
      // The generator's counter already hands two simultaneous requests two
      // numbers. The unique partial index (enrollmentNo_unique_present on the
      // User model) is the second line: a number some older path issued
      // outside the counter gets E11000 here, and the request takes the next —
      // the same shape as saveUserWithUniqueEnrollment in students.routes.
      let enrollmentNo = null;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          if (userDoc) {
            userDoc.enrollmentNo = candidate;
            await userDoc.save();
          } else {
            const displayName =
              [student.firstName, student.lastName].filter(Boolean).join(" ").trim() ||
              student.name || "Student";
            const email = (
              student.email || student.studentEmail || ""
            ).toLowerCase().trim();

            // ❌ Do NOT bcrypt.hash() here — the pre-save hook hashes the
            //    password and stamps passwordChangedAt, which the token
            //    staleness gate in middleware/auth.js then enforces.
            userDoc = await User.create({
              _id:               uuidv4(),
              name:              displayName,
              email:             email || undefined,
              role:              "student",
              schoolId,
              isActive:          true,
              enrollmentNo:      candidate,
              password:          tempPassword,
              mustResetPassword: true,
            });

            await Student.findByIdAndUpdate(student._id, {
              $set: { userId: userDoc._id },
            });
          }

          enrollmentNo = candidate;
          break;
        } catch (err) {
          const dupKeys = JSON.stringify(err?.keyPattern || err?.keyValue || {});
          const isDupNo = err?.code === 11000 && dupKeys.includes("enrollmentNo");
          if (!isDupNo || attempt === 4) throw err;

          console.warn(
            `[enrollment-number] "${candidate}" collided — taking the next number`
          );
          candidate = await nextAdmissionNo(schoolId);
        }
      }

      if (!student.enrollmentNo) {
        await Student.findByIdAndUpdate(student._id, {
          $set: { enrollmentNo },
        });
      }

      console.log(
        `✅ Enrollment number generated: ${enrollmentNo} → student ${student._id}`
      );
      return res.json({ success: true, enrollmentNo, tempPassword });

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

app.use("/api/academic-structure",
  auth.authenticate,
  loadRoute("./routes/academicStructure.routes")
);

app.use("/api/term-results",
  auth.authenticate,
  loadRoute("./routes/termResults.routes")
);

app.use("/api/annual-results",
  auth.authenticate,
  loadRoute("./routes/annualResults.routes")
);

// Fees. The router applies its own finance-role authorisation, so authenticate
// here is only establishing who is asking.
app.use("/api/fees",
  auth.authenticate,
  loadRoute("./routes/fees.routes")
);

// Expenses and payroll. Admin-only, enforced inside the router.
// Approvals. Mounted next to finance because that is what it gates today, and
// at its own top-level prefix rather than under /api/finance because a payroll
// signature is not a finance READ — the queue is a head teacher's screen.
app.use("/api/approvals",
  auth.authenticate,
  loadRoute("./routes/approvals.routes")
);

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

// Messaging: direct threads, class/subject channels, groups. Every route
// consults the communication policy; guardians come in through the portal
// router instead, because a portal token identifies a GuardianAccess row
// and not a User.
app.use("/api/messages",
  auth.authenticate,
  loadRoute("./routes/messages.routes")
);

// The school gate: QR sign-in and sign-out. Staff-only, enforced inside.
app.use("/api/gate",
  auth.authenticate,
  loadRoute("./routes/gate.routes")
);

// Cross-module reads — the early-warning watch list. Office-only, enforced
// inside the router.
app.use("/api/insights",
  auth.authenticate,
  loadRoute("./routes/insights.routes")
);
app.use("/api/interventions", auth.authenticate, loadRoute("./routes/interventions.routes"));
// The exploration catalog and a pupil's moves through an exploration (Stage 10).
app.use("/api/explorations", auth.authenticate, loadRoute("./routes/explorations.routes"));

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

// Mounted above /api/admin, like periods and timetable below it: the admin
// router is a catch-all for that prefix, so a more specific path has to be
// registered first or it never sees a request.
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM
//
// What sits above a school: creating one, switching it off, reading across all
// of them, the audit trail. Every route carries a platform.* capability that
// only super_admin holds. A super_admin working INSIDE a school does not come
// here — they use /api/admin/* with a schoolId, like any other administrator
// of that school.
// ─────────────────────────────────────────────────────────────────────────────
app.use("/api/super-admin",
  auth.authenticate,
  loadRoute("./routes/superAdmin.routes")
);

app.use("/api/admin/permissions",
  auth.authenticate,
  loadRoute("./routes/permissions.routes")
);

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
// ERROR REPORTING
// ─────────────────────────────────────────────────────────────────────────────
//
// Ahead of the handlers below, because they are what turns a thrown error
// into a tidy JSON response — after them there is nothing left to report.
// A no-op when SENTRY_DSN is unset.

if (errorReporting) Sentry.setupExpressErrorHandler(app);

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

    // Repair a stale non-sparse unique index on students.gateToken (see the
    // module docstring). Runs every boot, no-ops once the DB is correct.
    await ensureStudentGateTokenIndex();

    // The index middleware/idempotency.js depends on. Nothing created it on
    // purpose before this line existed — mongoose built it in the background,
    // and without it the middleware waves every repeated write through while
    // looking as though it is protecting them. See the module docstring.
    await ensureIdempotencyIndex();

    // The sync tombstones (models/SyncTombstone.js): one per hard-deleted row,
    // read by GET /sync/pull. Built here, as above — autoIndex is off in
    // production, and the collection only ever gains rows by upsert on its own
    // unique key, so a build cannot meet duplicates. Not fatal: without the
    // index tombstones still work, slower, and the index check reports it.
    try {
      await require("./db/models/SyncTombstone").createIndexes();
    } catch (err) {
      console.error("[sync] could not build the tombstone indexes — " + err.message);
    }

    // The school-wide analysis runs (docs/38): the unique index that keeps two
    // servers from running the same analysis at once, then the runs a stopped
    // process left queued or running, whose leases have expired.
    // Neither stops the server: without them the analysis may run twice or
    // a stale run waits out its lease, which costs work, not a school's day.
    const analysisRuns = require("./services/intelligence/analysisRuns.service");
    await analysisRuns.ensureIndexes();

    // Every index the models declare, against the database: one line per
    // missing index and a summary (docs/40 0.19). Never fatal. After the
    // models' own builds, so an index still being built is not reported.
    try {
      await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => null)));
      await require("./services/indexCheck.service").verifyDeclaredIndexes();
    } catch (err) {
      console.error("[indexes] could not verify the declared indexes — " + err.message);
    }
    try {
      const interrupted = await analysisRuns.recoverStale();
      if (interrupted) console.log(`[analysis] ${interrupted} interrupted run(s) from a previous process marked INTERRUPTED`);
    } catch (err) {
      console.error("[analysis] could not sweep interrupted runs at boot — " + err.message + " (they expire with their lease)");
    }

    console.log("✅ Indexes verified");

    /*
     * Email configuration, reported once at startup.
     *
     * A warning, not a refusal. A school runs this backend on a laptop in an
     * office to take a register and record fees, and none of that needs an
     * outbound mail provider — making the process refuse to start over an
     * unset API key would turn a missing convenience into a closed school.
     *
     * So it says clearly what is unavailable and starts. The queue already
     * degrades correctly: without a provider, resolveChannel() falls to "log",
     * every notification is still RECORDED, and the portal still shows a
     * parent their child's arrival. Only delivery is missing, and the row
     * carries a skipReason that says so.
     *
     * Shape only, never the key. describe() reports lengths.
     */
    try {
      const mailCfg = mail.describe();
      if (mail.isConfigured()) {
        console.log(`📧 Email provider  →  ${mailCfg.label} as ${mailCfg.from ?? "(no sender)"}`);
        if (mailCfg.replyTo) console.log(`   Reply-To        →  ${mailCfg.replyTo}`);
        // Whether there is anything behind the primary. Worth a line because
        // the difference only shows on the day a send is refused.
        console.log(
          mailCfg.failover
            ? `   Failover        →  ${mailCfg.failover.label} as ${mailCfg.failover.as ?? "(unknown)"}`
            : "   Failover        →  none (a refused send is reported, not retried)"
        );
        // Configured, but not perfectly. Nothing here stops a send, which is
        // why it reads as a note rather than a warning.
        for (const note of mailCfg.advisories ?? []) console.log(`   Note            →  ${note}`);
        const unset = Object.entries(mailCfg.templates ?? {})
          .filter(([, id]) => !id).map(([k]) => k);
        if (unset.length) {
          console.log(
            `   Brevo templates not yet assigned: ${unset.join(", ")} ` +
            "— those emails send this app's own HTML until an id is set."
          );
        }
      } else {
        console.warn("⚠️  Brevo email service is not configured.");
        console.warn("    Transactional emails will be unavailable; everything else works.");
        for (const issue of mailCfg.problems ?? []) console.warn(`    - ${issue}`);
      }
    } catch (err) {
      // Reporting configuration must never be the thing that stops a start.
      console.warn("⚠️  Could not report email configuration:", err.message);
    }

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log("════════════════════════════════════");
      console.log(`🚀 Server running  →  http://0.0.0.0:${PORT}`);
      console.log(`❤️  Health check   →  http://localhost:${PORT}/api/health`);
      {
        // Where uploads go. Never the credentials.
        const store = getStore();
        console.log(store.driver === "local" ? "📁 Uploads        →  local disk (backend/src/uploads)"
          : store.driver === "mongo"         ? "🍃 Uploads        →  MongoDB GridFS (uploads.files / uploads.chunks)"
          : `🪣 Uploads        →  bucket "${store.bucket}"`);
        if (store.driver === "local" && process.env.NODE_ENV === "production") {
          console.warn("⚠️  Uploads are on this server's disk. On Render that disk is wiped on every deploy — unset STORAGE_DRIVER (GridFS is the production default) or set STORAGE_BUCKET.");
        }
      }
      console.log("════════════════════════════════════");
      console.log("Route groups (in match order):");
      console.log("  PUBLIC   GET  /");
      console.log("  PUBLIC   GET  /api/health");
      console.log("  PUBLIC   GET  /api/health/ready");
      console.log("  PUBLIC   ANY  /api/auth/*");
      console.log("  PUBLIC   ANY  /api/*              (public.routes)");
      console.log("  ─────────────────────────────────");
      console.log("  MEDIA    GET  /uploads/{*path}     ← range streaming");
      console.log("  STATIC   ANY  /uploads/*           ← express.static");
      console.log("  ─────────────────────────────────");
      console.log("  AUTH+NC  GET  /api/students/announcements      ← FIRST");
      console.log("  AUTH+NC+STU POST /api/students/announcements/:id/read");
      console.log("  AUTH+NC+STU POST /api/students/announcements/:id/acknowledge");
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
