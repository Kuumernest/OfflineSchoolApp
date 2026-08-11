// backend/src/routes/admin.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

// ─── Models ──────────────────────────────────────────────────────────────────
const User              = require("../db/models/User");
const Class             = require("../db/models/Class");
const Subject           = require("../db/models/Subject");
const TeacherAssignment = require("../db/models/TeacherAssignment");
const School            = require("../db/models/School");

// ─── Services ────────────────────────────────────────────────────────────────
const { sendEmail } = require("../services/email.service");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — SHARED UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => next(err));

const sendSuccess = (res, data, status = 200) =>
  res.status(status).json({ success: true, ...data });

const sendError = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const resolveSchoolId = (req, providedSchoolId) => {
  const provided = providedSchoolId || req.body?.schoolId || req.query?.schoolId;
  if (req.user?.role === "super_admin" && provided) {
    return String(provided).trim();
  }
  return req.user?.schoolId;
};

const getTenantQuery = (req, targetId) => {
  const query = { _id: String(targetId).trim() };
  if (req.user?.role !== "super_admin") {
    query.schoolId = req.user?.schoolId;
  }
  return query;
};

// ─── NOT_DELETED helpers ──────────────────────────────────────────────────────
//
// DESIGN NOTE:
// MongoDB does not allow two top-level $or keys in the same object.
// So we never spread NOT_DELETED directly into a query that already has $or.
// Instead use:
//   - addNotDeleted(query)   → merges via $and, safe in all cases
//   - NOT_DELETED_FILTER     → use when the query has NO other $or
//   - notDeletedClause()     → returns the $or array element for $and arrays

const NOT_DELETED_FILTER = {
  $or: [
    { deletedAt: { $exists: false } },
    { deletedAt: null               },
    { deletedAt: ""                 },
  ],
};

// Returns a single $and-compatible clause object
const notDeletedClause = () => ({
  $or: [
    { deletedAt: { $exists: false } },
    { deletedAt: null               },
    { deletedAt: ""                 },
  ],
});

/**
 * Safely add "not deleted" condition to any query.
 * If the query already has a top-level $or, wraps both in $and.
 * Otherwise adds $or directly.
 */
const addNotDeleted = (query) => {
  const ndClause = notDeletedClause();

  if (query.$or) {
    // Merge existing $or into $and to avoid clobbering
    const existingOr = query.$or;
    const { $or: _removed, ...rest } = query;
    return {
      ...rest,
      $and: [
        ...(rest.$and || []),
        { $or: existingOr },
        ndClause,
      ],
    };
  }

  // No existing $or — safe to add directly
  return { ...query, ...ndClause };
};

// ─── Lazy model loaders ──────────────────────────────────────────────────────

const lazyModel = (modulePath, label) => {
  let cached = null, attempted = false;
  return () => {
    if (!attempted) {
      attempted = true;
      try { cached = require(modulePath); }
      catch { console.warn(`⚠️  Optional model "${label}" not found at "${modulePath}"`); }
    }
    return cached;
  };
};

const getStudentApplication = lazyModel("../db/models/StudentApplication", "StudentApplication");
const getStudent            = lazyModel("../db/models/Student",            "Student");
const getGradingConfig      = lazyModel("../db/models/GradingConfig",      "GradingConfig");

// ─── Field normalisers ────────────────────────────────────────────────────────

const normaliseSubject = (s) => {
  if (!s) return s;
  const classRef = s.class || s.classId || null;
  return { ...s, class: classRef, classId: classRef };
};

const normaliseStudentDoc = (s) => {
  if (!s) return null;
  const idStr = String(s._id || s.id || "");
  if (!idStr) return null;

  const name =
    [s.firstName, s.lastName].filter(Boolean).join(" ").trim() ||
    s.name || s.studentName || s.full_name || null;

  const classId   = s.classId || s.class_id || null;
  const className = s.className || s.class_name || null;

  return {
    id: idStr, _id: idStr,
    name,
    studentName: s.studentName || name,
    firstName:   s.firstName   || null,
    lastName:    s.lastName    || null,
    email:       s.email       || s.studentEmail || null,
    phone:       s.phone       || s.guardianPhone || null,
    dateOfBirth: s.dateOfBirth || s.date_of_birth || s.dob || null,
    gender:      s.gender      || null,
    address:     s.address     || null,
    classId,
    class_id:    classId,
    className,
    admissionNo:     s.admissionNo     || s.admissionNumber || null,
    admissionNumber: s.admissionNumber || s.admissionNo     || null,
    guardianName:    s.guardianName    || s.guardian_name   || null,
    guardianPhone:   s.guardianPhone   || s.guardian_phone  || null,
    schoolId:        s.schoolId        || null,
    userId:          s.userId          || null,
    studentId:       s.studentId       || null,
    applicationId:   s.applicationId   || null,
    status:          s.status          || "approved",
    isActive:        s.isActive        ?? true,
    grade:           s.grade           || s.className || null,
    notes:           s.notes           || null,
    enrolledAt:      s.enrolledAt      || s.approvedAt || null,
    createdAt:       s.createdAt       || null,
    updatedAt:       s.updatedAt       || null,
  };
};

// ─── Multi-collection student helpers ────────────────────────────────────────

/**
 * Fetch students preferring the Student (canonical) collection.
 * Falls back to StudentApplication only when Student returns nothing.
 *
 * NOTE: Do NOT pass NOT_DELETED_FILTER or any object with $or directly
 * into this function — use addNotDeleted() on your query first if needed.
 */
const fetchAllStudents = async (query = {}) => {
  const S   = getStudent();
  const App = getStudentApplication();

  if (S) {
    const docs = await S.find(query).lean().catch(() => []);
    if (docs.length > 0) return docs;
  }

  if (App) {
    return App.find(query).lean().catch(() => []);
  }

  return [];
};

/**
 * Fetch and merge from BOTH collections (used when you genuinely need both,
 * e.g. GET /students/:id). Student record wins on email collision.
 */
const fetchMergedStudents = async (query = {}) => {
  const App = getStudentApplication();
  const S   = getStudent();

  const [appDocs, studentDocs] = await Promise.all([
    App ? App.find(query).lean().catch(() => []) : [],
    S   ? S.find(query).lean().catch(() => [])   : [],
  ]);

  const merged = new Map();

  for (const doc of appDocs) {
    const key = doc.email?.toLowerCase().trim() || `id:${String(doc._id)}`;
    if (!merged.has(key)) merged.set(key, { ...doc, _source: "application" });
  }

  for (const doc of studentDocs) {
    const key = doc.email?.toLowerCase().trim() || `id:${String(doc._id)}`;
    merged.set(key, { ...doc, _source: "student" });
  }

  return [...merged.values()];
};

// ─── Misc helpers ─────────────────────────────────────────────────────────────

