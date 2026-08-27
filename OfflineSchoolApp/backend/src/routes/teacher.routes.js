// backend/src/routes/teacher.routes.js
"use strict";

const express = require("express");
const router  = express.Router();
const path    = require("path");
const fs      = require("fs");

const User              = require("../db/models/User");
const Class             = require("../db/models/Class");
const Subject           = require("../db/models/Subject");
const TeacherAssignment = require("../db/models/TeacherAssignment");

// ═════════════════════════════════════════════════════════════════════════════
// MULTER SETUP
// ═════════════════════════════════════════════════════════════════════════════

let multer;
try {
  multer = require("multer");
} catch {
  console.warn("⚠️  multer not installed — file uploads will be disabled");
}

const ALLOWED_MIMES = {
  syllabus: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
  ],
  notes: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/png",
    "text/plain",
    "text/html",
  ],
  video: [
    "video/mp4",   "video/webm",    "video/quicktime",
    "video/ogg",   "video/x-msvideo","video/x-matroska",
    "video/mpeg",  "video/3gpp",    "video/x-m4v",
    "video/mp2t",
  ],
  audio: [
    "audio/mpeg",  "audio/mp3",  "audio/ogg",
    "audio/wav",   "audio/x-wav","audio/mp4",
    "audio/x-m4a", "audio/aac",  "audio/webm",
    "audio/flac",
  ],
  image: [
    "image/jpeg", "image/jpg", "image/png",
    "image/gif",  "image/webp","image/svg+xml",
    "image/bmp",  "image/tiff",
  ],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    "application/csv",
  ],
};

const ALL_ALLOWED_MIMES = new Set(Object.values(ALLOWED_MIMES).flat());

const MIME_TO_TYPES = {};
for (const [contentType, mimes] of Object.entries(ALLOWED_MIMES)) {
  for (const mime of mimes) {
    if (!MIME_TO_TYPES[mime]) MIME_TO_TYPES[mime] = [];
    MIME_TO_TYPES[mime].push(contentType);
  }
}

const MAX_FILE_SIZES = {
  video:    500 * 1024 * 1024,
  audio:    100 * 1024 * 1024,
  image:     10 * 1024 * 1024,
  syllabus:  50 * 1024 * 1024,
  notes:     50 * 1024 * 1024,
  document:  50 * 1024 * 1024,
};

const DEFAULT_MAX_SIZE = 100 * 1024 * 1024;

let _multerInstance = null;

const getMulterInstance = () => {
  if (!multer)          return null;
  if (_multerInstance)  return _multerInstance;

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      const bodyType      = (req.body?.type || "").toLowerCase().trim();
      const inferredTypes = MIME_TO_TYPES[file.mimetype?.toLowerCase()] || [];
      const type          = bodyType || inferredTypes[0] || "document";
      const dir           = path.join(__dirname, "..", "uploads", "content", type);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      const ext  = path.extname(file.originalname).toLowerCase();
      const base = path
        .basename(file.originalname, ext)
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_\-]/g, "")
        .slice(0, 80);
      cb(null, `${Date.now()}-${base}${ext}`);
    },
  });

  const fileFilter = (req, file, cb) => {
    const fileMime = (file.mimetype || "").toLowerCase();
    const bodyType = (req.body?.type  || "").toLowerCase().trim();

    if (bodyType) {
      const allowedForType = ALLOWED_MIMES[bodyType];
      if (!allowedForType) {
        return cb(
          Object.assign(new Error(`Unknown content type "${bodyType}"`), { code: "INVALID_TYPE" }),
          false
        );
      }
      if (!allowedForType.includes(fileMime)) {
        return cb(
          Object.assign(
            new Error(
              `File type "${fileMime}" is not allowed for content type "${bodyType}". ` +
              `Allowed: ${allowedForType.join(", ")}`
            ),
            { code: "INVALID_MIME" }
          ),
          false
        );
      }
      return cb(null, true);
    }

    if (ALL_ALLOWED_MIMES.has(fileMime)) {
      console.warn(
        `[fileFilter] req.body.type not set for "${fileMime}" — accepted via permissive fallback`
      );
      return cb(null, true);
    }

    return cb(
      Object.assign(
        new Error(`File type "${fileMime}" is not permitted.`),
        { code: "INVALID_MIME" }
      ),
      false
    );
  };

  _multerInstance = multer({
    storage,
    fileFilter,
    limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  });

  return _multerInstance;
};

const multerForContent = (req, res, next) => {
  const instance = getMulterInstance();
  if (!instance) return next();

  instance.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ success: false, error: "File exceeds the maximum allowed size." });
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({ success: false, error: 'Unexpected field name. Use field name "file".' });
      }
      if (err.code === "INVALID_MIME" || err.code === "INVALID_TYPE") {
        return res.status(415).json({ success: false, error: err.message });
      }
      return res.status(400).json({ success: false, error: err.message });
    }

    if (req.file) {
      const bodyType = (req.body?.type || "").toLowerCase().trim();
      const fileMime = (req.file.mimetype || "").toLowerCase();

      if (bodyType) {
        const allowedForType = ALLOWED_MIMES[bodyType];
        if (allowedForType && !allowedForType.includes(fileMime)) {
          deleteUploadedFile(req.file.path);
          return res.status(415).json({
            success: false,
            error: `File type "${fileMime}" is not allowed for content type "${bodyType}".`,
          });
        }
      }

      const type    = bodyType || "document";
      const maxSize = MAX_FILE_SIZES[type] ?? DEFAULT_MAX_SIZE;

      if (req.file.size > maxSize) {
        deleteUploadedFile(req.file.path);
        const mb = Math.round(maxSize / 1024 / 1024);
        return res.status(413).json({
          success: false,
          error:   `File too large for type "${type}". Maximum: ${mb} MB`,
        });
      }
    }

    next();
  });
};

const deleteUploadedFile = (filePath) => {
  if (!filePath) return;
  fs.unlink(filePath, (e) => {
    if (e && e.code !== "ENOENT") console.warn("[deleteUploadedFile]", e.message);
  });
};

const buildFileUrl = (req, absolutePath) => {
  if (!absolutePath) return null;
  const BASE_URL = process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
  const relative = absolutePath.replace(/\\/g, "/").split("uploads/")[1];
  return relative ? `${BASE_URL}/uploads/${relative}` : null;
};

// ═════════════════════════════════════════════════════════════════════════════
// LAZY MODEL LOADERS
// ═════════════════════════════════════════════════════════════════════════════

const lazyModel = (modulePath, label) => {
  let cached    = null;
  let attempted = false;
  return () => {
    if (!attempted) {
      attempted = true;
      try { cached = require(modulePath); }
      catch { console.warn(`⚠️ ${label} model not found at "${modulePath}"`); }
    }
    return cached;
  };
};

const getStudent       = lazyModel("../db/models/Student",       "Student");
const getTimetableSlot = lazyModel("../db/models/TimetableSlot", "TimetableSlot");
const getPeriod        = lazyModel("../db/models/Period",        "Period");
const getAttendance    = lazyModel("../db/models/Attendance",    "Attendance");
const getSubmission    = lazyModel("../db/models/Submission",    "Submission");
const getAssignment    = lazyModel("../db/models/Assignment",    "Assignment");
const getQuiz          = lazyModel("../db/models/Quiz",          "Quiz");
const getContent       = lazyModel("../db/models/Content",       "Content");
const getExam          = lazyModel("../db/models/Exam",          "Exam");
const getExamMark      = lazyModel("../db/models/ExamMark",      "ExamMark");
const getResult        = lazyModel("../db/models/Result",        "Result");

// ═════════════════════════════════════════════════════════════════════════════
// ASYNC HANDLER
// ═════════════════════════════════════════════════════════════════════════════

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ═════════════════════════════════════════════════════════════════════════════
// TEACHER GUARD
// ═════════════════════════════════════════════════════════════════════════════

// Every route here answers "what am I teaching?" — my classes, my register,
// my homework. The bursar teaches nothing, so TEACHING_ROLES is the whole set;
// admins stay in because they cover for absent staff and need to see the same
// screens to support them.
const { TEACHING_ROLES } = require("../config/roles");

