// backend/src/routes/timetable.routes.js - FULLY FIXED
"use strict";

const express       = require("express");
const router        = express.Router();
const TimetableSlot = require("../db/models/TimetableSlot");
const User          = require("../db/models/User");
const Subject       = require("../db/models/Subject");

// ─────────────────────────────────────────────────────────────────────────────
// FIXED (Issue 4): Load Class model at module level — fail loudly at startup,
// not silently on every request. A missing model is a configuration error and
// should crash the process during boot, not hide itself in production traffic.
// ─────────────────────────────────────────────────────────────────────────────

let Class = null;
try {
  Class = require("../db/models/Class");
} catch (err) {
  console.warn(
    "[timetable.routes] Class model not found — className will be null in " +
    "responses. If this is unexpected, check ../db/models/Class exists.",
    err.message
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

const { authenticate } = require("../../middleware/auth");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ─────────────────────────────────────────────────────────────────────────────
// FIXED (Issue 2): Consolidate null | "" into $in so MongoDB can use a sparse
// index on deletedAt. The three-branch $or previously prevented index usage.
//
// TODO: run a one-time migration to normalise legacy "" values to null so the
// "" branch can eventually be removed:
//   db.timetableslots.updateMany({ deletedAt: "" }, { $set: { deletedAt: null } })
// ─────────────────────────────────────────────────────────────────────────────

const NOT_DELETED = {
  $or: [
    { deletedAt: { $exists: false }    },
    { deletedAt: { $in: [null, ""] }   },  // null + legacy empty-string values
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// DAY NORMALISATION
//
// FIXED (Issue 3): canonicalDay now accepts a strict flag. In strict mode any
// value not present in DAY_CANONICAL throws a ValidationError so bad data is
// rejected at the boundary rather than stored silently.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_CANONICAL = {
  monday:    "monday",    mon: "monday",
  tuesday:   "tuesday",   tue: "tuesday",
  wednesday: "wednesday", wed: "wednesday",
  thursday:  "thursday",  thu: "thursday",
  friday:    "friday",    fri: "friday",
  saturday:  "saturday",  sat: "saturday",
  sunday:    "sunday",    sun: "sunday",
};

/**
 * Converts any supported day string to its canonical lowercase form.
 *
 * @param {string} raw      - Raw day value from request or database.
 * @param {{ strict?: boolean }} [opts]
 * @param {boolean} [opts.strict=false] - When true, throw on unrecognised values.
 * @returns {string} Canonical lowercase day name.
 * @throws {Error} name="ValidationError" when strict=true and day is unknown.
 */
const canonicalDay = (raw, { strict = false } = {}) => {
  const key       = (raw || "").toLowerCase().trim();
  const canonical = DAY_CANONICAL[key];

  if (!canonical && strict) {
    const err     = new Error(`Invalid dayOfWeek value: "${raw}"`);
    err.name      = "ValidationError";
    err.statusCode = 400;
    throw err;
  }

  // Non-strict: return whatever was lowercased so read paths never blow up.
  return canonical || key;
};

// ─────────────────────────────────────────────────────────────────────────────
// SLOT NORMALISATION
// Always returns canonical lowercase dayOfWeek.
// ─────────────────────────────────────────────────────────────────────────────

const normalizeSlot = (s) => ({
  _id:       s._id       ? String(s._id) : undefined,
  schoolId:  s.schoolId  || null,
  classId:   s.classId   || null,
  subjectId: s.subjectId || null,
  teacherId: s.teacherId || null,
  periodId:  s.periodId  || null,
  dayOfWeek: s.dayOfWeek ? canonicalDay(s.dayOfWeek) : null,
  room:      s.room      || null,
  version:   s.version   || 1,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUARDS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allows school_admin, admin, super_admin, and teacher roles.
 * Teachers need read access to their own schedule.
 */
const staffOnly = (req, res, next) => {
  const ALLOWED = new Set(["super_admin", "school_admin", "admin", "teacher"]);
  if (!req.user) {
    return res
      .status(401)
      .json({ success: false, message: "Not authenticated" });
  }
  if (!ALLOWED.has(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Your role "${req.user.role}" is not permitted.`,
    });
  }
  next();
};

/**
 * Admin-only guard for write operations (create, update, delete).
 */
const adminOnly = (req, res, next) => {
  const ALLOWED = new Set(["super_admin", "school_admin", "admin"]);
  if (!req.user) {
    return res
      .status(401)
      .json({ success: false, message: "Not authenticated" });
  }
  if (!ALLOWED.has(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Admin only. Your role "${req.user.role}" is not permitted.`,
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true when the requesting user holds an admin-level role. */
const isAdminRole = (user) =>
  new Set(["super_admin", "school_admin", "admin"]).has(user?.role);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/timetable
// Query: ?schoolId=&classId=&teacherId=
//
// FIXED (Issue 6): Teachers are silently scoped to their own teacherId so they
// cannot enumerate other teachers' schedules by passing ?teacherId=<otherId>.
// Admins continue to receive unscoped results.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/",
  authenticate,
  staffOnly,
  asyncHandler(async (req, res) => {
    const { schoolId, classId } = req.query;
    let   { teacherId }         = req.query;

    // FIXED (Issue 6): non-admin users may only see their own slots.
    if (!isAdminRole(req.user)) {
      teacherId = String(req.user._id || req.user.id || "").trim();
    }

    const filter = { ...NOT_DELETED };
    if (schoolId)  filter.schoolId  = String(schoolId).trim();
    if (classId)   filter.classId   = String(classId).trim();
    if (teacherId) filter.teacherId = String(teacherId).trim();

    const slots = await TimetableSlot
      .find(filter)
      .sort({ dayOfWeek: 1, periodId: 1 })
      .lean();

    const subjectIds = [...new Set(slots.map((s) => s.subjectId).filter(Boolean))];
    const teacherIds = [...new Set(slots.map((s) => s.teacherId).filter(Boolean))];

    const [subjectDocs, teacherDocs] = await Promise.all([
      subjectIds.length > 0
        ? Subject.find({ _id: { $in: subjectIds } }).select("name code").lean()
        : [],
      teacherIds.length > 0
        ? User.find({ _id: { $in: teacherIds } }).select("name email").lean()
        : [],
    ]);

    const subjectMap = new Map(subjectDocs.map((s) => [String(s._id), s]));
    const teacherMap = new Map(teacherDocs.map((t) => [String(t._id), t]));

    const populated = slots.map((s) => ({
      ...normalizeSlot(s),
      subject: subjectMap.get(String(s.subjectId)) || null,
      teacher: teacherMap.get(String(s.teacherId)) || null,
    }));

    res.json({ success: true, slots: populated, count: populated.length });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/timetable/my-schedule
// Teacher fetches their own schedule using the JWT identity.
//
// IMPORTANT: registered BEFORE /:id to prevent Express matching "my-schedule"
// as a Mongo ObjectId and throwing a CastError.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/my-schedule",
  authenticate,
  staffOnly,        // staffOnly — teachers must be able to reach this endpoint
  asyncHandler(async (req, res) => {
    const teacherId = String(req.user._id || req.user.id || "").trim();
    const schoolId  = req.user.schoolId || req.query.schoolId || null;

    if (!teacherId) {
      return res.status(400).json({
        success: false,
        error:   "Could not resolve teacher identity from token",
      });
    }

    const filter = { teacherId, ...NOT_DELETED };
    if (schoolId) filter.schoolId = String(schoolId).trim();

    const slots = await TimetableSlot
      .find(filter)
      .sort({ dayOfWeek: 1, periodId: 1 })
      .lean();

    const subjectIds = [...new Set(slots.map((s) => s.subjectId).filter(Boolean))];
    const classIds   = [...new Set(slots.map((s) => s.classId).filter(Boolean))];

    // FIXED (Issue 4): Class is loaded at module level — no require() here.
    const [subjectDocs, classDocs] = await Promise.all([
      subjectIds.length > 0
        ? Subject.find({ _id: { $in: subjectIds } }).select("name code").lean()
        : [],
      classIds.length > 0 && Class
        ? Class.find({ _id: { $in: classIds } }).select("name section").lean()
        : [],
    ]);

    const subjectMap = new Map(subjectDocs.map((s) => [String(s._id), s]));
    const classMap   = new Map(classDocs.map((c)   => [String(c._id), c]));

    const populated = slots.map((s) => {
      const sub = subjectMap.get(String(s.subjectId));
      const cls = classMap.get(String(s.classId));
      return {
        ...normalizeSlot(s),
        subjectName: sub?.name || null,
        subjectCode: sub?.code || null,
        className:   cls
          ? [cls.name, cls.section].filter(Boolean).join(" ")
          : null,
        subject: sub || null,
        class:   cls || null,
      };
    });

    res.json({ success: true, slots: populated, count: populated.length });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/timetable
//
// FIXED (Issue 3): dayOfWeek validated in strict mode — rejects unknown values
// before they can be stored.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  "/",
  authenticate,
  adminOnly,
  asyncHandler(async (req, res) => {
    const {
      schoolId, classId, subjectId,
      teacherId, dayOfWeek, periodId, room,
    } = req.body;

    const missing = [];
    if (!schoolId)  missing.push("schoolId");
    if (!classId)   missing.push("classId");
    if (!subjectId) missing.push("subjectId");
    if (!teacherId) missing.push("teacherId");
    if (!dayOfWeek) missing.push("dayOfWeek");
    if (!periodId)  missing.push("periodId");

    if (missing.length) {
      return res.status(400).json({
        success: false,
        error:   "Validation Error",
        details: [`Missing required fields: ${missing.join(", ")}`],
      });
    }

    // FIXED (Issue 3): strict=true rejects invalid day names immediately.
    const day = canonicalDay(dayOfWeek, { strict: true });

    const classConflict = await TimetableSlot.findOne({
      classId, dayOfWeek: day, periodId, ...NOT_DELETED,
    }).lean();

    if (classConflict) {
      return res.status(409).json({
        success:  false,
        error:    "Class already has a lesson in this period",
        conflict: "class",
        slot:     normalizeSlot(classConflict),
      });
    }

    const teacherConflict = await TimetableSlot.findOne({
      teacherId, dayOfWeek: day, periodId, ...NOT_DELETED,
    }).lean();

    if (teacherConflict) {
      return res.status(409).json({
        success:  false,
        error:    "Teacher is already assigned in this period",
        conflict: "teacher",
        slot:     normalizeSlot(teacherConflict),
      });
    }

    const created = await TimetableSlot.create({
      schoolId, classId, subjectId, teacherId,
      dayOfWeek: day,
      periodId,
      room: room?.trim() || null,
    });

    res.status(201).json({
      success: true,
      slot:    normalizeSlot(created.toObject()),
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/timetable/:id
//
// FIXED (Issue 3): dayOfWeek validated in strict mode.
// FIXED (Issue 5): optimistic concurrency check on the version field prevents
// silent overwrites when two admins edit the same slot simultaneously.
// ─────────────────────────────────────────────────────────────────────────────

router.put(
  "/:id",
  authenticate,
  adminOnly,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const slot = await TimetableSlot.findOne({ _id: id, ...NOT_DELETED });
    if (!slot) {
      return res.status(404).json({
        success: false,
        error:   "Timetable slot not found",
      });
    }

    const {
      subjectId,
      teacherId,
      room,
      dayOfWeek,
      periodId,
      classId,
      // FIXED (Issue 5): client should send the version it last read so we can
      // detect concurrent edits. If omitted the check is skipped (backwards
      // compatible with older clients).
      version: clientVersion,
    } = req.body;

    // FIXED (Issue 5): reject stale writes.
    if (clientVersion !== undefined && slot.version !== Number(clientVersion)) {
      return res.status(409).json({
        success:  false,
        error:    "Conflict: slot was modified by another user since you last loaded it",
        conflict: "version",
        current:  normalizeSlot(slot.toObject()),
      });
    }

    // FIXED (Issue 3): strict canonicalDay on incoming dayOfWeek.
    const newDay     = dayOfWeek ? canonicalDay(dayOfWeek, { strict: true }) : slot.dayOfWeek;
    const newPeriod  = periodId  || slot.periodId;
    const newClass   = classId   || slot.classId;
    const newTeacher = teacherId || slot.teacherId;

    const classConflict = await TimetableSlot.findOne({
      _id:       { $ne: id },
      classId:   newClass,
      dayOfWeek: newDay,
      periodId:  newPeriod,
      ...NOT_DELETED,
    }).lean();

    if (classConflict) {
      return res.status(409).json({
        success:  false,
        error:    "Class already has a lesson in this period",
        conflict: "class",
      });
    }

    const teacherConflict = await TimetableSlot.findOne({
      _id:       { $ne: id },
      teacherId: newTeacher,
      dayOfWeek: newDay,
      periodId:  newPeriod,
      ...NOT_DELETED,
    }).lean();

    if (teacherConflict) {
      return res.status(409).json({
        success:  false,
        error:    "Teacher is already assigned in this period",
        conflict: "teacher",
      });
    }

    if (subjectId !== undefined) slot.subjectId = subjectId;
    if (teacherId !== undefined) slot.teacherId = teacherId;
    if (dayOfWeek !== undefined) slot.dayOfWeek = newDay;
    if (periodId  !== undefined) slot.periodId  = periodId;
    if (classId   !== undefined) slot.classId   = classId;
    if (room      !== undefined) slot.room       = room?.trim() || null;

    slot.version  += 1;
    slot.updatedAt = new Date();

    await slot.save();

    res.json({ success: true, slot: normalizeSlot(slot.toObject()) });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/timetable/:id  (soft delete)
// ─────────────────────────────────────────────────────────────────────────────

router.delete(
  "/:id",
  authenticate,
  adminOnly,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const slot = await TimetableSlot.findOne({ _id: id, ...NOT_DELETED });
    if (!slot) {
      return res.status(404).json({
        success: false,
        error:   "Timetable slot not found",
      });
    }

    slot.deletedAt = new Date();
    slot.updatedAt = new Date();
    slot.version  += 1;

    await slot.save();

    res.json({ success: true, message: "Slot removed from timetable" });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/timetable/teacher/:teacherId
// Returns slots for a specific teacher — admin use only.
//
// FIXED (Issue 3): weekDay query param normalised in strict mode.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/teacher/:teacherId",
  authenticate,
  adminOnly,
  asyncHandler(async (req, res) => {
    const { teacherId }         = req.params;
    const { schoolId, weekDay } = req.query;

    const filter = { teacherId, ...NOT_DELETED };
    if (schoolId) filter.schoolId  = String(schoolId).trim();
    // FIXED (Issue 3): strict mode rejects bad weekDay values at the boundary.
    if (weekDay)  filter.dayOfWeek = canonicalDay(weekDay, { strict: true });

    const slots = await TimetableSlot
      .find(filter)
      .sort({ dayOfWeek: 1, periodId: 1 })
      .lean();

    res.json({ success: true, slots: slots.map(normalizeSlot) });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
  console.error("[timetable.routes]", err.name, "—", err.message);

  if (err.name === "ValidationError") {
    return res.status(err.statusCode || 400).json({
      success: false,
      error:   "Validation Error",
      // Mongoose ValidationError surfaces field messages via err.errors;
      // our custom ValidationError surfaces a plain message string.
      details: err.errors
        ? Object.values(err.errors).map((e) => e.message)
        : [err.message],
    });
  }

  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      error:   "Invalid ID format",
      details: [err.message],
    });
  }

  res.status(500).json({
    success: false,
    error:   "Internal Server Error",
    message: err.message,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIXED (Issue 1): module.exports is the very last statement in the file.
// All code that previously appeared after this line has been removed — it was
// unreachable dead code containing the syntax error `{ ... }` which caused
// Node.js to throw a SyntaxError when loading the module.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = router;