const generateTempPassword = () => {
  const adjectives = ["Swift","Brave","Calm","Bold","Keen","Pure","Wise","Kind","Fair","Glad","Firm","Safe","True","Warm","Neat"];
  const nouns      = ["River","Stone","Eagle","Cedar","Flame","Ocean","Tiger","Haven","Pearl","Maple","Tower","Cloud","Frost","Spark","Grove"];
  const adj    = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun   = nouns[Math.floor(Math.random() * nouns.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${adj}${noun}${digits}`;
};

const isValidEmail = (email) =>
  typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

const getSchoolName = async (schoolId) => {
  const fallback = process.env.SCHOOL_NAME || "Your School";
  if (!schoolId) return fallback;
  try {
    const school = await School.findById(schoolId).lean();
    return school?.name || fallback;
  } catch { return fallback; }
};

const sendEmailSafe = async ({ to, template, data, context = "" }) => {
  try {
    const result = await sendEmail({ to, template, data });
    return result ?? { success: true };
  } catch (err) {
    console.warn(`sendEmail failed${context ? ` [${context}]` : ""}:`, err.message);
    return { success: false };
  }
};

const createStaffAccount = async ({ name, email, role, schoolId, createdBy }) => {
  const tempPassword = generateTempPassword();
  const user = await User.create({
    name:              name.trim(),
    email:             email.toLowerCase().trim(),
    role, isActive: true, schoolId,
    password:          tempPassword,
    mustResetPassword: true,
    createdBy,
  });
  return { user, tempPassword };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — ADMIN GUARD
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_ROLES = new Set(["super_admin", "school_admin", "admin"]);

const adminOnly = (req, res, next) => {
  if (!req.user) return sendError(res, 401, "Not authenticated");
  const { role } = req.user;
  console.log(`🔐 adminOnly — user: ${req.user.email}, role: "${role}"`);
  if (!ADMIN_ROLES.has(role)) {
    console.warn(`⛔ Access denied for role "${role}"`);
    return sendError(res, 403, `Admin only. Your role "${role}" is not permitted.`);
  }
  return next();
};

router.use(adminOnly);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — DASHBOARD STATS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/stats", asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
  const baseQuery = schoolId ? { schoolId } : {};

  console.log(`📊 /stats — schoolId: ${schoolId}`);

  const [
    totalTeachers,
    assignedTeacherIds,
    totalClasses,
    totalSubjects,
    classesWithSubjectsNew,
    classesWithSubjectsLegacy,
    totalAssignments,
    pendingStudents,
    approvedStudents,
    stalePendingApps,
    activeAnnouncements,
    totalPeriods,
  ] = await Promise.all([

    User.countDocuments({ ...baseQuery, role: "teacher", isActive: true }),

    TeacherAssignment.distinct("teacher", baseQuery),

    // Use addNotDeleted to safely merge NOT_DELETED with isActive filter
    Class.countDocuments(addNotDeleted({ ...baseQuery, isActive: true })),

    Subject.countDocuments(baseQuery),

    Subject.distinct("class",   { ...baseQuery, class:   { $exists: true, $ne: null } }),
    Subject.distinct("classId", { ...baseQuery, classId: { $exists: true, $ne: null } }),

    TeacherAssignment.countDocuments(baseQuery),

    // Pending students
    (async () => {
      try {
        const S = getStudent();
        if (S) {
          return S.countDocuments(
            addNotDeleted({ ...baseQuery, status: "pending" })
          );
        }
        const App = getStudentApplication();
        return App ? App.countDocuments({ ...baseQuery, status: "pending" }) : 0;
      } catch { return 0; }
    })(),

    // Approved students
    (async () => {
      try {
        const S = getStudent();
        if (S) {
          return S.countDocuments(
            addNotDeleted({ ...baseQuery, status: { $in: ["approved", "active"] } })
          );
        }
        const App = getStudentApplication();
        return App
          ? App.countDocuments({ ...baseQuery, status: { $in: ["approved", "active"] } })
          : 0;
      } catch { return 0; }
    })(),

    // Stale pending (> 3 days)
    (async () => {
      try {
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const S = getStudent();
        if (S) {
          return S.countDocuments(
            addNotDeleted({
              ...baseQuery,
              status:    "pending",
              createdAt: { $lt: threeDaysAgo },
            })
          );
        }
        const App = getStudentApplication();
        return App
          ? App.countDocuments({
              ...baseQuery,
              status:    "pending",
              createdAt: { $lt: threeDaysAgo },
            })
          : 0;
      } catch { return 0; }
    })(),

    // Active announcements
    (async () => {
      try {
        const Announcement = require("../db/models/Announcement");
        const now = new Date();
        return Announcement.countDocuments({
          ...baseQuery, isActive: true,
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: null               },
            { expiresAt: { $gt: now }       },
          ],
        });
      } catch { return 0; }
    })(),

    // Total periods
    (async () => {
      try {
        const Period = require("../db/models/Period");
        return Period.countDocuments({ ...baseQuery, isActive: true });
      } catch { return 0; }
    })(),
  ]);

  const allClassesWithSubjects = [
    ...new Set([
      ...classesWithSubjectsNew.map(String),
      ...classesWithSubjectsLegacy.map(String),
    ]),
  ];

  const unassignedTeachers     = Math.max(0, totalTeachers - assignedTeacherIds.length);
  const classesWithoutSubjects = Math.max(0, totalClasses  - allClassesWithSubjects.length);

  const assignedSubjects = allClassesWithSubjects.length > 0
    ? await Subject.countDocuments({
        ...baseQuery,
        $or: [
          { class:   { $in: allClassesWithSubjects } },
          { classId: { $in: allClassesWithSubjects } },
        ],
      }).catch(() => 0)
    : 0;

  let incompleteTimetableSlots = 0, timetableConflicts = 0;
  try {
    const TimetableSlot = require("../db/models/TimetableSlot");
    const classesWithTimetable = await TimetableSlot.distinct(
      "classId",
      addNotDeleted({ ...baseQuery })
    );
    incompleteTimetableSlots = Math.max(0, totalClasses - classesWithTimetable.length);

    const conflicts = await TimetableSlot.aggregate([
      { $match: addNotDeleted({ ...baseQuery }) },
      {
        $group: {
          _id:   { teacherId: "$teacherId", dayOfWeek: "$dayOfWeek", periodId: "$periodId" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $count: "total" },
    ]);
    timetableConflicts = conflicts[0]?.total || 0;
  } catch { /* TimetableSlot optional */ }

  const stats = {
    pendingApplications:     pendingStudents,
    approvedStudents,
    totalTeachers,
    unassignedTeachers,
    totalClasses,
    totalSubjects,
    assignedSubjects,
    totalAssignments,
    incompleteTimetableSlots,
    activeAnnouncements,
    classesWithoutSubjects,
    timetableConflicts,
    stalePendingApps,
    totalPeriods,
  };

  console.log("📊 Stats calculated successfully");
  return sendSuccess(res, { stats, data: stats });
}));

router.get("/debug/counts", asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
  const baseQuery = schoolId ? { schoolId } : {};
  const teacherQuery = { ...baseQuery, role: "teacher", isActive: true };

  const counts = {
    teachers:    await User.countDocuments(teacherQuery),
    classes:     await Class.countDocuments(addNotDeleted({ ...baseQuery, isActive: true })),
    subjects:    await Subject.countDocuments(baseQuery),
    assignments: await TeacherAssignment.countDocuments(baseQuery),
  };

  const [teachersList, classesList, rawSubjects, assignmentsList] = await Promise.all([
    User.find(teacherQuery).select("name email role").lean(),
    Class.find(addNotDeleted({ ...baseQuery, isActive: true })).select("name level section").lean(),
    Subject.find(baseQuery).select("name code class classId").lean(),
    TeacherAssignment.find(baseQuery).select("teacher class subject").lean(),
  ]);

  const subjectsList = rawSubjects.map(normaliseSubject);

  const teacherIds = [...new Set(assignmentsList.map((a) => a.teacher).filter(Boolean))];
  const classIds   = [...new Set(assignmentsList.map((a) => a.class).filter(Boolean))];
  const subjectIds = [...new Set(assignmentsList.map((a) => a.subject).filter(Boolean))];

  const [tUsers, tClasses, tSubjects] = await Promise.all([
    User.find({ _id: { $in: teacherIds } }).select("name").lean(),
    Class.find({ _id: { $in: classIds } }).select("name").lean(),
    Subject.find({ _id: { $in: subjectIds } }).select("name").lean(),
  ]);

  const uMap = new Map(tUsers.map((u)   => [String(u._id), u]));
  const cMap = new Map(tClasses.map((c) => [String(c._id), c]));
  const sMap = new Map(tSubjects.map((s) => [String(s._id), s]));

  const assignmentsPopulated = assignmentsList.map((a) => ({
    ...a,
    teacher: uMap.get(String(a.teacher)) || a.teacher,
    class:   cMap.get(String(a.class))   || a.class,
    subject: sMap.get(String(a.subject)) || a.subject,
  }));

  return sendSuccess(res, {
    counts, teachersList, classesList, subjectsList,
    assignmentsList: assignmentsPopulated, schoolId,
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — PER-ENTITY STATS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/students/stats", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const S   = getStudent();
  const App = getStudentApplication();

  let total = 0, active = 0, newCount = 0;

  if (S) {
    const baseFilter = addNotDeleted({
      schoolId,
      status: { $in: ["approved", "active"] },
    });
    [total, active, newCount] = await Promise.all([
      S.countDocuments(baseFilter),
      S.countDocuments({ ...baseFilter, isActive: true }),
      S.countDocuments({ ...baseFilter, createdAt: { $gte: since } }),
    ]);
  } else if (App) {
    const filter = { schoolId, status: { $in: ["approved", "active"] } };
    [total, active, newCount] = await Promise.all([
      App.countDocuments(filter),
      App.countDocuments({ ...filter, isActive: true }),
      App.countDocuments({ ...filter, createdAt: { $gte: since } }),
    ]);
  }

  return sendSuccess(res, { total, active, new: newCount });
}));

router.get("/teachers/stats", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  const baseFilter = { schoolId, role: "teacher" };
  const [total, active] = await Promise.all([
    User.countDocuments(baseFilter),
    User.countDocuments({ ...baseFilter, isActive: true }),
  ]);

  return sendSuccess(res, { total, active });
}));

router.get("/classes/stats", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  const [total, classIdsWithSubjectsNew, classIdsWithSubjectsLegacy] = await Promise.all([
    Class.countDocuments(addNotDeleted({ schoolId, isActive: true })),
    Subject.distinct("class",   { schoolId, class:   { $exists: true, $ne: null } }),
    Subject.distinct("classId", { schoolId, classId: { $exists: true, $ne: null } }),
  ]);

  const withSubjects = [
    ...new Set([
      ...classIdsWithSubjectsNew.map(String),
      ...classIdsWithSubjectsLegacy.map(String),
    ]),
  ].length;

  return sendSuccess(res, { total, withSubjects });
}));

router.get("/subjects/stats", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");
  const total = await Subject.countDocuments({ schoolId });
  return sendSuccess(res, { total });
}));

router.get("/exams/stats", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  let Exam = null;
  try { Exam = require("../db/models/Exam"); } catch { /* optional */ }

  if (!Exam) {
    return sendSuccess(res, { total: 0, ongoing: 0, completed: 0, draft: 0, scheduled: 0 });
  }

  const [total, ongoing, completed, draft, scheduled] = await Promise.all([
    Exam.countDocuments({ schoolId }),
    Exam.countDocuments({ schoolId, status: "ongoing"   }),
    Exam.countDocuments({ schoolId, status: "completed" }),
    Exam.countDocuments({ schoolId, status: "draft"     }),
    Exam.countDocuments({ schoolId, status: "scheduled" }),
  ]);

  return sendSuccess(res, { total, ongoing, completed, draft, scheduled });
}));

router.get("/attendance/stats", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  let StudentAttendance = null;
  try {
    const mod = require("../db/models/Attendance");
    StudentAttendance = mod?.StudentAttendance;
    if (!StudentAttendance || typeof StudentAttendance.countDocuments !== "function") {
      throw new Error(
        `StudentAttendance not found in module. Available: ${Object.keys(mod || {}).join(", ")}`
      );
    }
  } catch (importErr) {
    console.warn("⚠️  [attendance/stats] Model not available:", importErr.message);
    return sendSuccess(res, {
      todayPresent: 0, todayAbsent: 0, rate: 0,
      note: "Attendance module not configured",
    });
  }

  try {
    const dateStr    = new Date().toISOString().split("T")[0];
    const baseFilter = { schoolId, date: dateStr };

    const [todayPresent, todayAbsent] = await Promise.all([
      StudentAttendance.countDocuments({ ...baseFilter, status: "present" }),
      StudentAttendance.countDocuments({ ...baseFilter, status: "absent"  }),
    ]);

    const total = todayPresent + todayAbsent;
    const rate  = total > 0 ? Math.round((todayPresent / total) * 100) : 0;

    return sendSuccess(res, { todayPresent, todayAbsent, total, rate });
  } catch (queryErr) {
    console.error("❌ [attendance/stats] Query failed:", queryErr.message);
    return sendSuccess(res, {
      todayPresent: 0, todayAbsent: 0, rate: 0,
      note: "Attendance data temporarily unavailable",
    });
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — TEACHERS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/teachers", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const query = { role: "teacher", isActive: true };
  if (schoolId)                query.schoolId = schoolId;
  if (req.query.email?.trim()) query.email    = req.query.email.toLowerCase().trim();

  const teachers = await User.find(query).select("-password -tempPassword").lean();
  console.log(`GET /teachers → ${teachers.length} results (schoolId=${schoolId ?? "all"})`);
  return sendSuccess(res, { data: teachers, teachers });
}));

router.post("/teachers", asyncHandler(async (req, res) => {
  const { id, name, email, schoolId } = req.body;
  if (!name?.trim() || !email) return sendError(res, 400, "name and email are required");

  const emailClean = email.toLowerCase().trim();
  if (!isValidEmail(emailClean)) return sendError(res, 400, "A valid email is required");

  const existing = await User.findOne({ email: emailClean }).lean();
  if (existing)   return sendError(res, 409, "Email already registered");

  const resolvedSchoolId = resolveSchoolId(req, schoolId);
  const schoolName       = await getSchoolName(resolvedSchoolId);
  const tempPassword     = generateTempPassword();

  const userData = {
    name: name.trim(), email: emailClean, role: "teacher",
    isActive: true, schoolId: resolvedSchoolId,
    password: tempPassword, mustResetPassword: true, createdBy: req.user?._id,
  };
  if (id) userData._id = String(id).trim();

  const teacher = await User.create(userData);

  const emailResult = await sendEmailSafe({
    to: emailClean, template: "teacherWelcome",
    data: {
      teacherName: name.trim(), email: emailClean,
      tempPassword, schoolName, loginUrl: process.env.APP_LOGIN_URL || null,
    },
    context: "teacherWelcome",
  });

  const teacherObj = teacher.toObject();
  delete teacherObj.password;
  delete teacherObj.tempPassword;

  console.log(`✅ Teacher created: ${teacher.name} (${teacher._id})`);
  return sendSuccess(res, {
    data: teacherObj, teacher: teacherObj, emailSent: emailResult.success,
    message: emailResult.success
      ? `Teacher created. Login details sent to ${emailClean}.`
      : `Teacher created. Email failed — share credentials manually.`,
    ...(emailResult.success ? {} : { tempPassword }),
  }, 201);
}));

router.get("/teachers/:id", asyncHandler(async (req, res) => {
  const teacher = await User.findOne({
    ...getTenantQuery(req, req.params.id),
    role: "teacher",
  }).select("-password -tempPassword").lean();

  if (!teacher) return sendError(res, 404, "Teacher not found");
  return sendSuccess(res, { data: teacher });
}));

router.put("/teachers/:id", asyncHandler(async (req, res) => {
  const { name, email, isActive, schoolId } = req.body;
  const updateFields = {
    ...(name                   && { name: name.trim() }),
    ...(isActive !== undefined && { isActive }),
  };

  if (email) {
    const emailClean = email.toLowerCase().trim();
    if (!isValidEmail(emailClean)) return sendError(res, 400, "A valid email is required");
    updateFields.email = emailClean;
  }
  if (req.user?.role === "super_admin" && schoolId) {
    updateFields.schoolId = String(schoolId).trim();
  }

  const teacher = await User.findOneAndUpdate(
    { ...getTenantQuery(req, req.params.id), role: "teacher" },
    updateFields,
    { new: true, runValidators: true, select: "-password -tempPassword" }
  );
  if (!teacher) return sendError(res, 404, "Teacher not found");

  console.log(`✅ Teacher updated: ${teacher.name}`);
  return sendSuccess(res, { data: teacher.toObject() });
}));

router.delete("/teachers/:id", asyncHandler(async (req, res) => {
  const teacher = await User.findOneAndUpdate(
    { ...getTenantQuery(req, req.params.id), role: "teacher" },
    { isActive: false },
    { new: true }
  );
  if (!teacher) return sendError(res, 404, "Teacher not found");

  console.log(`🗑️  Teacher deactivated: ${teacher._id}`);
  return sendSuccess(res, { message: "Teacher deactivated" });
}));

router.post("/teachers/:id/reset-password", asyncHandler(async (req, res) => {
  const teacher = await User.findOne({
    ...getTenantQuery(req, req.params.id),
    role: "teacher",
  });
  if (!teacher) return sendError(res, 404, "Teacher not found");

  const tempPassword        = generateTempPassword();
  teacher.password          = tempPassword;
  teacher.mustResetPassword = true;
  await teacher.save();

  const schoolName  = await getSchoolName(teacher.schoolId);
  const emailResult = await sendEmailSafe({
    to: teacher.email, template: "passwordResetByAdmin",
    data: { teacherName: teacher.name, email: teacher.email, tempPassword, schoolName },
    context: "passwordResetByAdmin",
  });

  console.log(`🔑 Password reset: ${teacher.name}`);
  return sendSuccess(res, {
    emailSent: emailResult.success,
    message:   emailResult.success
      ? "Password reset. New credentials emailed to teacher."
      : "Password reset. Email failed — share credentials manually.",
    ...(emailResult.success ? {} : { tempPassword }),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — CLASSES
// ═════════════════════════════════════════════════════════════════════════════

router.get("/classes", asyncHandler(async (req, res) => {
  const schoolId        = resolveSchoolId(req, req.query.schoolId);
  const includeInactive = req.query.includeInactive === "true";

  let query = {};
  if (schoolId) query.schoolId = schoolId;

  if (!includeInactive) {
    query.isActive = true;
    // addNotDeleted handles the $or merge safely
    query = addNotDeleted(query);
  }

  const classes = await Class.find(query).sort({ name: 1 }).lean();
  return sendSuccess(res, { classes });
}));

router.post("/classes", asyncHandler(async (req, res) => {
  const { id, name, level, section, schoolId } = req.body;
  if (!name?.trim()) return sendError(res, 400, "name is required");

  const resolvedSchoolId = resolveSchoolId(req, schoolId);

  const existing = await Class.findOne(
    addNotDeleted({
      name:     name.trim(),
      schoolId: resolvedSchoolId,
      isActive: true,
    })
  ).lean();

  if (existing) {
    return sendError(res, 409, "Class already exists", {
      class:    existing,
      serverId: String(existing._id),
      clientId: id ? String(id).trim() : null,
    });
  }

  const cls = await Class.create({
    name:      name.trim(),
    level:     level || null,
    section:   section?.trim() || "",
    schoolId:  resolvedSchoolId,
    isActive:  true,
    deletedAt: null,
  });

  console.log(`✅ Class created: ${cls.name} [${cls._id}]`);
  return sendSuccess(res, {
    class:    cls.toObject(),
    serverId: String(cls._id),
    clientId: id ? String(id).trim() : null,
  }, 201);
}));

router.put("/classes/:id", asyncHandler(async (req, res) => {
  const { name, level, section, isActive } = req.body;
  const cls = await Class.findOneAndUpdate(
    getTenantQuery(req, req.params.id),
    {
      ...(name                   && { name: name.trim() }),
      ...(level   !== undefined  && { level }),
      ...(section !== undefined  && { section }),
      ...(isActive !== undefined && { isActive }),
    },
    { new: true, runValidators: true }
  );
  if (!cls) return sendError(res, 404, "Class not found");

  console.log(`✅ Class updated: ${cls.name}`);
  return sendSuccess(res, { class: cls.toObject() });
}));

router.delete("/classes/:id", asyncHandler(async (req, res) => {
  const classId = req.params.id;
  const cls     = await Class.findOne(getTenantQuery(req, classId)).lean();
  if (!cls) return sendError(res, 404, "Class not found");

  const schoolId = cls.schoolId;
  const S        = getStudent();
  const App      = getStudentApplication();
  let studentCount = 0;

  if (S) {
    studentCount = await S.countDocuments(
      addNotDeleted({ classId, schoolId })
    );
  } else if (App) {
    studentCount = await App.countDocuments({ classId, schoolId });
  }

  if (studentCount > 0) {
    return sendError(
      res, 409,
      "Cannot delete a class that has students enrolled. Move or remove students first."
    );
  }

  const subjectResult = await Subject.deleteMany({
    $or: [{ class: classId }, { classId }],
  }).catch(() => ({ deletedCount: 0 }));

  console.log(`🗑️  Deleted ${subjectResult.deletedCount} subject(s) for class ${classId}`);

  await TeacherAssignment.deleteMany({
    $or: [{ class: classId }, { classId }],
  }).catch(() => {});

  const deleted = await Class.findOneAndUpdate(
    getTenantQuery(req, classId),
    { isActive: false, deletedAt: new Date() },
    { new: true }
  );
  if (!deleted) return sendError(res, 404, "Class not found");

  console.log(`🗑️  Class soft-deleted: ${classId}`);
  return sendSuccess(res, {
    message:         `Class and ${subjectResult.deletedCount} subject(s) deleted successfully`,
    deletedSubjects: subjectResult.deletedCount,
  });
}));

router.get("/classes/:classId/subjects", asyncHandler(async (req, res) => {
  const classIdStr  = String(req.params.classId).trim();
  const classRecord = await Class.findOne(getTenantQuery(req, classIdStr)).lean();
  if (!classRecord)  return sendError(res, 404, "Class not found or access denied");

  const subjects = (
    await Subject.find({
      $or: [{ class: classIdStr }, { classId: classIdStr }],
    }).lean()
  ).map(normaliseSubject);

  return sendSuccess(res, { subjects });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — SUBJECTS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/subjects", asyncHandler(async (req, res) => {
  const schoolId    = resolveSchoolId(req, req.query.schoolId);
  const { classId } = req.query;

  const query = {};
  if (schoolId) query.schoolId = schoolId;
  if (classId) {
    const cid = String(classId).trim();
    query.$or = [{ class: cid }, { classId: cid }];
  }

  const rawSubjects = await Subject.find(query).sort({ name: 1 }).lean();
  if (!rawSubjects.length) return sendSuccess(res, { subjects: [] });

  const allClassIds = [
    ...new Set(
      rawSubjects
        .map((s) => s.class || s.classId)
        .filter(Boolean)
        .map(String)
    ),
  ];

  const allSubjectIds = rawSubjects.map((s) => String(s._id));

  const [classRecords, assignments] = await Promise.all([
    allClassIds.length > 0
      ? Class.find({ _id: { $in: allClassIds } }).select("name section level").lean()
      : [],
    TeacherAssignment.find({ subject: { $in: allSubjectIds } })
      .populate("teacher", "name email")
      .lean(),
  ]);

  const classMap = new Map(classRecords.map((c) => [String(c._id), c]));

  const subjectTeacherMap = new Map();
  for (const a of assignments) {
    const sid = String(a.subject?._id || a.subject || "");
    if (!sid || subjectTeacherMap.has(sid)) continue;
    const t = a.teacher;
    if (t) {
      subjectTeacherMap.set(sid, {
        _id:   String(t._id || t),
        name:  t.name  || "",
        email: t.email || "",
      });
    }
  }

  const subjects = rawSubjects.map((s) => {
    const canonicalClassId = s.class || s.classId || null;
    const classRecord      = canonicalClassId
      ? classMap.get(String(canonicalClassId)) || null
      : null;
    const teacher          = subjectTeacherMap.get(String(s._id)) || null;

    return {
      ...s,
      class:    canonicalClassId,
      classId:  canonicalClassId,
      classObj: classRecord ? { _id: String(classRecord._id), ...classRecord } : null,
      teacherId:   teacher?._id  || s.teacherId  || s.teacher_id || null,
      teacher_id:  teacher?._id  || s.teacher_id || s.teacherId  || null,
      teacherName: teacher?.name || s.teacherName || null,
      teacher:     teacher       || null,
    };
  });

  const seen    = new Set();
  const deduped = subjects.filter((s) => {
    const key = `${(s.name || "").toLowerCase().trim()}|${s.class || s.classId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return sendSuccess(res, { subjects: deduped });
}));

router.post("/subjects", asyncHandler(async (req, res) => {
  const { id, name, code, classId, schoolId } = req.body;
  if (!name?.trim()) return sendError(res, 400, "name is required");
  if (!classId)      return sendError(res, 400, "classId is required");

  const resolvedSchoolId = resolveSchoolId(req, schoolId);
  const classIdStr       = String(classId).trim();

  const classExists = await Class.findOne(getTenantQuery(req, classIdStr)).lean();
  if (!classExists) {
    return sendError(res, 422,
      "Class not found on server or permission denied. Sync classes first.",
      { code: "CLASS_NOT_SYNCED", classId: classIdStr }
    );
  }

  const existing = await Subject.findOne({
    name:     name.trim(),
    schoolId: resolvedSchoolId,
    $or: [{ class: classIdStr }, { classId: classIdStr }],
  }).lean();

  if (existing) {
    return sendError(res, 409, "Subject already exists in this class", {
      subject:  normaliseSubject(existing),
      serverId: String(existing._id),
      clientId: id ? String(id).trim() : null,
    });
  }

  const subject = await Subject.create({
    name:     name.trim(),
    code:     code?.trim() || "",
    class:    classIdStr,
    classId:  classIdStr,
    schoolId: resolvedSchoolId,
  });

  const populated = {
    ...normaliseSubject(subject.toObject()),
    classObj: {
      _id:     String(classExists._id),
      name:    classExists.name,
      section: classExists.section,
    },
    teacherId: null, teacher_id: null, teacherName: null, teacher: null,
  };

  console.log(`✅ Subject created: ${subject.name} [${subject._id}]`);
  return sendSuccess(res, {
    subject:  populated,
    serverId: String(subject._id),
    clientId: id ? String(id).trim() : null,
  }, 201);
}));

router.put("/subjects/:id", asyncHandler(async (req, res) => {
  const { name, code, classId } = req.body;

  if (classId) {
    const classExists = await Class.findOne(getTenantQuery(req, classId)).lean();
    if (!classExists) {
      return sendError(res, 403, "Selected class does not exist or access denied");
    }
  }

  const classIdStr = classId ? String(classId).trim() : undefined;

  const subject = await Subject.findOneAndUpdate(
    getTenantQuery(req, req.params.id),
    {
      ...(name               && { name: name.trim()        }),
      ...(code !== undefined && { code: code?.trim() || "" }),
      ...(classIdStr         && { class: classIdStr, classId: classIdStr }),
    },
    { new: true, runValidators: true }
  ).lean();

  if (!subject) return sendError(res, 404, "Subject not found");

  const assignment = await TeacherAssignment.findOne({ subject: String(subject._id) })
    .populate("teacher", "name email")
    .lean();

  const teacher = assignment?.teacher
    ? {
        _id:   String(assignment.teacher._id),
        name:  assignment.teacher.name  || "",
        email: assignment.teacher.email || "",
      }
    : null;

  console.log(`✅ Subject updated: ${subject.name}`);
  return sendSuccess(res, {
    subject: {
      ...normaliseSubject(subject),
      teacherId:   teacher?._id  || null,
      teacher_id:  teacher?._id  || null,
      teacherName: teacher?.name || null,
      teacher:     teacher       || null,
    },
  });
}));

router.delete("/subjects/:id", asyncHandler(async (req, res) => {
  const inUse = await TeacherAssignment.findOne({ subject: req.params.id }).lean();
  if (inUse) {
    return sendError(res, 409,
      "Cannot delete — subject has teacher assignments. Remove them first."
    );
  }

  const subject = await Subject.findOneAndDelete(getTenantQuery(req, req.params.id));
  if (!subject) return sendError(res, 404, "Subject not found");

  console.log(`🗑️  Subject deleted: ${req.params.id}`);
  return sendSuccess(res, { message: "Subject deleted" });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — STUDENTS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/students/pending", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  // Build query without $or conflict — addNotDeleted handles the merge
  const query = addNotDeleted({
    status: "pending",
    ...(schoolId ? { schoolId } : {}),
  });

  const students   = await fetchAllStudents(query);
  const sorted     = students.sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
  );
  const normalised = sorted.map(normaliseStudentDoc).filter(Boolean);

  return sendSuccess(res, {
    students: normalised, data: normalised, total: normalised.length,
  });
}));