const TEACHER_ROLES = new Set(TEACHING_ROLES);

const teacherOnly = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Not authenticated" });
  if (!TEACHER_ROLES.has(req.user.role)) {
    console.warn(`⛔ Teacher access denied for role "${req.user.role}"`);
    return res.status(403).json({
      message: `Teacher access only. Your role "${req.user.role}" is not permitted.`,
    });
  }
  return next();
};

router.use(teacherOnly);

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const resolveTeacherId = (req) =>
  req.user?._id || req.user?.id || req.user?.userId || null;

/**
 * FIX #CACHE — resolveClassIds made a DB round-trip for every class ID on
 * every request. We now cache results in a module-level Map with a 5-minute
 * TTL so repeated requests for the same class ID (which is the common case)
 * never hit MongoDB more than once per TTL window.
 */
const _classIdCache    = new Map(); // key → { ids: string[], expiresAt: number }
const CLASS_ID_CACHE_TTL_MS = 5 * 60 * 1000;

const resolveClassIds = async (classId) => {
  if (!classId) return [];

  const input   = String(classId).trim();
  const cached  = _classIdCache.get(input);
  if (cached && Date.now() < cached.expiresAt) return cached.ids;

  const ids = new Set([input]);

  try {
    const cls = await Class.findOne({
      $or: [
        { _id:        input },
        { id:         input },
        { uuid:       input },
        { externalId: input },
        { legacyId:   input },
      ],
    }).select("_id id uuid externalId legacyId name").lean();

    if (cls) {
      if (cls._id)        ids.add(String(cls._id));
      if (cls.id)         ids.add(String(cls.id));
      if (cls.uuid)       ids.add(String(cls.uuid));
      if (cls.externalId) ids.add(String(cls.externalId));
      if (cls.legacyId)   ids.add(String(cls.legacyId));
      console.log(`[resolveClassIds] "${input}" → ${cls.name} → [${[...ids].join(", ")}]`);
    } else {
      console.warn(`[resolveClassIds] no Class found for "${input}" — using as-is`);
    }
  } catch (err) {
    console.warn("[resolveClassIds] lookup failed:", err.message);
  }

  const result = [...ids];
  _classIdCache.set(input, { ids: result, expiresAt: Date.now() + CLASS_ID_CACHE_TTL_MS });
  return result;
};

/**
 * FIX #SCOPE — getTeacherScope previously ran findOne({}) on TeacherAssignment
 * just to detect whether the schema uses "teacher" or "teacherId". That probe
 * fires on every request and adds a round-trip even when the collection is
 * empty. We now always query both field names using $or which works regardless
 * of schema version, and we removed the findOne probe entirely.
 */
const getTeacherScope = async (teacherId, schoolId) => {
  const subjectIds = new Set();
  const classIds   = new Set();
  const tid        = String(teacherId);

  try {
    const rows = await TeacherAssignment.find({
      $or: [{ teacher: tid }, { teacherId: tid }],
    })
      .select("subject subjectId subject_id class classId class_id")
      .lean();

    console.log(`[getTeacherScope] TeacherAssignment rows for ${tid}: ${rows.length}`);

    for (const r of rows) {
      const sId = String(r.subject || r.subjectId || r.subject_id || "");
      if (sId && sId !== "null" && sId !== "undefined") subjectIds.add(sId);
      const cId = String(r.class || r.classId || r.class_id || "");
      if (cId && cId !== "null" && cId !== "undefined") classIds.add(cId);
    }
  } catch (e) {
    console.warn("[getTeacherScope] TeacherAssignment error:", e.message);
  }

  try {
    const rows = await Subject.find({
      $or: [{ teacher_id: tid }, { teacherId: tid }, { teacher: tid }],
    })
      .select("_id class classId class_id")
      .lean();

    for (const r of rows) {
      subjectIds.add(String(r._id));
      const cId = String(r.class || r.classId || r.class_id || "");
      if (cId && cId !== "null" && cId !== "undefined") classIds.add(cId);
    }
  } catch (e) {
    console.warn("[getTeacherScope] Subject error:", e.message);
  }

  console.log(
    `[getTeacherScope] subjects: [${[...subjectIds].join(", ")}] ` +
    `classes: [${[...classIds].join(", ")}]`
  );

  return { subjectIds: [...subjectIds], classIds: [...classIds] };
};

const queryStudentsByClassIds = async (S, targetClassIds, schoolId) => {
  if (!targetClassIds.length) return [];

  const query = {
    $or: [
      { classId:  { $in: targetClassIds } },
      { class_id: { $in: targetClassIds } },
      { class:    { $in: targetClassIds } },
    ],
  };

  if (schoolId) {
    query.$and = [{
      $or: [
        { schoolId },
        { school_id: schoolId },
        { schoolId: { $exists: false } },
      ],
    }];
  }

  const students = await S.find(query)
    .select(
      "_id id name studentName fullName admissionNo admissionNumber " +
      "regNo email classId class_id class isActive schoolId " +
      "rollNumber roll_number dateOfBirth dob gender"
    )
    .sort({ name: 1, studentName: 1 })
    .lean();

  console.log(
    `[queryStudentsByClassIds] classIds=[${targetClassIds.join(",")}] → ${students.length} students`
  );

  return students;
};

const normaliseStudent = (s) => ({
  _id:         String(s._id || s.id || ""),
  id:          String(s._id || s.id || ""),
  studentName: s.studentName || s.name || s.fullName || "Unknown",
  name:        s.studentName || s.name || s.fullName || "Unknown",
  admissionNo: s.admissionNo || s.admissionNumber || s.regNo || null,
  email:       s.email       || null,
  classId:     String(s.classId || s.class_id || s.class || ""),
  class_id:    String(s.classId || s.class_id || s.class || ""),
  rollNumber:  s.rollNumber  || s.roll_number || null,
  gender:      s.gender      || null,
  dateOfBirth: s.dateOfBirth || s.dob         || null,
  isActive:    s.isActive    ?? true,
  schoolId:    s.schoolId    || null,
});

const isAssignedToClass = (resolvedIds, teacherClassIds) => {
  const teacherSet  = new Set(teacherClassIds.map(String));
  const resolvedSet = new Set(resolvedIds);
  return (
    [...resolvedIds].some((id) => teacherSet.has(id)) ||
    [...teacherClassIds].some((id) => resolvedSet.has(id))
  );
};

const todayISO       = () => new Date().toISOString().split("T")[0];
const sevenDaysFromNow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().split("T")[0];
};

const getTodayDayName = () => {
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return days[new Date().getDay()];
};

const getTodayDayNameQuery = () => {
  const codes = {
    0: ["SUN", "Sunday"],    1: ["MON", "Monday"],
    2: ["TUE", "Tuesday"],   3: ["WED", "Wednesday"],
    4: ["THU", "Thursday"],  5: ["FRI", "Friday"],
    6: ["SAT", "Saturday"],
  };
  return { $in: codes[new Date().getDay()] || [] };
};

