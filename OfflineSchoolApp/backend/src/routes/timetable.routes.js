// backend/src/routes/timetable.routes.js
"use strict";

const express       = require("express");
const router        = express.Router();
const TimetableSlot = require("../db/models/TimetableSlot");
const User          = require("../db/models/User");
const Subject       = require("../db/models/Subject");

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

const NOT_DELETED = {
  $or: [
    { deletedAt: { $exists: false }  },
    { deletedAt: { $in: [null, ""] } },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// DAY NORMALISATION
//
// MUST match the TimetableSlot Mongoose schema enum exactly:
//   ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
//
// The previous version mapped to "monday"/"tuesday" etc. which Mongoose
// correctly rejected because those values are not in the enum.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_CANONICAL = {
  // ── full lowercase ─────────────────────────────────────────────────────────
  monday:    "MON",
  tuesday:   "TUE",
  wednesday: "WED",
  thursday:  "THU",
  friday:    "FRI",
  saturday:  "SAT",
  sunday:    "SUN",
  // ── 3-letter lowercase ─────────────────────────────────────────────────────
  mon:       "MON",
  tue:       "TUE",
  wed:       "WED",
  thu:       "THU",
  fri:       "FRI",
  sat:       "SAT",
  sun:       "SUN",
  // ── already-canonical UPPERCASE (idempotent) ───────────────────────────────
  MON:       "MON",
  TUE:       "TUE",
  WED:       "WED",
  THU:       "THU",
  FRI:       "FRI",
  SAT:       "SAT",
  SUN:       "SUN",
  // ── Title-case full names ──────────────────────────────────────────────────
  Monday:    "MON",
  Tuesday:   "TUE",
  Wednesday: "WED",
  Thursday:  "THU",
  Friday:    "FRI",
  Saturday:  "SAT",
  Sunday:    "SUN",
};

/** Values the Mongoose enum accepts — single source of truth. */
const VALID_DAYS = new Set(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);

/**
 * Converts any supported day string to its canonical uppercase 3-letter code.
 *
 * @param {string} raw
 * @param {{ strict?: boolean }} [opts]
 * @returns {string} e.g. "MON", "TUE" …
 * @throws {Error} name="ValidationError" when strict=true and value is unknown.
 */
const canonicalDay = (raw, { strict = false } = {}) => {
  if (!raw) {
    if (strict) {
      const err      = new Error(`dayOfWeek is required`);
      err.name       = "ValidationError";
      err.statusCode = 400;
      throw err;
    }
    return null;
  }

  const str      = raw.toString().trim();
  const canonical =
    DAY_CANONICAL[str] ||              // exact hit (covers UPPERCASE + Title-case)
    DAY_CANONICAL[str.toLowerCase()];  // case-insensitive fallback

  if (!canonical || !VALID_DAYS.has(canonical)) {
    if (strict) {
      const err      = new Error(`${raw} is not a valid day`);
      err.name       = "ValidationError";
      err.statusCode = 400;
      throw err;
    }
    return null;
  }

  return canonical;
};

// ─────────────────────────────────────────────────────────────────────────────
// SLOT NORMALISATION
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

const staffOnly = (req, res, next) => {
  const ALLOWED = new Set(["super_admin", "school_admin", "admin", "teacher"]);
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  if (!ALLOWED.has(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Your role "${req.user.role}" is not permitted.`,
    });
  }
  next();
};

const adminOnly = (req, res, next) => {
  const ALLOWED = new Set(["super_admin", "school_admin", "admin"]);
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  if (!ALLOWED.has(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Admin only. Your role "${req.user.role}" is not permitted.`,
    });
  }
  next();
};

const isAdminRole = (user) =>
  new Set(["super_admin", "school_admin", "admin"]).has(user?.role);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/timetable
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/",
  authenticate,
  staffOnly,
  asyncHandler(async (req, res) => {
    const { schoolId, classId } = req.query;
    let   { teacherId }         = req.query;

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
// Registered BEFORE /:id to prevent "my-schedule" matching as a Mongo ObjectId
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/my-schedule",
  authenticate,
  staffOnly,
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

    // ✅ strict=true — rejects anything not in the Mongoose enum
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
      version: clientVersion,
    } = req.body;

    // Optimistic concurrency check
    if (clientVersion !== undefined && slot.version !== Number(clientVersion)) {
      return res.status(409).json({
        success:  false,
        error:    "Conflict: slot was modified by another user since you last loaded it",
        conflict: "version",
        current:  normalizeSlot(slot.toObject()),
      });
    }

    // ✅ strict=true — rejects anything not in the Mongoose enum
    const newDay     = dayOfWeek
      ? canonicalDay(dayOfWeek, { strict: true })
      : slot.dayOfWeek;
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

module.exports = router;