router.get("/students/approved", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  // Build base query then safely add not-deleted clause
  let query = { status: { $in: ["approved", "active"] } };
  if (schoolId)          query.schoolId = schoolId;
  if (req.query.classId) query.classId  = String(req.query.classId).trim();
  if (req.query.since) {
    const d = new Date(req.query.since);
    if (!isNaN(d.getTime())) query.updatedAt = { $gte: d };
  }
  query = addNotDeleted(query);

  const students = await fetchAllStudents(query);
  const sorted   = students.sort((a, b) => {
    const nameA = (a.studentName || a.name || a.firstName || "").toLowerCase();
    const nameB = (b.studentName || b.name || b.firstName || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });

  const classIds = [
    ...new Set(sorted.map((s) => s.classId || s.class_id).filter(Boolean).map(String)),
  ];
  const classMap = {};
  if (classIds.length > 0) {
    const classes = await Class.find({ _id: { $in: classIds } })
      .select("_id name section")
      .lean();
    for (const c of classes) {
      classMap[String(c._id)] = [c.name, c.section].filter(Boolean).join(" ");
    }
  }

  const normalised = sorted.map((s) => {
    const doc = normaliseStudentDoc(s);
    if (!doc) return null;
    const cid = s.classId || s.class_id || null;
    return {
      ...doc,
      classId:   cid,
      class_id:  cid,
      className: classMap[String(cid)] || s.className || s.class_name || null,
    };
  }).filter(Boolean);

  return sendSuccess(res, {
    count: normalised.length, total: normalised.length,
    students: normalised, data: normalised,
  });
}));