const formatTime12 = (time24) => {
  if (!time24) return "";
  try {
    const [h, m] = time24.split(":");
    const hour   = parseInt(h, 10);
    const ampm   = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${m} ${ampm}`;
  } catch { return time24; }
};

const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const match = String(timeStr).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return 0;
  let hours  = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);
  const ampm = (match[3] || "").toUpperCase();
  if (ampm === "PM" && hours !== 12) hours += 12;
  if (ampm === "AM" && hours === 12) hours = 0;
  return hours * 60 + mins;
};

const computeSlotStatus = (startTime, endTime) => {
  const now        = new Date();
  const currentMin = now.getHours() * 60 + now.getMinutes();
  const startMin   = timeToMinutes(startTime);
  const endMin     = timeToMinutes(endTime);
  if (endMin > 0 && currentMin > endMin)                              return "past";
  if (startMin > 0 && currentMin >= startMin && currentMin <= endMin) return "current";
  return "upcoming";
};

const enrichTimetableSlots = async (rawSlots) => {
  if (!rawSlots.length) return [];

  const subjectIds = [...new Set(rawSlots.map((s) => String(s.subjectId)).filter(Boolean))];
  const classIds   = [...new Set(rawSlots.map((s) => String(s.classId)).filter(Boolean))];
  const periodIds  = [...new Set(rawSlots.map((s) => String(s.periodId)).filter(Boolean))];
  const P          = getPeriod();

  const [subjects, classes, periods] = await Promise.all([
    subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select("_id name code").lean() : [],
    classIds.length   ? Class.find({ _id: { $in: classIds } }).select("_id name level section").lean() : [],
    P && periodIds.length
      ? P.find({ _id: { $in: periodIds } }).select("_id name startTime endTime sortOrder").lean()
      : [],
  ]);

  const subjectMap = new Map(subjects.map((s) => [String(s._id), s]));
  const classMap   = new Map(classes.map((c)  => [String(c._id), c]));
  const periodMap  = new Map(periods.map((p)  => [String(p._id), p]));

  return rawSlots.map((s) => {
    const subject = subjectMap.get(String(s.subjectId)) || {};
    const cls     = classMap.get(String(s.classId))     || {};
    const period  = periodMap.get(String(s.periodId))   || {};
    return {
      _id:          String(s._id),
      dayOfWeek:    s.dayOfWeek,
      room:         s.room        || null,
      subjectId:    s.subjectId,
      subjectName:  subject.name  || "Unknown Subject",
      subjectCode:  subject.code  || null,
      classId:      s.classId,
      className:    cls.name      || "Unknown Class",
      classLevel:   cls.level     || null,
      classSection: cls.section   || null,
      periodId:     s.periodId,
      periodName:   period.name   || "Period",
      startTime:    formatTime12(period.startTime),
      endTime:      formatTime12(period.endTime),
      sortOrder:    period.sortOrder ?? 0,
    };
  });
};

const DAY_ORDER = {
  MON: 1, MONDAY: 1,    TUE: 2, TUESDAY: 2,
  WED: 3, WEDNESDAY: 3, THU: 4, THURSDAY: 4,
  FRI: 5, FRIDAY: 5,    SAT: 6, SATURDAY: 6,
  SUN: 7, SUNDAY: 7,
};

const sortSlotsByTime = (slots) =>
  slots.sort((a, b) => {
    const dayA = DAY_ORDER[String(a.dayOfWeek || "").toUpperCase()] ?? 99;
    const dayB = DAY_ORDER[String(b.dayOfWeek || "").toUpperCase()] ?? 99;
    if (dayA !== dayB) return dayA - dayB;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  });

const buildGroupedSubjects = async (subjectIds, classIds) => {
  const subjects = subjectIds.length > 0
    ? await Subject.find({ _id: { $in: subjectIds } })
        .select("name code class classId schoolId")
        .lean()
    : [];

  const classRecords = classIds.length > 0
    ? await Class.find({ _id: { $in: classIds } })
        .select("name level section schoolId isActive")
        .lean()
    : [];

  const classMap = new Map(classRecords.map((c) => [String(c._id), c]));
  const grouped  = new Map();

  for (const cls of classRecords) {
    const cid = String(cls._id);
    grouped.set(cid, {
      classId:      cid,
      className:    cls.name    || "Unknown Class",
      level:        cls.level   || null,
      section:      cls.section || null,
      schoolId:     cls.schoolId || null,
      isActive:     cls.isActive ?? true,
      subjects:     [],
      subjectCount: 0,
    });
  }

  for (const s of subjects) {
    const cid      = (s.class || s.classId) ? String(s.class || s.classId) : null;
    const classObj = cid ? classMap.get(cid) || null : null;
    const enriched = {
      _id:      String(s._id),
      name:     s.name,
      code:     s.code     || null,
      classId:  cid,
      class:    cid,
      schoolId: s.schoolId || null,
    };

    if (cid && grouped.has(cid)) {
      grouped.get(cid).subjects.push(enriched);
      grouped.get(cid).subjectCount++;
    } else if (cid) {
      grouped.set(cid, {
        classId:      cid,
        className:    classObj?.name    || `Class …${cid.slice(-4)}`,
        level:        classObj?.level   || null,
        section:      classObj?.section || null,
        schoolId:     classObj?.schoolId || null,
        isActive:     classObj?.isActive ?? true,
        subjects:     [enriched],
        subjectCount: 1,
      });
    } else {
      if (!grouped.has("__unassigned__")) {
        grouped.set("__unassigned__", {
          classId: null, className: "Unassigned",
          level: null, section: null, schoolId: null, isActive: true,
          subjects: [], subjectCount: 0,
        });
      }
      grouped.get("__unassigned__").subjects.push(enriched);
      grouped.get("__unassigned__").subjectCount++;
    }
  }

  for (const g of grouped.values()) {
    g.subjects.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  return [...grouped.values()].sort((a, b) =>
    (a.className || "").localeCompare(b.className || "")
  );
};

const normaliseContentItem = (item) => {
  const subjectId   = item.subjectId?._id  || item.subjectId  || null;
  const subjectName = item.subjectId?.name || item.subjectName || null;
  const classId     = item.classId?._id    || item.classId    || null;
  const className   = item.classId?.name   || item.className  || null;

  const classIds   = item.classIds?.length  ? item.classIds  : classId   ? [String(classId)]   : [];
  const classNames = item.classNames?.length ? item.classNames : className ? [String(className)] : [];

  return {
    _id:           String(item._id || ""),
    id:            String(item._id || ""),
    title:         item.title         || "Untitled",
    description:   item.description   || "",
    type:          item.type?.toLowerCase() || "document",
    fileUrl:       item.fileUrl       || item.url      || null,
    fileName:      item.fileName      || item.title    || null,
    fileSize:      item.fileSize      || item.size     || 0,
    mimeType:      item.mimeType      || null,
    thumbnail:     item.thumbnail     || null,
    subjectId:     subjectId  ? String(subjectId)  : null,
    subjectName:   subjectName || null,
    classIds,
    classNames,
    teacherId:     String(item.teacherId || ""),
    status:        item.status        || "active",
    viewCount:     item.viewCount     || 0,
    downloadCount: item.downloadCount || 0,
    createdAt:     item.createdAt     || null,
    updatedAt:     item.updatedAt     || null,
  };
};

/**
 * FIX #SCOPE — Shared helper that resolves the teacher scope and all class
 * IDs in one place. Routes that previously called getTeacherScope followed
 * by Promise.all(classIds.map(resolveClassIds)) now call this instead,
 * eliminating duplicated resolution logic across five route handlers.
 */
const resolveTeacherScopeAndClassIds = async (teacherId, schoolId) => {
  const scope = await getTeacherScope(teacherId, schoolId);
  const resolved = await Promise.all(scope.classIds.map((id) => resolveClassIds(id)));
  const allClassIds = [...new Set(resolved.flat())];
  return { ...scope, allClassIds };
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/me
// ═════════════════════════════════════════════════════════════════════════════

router.get("/me", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  if (!teacherId)
    return res.status(400).json({ message: "Could not resolve teacher ID" });

  const teacher = await User.findById(teacherId)
    .select("-password -tempPassword")
    .lean();
  if (!teacher)
    return res.status(404).json({ message: "Teacher not found" });

  return res.json({ success: true, data: teacher });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/profile
// ═════════════════════════════════════════════════════════════════════════════

router.get("/profile", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  if (!teacherId) {
    return res.status(400).json({ success: false, error: "Could not resolve teacher ID" });
  }

  const schoolId = req.user?.schoolId || null;

  const teacher = await User.findById(teacherId)
    .select("-password -passwordHash -passwordSalt -tempPassword -__v")
    .lean();
  if (!teacher) {
    return res.status(404).json({ success: false, error: "Teacher not found" });
  }

  const assignmentFilter = {
    $or: [{ teacherId: String(teacherId) }, { teacher: String(teacherId) }],
  };
  if (schoolId) {
    assignmentFilter.$and = [{
      $or: [{ schoolId }, { school_id: schoolId }, { schoolId: { $exists: false } }],
    }];
  }

  const assignments = await TeacherAssignment.find(assignmentFilter).lean();

  const classIds = [...new Set(
    assignments.map((a) => a.classId || a.class_id || a.class).filter(Boolean).map(String)
  )];
  const subjectIds = [...new Set(
    assignments.map((a) => a.subjectId || a.subject_id || a.subject).filter(Boolean).map(String)
  )];

  const [classes, subjects] = await Promise.all([
    classIds.length
      ? Class.find({ _id: { $in: classIds } }).select("_id name level section").lean()
      : [],
    subjectIds.length
      ? Subject.find({ _id: { $in: subjectIds } }).select("_id name code").lean()
      : [],
  ]);

  const classMap   = Object.fromEntries(classes.map((c)  => [String(c._id), c]));
  const subjectMap = Object.fromEntries(subjects.map((s) => [String(s._id), s]));

  const enrichedAssignments = assignments.map((a) => {
    const cId = String(a.classId   || a.class_id   || a.class   || "");
    const sId = String(a.subjectId || a.subject_id || a.subject || "");
    return {
      ...a,
      classId:   cId || null,
      subjectId: sId || null,
      class:   cId ? (classMap[cId]   || { _id: cId }) : null,
      subject: sId ? (subjectMap[sId] || { _id: sId }) : null,
    };
  });

  return res.json({
    success:     true,
    teacher,
    assignments: enrichedAssignments,
    summary: {
      totalAssignments: assignments.length,
      totalClasses:     classIds.length,
      totalSubjects:    subjectIds.length,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/my-assignments
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-assignments", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  if (!teacherId) return res.status(401).json({ message: "Not authenticated" });

  const tid      = String(teacherId);
  const schoolId = req.user?.schoolId || null;

  const filter = { $or: [{ teacher: tid }, { teacherId: tid }] };
  if (schoolId) {
    filter.$and = [{
      $or: [{ schoolId }, { school_id: schoolId }, { schoolId: { $exists: false } }],
    }];
  }

  const assignments = await TeacherAssignment.find(filter).sort({ createdAt: -1 }).lean();

  if (!assignments.length) {
    return res.json({ success: true, assignments: [], data: [], count: 0 });
  }

  const subjectIds = [...new Set(
    assignments.map((a) => String(a.subject || a.subjectId || a.subject_id || "")).filter(Boolean)
  )];
  const classIds = [...new Set(
    assignments.map((a) => String(a.class || a.classId || a.class_id || "")).filter(Boolean)
  )];

  const [subjects, classes] = await Promise.all([
    subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select("name code").lean() : [],
    classIds.length   ? Class.find({ _id: { $in: classIds } }).select("name level section").lean() : [],
  ]);

  const subjectMap = new Map(subjects.map((s) => [String(s._id), s]));
  const classMap   = new Map(classes.map((c)  => [String(c._id), c]));

  const normalized = assignments.map((a) => {
    const cId         = String(a.class || a.classId || a.class_id || "");
    const sId         = String(a.subject || a.subjectId || a.subject_id || "");
    const subjectData = sId ? subjectMap.get(sId) : null;
    const classData   = cId ? classMap.get(cId)   : null;

    return {
      _id:       a._id,
      id:        a._id,
      schoolId:  a.schoolId || schoolId,
      teacherId: tid,
      classId:   cId || null,
      subjectId: sId || null,
      teacher:   { _id: tid },
      class: classData
        ? { _id: cId, name: classData.name, level: classData.level, section: classData.section }
        : cId ? { _id: cId } : null,
      subject: subjectData
        ? { _id: sId, name: subjectData.name, code: subjectData.code }
        : sId ? { _id: sId } : null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  });

  return res.json({ success: true, assignments: normalized, data: normalized, count: normalized.length });
}));

// FIX #ALIAS — The original used router.handle() which is an internal Express
// API not designed for public use. The correct pattern for a route alias is a
// dedicated handler that calls the same logic, or a simple redirect. Here we
// use a dedicated handler that re-uses the same async function.
router.get("/assignments", asyncHandler(async (req, res) => {
  // Forward to my-assignments handler by re-using the same logic directly.
  // We avoid req.url mutation or router.handle() which are internal APIs.
  const teacherId = resolveTeacherId(req);
  if (!teacherId) return res.status(401).json({ message: "Not authenticated" });

  const tid      = String(teacherId);
  const schoolId = req.user?.schoolId || null;

  const filter = { $or: [{ teacher: tid }, { teacherId: tid }] };
  if (schoolId) {
    filter.$and = [{
      $or: [{ schoolId }, { school_id: schoolId }, { schoolId: { $exists: false } }],
    }];
  }

  const assignments = await TeacherAssignment.find(filter).sort({ createdAt: -1 }).lean();

  if (!assignments.length) {
    return res.json({ success: true, assignments: [], data: [], count: 0 });
  }

  const subjectIds = [...new Set(
    assignments.map((a) => String(a.subject || a.subjectId || a.subject_id || "")).filter(Boolean)
  )];
  const classIds = [...new Set(
    assignments.map((a) => String(a.class || a.classId || a.class_id || "")).filter(Boolean)
  )];

  const [subjects, classes] = await Promise.all([
    subjectIds.length ? Subject.find({ _id: { $in: subjectIds } }).select("name code").lean() : [],
    classIds.length   ? Class.find({ _id: { $in: classIds } }).select("name level section").lean() : [],
  ]);

  const subjectMap = new Map(subjects.map((s) => [String(s._id), s]));
  const classMap   = new Map(classes.map((c)  => [String(c._id), c]));

  const normalized = assignments.map((a) => {
    const cId         = String(a.class || a.classId || a.class_id || "");
    const sId         = String(a.subject || a.subjectId || a.subject_id || "");
    const subjectData = sId ? subjectMap.get(sId) : null;
    const classData   = cId ? classMap.get(cId)   : null;

    return {
      _id:       a._id,
      id:        a._id,
      schoolId:  a.schoolId || schoolId,
      teacherId: tid,
      classId:   cId || null,
      subjectId: sId || null,
      teacher:   { _id: tid },
      class: classData
        ? { _id: cId, name: classData.name, level: classData.level, section: classData.section }
        : cId ? { _id: cId } : null,
      subject: subjectData
        ? { _id: sId, name: subjectData.name, code: subjectData.code }
        : sId ? { _id: sId } : null,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  });

  return res.json({ success: true, assignments: normalized, data: normalized, count: normalized.length });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/stats/summary
// ═════════════════════════════════════════════════════════════════════════════

router.get("/stats/summary", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  if (!teacherId)
    return res.status(400).json({ message: "Could not resolve teacher ID" });

  const schoolId = req.user?.schoolId || null;
  const today    = todayISO();
  const weekEnd  = sevenDaysFromNow();
  const dayQuery = getTodayDayNameQuery();

  // FIX #SCOPE — use the shared helper that resolves and caches class IDs
  const { subjectIds, classIds, allClassIds } =
    await resolveTeacherScopeAndClassIds(teacherId, schoolId);

  const [
    totalStudents,
    todayClassCount,
    contentUploads,
    activeQuizzes,
    activeHomework,
    pendingGrading,
    upcomingDeadlines,
    upcomingExams,
    todayAttendanceMissing,
    newSubmissions,
    activeExams,
    pendingMarksEntry,
    rejectedSubmissions,
    submittedMarks,
    approvedMarks,
  ] = await Promise.all([
    (async () => {
      try {
        const S = getStudent();
        if (!S || !allClassIds.length) return 0;
        return await S.countDocuments({
          $or: [{ classId: { $in: allClassIds } }, { class_id: { $in: allClassIds } }, { class: { $in: allClassIds } }],
          isActive: { $ne: false },
        });
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const T = getTimetableSlot();
        return T ? await T.countDocuments({ teacherId: String(teacherId), dayOfWeek: dayQuery, deletedAt: null }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const C = getContent();
        return C ? await C.countDocuments({ teacherId: String(teacherId) }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const Q = getQuiz();
        return Q ? await Q.countDocuments({ teacherId: String(teacherId) }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const A = getAssignment();
        return A ? await A.countDocuments({ teacherId: String(teacherId) }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const Sub = getSubmission();
        return Sub ? await Sub.countDocuments({ teacherId: String(teacherId), status: "pending" }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const A = getAssignment();
        return A ? await A.countDocuments({ teacherId: String(teacherId), dueDate: { $gte: new Date(today), $lte: new Date(weekEnd) } }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const E = getExam();
        return E ? await E.countDocuments({ teacherId: String(teacherId), examDate: { $gte: new Date(today), $lte: new Date(weekEnd) } }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const T   = getTimetableSlot();
        const Att = getAttendance();
        if (!T || !Att) return 0;
        const slots = await T.find({ teacherId: String(teacherId), dayOfWeek: dayQuery, deletedAt: null }).select("classId").lean();
        if (!slots.length) return 0;
        const slotClassIds = [...new Set(slots.map((s) => String(s.classId)))];
        const markedCount  = await Att.countDocuments({ teacherId: String(teacherId), date: today, classId: { $in: slotClassIds } });
        return Math.max(0, slotClassIds.length - markedCount);
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const Sub = getSubmission();
        return Sub ? await Sub.countDocuments({ teacherId: String(teacherId), status: "new" }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const E = getExam();
        return E ? await E.countDocuments({ teacherId: String(teacherId), $or: [{ status: "active" }, { status: { $exists: false } }, { status: null }] }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const E  = getExam();
        const EM = getExamMark();
        if (!E || !subjectIds.length) return 0;
        if (EM) {
          const submittedIds = await EM.distinct("examId", { teacherId: String(teacherId), status: { $in: ["submitted", "approved"] } });
          return await E.countDocuments({ subjectId: { $in: subjectIds }, _id: { $nin: submittedIds } });
        }
        return await E.countDocuments({ subjectId: { $in: subjectIds }, marksEntered: { $ne: true } });
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const EM = getExamMark();
        return EM ? await EM.countDocuments({ teacherId: String(teacherId), status: "rejected" }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const EM = getExamMark();
        return EM ? await EM.countDocuments({ teacherId: String(teacherId), status: "submitted" }) : 0;
      } catch { return 0; }
    })(),
    (async () => {
      try {
        const EM = getExamMark();
        return EM ? await EM.countDocuments({ teacherId: String(teacherId), status: "approved" }) : 0;
      } catch { return 0; }
    })(),
  ]);

  let todayClasses = [];
  try {
    const T = getTimetableSlot();
    if (T) {
      const rawSlots = await T.find({ teacherId: String(teacherId), dayOfWeek: dayQuery, deletedAt: null }).lean();
      const enriched = await enrichTimetableSlots(rawSlots);
      sortSlotsByTime(enriched);
      todayClasses = enriched.map((s) => ({
        slotId:      s._id,
        subjectName: s.subjectName,
        className:   s.className,
        periodName:  s.periodName,
        startTime:   s.startTime,
        endTime:     s.endTime,
        room:        s.room,
        status:      computeSlotStatus(s.startTime, s.endTime),
      }));
    }
  } catch (e) {
    console.warn("stats/summary timetable error:", e.message);
  }

  const stats = {
    assignedSubjects: subjectIds.length,
    assignedClasses:  classIds.length,
    totalStudents, todayClassCount, contentUploads, activeQuizzes,
    activeHomework, pendingGrading, upcomingDeadlines, upcomingExams,
    todayAttendanceMissing, newSubmissions, activeExams, pendingMarksEntry,
    rejectedSubmissions, submittedMarks, approvedMarks, todayClasses,
  };

  console.log("📊 Teacher stats:", stats);
  return res.json({ success: true, summary: stats, ...stats });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/my-workload
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-workload", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  if (!teacherId)
    return res.status(400).json({ message: "Could not resolve teacher ID" });

  const schoolId = req.user?.schoolId || null;
  const dayName  = getTodayDayName();
  const dayQuery = getTodayDayNameQuery();

  const { subjectIds, classIds } = await getTeacherScope(teacherId, schoolId);
  const groupedSubjects          = await buildGroupedSubjects(subjectIds, classIds);

  const subjects = groupedSubjects.flatMap((g) => g.subjects);
  const classes  = groupedSubjects
    .filter((g) => g.classId)
    .map(({ classId, className, level, section, schoolId: sid, isActive }) => ({
      _id: classId, name: className, level, section, schoolId: sid, isActive,
    }));

  let todayClasses = [];
  try {
    const T = getTimetableSlot();
    if (T) {
      const rawSlots = await T.find({ teacherId: String(teacherId), dayOfWeek: dayQuery, deletedAt: null }).lean();
      const enriched = await enrichTimetableSlots(rawSlots);
      sortSlotsByTime(enriched);
      todayClasses = enriched.map((s) => ({
        slotId:      s._id,
        subjectName: s.subjectName,
        className:   s.className,
        periodName:  s.periodName,
        startTime:   s.startTime,
        endTime:     s.endTime,
        room:        s.room,
        status:      computeSlotStatus(s.startTime, s.endTime),
      }));
    }
  } catch (e) {
    console.warn("my-workload timetable error:", e.message);
  }

  let pendingMarksEntry = 0, rejectedSubmissions = 0;
  try {
    const EM = getExamMark();
    if (EM) {
      [pendingMarksEntry, rejectedSubmissions] = await Promise.all([
        (async () => {
          const E = getExam();
          if (!E || !subjectIds.length) return 0;
          const submittedIds = await EM.distinct("examId", {
            teacherId: String(teacherId),
            status:    { $in: ["submitted", "approved"] },
          });
          return await E.countDocuments({ subjectId: { $in: subjectIds }, _id: { $nin: submittedIds } });
        })(),
        EM.countDocuments({ teacherId: String(teacherId), status: "rejected" }),
      ]);
    }
  } catch (e) {
    console.warn("my-workload marks error:", e.message);
  }

  return res.json({
    success: true,
    data: {
      teacherId:        String(teacherId),
      subjectsByClass:  groupedSubjects,
      assignedSubjects: subjects,
      assignedClasses:  classes,
      todayClasses,
      pendingMarksEntry,
      rejectedSubmissions,
      day:              dayName,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/my-subjects  &  GET /teacher/my-subjects/by-class
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-subjects/by-class", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const schoolId  = req.user?.schoolId || null;

  const { subjectIds, classIds } = await getTeacherScope(teacherId, schoolId);
  const groupedSubjects          = await buildGroupedSubjects(subjectIds, classIds);

  return res.json({
    success:         true,
    subjectsByClass: groupedSubjects,
    totalClasses:    groupedSubjects.filter((g) => g.classId).length,
    totalSubjects:   subjectIds.length,
  });
}));

router.get("/my-subjects", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const schoolId  = req.user?.schoolId || null;
  const grouped   = req.query.grouped === "true";

  const { subjectIds, classIds } = await getTeacherScope(teacherId, schoolId);
  const groupedSubjects          = await buildGroupedSubjects(subjectIds, classIds);

  if (grouped) {
    return res.json({
      success:         true,
      subjectsByClass: groupedSubjects,
      totalClasses:    groupedSubjects.filter((g) => g.classId).length,
      totalSubjects:   subjectIds.length,
    });
  }

  const flatSubjects = groupedSubjects.flatMap((g) => g.subjects);
  return res.json({
    success:         true,
    subjects:        flatSubjects,
    subjectsByClass: groupedSubjects,
    totalClasses:    groupedSubjects.filter((g) => g.classId).length,
    totalSubjects:   flatSubjects.length,
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/my-classes
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-classes", asyncHandler(async (req, res) => {
  const teacherId    = resolveTeacherId(req);
  const schoolId     = req.user?.schoolId || null;
  const { classIds } = await getTeacherScope(teacherId, schoolId);

  const classes = classIds.length > 0
    ? await Class.find({ _id: { $in: classIds } }).select("name level section schoolId isActive").lean()
    : [];

  return res.json({ success: true, classes });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/my-students  &  GET /teacher/students
// ═════════════════════════════════════════════════════════════════════════════

const handleStudentsRequest = asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const schoolId  = req.user?.schoolId || null;
  const S         = getStudent();

  if (!S) return res.json({ success: true, students: [], count: 0 });

  const { classIds } = await getTeacherScope(teacherId, schoolId);
  if (!classIds.length) return res.json({ success: true, students: [], count: 0 });

  const { classId: queryClassId } = req.query;
  let targetClassIds;

  if (queryClassId) {
    const resolvedIds = await resolveClassIds(queryClassId);
    if (!isAssignedToClass(resolvedIds, classIds)) {
      console.warn(`[my-students] classId "${queryClassId}" not assigned to teacher ${teacherId}`);
      return res.json({ success: true, students: [], count: 0 });
    }
    targetClassIds = resolvedIds;
  } else {
    const resolved = await Promise.all(classIds.map((id) => resolveClassIds(id)));
    targetClassIds = [...new Set(resolved.flat())];
  }

  const students = await queryStudentsByClassIds(S, targetClassIds, schoolId);
  return res.json({ success: true, count: students.length, students: students.map(normaliseStudent) });
});

router.get("/my-students", handleStudentsRequest);
router.get("/students",    handleStudentsRequest);

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/my-timetable
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-timetable", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const T         = getTimetableSlot();

  if (!T) return res.json({ success: true, slots: [] });

  const filter = { teacherId: String(teacherId), deletedAt: null };
  if (req.query.dayOfWeek) filter.dayOfWeek = req.query.dayOfWeek;

  const rawSlots = await T.find(filter).lean();
  const enriched = await enrichTimetableSlots(rawSlots);
  sortSlotsByTime(enriched);

  return res.json({ success: true, slots: enriched });
}));

// ═════════════════════════════════════════════════════════════════════════════
// ATTENDANCE
// ═════════════════════════════════════════════════════════════════════════════

router.post("/attendance/mark", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const Att       = getAttendance();

  if (!Att) return res.status(503).json({ message: "Attendance model not available" });

  const { classId, date, records } = req.body;
  if (!classId || !date || !Array.isArray(records) || !records.length) {
    return res.status(400).json({ message: "classId, date, and records[] are required" });
  }

  const schoolId     = req.user?.schoolId || null;
  const { classIds } = await getTeacherScope(teacherId, schoolId);
  const resolvedIds  = await resolveClassIds(String(classId).trim());

  if (!isAssignedToClass(resolvedIds, classIds)) {
    return res.status(403).json({ message: "You are not assigned to this class" });
  }

  const classIdStr = String(classId).trim();
  const dateStr    = String(date).split("T")[0];
  const saved      = [], failed = [];

  for (const r of records) {
    try {
      const doc = await Att.findOneAndUpdate(
        { teacherId: String(teacherId), classId: classIdStr, studentId: String(r.studentId), date: dateStr },
        { teacherId: String(teacherId), classId: classIdStr, studentId: String(r.studentId), date: dateStr, status: r.status || "present", schoolId },
        { upsert: true, new: true }
      );
      saved.push(doc._id);
    } catch (e) {
      failed.push({ studentId: r.studentId, reason: e.message });
    }
  }

  return res.json({ success: true, message: `Attendance saved: ${saved.length}, failed: ${failed.length}`, saved, failed });
}));

router.get("/attendance/status", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const Att       = getAttendance();

  if (!Att) return res.json({ success: true, records: [] });

  const { classId, date } = req.query;
  if (!classId || !date) return res.status(400).json({ message: "classId and date are required" });

  const schoolId     = req.user?.schoolId || null;
  const { classIds } = await getTeacherScope(teacherId, schoolId);
  const resolvedIds  = await resolveClassIds(String(classId).trim());

  if (!isAssignedToClass(resolvedIds, classIds)) {
    return res.status(403).json({ message: "You are not assigned to this class" });
  }

  const records = await Att.find({
    teacherId: String(teacherId),
    classId:   String(classId).trim(),
    date:      String(date).split("T")[0],
  }).lean();

  return res.json({ success: true, records });
}));

// ═════════════════════════════════════════════════════════════════════════════
// EXAMS & MARKS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-exams", asyncHandler(async (req, res) => {
  const teacherId  = resolveTeacherId(req);
  const E          = getExam();

  if (!E) return res.json({ success: true, exams: [] });

  const schoolId       = req.user?.schoolId || null;
  const { subjectIds } = await getTeacherScope(teacherId, schoolId);

  if (!subjectIds.length) return res.json({ success: true, exams: [] });

  const exams = await E.find({ subjectId: { $in: subjectIds } })
    .populate("subjectId", "name code")
    .populate("classId",   "name level")
    .sort({ examDate: -1 })
    .lean();

  const EM       = getExamMark();
  const marksMap = new Map();

  if (EM) {
    const marks = await EM.find({ teacherId: String(teacherId), examId: { $in: exams.map((e) => e._id) } })
      .select("examId status")
      .lean();
    for (const m of marks) marksMap.set(String(m.examId), m.status);
  }

  return res.json({
    success: true,
    exams: exams.map((e) => ({ ...e, marksStatus: marksMap.get(String(e._id)) || "not_submitted" })),
  });
}));

router.get("/exams/:examId/marks", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const EM        = getExamMark();

  if (!EM) return res.json({ success: true, marks: [] });

  const { examId } = req.params;
  const E          = getExam();

  if (E) {
    const exam           = await E.findById(examId).lean();
    const schoolId       = req.user?.schoolId || null;
    const { subjectIds } = await getTeacherScope(teacherId, schoolId);
    if (exam && !subjectIds.includes(String(exam.subjectId))) {
      return res.status(403).json({ message: "You are not assigned to this exam's subject" });
    }
  }

  const marks = await EM.find({ examId: String(examId), teacherId: String(teacherId) })
    .populate("studentId", "studentName")
    .lean();

  return res.json({ success: true, marks });
}));

router.post("/exams/:examId/marks", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const EM        = getExamMark();

  if (!EM) return res.status(503).json({ message: "ExamMark model not available" });

  const { examId } = req.params;
  const { marks }  = req.body;

  if (!Array.isArray(marks) || !marks.length) {
    return res.status(400).json({ message: "marks[] array is required" });
  }

  const E = getExam();
  if (E) {
    const exam           = await E.findById(examId).lean();
    const schoolId       = req.user?.schoolId || null;
    const { subjectIds } = await getTeacherScope(teacherId, schoolId);
    if (exam && !subjectIds.includes(String(exam.subjectId))) {
      return res.status(403).json({ message: "You are not assigned to this exam's subject" });
    }
  }

  const saved = [], failed = [];

  for (const m of marks) {
    try {
      const doc = await getExamMark().findOneAndUpdate(
        { examId: String(examId), studentId: String(m.studentId), teacherId: String(teacherId) },
        {
          examId:        String(examId),
          studentId:     String(m.studentId),
          teacherId:     String(teacherId),
          marksObtained: m.marksObtained,
          totalMarks:    m.totalMarks,
          grade:         m.grade   || null,
          remarks:       m.remarks || null,
          status:        "submitted",
          submittedAt:   new Date(),
        },
        { upsert: true, new: true }
      );
      saved.push(doc._id);
    } catch (e) {
      failed.push({ studentId: m.studentId, reason: e.message });
    }
  }

  return res.json({ success: true, message: `Marks saved: ${saved.length}, failed: ${failed.length}`, saved, failed });
}));

// ═════════════════════════════════════════════════════════════════════════════
// HOMEWORK
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-homework", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const A         = getAssignment();

  if (!A) return res.json({ success: true, assignments: [] });

  const assignments = await A.find({ teacherId: String(teacherId) })
    .populate("classId",   "name level")
    .populate("subjectId", "name code")
    .sort({ createdAt: -1 })
    .lean();

  return res.json({ success: true, assignments });
}));

router.post("/homework", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const A         = getAssignment();

  if (!A) return res.status(503).json({ message: "Assignment model not available" });

  const { title, description, classId, subjectId, dueDate } = req.body;
  if (!title?.trim() || !classId || !subjectId) {
    return res.status(400).json({ message: "title, classId, and subjectId are required" });
  }

  const schoolId                 = req.user?.schoolId || null;
  const { classIds, subjectIds } = await getTeacherScope(teacherId, schoolId);
  const resolvedIds              = await resolveClassIds(String(classId).trim());

  if (!isAssignedToClass(resolvedIds, classIds)) {
    return res.status(403).json({ message: "You are not assigned to this class" });
  }
  if (!subjectIds.map(String).includes(String(subjectId).trim())) {
    return res.status(403).json({ message: "You are not assigned to this subject" });
  }

  const assignment = await A.create({
    title:       title.trim(),
    description: description?.trim() || "",
    teacherId:   String(teacherId),
    classId:     String(classId).trim(),
    subjectId:   String(subjectId).trim(),
    schoolId,
    dueDate:     dueDate ? new Date(dueDate) : null,
  });

  return res.status(201).json({ success: true, assignment });
}));

router.get("/homework/:id/submissions", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const Sub       = getSubmission();

  if (!Sub) return res.json({ success: true, submissions: [] });

  const submissions = await Sub.find({ assignmentId: String(req.params.id), teacherId: String(teacherId) })
    .populate("studentId", "studentName")
    .sort({ submittedAt: -1 })
    .lean();

  return res.json({ success: true, submissions });
}));

// ═════════════════════════════════════════════════════════════════════════════
// QUIZZES
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-quizzes", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const Q         = getQuiz();

  if (!Q) return res.json({ success: true, quizzes: [] });

  const quizzes = await Q.find({ teacherId: String(teacherId) })
    .populate("classId",   "name level")
    .populate("subjectId", "name code")
    .sort({ createdAt: -1 })
    .lean();

  return res.json({ success: true, quizzes });
}));

router.post("/quizzes", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const Q         = getQuiz();

  if (!Q) return res.status(503).json({ message: "Quiz model not available" });

  const { title, classId, subjectId, questions, dueDate } = req.body;
  if (!title?.trim() || !classId || !subjectId) {
    return res.status(400).json({ message: "title, classId, and subjectId are required" });
  }

  const schoolId                 = req.user?.schoolId || null;
  const { classIds, subjectIds } = await getTeacherScope(teacherId, schoolId);
  const resolvedIds              = await resolveClassIds(String(classId).trim());

  if (!isAssignedToClass(resolvedIds, classIds)) {
    return res.status(403).json({ message: "You are not assigned to this class" });
  }
  if (!subjectIds.map(String).includes(String(subjectId).trim())) {
    return res.status(403).json({ message: "You are not assigned to this subject" });
  }

  const quiz = await Q.create({
    title:     title.trim(),
    teacherId: String(teacherId),
    classId:   String(classId).trim(),
    subjectId: String(subjectId).trim(),
    schoolId,
    questions: Array.isArray(questions) ? questions : [],
    dueDate:   dueDate ? new Date(dueDate) : null,
  });

  return res.status(201).json({ success: true, quiz });
}));

// ═════════════════════════════════════════════════════════════════════════════
// CONTENT LIBRARY
// ═════════════════════════════════════════════════════════════════════════════

router.get("/my-content", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const C         = getContent();

  if (!C) return res.json({ success: true, content: [], items: [], summary: null });

  const filter = { teacherId: String(teacherId) };
  if (req.query.type && req.query.type !== "all") filter.type      = req.query.type.toLowerCase();
  if (req.query.subjectId)                        filter.subjectId = req.query.subjectId;
  if (req.query.classId)                          filter.classId   = req.query.classId;
  if (req.query.search) {
    filter.$or = [
      { title:       { $regex: req.query.search, $options: "i" } },
      { description: { $regex: req.query.search, $options: "i" } },
    ];
  }

  const [content, allContent] = await Promise.all([
    C.find(filter).sort({ createdAt: -1 }).lean(),
    C.find({ teacherId: String(teacherId) }).select("type").lean(),
  ]);

  const summary = { total: allContent.length, syllabus: 0, notes: 0, video: 0, audio: 0, document: 0, image: 0 };
  allContent.forEach((item) => {
    const t = item.type?.toLowerCase();
    if (t && Object.hasOwn(summary, t)) summary[t]++;
  });

  const items = content.map(normaliseContentItem);
  return res.json({ success: true, summary, items, content: items });
}));

router.post(
  "/content",
  multerForContent,
  asyncHandler(async (req, res) => {
    const teacherId    = resolveTeacherId(req);
    const uploadedPath = req.file?.path ?? null;
    const C            = getContent();

    if (!C) {
      deleteUploadedFile(uploadedPath);
      return res.status(503).json({ message: "Content model not available" });
    }

    const { title, type, url = "", classId, subjectId, description = "", fileName, fileSize, mimeType } = req.body ?? {};

    if (!title?.trim() || !type || !classId || !subjectId) {
      deleteUploadedFile(uploadedPath);
      return res.status(400).json({ success: false, message: "title, type, classId, and subjectId are required" });
    }

    const ALLOWED_TYPES = Object.keys(ALLOWED_MIMES);
    if (!ALLOWED_TYPES.includes(type.toLowerCase())) {
      deleteUploadedFile(uploadedPath);
      return res.status(400).json({ success: false, message: `type must be one of: ${ALLOWED_TYPES.join(", ")}` });
    }

    const schoolId                 = req.user?.schoolId || null;
    const { classIds, subjectIds } = await getTeacherScope(teacherId, schoolId);
    const resolvedIds              = await resolveClassIds(String(classId).trim());

    if (!isAssignedToClass(resolvedIds, classIds)) {
      deleteUploadedFile(uploadedPath);
      return res.status(403).json({ success: false, message: "You are not assigned to this class" });
    }
    if (!subjectIds.map(String).includes(String(subjectId).trim())) {
      deleteUploadedFile(uploadedPath);
      return res.status(403).json({ success: false, message: "You are not assigned to this subject" });
    }

    let subjectName = "", className = "";
    try {
      const [subjectDoc, classDoc] = await Promise.all([
        Subject.findById(subjectId).select("name").lean(),
        Class.findById(classId).select("name level section").lean(),
      ]);
      subjectName = subjectDoc?.name || "";
      className   = classDoc
        ? classDoc.name || [classDoc.level, classDoc.section].filter(Boolean).join(" ")
        : "";
    } catch { /* non-fatal */ }

    let resolvedFileUrl = null, resolvedFileName = null, resolvedFileSize = 0, resolvedMimeType = null;

    if (req.file) {
      resolvedFileUrl  = buildFileUrl(req, req.file.path);
      resolvedFileName = req.file.originalname;
      resolvedFileSize = req.file.size;
      resolvedMimeType = req.file.mimetype;
    } else if (url?.trim()) {
      resolvedFileUrl  = url.trim();
      resolvedFileName = fileName || title;
      resolvedFileSize = Number(fileSize) || 0;
      resolvedMimeType = mimeType || null;
    }

    let content;
    try {
      content = await C.create({
        title:        title.trim(),
        type:         type.toLowerCase(),
        url:          resolvedFileUrl,
        fileUrl:      resolvedFileUrl,
        fileName:     resolvedFileName || title,
        fileSize:     resolvedFileSize,
        mimeType:     resolvedMimeType || undefined,
        description:  description.trim(),
        teacherId:    String(teacherId),
        subjectId:    String(subjectId).trim(),
        subjectName,
        classId:      String(classId).trim(),
        className,
        classIds:     [String(classId).trim()],
        classNames:   className ? [className] : [],
        schoolId,
        status:       "active",
      });
    } catch (dbErr) {
      deleteUploadedFile(uploadedPath);
      if (dbErr.name === "ValidationError") {
        const messages = Object.values(dbErr.errors).map((e) => e.message);
        return res.status(400).json({ success: false, message: messages.join("; ") });
      }
      throw dbErr;
    }

    const plain = content.toObject();
    return res.status(201).json({ success: true, content: normaliseContentItem(plain), data: normaliseContentItem(plain) });
  })
);

router.delete("/content/:id", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const C         = getContent();

  if (!C) return res.status(503).json({ message: "Content model not available" });

  const content = await C.findById(req.params.id).lean();
  if (!content)
    return res.status(404).json({ success: false, message: "Content not found" });
  if (String(content.teacherId) !== String(teacherId))
    return res.status(403).json({ success: false, message: "You can only delete your own content" });

  if (content.fileUrl) {
    const isLocalUrl =
      content.fileUrl.includes("/uploads/") &&
      !content.fileUrl.startsWith("http://www") &&
      !content.fileUrl.includes("youtube") &&
      !content.fileUrl.includes("drive.google");

    if (isLocalUrl) {
      try {
        const BASE_URL  = process.env.BASE_URL || "";
        const relative  = content.fileUrl.replace(BASE_URL, "");
        const localPath = path.join(__dirname, "..", relative);
        deleteUploadedFile(localPath);
      } catch { /* non-fatal */ }
    }
  }

  await C.findByIdAndDelete(req.params.id);
  return res.json({ success: true, message: "Content deleted successfully" });
}));

router.patch("/content/:id/status", asyncHandler(async (req, res) => {
  const teacherId  = resolveTeacherId(req);
  const C          = getContent();
  const { status } = req.body;

  if (!C) return res.status(503).json({ message: "Content model not available" });

  const ALLOWED = ["active", "draft", "archived"];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({ success: false, message: `status must be one of: ${ALLOWED.join(", ")}` });
  }

  const content = await C.findById(req.params.id).lean();
  if (!content)
    return res.status(404).json({ success: false, message: "Content not found" });
  if (String(content.teacherId) !== String(teacherId))
    return res.status(403).json({ success: false, message: "You can only update your own content" });

  const updated = await C.findByIdAndUpdate(req.params.id, { status }, { new: true }).lean();
  return res.json({ success: true, data: normaliseContentItem(updated) });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/subjects-classes
// ═════════════════════════════════════════════════════════════════════════════

router.get("/subjects-classes", asyncHandler(async (req, res) => {
  const teacherId = resolveTeacherId(req);
  const schoolId  = req.user?.schoolId || null;

  const { subjectIds, classIds } = await getTeacherScope(teacherId, schoolId);
  const groupedSubjects          = await buildGroupedSubjects(subjectIds, classIds);
  const subjectMap               = new Map();

  groupedSubjects.forEach((group) => {
    const { classId, className, subjects = [] } = group;
    subjects.forEach((sub) => {
      const subId = String(sub._id);
      if (!subjectMap.has(subId)) {
        subjectMap.set(subId, { subjectId: subId, subjectName: sub.name || "Unknown", classes: [] });
      }
      if (classId) {
        const entry = subjectMap.get(subId);
        const dupe  = entry.classes.find((c) => c.classId === String(classId));
        if (!dupe) {
          entry.classes.push({ classId: String(classId), className: className || "Unknown Class" });
        }
      }
    });
  });

  return res.json(Array.from(subjectMap.values()));
}));

// ═════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/results", asyncHandler(async (req, res) => {
  const teacherId  = resolveTeacherId(req);
  const R          = getResult();

  if (!R) return res.json({ success: true, results: [] });

  const schoolId       = req.user?.schoolId || null;
  const { subjectIds } = await getTeacherScope(teacherId, schoolId);

  if (!subjectIds.length) return res.json({ success: true, results: [] });

  const { classId, examId } = req.query;
  const filter = { subjectId: { $in: subjectIds } };
  if (classId) filter.classId = String(classId).trim();
  if (examId)  filter.examId  = String(examId).trim();

  const results = await R.find(filter)
    .populate("studentId", "studentName")
    .populate("subjectId", "name code")
    .sort({ createdAt: -1 })
    .lean();

  return res.json({ success: true, results });
}));

// ═════════════════════════════════════════════════════════════════════════════
// PROFILE — update
// ═════════════════════════════════════════════════════════════════════════════

router.put("/profile", asyncHandler(async (req, res) => {
  const teacherId       = resolveTeacherId(req);
  const { name, email } = req.body;

  if (!name?.trim()) return res.status(400).json({ message: "name is required" });

  const updates = { name: name.trim() };

  if (email) {
    const emailClean = email.toLowerCase().trim();
    const taken = await User.findOne({ email: emailClean, _id: { $ne: teacherId } }).lean();
    if (taken) return res.status(409).json({ message: "Email already in use" });
    updates.email = emailClean;
  }

  const teacher = await User.findByIdAndUpdate(teacherId, updates, {
    new: true, runValidators: true, select: "-password -tempPassword",
  });

  if (!teacher) return res.status(404).json({ message: "Teacher not found" });
  return res.json({ success: true, data: teacher.toObject() });
}));

router.put("/profile/password", asyncHandler(async (req, res) => {
  const teacherId                        = resolveTeacherId(req);
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "currentPassword and newPassword are required" });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ message: "New password must be at least 8 characters" });
  }

  const teacher = await User.findById(teacherId).select("+password");
  if (!teacher) return res.status(404).json({ message: "Teacher not found" });

  const isMatch = await teacher.comparePassword(currentPassword);
  if (!isMatch) return res.status(401).json({ message: "Current password is incorrect" });

  teacher.password          = newPassword;
  teacher.mustResetPassword = false;
  await teacher.save();

  return res.json({ success: true, message: "Password changed successfully" });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GET /teacher/school/info
// ═════════════════════════════════════════════════════════════════════════════

router.get("/school/info", asyncHandler(async (req, res) => {
  try {
    const schoolId = req.user?.schoolId;
    if (!schoolId) {
      return res.status(400).json({ success: false, message: "No schoolId associated with your account" });
    }

    const School = require("../db/models/School");

    // The logo is an inline base64 string, routinely ~160 KB, and dwarfs the
    // rest of this document. Shipping it on every poll made this route take
    // seconds against the remote cluster, so it is opt-in via ?includeLogo=1.
    const includeLogo =
      req.query.includeLogo === "1" || req.query.includeLogo === "true";

    const LIGHT_FIELDS =
      "name code address city state country phone email website motto updatedAt";

    const school = await School.findById(schoolId)
      .select(includeLogo ? `${LIGHT_FIELDS} logo` : LIGHT_FIELDS)
      .lean();

    if (!school) return res.status(404).json({ success: false, message: "School not found" });

    // Fingerprint the TRIMMED logo — the mobile cache trims on write, so an
    // untrimmed length would mismatch forever and re-download it every check.
    if (includeLogo) {
      return res.json({
        success: true,
        school: {
          ...school,
          logoLen: school.logo ? Buffer.byteLength(String(school.logo).trim()) : 0,
        },
      });
    }

    // Probe what the logo is without transferring the image. When the value
    // is a short reference (a migrated school's URL) the head IS the whole
    // value, so it comes back for free; a legacy base64 blob stays put.
    const mongoose    = require("mongoose");
    const logoStorage = require("../utils/logoStorage");
    const HEAD = 512;

    let logoLen = null;
    let logoUrl = null;

    if (mongoose.Types.ObjectId.isValid(String(schoolId))) {
      try {
        const rows = await School.aggregate([
          { $match: { _id: new mongoose.Types.ObjectId(String(schoolId)) } },
          { $project: {
              logoLen: { $strLenBytes: { $trim: { input: { $ifNull: ["$logo", ""] } } } },
              logoHead: {
                $substrBytes: [{ $trim: { input: { $ifNull: ["$logo", ""] } } }, 0, HEAD],
              },
          } },
        ]);
        const row = rows[0];
        if (row) {
          logoLen = row.logoLen ?? null;
          const head = String(row.logoHead || "");
          if (row.logoLen <= HEAD && logoStorage.isLogoReference(head)) {
            logoUrl = head;
            logoLen = null;   // a URL needs no fingerprint
          }
        }
      } catch (err) {
        console.warn("[teacher/school/info] logo probe failed:", err.message);
      }
    }

    if (logoUrl) {
      return res.json({
        success: true,
        school: { ...school, logo: logoUrl, logoLen: null, logoIsUrl: true },
      });
    }

    return res.json({
      success: true,
      school: { ...school, logo: null, logoLen },
      logoOmitted: true,
    });
  } catch (err) {
    console.error("GET /teacher/school/info error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch school info" });
  }
}));

module.exports = router;