router.get("/students", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  let query = {};
  if (schoolId) query.schoolId = schoolId;

  // FIXED: clean status logic with no unreachable branch
  const statusParam = req.query.status;
  if (statusParam && statusParam !== "all") {
    query.status = statusParam.trim();
  }
  // If "all" or no status → no status filter (return everything)

  if (req.query.classId) query.classId = String(req.query.classId).trim();

  query = addNotDeleted(query);

  const students   = await fetchAllStudents(query);
  const sorted     = students.sort((a, b) => {
    const nameA = (a.studentName || a.name || a.firstName || "").toLowerCase();
    const nameB = (b.studentName || b.name || b.firstName || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });
  const normalised = sorted.map(normaliseStudentDoc).filter(Boolean);

  return sendSuccess(res, {
    count: normalised.length, students: normalised, data: normalised,
  });
}));

router.get("/students/:id", asyncHandler(async (req, res) => {
  const App         = getStudentApplication();
  const S           = getStudent();
  const requestedId = String(req.params.id).trim();
  const schoolId    = resolveSchoolId(req, req.query.schoolId);

  let appDoc     = null;
  let studentDoc = null;

  if (S)   studentDoc = await S.findById(requestedId).lean().catch(() => null);
  if (App) appDoc     = await App.findById(requestedId).lean().catch(() => null);

  if (studentDoc && !appDoc && studentDoc.applicationId && App) {
    appDoc = await App.findById(String(studentDoc.applicationId)).lean().catch(() => null);
  }
  if (appDoc && !studentDoc && appDoc.studentId && S) {
    studentDoc = await S.findById(String(appDoc.studentId)).lean().catch(() => null);
  }

  if (!appDoc && !studentDoc) return sendError(res, 404, "Student not found");

  const ownerDoc = studentDoc || appDoc;
  if (
    schoolId &&
    ownerDoc?.schoolId &&
    String(ownerDoc.schoolId) !== String(schoolId)
  ) {
    return sendError(res, 404, "Student not found");
  }

  const merged = {
    ...(appDoc     || {}),
    ...(studentDoc || {}),
    _id: requestedId,
    id:  requestedId,
    applicationId:   appDoc?._id            || studentDoc?.applicationId || null,
    studentId:       studentDoc?._id        || appDoc?.studentId         || null,
    studentName:     studentDoc?.studentName || appDoc?.studentName       || null,
    firstName:       studentDoc?.firstName   || appDoc?.firstName         || null,
    lastName:        studentDoc?.lastName    || appDoc?.lastName          || null,
    email:           studentDoc?.email       || appDoc?.email             || null,
    phone:           studentDoc?.phone       || appDoc?.phone             || null,
    dateOfBirth:     studentDoc?.dateOfBirth || appDoc?.dateOfBirth       || null,
    gender:          studentDoc?.gender      || appDoc?.gender            || null,
    address:         studentDoc?.address     || appDoc?.address           || null,
    guardianName:    studentDoc?.guardianName  || appDoc?.guardianName    || null,
    guardianPhone:   studentDoc?.guardianPhone || appDoc?.guardianPhone   || null,
    classId:         studentDoc?.classId     || appDoc?.classId           || null,
    className:       studentDoc?.className   || appDoc?.className         || null,
    schoolId:        studentDoc?.schoolId    || appDoc?.schoolId          || null,
    status:          studentDoc?.status      || appDoc?.status            || "approved",
    isActive:        studentDoc?.isActive    ?? appDoc?.isActive          ?? true,
    enrolledAt:      studentDoc?.enrolledAt  || appDoc?.enrolledAt || appDoc?.approvedAt || null,
    createdAt:       studentDoc?.createdAt   || appDoc?.createdAt         || null,
    updatedAt:       studentDoc?.updatedAt   || appDoc?.updatedAt         || null,
    admissionNo:     studentDoc?.admissionNo || appDoc?.admissionNo || appDoc?.admissionNumber || null,
    admissionNumber:
      studentDoc?.admissionNumber ||
      appDoc?.admissionNumber     ||
      studentDoc?.admissionNo     ||
      appDoc?.admissionNo         || null,
  };

  const doc = normaliseStudentDoc(merged);
  return sendSuccess(res, { student: doc, data: doc });
}));

router.delete("/students/:id", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { id }   = req.params;
  let deleted = false, linkedUserId = null;

  const S   = getStudent();
  const App = getStudentApplication();

  // Prefer Student collection first
  if (S) {
    const sRecord = await S.findById(id).lean().catch(() => null);
    if (sRecord) {
      if (schoolId && sRecord.schoolId && String(sRecord.schoolId) !== String(schoolId)) {
        return sendError(res, 403, "Access denied");
      }
      linkedUserId = sRecord.userId || null;
      if (sRecord.applicationId && App) {
        await App.findByIdAndDelete(sRecord.applicationId).catch(() => {});
      }
      await S.findByIdAndDelete(id);
      deleted = true;
    }
  }

  if (!deleted && App) {
    const appRecord = await App.findById(id).lean().catch(() => null);
    if (appRecord) {
      if (schoolId && appRecord.schoolId && String(appRecord.schoolId) !== String(schoolId)) {
        return sendError(res, 403, "Access denied — student does not belong to your school");
      }
      linkedUserId = appRecord.userId || null;
      if (appRecord.studentId && S) {
        await S.findByIdAndDelete(appRecord.studentId).catch(() => {});
      }
      await App.findByIdAndDelete(id);
      deleted = true;
    }
  }

  if (!deleted) return sendError(res, 404, "Student not found");

  if (linkedUserId) {
    await User.findByIdAndDelete(linkedUserId).catch(() => {});
  }

  return sendSuccess(res, {
    message: "Student deleted successfully",
    data:    { studentId: id },
  });
}));

router.patch("/students/:id/suspend", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { id }   = req.params;
  let student = null, model = null;
  const S   = getStudent();
  const App = getStudentApplication();

  if (S)              { const r = await S.findById(id).catch(() => null);   if (r) { student = r; model = S;   } }
  if (!student && App){ const r = await App.findById(id).catch(() => null); if (r) { student = r; model = App; } }
  if (!student) return sendError(res, 404, "Student not found");
  if (schoolId && student.schoolId && String(student.schoolId) !== String(schoolId)) {
    return sendError(res, 403, "Access denied");
  }
  if (student.status === "suspended") {
    return sendError(res, 409, "Student is already suspended");
  }

  student.status = "suspended"; student.isActive = false; student.updatedAt = new Date();
  await student.save();

  if (model === App && student.studentId && S) {
    await S.findByIdAndUpdate(student.studentId, { status: "suspended", isActive: false }).catch(() => {});
  }
  if (model === S && student.applicationId && App) {
    await App.findByIdAndUpdate(student.applicationId, { status: "suspended", isActive: false }).catch(() => {});
  }
  if (student.userId) {
    await User.findByIdAndUpdate(student.userId, { $set: { isActive: false } }).catch(() => {});
  }

  const name = student.studentName || student.name || "Student";
  return sendSuccess(res, {
    message: `"${name}" has been suspended`,
    data:    normaliseStudentDoc(student.toObject()),
  });
}));

router.patch("/students/:id/restore", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { id }   = req.params;
  let student = null, model = null;
  const S   = getStudent();
  const App = getStudentApplication();

  if (S)              { const r = await S.findById(id).catch(() => null);   if (r) { student = r; model = S;   } }
  if (!student && App){ const r = await App.findById(id).catch(() => null); if (r) { student = r; model = App; } }
  if (!student) return sendError(res, 404, "Student not found");
  if (schoolId && student.schoolId && String(student.schoolId) !== String(schoolId)) {
    return sendError(res, 403, "Access denied");
  }
  if (student.status === "approved") {
    return sendError(res, 409, "Student is already active");
  }

  student.status = "approved"; student.isActive = true; student.updatedAt = new Date();
  await student.save();

  if (model === App && student.studentId && S) {
    await S.findByIdAndUpdate(student.studentId, { status: "approved", isActive: true }).catch(() => {});
  }
  if (model === S && student.applicationId && App) {
    await App.findByIdAndUpdate(student.applicationId, { status: "approved", isActive: true }).catch(() => {});
  }
  if (student.userId) {
    await User.findByIdAndUpdate(student.userId, { $set: { isActive: true } }).catch(() => {});
  }

  const name = student.studentName || student.name || "Student";
  return sendSuccess(res, {
    message: `"${name}" has been restored`,
    data:    normaliseStudentDoc(student.toObject()),
  });
}));

router.patch("/students/:id/move", asyncHandler(async (req, res) => {
  const { classId } = req.body;
  if (!classId) return sendError(res, 400, "classId is required in the request body");

  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const { id }   = req.params;
  let student = null, model = null;
  const S   = getStudent();
  const App = getStudentApplication();

  if (S)              { const r = await S.findById(id).catch(() => null);   if (r) { student = r; model = S;   } }
  if (!student && App){ const r = await App.findById(id).catch(() => null); if (r) { student = r; model = App; } }
  if (!student) return sendError(res, 404, "Student not found");
  if (schoolId && student.schoolId && String(student.schoolId) !== String(schoolId)) {
    return sendError(res, 403, "Access denied");
  }

  const targetClass = await Class.findById(classId).lean();
  if (!targetClass) return sendError(res, 404, "Target class not found");
  if (schoolId && String(targetClass.schoolId) !== String(schoolId)) {
    return sendError(res, 403, "Target class does not belong to your school");
  }

  const previousClassId = student.classId;
  student.classId       = classId;
  student.className     = targetClass.name || null;
  student.updatedAt     = new Date();
  await student.save();

  if (model === App && student.studentId && S) {
    await S.findByIdAndUpdate(student.studentId, {
      classId, className: targetClass.name || null,
    }).catch(() => {});
  }
  if (model === S && student.applicationId && App) {
    await App.findByIdAndUpdate(student.applicationId, {
      classId, className: targetClass.name || null,
    }).catch(() => {});
  }

  const className = [targetClass.name, targetClass.section].filter(Boolean).join(" ");
  const name      = student.studentName || student.name || "Student";
  console.log(`[PATCH /students/${id}/move] "${name}" ${previousClassId} → ${classId}`);
  return sendSuccess(res, {
    message: `"${name}" moved to ${className}`,
    data:    { ...normaliseStudentDoc(student.toObject()), className },
  });
}));

router.put("/students/:id/approve", asyncHandler(async (req, res) => {
  const App = getStudentApplication();
  if (!App) return sendError(res, 404, "Application model not found");

  const { classId }  = req.body;
  const application  = await App.findOne(getTenantQuery(req, req.params.id));
  if (!application)  return sendError(res, 404, "Application not found");
  if (application.status === "approved") {
    return sendError(res, 409, "Application already approved");
  }

  let resolvedClass = null;
  if (classId) {
    resolvedClass = await Class.findOne({
      _id: String(classId).trim(), schoolId: application.schoolId, isActive: true,
    }).lean();
    if (!resolvedClass) return sendError(res, 400, "Selected class not found or is inactive");
  }

  const finalClassId   = resolvedClass?._id   || application.classId   || null;
  const finalClassName = resolvedClass?.name   || application.className || null;

  application.status     = "approved";
  application.reviewedBy = req.user?._id;
  application.reviewedAt = new Date();
  application.approvedAt = new Date();
  if (finalClassId)   application.classId   = String(finalClassId);
  if (finalClassName) application.className  = finalClassName;

  const S = getStudent();
  let enrolledStudent = null;

  if (S) {
    try {
      enrolledStudent = await S.create({
        _id:           uuidv4(),
        applicationId: String(application._id),
        studentName:   application.studentName,
        guardianName:  application.guardianName,
        email:         application.email || undefined,
        phone:         application.phone   || null,
        address:       application.address || null,
        schoolId:      application.schoolId,
        classId:       finalClassId ? String(finalClassId) : null,
        className:     finalClassName || null,
        grade:         finalClassName || null,
        enrolledAt:    new Date(),
        isActive:      true,
        status:        "approved",
      });
    } catch (enrollErr) {
      if (enrollErr.code === 11000) {
        enrolledStudent = await S.findOne({ email: application.email }).lean();
      } else {
        console.error("Failed to create enrolled student:", enrollErr.message);
      }
    }
  }

  const studentEmail = application.email?.toLowerCase().trim() || null;
  let newUser        = null;
  let tempPassword   = null;
  let emailResult    = { success: false };
  let warning        = null;
  let emailAttached  = false;

  if (!studentEmail) {
    warning = "Application approved but student has no email address. Login account created without email.";
    try {
      const tempPwd = generateTempPassword();
      newUser = await User.create({
        _id: uuidv4(), name: application.studentName,
        role: "student", schoolId: application.schoolId,
        isActive: true, password: tempPwd,
        mustResetPassword: true, createdBy: req.user?._id,
      });
      tempPassword = tempPwd;
    } catch (err) {
      console.error("Failed to create no-email student account:", err.message);
    }
  } else {
    const existingUser = await User.findOne({ email: studentEmail }).lean();

    if (existingUser) {
      if (existingUser.role === "student") {
        warning =
          `The email (${studentEmail}) is already used by another student. ` +
          `A separate account has been created.`;
        try {
          const tempPwd = generateTempPassword();
          newUser = await User.create({
            _id: uuidv4(), name: application.studentName,
            role: "student", schoolId: application.schoolId,
            isActive: true, password: tempPwd,
            mustResetPassword: true, createdBy: req.user?._id,
          });
          tempPassword = tempPwd;
        } catch (err) {
          console.error("Failed to create sibling student account:", err.message);
        }
      } else {
        warning =
          `The email (${studentEmail}) belongs to a ${existingUser.role} account. ` +
          `A separate student account has been created.`;
        try {
          const tempPwd = generateTempPassword();
          newUser = await User.create({
            _id: uuidv4(), name: application.studentName,
            role: "student", schoolId: application.schoolId,
            isActive: true, password: tempPwd,
            mustResetPassword: true, createdBy: req.user?._id,
          });
          tempPassword = tempPwd;
        } catch (err) {
          console.error("Failed to create staff-parent student account:", err.message);
        }
      }
    } else {
      try {
        const tempPwd = generateTempPassword();
        newUser = await User.create({
          _id: uuidv4(), name: application.studentName,
          email: studentEmail, role: "student",
          schoolId: application.schoolId, isActive: true,
          password: tempPwd, mustResetPassword: true, createdBy: req.user?._id,
        });
        tempPassword  = tempPwd;
        emailAttached = true;
      } catch (userErr) {
        if (userErr.code === 11000) {
          warning = "A user with this email already exists. No new account created.";
          newUser = await User.findOne({ email: studentEmail }).lean();
        } else {
          console.error("Failed to create user account:", userErr.message);
          warning = "Application approved but login account creation failed.";
        }
      }
    }

    if (newUser && tempPassword && emailAttached) {
      const schoolName = await getSchoolName(application.schoolId);
      emailResult = await sendEmailSafe({
        to: studentEmail, template: "studentApproved",
        data: {
          studentName: application.studentName, email: studentEmail,
          tempPassword, className: finalClassName || "your class",
          schoolName, loginUrl: process.env.APP_LOGIN_URL || null,
        },
        context: "studentApproved",
      });
    }
  }

  if (newUser)         application.userId    = String(newUser._id || newUser.id);
  if (enrolledStudent) application.studentId = String(enrolledStudent._id);
  await application.save();

  if (enrolledStudent && newUser && S) {
    await S.findByIdAndUpdate(
      enrolledStudent._id,
      { userId: String(newUser._id || newUser.id) }
    ).catch(() => {});
  }

  return sendSuccess(res, {
    student:      application.toObject(),
    emailSent:    emailResult.success,
    tempPassword: emailResult.success ? undefined : tempPassword || undefined,
    userId:       newUser         ? String(newUser._id || newUser.id) : null,
    studentId:    enrolledStudent ? String(enrolledStudent._id)       : null,
    warning:      warning || undefined,
  });
}));

router.put("/students/:id/reject", asyncHandler(async (req, res) => {
  const App = getStudentApplication();
  if (!App) return sendError(res, 404, "Application model not found");

  const application = await App.findOne(getTenantQuery(req, req.params.id));
  if (!application)  return sendError(res, 404, "Application not found");
  if (application.status === "rejected") {
    return sendError(res, 409, "Application already rejected");
  }

  application.status       = "rejected";
  application.reviewedBy   = req.user?._id;
  application.reviewedAt   = new Date();
  application.rejectedAt   = new Date();
  application.rejectReason =
    typeof req.body.reason === "string" ? req.body.reason.trim() : null;
  await application.save();

  if (application.email) {
    const schoolName = await getSchoolName(application.schoolId);
    await sendEmailSafe({
      to: application.email, template: "studentRejected",
      data: {
        studentName: application.studentName,
        reason:      application.rejectReason,
        schoolName,
      },
      context: "studentRejected",
    });
  }

  return sendSuccess(res, { student: application.toObject() });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — TEACHER ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════

const handleGetAssignments = asyncHandler(async (req, res) => {
  const { schoolId: qSchool, teacherId, classId, subjectId } = req.query;
  const filter = {};
  if (teacherId) filter.teacher = String(teacherId).trim();
  if (classId)   filter.class   = String(classId).trim();
  if (subjectId) filter.subject = String(subjectId).trim();

  const schoolId = resolveSchoolId(req, qSchool);
  if (schoolId) filter.schoolId = schoolId;

  const assignments = await TeacherAssignment
    .find(filter)
    .sort({ createdAt: -1 })
    .lean()
    .maxTimeMS(8000);

  if (!assignments.length) {
    return sendSuccess(res, { assignments: [], data: [], count: 0 });
  }

  const teacherIds    = [...new Set(assignments.map((a) => a.teacher).filter(Boolean))];
  const classIds      = [...new Set(assignments.map((a) => a.class).filter(Boolean))];
  const subjectIds    = [...new Set(assignments.map((a) => a.subject).filter(Boolean))];
  const assignedByIds = [...new Set(assignments.map((a) => a.assignedBy).filter(Boolean))];

  const [teachers, classes, subjects, assignedByUsers] = await Promise.all([
    teacherIds.length    > 0
      ? User.find({ _id: { $in: teacherIds } }).select("name email role").lean().catch(() => [])
      : [],
    classIds.length      > 0
      ? Class.find({ _id: { $in: classIds } }).select("name level section").lean().catch(() => [])
      : [],
    subjectIds.length    > 0
      ? Subject.find({ _id: { $in: subjectIds } }).select("name code class classId").lean().catch(() => [])
      : [],
    assignedByIds.length > 0
      ? User.find({ _id: { $in: assignedByIds } }).select("name").lean().catch(() => [])
      : [],
  ]);

  const teacherMap    = new Map(teachers.map((t)        => [String(t._id), t]));
  const classMap      = new Map(classes.map((c)         => [String(c._id), c]));
  const subjectMap    = new Map(subjects.map((s)        => [String(s._id), normaliseSubject(s)]));
  const assignedByMap = new Map(assignedByUsers.map((u) => [String(u._id), u]));

  const seen       = new Set();
  const normalized = [];

  for (const a of assignments) {
    const tId  = a.teacher    ? String(a.teacher)    : null;
    const cId  = a.class      ? String(a.class)      : null;
    const sId  = a.subject    ? String(a.subject)    : null;
    const abId = a.assignedBy ? String(a.assignedBy) : null;
    const key  = `${tId}|${cId}|${sId}`;

    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      _id: a._id, id: a._id,
      schoolId:   a.schoolId   || null,
      isActive:   a.isActive   ?? true,
      validFrom:  a.validFrom  || null,
      validUntil: a.validUntil || null,
      createdAt:  a.createdAt,
      updatedAt:  a.updatedAt,
      teacher:    tId  ? { _id: tId,  ...(teacherMap.get(tId)     || {}) } : null,
      class:      cId  ? { _id: cId,  ...(classMap.get(cId)       || {}) } : null,
      subject:    sId  ? { _id: sId,  ...(subjectMap.get(sId)     || {}) } : null,
      assignedBy: abId ? { _id: abId, ...(assignedByMap.get(abId) || {}) } : null,
      teacherId: tId, classId: cId, subjectId: sId,
    });
  }

  return sendSuccess(res, {
    assignments: normalized, data: normalized, count: normalized.length,
  });
});

const handleCreateAssignment = asyncHandler(async (req, res) => {
  const { teacherId, classId, subjectId, schoolId: bodySchool } = req.body;
  if (!teacherId || !classId || !subjectId) {
    return sendError(res, 400, "teacherId, classId, and subjectId are required");
  }

  const schoolId = resolveSchoolId(req, bodySchool);

  const [teacher, cls, subject] = await Promise.all([
    User.findOne({ _id: String(teacherId).trim(), schoolId, isActive: true }).lean(),
    Class.findOne({ _id: String(classId).trim(), schoolId }).lean(),
    Subject.findOne({ _id: String(subjectId).trim(), schoolId }).lean().then((s) =>
      s || Subject.findOne({
        _id: String(subjectId).trim(),
        $or: [
          { schoolId: { $exists: false } },
          { schoolId: null               },
          { schoolId: ""                 },
        ],
      }).lean()
    ),
  ]);

  if (!teacher) return sendError(res, 404, "Teacher not found or belongs to another school");
  if (!cls)     return sendError(res, 404, "Class not found or belongs to another school");
  if (!subject) return sendError(res, 404, "Subject not found or belongs to another school");

  const existing = await TeacherAssignment.findOne({
    teacher: String(teacherId).trim(),
    class:   String(classId).trim(),
    subject: String(subjectId).trim(),
  }).lean();

  if (existing) {
    return sendError(res, 409, "Assignment already exists", {
      assignment: existing,
      serverId:   String(existing._id),
    });
  }

  const assignment = await TeacherAssignment.create({
    _id:        uuidv4(),
    schoolId,
    teacher:    String(teacherId).trim(),
    class:      String(classId).trim(),
    subject:    String(subjectId).trim(),
    assignedBy: req.user?._id || req.user?.id || null,
  });

  const response = {
    _id: assignment._id, id: assignment._id, schoolId: assignment.schoolId,
    teacherId: String(teacherId), classId: String(classId), subjectId: String(subjectId),
    teacher:    { _id: String(teacher._id), name: teacher.name, email: teacher.email, role: teacher.role },
    class:      { _id: String(cls._id), name: cls.name, level: cls.level, section: cls.section },
    subject:    { _id: String(subject._id), name: subject.name, code: subject.code },
    assignedBy: null,
    createdAt:  assignment.createdAt,
    updatedAt:  assignment.updatedAt,
  };

  return sendSuccess(res, {
    assignment: response, data: response, serverId: String(assignment._id),
  }, 201);
});

const handleBulkCreate = asyncHandler(async (req, res) => {
  const { teacherId, assignments, schoolId: bodySchool } = req.body;
  const schoolId = resolveSchoolId(req, bodySchool);

  if (!teacherId || !Array.isArray(assignments) || !assignments.length) {
    return sendError(res, 400, "teacherId and assignments[] are required");
  }

  const teacher = await User.findOne({ _id: String(teacherId).trim(), schoolId }).lean();
  if (!teacher) return sendError(res, 404, "Teacher not found or belongs to another school");

  const classIds   = [...new Set(assignments.map((a) => a.classId).filter(Boolean).map(String))];
  const subjectIds = [...new Set(assignments.map((a) => a.subjectId).filter(Boolean).map(String))];

  const [classes, subjects, existingAssignments] = await Promise.all([
    Class.find({ _id: { $in: classIds }, schoolId }).lean(),
    Subject.find({ _id: { $in: subjectIds }, schoolId }).lean(),
    TeacherAssignment.find({
      teacher: String(teacher._id),
      class:   { $in: classIds },
      subject: { $in: subjectIds },
    }).lean(),
  ]);

  const classMap    = new Map(classes.map((c)  => [String(c._id), c]));
  const subjectMap  = new Map(subjects.map((s) => [String(s._id), s]));
  const existingSet = new Set(
    existingAssignments.map((a) => `${String(a.class)}::${String(a.subject)}`)
  );

  const created = [], skipped = [], failed = [];

  for (const a of assignments) {
    const classIdStr   = a.classId   ? String(a.classId).trim()   : null;
    const subjectIdStr = a.subjectId ? String(a.subjectId).trim() : null;

    if (!classIdStr || !subjectIdStr) {
      failed.push({ ...a, reason: "Missing classId or subjectId" }); continue;
    }
    if (!classMap.has(classIdStr)) {
      failed.push({ ...a, reason: "Class not found" }); continue;
    }
    if (!subjectMap.has(subjectIdStr)) {
      failed.push({ ...a, reason: "Subject not found" }); continue;
    }

    const key = `${classIdStr}::${subjectIdStr}`;
    if (existingSet.has(key)) {
      skipped.push({ ...a, reason: "Already exists" }); continue;
    }

    try {
      const doc = await TeacherAssignment.create({
        _id:        uuidv4(),
        schoolId,
        teacher:    String(teacher._id),
        class:      classIdStr,
        subject:    subjectIdStr,
        assignedBy: req.user?._id || null,
      });
      existingSet.add(key);
      created.push({ id: String(doc._id), _id: String(doc._id), classId: classIdStr, subjectId: subjectIdStr });
    } catch (e) {
      if (e.code === 11000) skipped.push({ ...a, reason: "Duplicate" });
      else                  failed.push({ ...a, reason: e.message });
    }
  }

  return sendSuccess(res, {
    message: `Created ${created.length}, skipped ${skipped.length}, failed ${failed.length}`,
    created, skipped, failed,
  }, 201);
});

const handleDeleteAssignment = asyncHandler(async (req, res) => {
  const deleted = await TeacherAssignment.findOneAndDelete(
    getTenantQuery(req, req.params.id)
  );
  if (!deleted) return sendError(res, 404, "Assignment not found");
  return sendSuccess(res, { message: "Assignment removed" });
});

router.get("/teacher-assignments",        handleGetAssignments);
router.post("/teacher-assignments/bulk",  handleBulkCreate);
router.post("/teacher-assignments",       handleCreateAssignment);
router.delete("/teacher-assignments/:id", handleDeleteAssignment);

router.get("/assignments",        handleGetAssignments);
router.post("/assignments/bulk",  handleBulkCreate);
router.post("/assignments",       handleCreateAssignment);
router.delete("/assignments/:id", handleDeleteAssignment);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — SETTINGS: GRADING
// ═════════════════════════════════════════════════════════════════════════════

const DEFAULT_GRADES = [
  { grade: "A+", minMark:  90, maxMark: 100, gpaPoints: 4.0, remark: "Excellent"     },
  { grade: "A",  minMark:  80, maxMark:  89, gpaPoints: 4.0, remark: "Very Good"     },
  { grade: "B+", minMark:  75, maxMark:  79, gpaPoints: 3.5, remark: "Good"          },
  { grade: "B",  minMark:  70, maxMark:  74, gpaPoints: 3.0, remark: "Above Average" },
  { grade: "C+", minMark:  65, maxMark:  69, gpaPoints: 2.5, remark: "Average"       },
  { grade: "C",  minMark:  60, maxMark:  64, gpaPoints: 2.0, remark: "Satisfactory"  },
  { grade: "D",  minMark:  50, maxMark:  59, gpaPoints: 1.0, remark: "Pass"          },
  { grade: "F",  minMark:   0, maxMark:  49, gpaPoints: 0.0, remark: "Fail"          },
];

const getDefaultGradingConfig = (schoolId) => ({
  schoolId, grades: DEFAULT_GRADES, passMark: 50,
  useGpa: false, gpaScale: 4.0, gradingType: "percentage",
});

router.get("/settings/grading", asyncHandler(async (req, res) => {
  const schoolId      = resolveSchoolId(req, req.query.schoolId);
  const GradingConfig = getGradingConfig();
  if (!GradingConfig) {
    return sendSuccess(res, { grading: getDefaultGradingConfig(schoolId) });
  }
  const config =
    (await GradingConfig.findOne({ schoolId }).lean()) ||
    getDefaultGradingConfig(schoolId);
  return sendSuccess(res, { grading: config });
}));

router.put("/settings/grading", asyncHandler(async (req, res) => {
  const schoolId      = resolveSchoolId(req, req.body.schoolId);
  const GradingConfig = getGradingConfig();
  const { grades, passMark, useGpa, gpaScale, gradingType } = req.body;

  if (!GradingConfig) {
    return sendSuccess(res, {
      message: "Grading config saved locally (model not available)",
      grading: req.body,
    });
  }

  const config = await GradingConfig.findOneAndUpdate(
    { schoolId },
    {
      schoolId,
      grades:      grades      || DEFAULT_GRADES,
      passMark:    passMark    ?? 50,
      useGpa:      useGpa      ?? false,
      gpaScale:    gpaScale    ?? 4.0,
      gradingType: gradingType || "percentage",
      updatedBy:   req.user?._id,
    },
    { upsert: true, new: true, runValidators: true }
  );

  return sendSuccess(res, { grading: config });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — SETTINGS: ADMIN MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

router.get("/settings/admins", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const admins   = await User.find({
    schoolId,
    role:     { $in: ["super_admin", "school_admin"] },
    isActive: true,
  }).select("-password -tempPassword").lean();
  return sendSuccess(res, { admins });
}));

router.post("/settings/admins", asyncHandler(async (req, res) => {
  const { name, email, role, schoolId } = req.body;
  if (!name?.trim() || !email?.trim()) {
    return sendError(res, 400, "name and email are required");
  }

  const emailClean = email.toLowerCase().trim();
  if (!isValidEmail(emailClean)) return sendError(res, 400, "A valid email is required");

  const ROLE_ALIASES   = { admin: "school_admin" };
  const requestedRole  = String(role || "school_admin").trim().toLowerCase();
  const normalizedRole = ROLE_ALIASES[requestedRole] || requestedRole;

  if (normalizedRole === "super_admin" && req.user?.role !== "super_admin") {
    return sendError(res, 403, "Only super admins can create super admins");
  }

  const ALLOWED_ROLES = ["super_admin", "school_admin"];
  if (!ALLOWED_ROLES.includes(normalizedRole)) {
    return sendError(res, 400, `Invalid role "${role}". Allowed: school_admin, super_admin`);
  }

  const resolvedSchoolId = resolveSchoolId(req, schoolId);
  if (!resolvedSchoolId) return sendError(res, 400, "schoolId is required to create an admin");

  const existing = await User.findOne({ email: emailClean }).lean();
  if (existing)   return sendError(res, 409, "Email already registered");

  const schoolName = await getSchoolName(resolvedSchoolId);
  const { user: admin, tempPassword } = await createStaffAccount({
    name:      name.trim(),
    email:     emailClean,
    role:      normalizedRole,
    schoolId:  resolvedSchoolId,
    createdBy: req.user?._id,
  });

  const emailResult = await sendEmailSafe({
    to: emailClean, template: "adminWelcome",
    data: {
      adminName: name.trim(), email: emailClean, tempPassword,
      role: normalizedRole, schoolName, loginUrl: process.env.APP_LOGIN_URL || null,
    },
    context: "adminWelcome",
  });

  const adminObj = admin.toObject();
  delete adminObj.password;
  delete adminObj.tempPassword;

  return sendSuccess(res, {
    admin: adminObj, emailSent: emailResult.success, tempPassword,
    message: emailResult.success
      ? `Admin created. Login details sent to ${emailClean}.`
      : `Admin created. Email failed — share credentials manually.`,
  }, 201);
}));

router.post("/settings/admins/:id/reset-password", asyncHandler(async (req, res) => {
  const admin = await User.findOne(getTenantQuery(req, req.params.id));
  if (!admin) return sendError(res, 404, "Admin not found");

  const tempPassword      = generateTempPassword();
  admin.password          = tempPassword;
  admin.mustResetPassword = true;
  await admin.save();

  const schoolName  = await getSchoolName(admin.schoolId);
  const emailResult = await sendEmailSafe({
    to: admin.email, template: "adminWelcome",
    data: {
      adminName: admin.name, email: admin.email, tempPassword,
      role: admin.role, schoolName, loginUrl: process.env.APP_LOGIN_URL || null,
    },
    context: "adminWelcome (reset)",
  });

  return sendSuccess(res, {
    emailSent: emailResult.success,
    tempPassword,
    message: emailResult.success
      ? `Password reset. New credentials emailed to ${admin.email}.`
      : `Password reset. Email failed. Share manually: ${tempPassword}`,
  });
}));

router.delete("/settings/admins/:id", asyncHandler(async (req, res) => {
  if (String(req.params.id) === String(req.user?._id)) {
    return sendError(res, 400, "You cannot remove yourself as admin");
  }

  const admin = await User.findOneAndUpdate(
    getTenantQuery(req, req.params.id),
    { isActive: false },
    { new: true }
  );
  if (!admin) return sendError(res, 404, "Admin not found");

  return sendSuccess(res, { message: "Admin removed" });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — SETTINGS: PROFILE
// ═════════════════════════════════════════════════════════════════════════════

router.get("/settings/profile", asyncHandler(async (req, res) => {
  const user = await User.findById(req.user?._id).select("-password").lean();
  if (!user) return sendError(res, 404, "User not found");
  return sendSuccess(res, { profile: user });
}));

router.put("/settings/profile", asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  const userId          = req.user?._id;
  if (!name?.trim()) return sendError(res, 400, "Name is required");

  const updates = { name: name.trim() };
  if (email) {
    const emailClean = email.toLowerCase().trim();
    if (!isValidEmail(emailClean)) return sendError(res, 400, "A valid email is required");
    const taken = await User.findOne({ email: emailClean, _id: { $ne: userId } }).lean();
    if (taken) return sendError(res, 409, "Email already in use");
    updates.email = emailClean;
  }

  const user = await User.findByIdAndUpdate(userId, updates, {
    new: true, runValidators: true, select: "-password",
  });
  if (!user) return sendError(res, 404, "User not found");
  return sendSuccess(res, { profile: user.toObject() });
}));

router.put("/settings/profile/password", asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user?._id;

  if (!currentPassword || !newPassword) {
    return sendError(res, 400, "currentPassword and newPassword are required");
  }
  if (newPassword.length < 8) {
    return sendError(res, 400, "New password must be at least 8 characters");
  }

  const user = await User.findById(userId).select("+password");
  if (!user) return sendError(res, 404, "User not found");

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) return sendError(res, 401, "Current password is incorrect");

  user.password          = newPassword;
  user.mustResetPassword = false;
  await user.save();

  return sendSuccess(res, { message: "Password changed successfully" });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — SETTINGS: ANALYTICS
// ═════════════════════════════════════════════════════════════════════════════

router.get("/settings/analytics", asyncHandler(async (req, res) => {
  const schoolId  = resolveSchoolId(req, req.query.schoolId);
  const baseQuery = schoolId ? { schoolId } : {};

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  let enrollmentTrend = [], teachersBySubject = [], classLoad = [];

  try {
    const S = getStudent();
    if (S) {
      enrollmentTrend = await S.aggregate([
        { $match: { ...baseQuery, status: "approved", createdAt: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id:   { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
        { $project: { _id: 0, year: "$_id.year", month: "$_id.month", count: 1 } },
      ]);
    }
  } catch { /* ignore */ }

  try {
    teachersBySubject = await TeacherAssignment.aggregate([
      { $match: baseQuery },
      { $group: { _id: "$subject", count: { $sum: 1 } } },
      {
        $lookup: {
          from: "subjects", localField: "_id", foreignField: "_id", as: "subject",
        },
      },
      { $unwind: { path: "$subject", preserveNullAndEmpty: true } },
      {
        $project: {
          _id: 0, subjectName: { $ifNull: ["$subject.name", "Unknown"] }, count: 1,
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);
  } catch { /* ignore */ }

  try {
    const S = getStudent();
    if (S) {
      classLoad = await S.aggregate([
        { $match: { ...baseQuery, status: "approved" } },
        { $group: { _id: "$classId", count: { $sum: 1 } } },
        {
          $lookup: {
            from: "classes", localField: "_id", foreignField: "_id", as: "class",
          },
        },
        { $unwind: { path: "$class", preserveNullAndEmpty: true } },
        {
          $project: {
            _id: 0, className: { $ifNull: ["$class.name", "Unknown"] }, count: 1,
          },
        },
        { $sort: { count: -1 } },
      ]);
    }
  } catch { /* ignore */ }

  const [totalTeachers, totalClasses, totalSubjects, totalAssignments] = await Promise.all([
    User.countDocuments({ ...baseQuery, role: "teacher", isActive: true }),
    Class.countDocuments(addNotDeleted({ ...baseQuery, isActive: true })),
    Subject.countDocuments(baseQuery),
    TeacherAssignment.countDocuments(baseQuery),
  ]);

  return sendSuccess(res, {
    analytics: {
      summary: { totalTeachers, totalClasses, totalSubjects, totalAssignments },
      enrollmentTrend, teachersBySubject, classLoad,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — SCHOOL INFO
// ═════════════════════════════════════════════════════════════════════════════

router.get("/school-info", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  const school   = await School.findById(schoolId)
    .select("name code address city state country phone email logo motto website applicationsOpen isActive")
    .lean();
  if (!school) return sendError(res, 404, "School not found");
  return sendSuccess(res, { school });
}));

router.put("/school-info", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId || req.query.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  const {
    name, code, address, city, state, country,
    phone, email, website, applicationsOpen, logoBase64,
  } = req.body;

  const updateFields = {
    ...(name             !== undefined && { name: name.trim()                  }),
    ...(code             !== undefined && { code: code?.trim() || null         }),
    ...(address          !== undefined && { address                            }),
    ...(city             !== undefined && { city                               }),
    ...(state            !== undefined && { state                              }),
    ...(country          !== undefined && { country                            }),
    ...(phone            !== undefined && { phone                              }),
    ...(email            !== undefined && { email: email?.toLowerCase().trim() }),
    ...(website          !== undefined && { website                            }),
    ...(applicationsOpen !== undefined && { applicationsOpen                   }),
    ...(logoBase64                     && { logo: logoBase64                   }),
  };

  const school = await School.findByIdAndUpdate(
    schoolId, updateFields, { new: true, runValidators: true }
  );
  if (!school) return sendError(res, 404, "School not found");

  return sendSuccess(res, { school });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — ERROR HANDLING
// ═════════════════════════════════════════════════════════════════════════════

router.use((req, res) => {
  res.status(404).json({
    success:   false,
    message:   `Admin route not found: ${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString(),
  });
});

router.use((err, req, res, next) => {
  console.error("❌ Admin routes error:", err.message);
  console.error(err.stack);
  const status  = err.status || err.statusCode || 500;
  const message = err.message || "Internal server error";
  return res.status(status).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === "development" && {
      error: err.message,
      stack: err.stack,
    }),
  });
});

module.exports = router;