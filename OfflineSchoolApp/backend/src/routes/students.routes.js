// backend/routes/students.routes.js
"use strict";

/**
 * students.routes.js
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CANONICAL SOURCE OF TRUTH                                                 │
 * │                                                                           │
 * │ The `Student` collection is the ONLY canonical store for enrolled         │
 * │ students. `StudentApplication` (if present) is a legacy/optional          │
 * │ intake table and is consulted ONLY as a read fallback in GET /:id.        │
 * │                                                                           │
 * │ Do NOT reintroduce a `resolveReadModel()`-style helper that prefers       │
 * │ StudentApplication over Student — that hides every student created via    │
 * │ direct enrollment (AddStudentPage → POST /apply → PUT /:id/approve).      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const { authenticate } = require("../../middleware/auth");

const Student      = require("../db/models/Student");
const User         = require("../db/models/User");
const Class        = require("../db/models/Class");
const Announcement = require("../db/models/Announcement");
const Content      = require("../db/models/Content");

const { sendEmail } = require("../services/email.service");

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const sendSuccess = (res, data, status = 200) =>
  res.status(status).json({ success: true, ...data });

const sendError = (res, status, message, extra = {}) =>
  res.status(status).json({ success: false, message, ...extra });

const resolveSchoolId = (req, provided) => {
  const explicit = provided || req.query?.schoolId || req.body?.schoolId || null;
  if (req.user?.role === "super_admin" && explicit) return String(explicit).trim();
  return req.user?.schoolId || (explicit ? String(explicit).trim() : null);
};

const canAccess = (req, doc, schoolId) => {
  if (req.user?.role === "super_admin") return true;
  return String(doc?.schoolId ?? "") === String(schoolId ?? "");
};

const escapeRegex = (str) =>
  String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseDate = (value) => {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
};

const lazyModel = (modulePath, label) => {
  let cached    = null;
  let attempted = false;
  return () => {
    if (!attempted) {
      attempted = true;
      try   { cached = require(modulePath); }
      catch { console.warn(`⚠️  Optional model "${label}" not found`); }
    }
    return cached;
  };
};

const getSchoolModel       = lazyModel("../db/models/School",             "School");
const getTeacherAssignment = lazyModel("../db/models/TeacherAssignment",  "TeacherAssignment");
const getStudentApp        = lazyModel("../db/models/StudentApplication", "StudentApplication");

// ─── Shared query clauses ─────────────────────────────────────────────────────

/**
 * FIXED: Widened to catch all falsy deletedAt values.
 * Previously students with deletedAt: undefined (stored as field),
 * deletedAt: 0, or deletedAt: false were excluded from results.
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

const APPROVED_STATUS = {
  $or: [
    { status: "approved"          },
    { status: "active"            },
    { status: { $exists: false }  },
    { status: null                },
  ],
};

const buildStudentFilter = ({ schoolId, status, classId, since, search } = {}) => {
  const and = [NOT_DELETED];

  if (schoolId) and.push({ schoolId: String(schoolId) });

  const s = status ? String(status).trim() : "approved";
  if (s === "approved")      and.push(APPROVED_STATUS);
  else if (s !== "all")      and.push({ status: s });
  // "all" → no status clause → every student returned

  if (classId) and.push({ classId: String(classId).trim() });

  const sinceDate = parseDate(since);
  if (sinceDate) and.push({ updatedAt: { $gte: sinceDate } });

  if (search && String(search).trim()) {
    const rx = new RegExp(escapeRegex(String(search).trim()), "i");
    and.push({
      $or: [
        { name:         rx },
        { studentName:  rx },
        { firstName:    rx },
        { lastName:     rx },
        { email:        rx },
        { admissionNo:  rx },
        { enrollmentNo: rx },
        { guardianName: rx },
      ],
    });
  }

  return { $and: and };
};

// ─── Name / email helpers ─────────────────────────────────────────────────────

const resolveDisplayName = (student) => {
  const fromParts = [student?.firstName, student?.lastName]
    .filter(Boolean).join(" ").trim();
  if (fromParts)            return fromParts;
  if (student?.studentName) return String(student.studentName).trim();
  if (student?.name)        return String(student.name).trim();
  return "Student";
};

const resolveEmail = (student) =>
  (student?.email || student?.studentEmail || student?.parentEmail || "")
    .trim()
    .toLowerCase();

const getSchoolName = async (schoolId) => {
  const fallback = process.env.SCHOOL_NAME || "Your School";
  if (!schoolId) return fallback;
  try {
    const School = getSchoolModel();
    if (!School) return fallback;
    const school = await School.findById(schoolId).lean();
    return school?.name || fallback;
  } catch { return fallback; }
};

const generateTempPassword = () => {
  const words = [
    "Apple","Mango","Cedar","Delta","Eagle","Flame",
    "Grace","Haven","Ivory","Jewel","Karma","Lemon",
    "Maple","Noble","Ocean","Pearl","Queen","River",
    "Stone","Tiger","Unity","Vivid","Witty","Xenon",
    "Yield","Zesty",
  ];
  const word   = words[Math.floor(Math.random() * words.length)];
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  const symbol = ["!", "@", "#", "$"][Math.floor(Math.random() * 4)];
  return `${word}${digits}${symbol}`;
};

const sendEmailSafe = async ({ to, template, data, context = "" }) => {
  try {
    const result = await sendEmail({ to, template, data });
    return result ?? { success: true };
  } catch (err) {
    console.warn(
      `sendEmail failed (non-fatal)${context ? ` [${context}]` : ""}:`,
      err.message
    );
    return { success: false };
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — ENROLLMENT NUMBER HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const resolveSchoolCode = async (schoolId) => {
  if (!schoolId) return "SCH";
  try {
    const School = getSchoolModel();
    if (School) {
      const school = await School.findById(schoolId).select("code").lean();
      if (school?.code) return school.code.trim().toUpperCase().slice(0, 5);
    }
  } catch (err) {
    console.warn("[resolveSchoolCode] failed:", err.message);
  }
  return String(schoolId).replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase() || "SCH";
};

const buildEnrollmentNo = async (schoolCode, year) => {
  const prefix = `${schoolCode}-${year}-`;

  const last = await User.findOne(
    { enrollmentNo: { $regex: `^${escapeRegex(prefix)}` }, role: "student" },
    { enrollmentNo: 1 },
    { sort: { enrollmentNo: -1 } }
  ).lean();

  let nextNum = 1;
  if (last?.enrollmentNo) {
    const parts = last.enrollmentNo.split("-");
    const seq   = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(seq)) nextNum = seq + 1;
  }

  return `${prefix}${String(nextNum).padStart(4, "0")}`;
};

const saveUserWithUniqueEnrollment = async (userAccount, seedNo, schoolId) => {
  let enrollmentNo = seedNo;

  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      userAccount.enrollmentNo = enrollmentNo;
      await userAccount.save();
      return enrollmentNo;
    } catch (err) {
      const dupKeys  = JSON.stringify(err?.keyPattern || err?.keyValue || {});
      const isDupNo  = err?.code === 11000 && dupKeys.includes("enrollmentNo");
      if (!isDupNo || attempt === 3) throw err;

      console.warn(
        `[enrollment] "${enrollmentNo}" collided — regenerating (attempt ${attempt + 1})`
      );
      const schoolCode = await resolveSchoolCode(schoolId);
      enrollmentNo = await buildEnrollmentNo(schoolCode, new Date().getFullYear());
    }
  }

  return enrollmentNo;
};

// ─── NORMALISE ────────────────────────────────────────────────────────────────

const normaliseStudent = (s) => {
  if (!s) return null;
  const id = String(s._id || s.id || "");
  if (!id) return null;
  return {
    ...s,
    id,
    _id:             id,
    name:            resolveDisplayName(s),
    studentName:     s.studentName || resolveDisplayName(s),
    firstName:       s.firstName   || null,
    lastName:        s.lastName    || null,
    email:           resolveEmail(s) || null,
    phone:           s.phone || s.mobile || null,
    gender:          s.gender      || null,
    dateOfBirth:     s.dateOfBirth || s.date_of_birth || s.dob || null,
    address:         s.address     || s.homeAddress   || null,
    classId:         s.classId     || s.class_id      || null,
    class_id:        s.class_id    || s.classId       || null,
    className:       s.className   || s.class_name    || s.grade || null,
    guardianName:    s.guardianName  || s.guardian_name  || null,
    guardianPhone:   s.guardianPhone || s.guardian_phone || null,
    enrollmentNo:    s.enrollmentNo    || s.admissionNo || s.admissionNumber || null,
    admissionNo:     s.admissionNo     || s.enrollmentNo || null,
    admissionNumber: s.admissionNumber || s.admissionNo || s.enrollmentNo || null,
    status:          s.status   || "approved",
    isActive:        s.isActive ?? true,
    enrolledAt:      s.enrolledAt  || s.enrolled_at  || s.approvedAt || null,
    createdAt:       s.createdAt   || null,
    updatedAt:       s.updatedAt   || null,
    schoolId:        s.schoolId    || null,
    userId:          s.userId      || null,
    studentId:       s.studentId   || null,
    notes:           s.notes       || null,
    grade:           s.grade       || s.className || null,
  };
};

const enrichWithClassNames = async (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];

  const classIds = [
    ...new Set(
      list.map((s) => s.classId || s.class_id).filter(Boolean).map(String)
    ),
  ];

  const nameMap = new Map();
  if (classIds.length) {
    const classes = await Class.find({ _id: { $in: classIds } })
      .select("_id name section")
      .lean()
      .catch(() => []);
    for (const c of classes) {
      nameMap.set(String(c._id), [c.name, c.section].filter(Boolean).join(" "));
    }
  }

  return list
    .map((s) => {
      const doc = normaliseStudent(s);
      if (!doc) return null;
      const cid   = doc.classId ? String(doc.classId) : null;
      const cname = (cid && nameMap.get(cid)) || doc.className || null;
      return { ...doc, className: cname, class_name: cname, grade: doc.grade || cname };
    })
    .filter(Boolean);
};

const normaliseContentItem = (item) => {
  if (!item) return null;
  const subjectId   = item.subjectId?._id  || item.subjectId  || null;
  const subjectName = item.subjectId?.name || item.subjectName || null;
  const classId     = item.classId?._id    || item.classId    || null;
  const className   = item.classId?.name   || item.className  || null;
  const classIds    = Array.isArray(item.classIds) && item.classIds.length
    ? item.classIds.map(String)
    : classId ? [String(classId)] : [];
  const classNames  = Array.isArray(item.classNames) && item.classNames.length
    ? item.classNames.map(String)
    : className ? [String(className)] : [];
  return {
    _id:           String(item._id || item.id || ""),
    id:            String(item._id || item.id || ""),
    title:         item.title       || "Untitled",
    description:   item.description || "",
    type:          item.type?.toLowerCase() || "document",
    fileUrl:       item.fileUrl     || item.url || null,
    fileName:      item.fileName    || item.title || null,
    fileSize:      Number(item.fileSize || item.size || 0),
    mimeType:      item.mimeType    || null,
    thumbnail:     item.thumbnail   || null,
    subjectId:     subjectId  ? String(subjectId)  : null,
    subjectName,
    classIds,
    classNames,
    teacherId:     String(item.teacherId || ""),
    status:        item.status       || "active",
    viewCount:     Number(item.viewCount     || 0),
    downloadCount: Number(item.downloadCount || 0),
    createdAt:     item.createdAt   || null,
    updatedAt:     item.updatedAt   || null,
  };
};

const resolveStudentRecord = async (userId, schoolId) => {
  let student = await Student.findOne({ userId, schoolId }).lean();
  if (student) return student;

  student = await Student.findOne({ _id: userId, schoolId }).lean();
  if (student) return student;

  const user = await User.findById(userId).select("email").lean();
  if (user?.email) {
    student = await Student.findOne({
      email: user.email.toLowerCase(),
      schoolId,
    }).lean();
    if (student) return student;
  }

  return null;
};

const getPagination = (req) => {
  const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — ROLE GUARDS
// ═════════════════════════════════════════════════════════════════════════════

const adminOnly = (req, res, next) => {
  const ADMIN_ROLES = ["super_admin", "school_admin", "admin"];
  if (!req.user || !ADMIN_ROLES.includes(req.user.role)) {
    return sendError(
      res, 403,
      `Admin only. Your role "${req.user?.role}" is not permitted.`
    );
  }
  next();
};

const studentOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "student") {
    return sendError(
      res, 403,
      `Students only. Your role "${req.user?.role}" is not permitted.`
    );
  }
  next();
};

const teacherOrAdmin = (req, res, next) => {
  const ALLOWED = ["super_admin", "school_admin", "admin", "teacher"];
  if (!req.user || !ALLOWED.includes(req.user.role)) {
    return sendError(
      res, 403,
      `Teachers and admins only. Your role "${req.user?.role}" is not permitted.`
    );
  }
  next();
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — SHARED DOMAIN LOGIC
// ═════════════════════════════════════════════════════════════════════════════

const findDuplicateStudent = async ({
  schoolId,
  emailClean,
  nameCandidates,
  dateOfBirth,
  guardianName,
}) => {
  if (!nameCandidates.length) return null;

  const nameConditions = nameCandidates
    .filter(Boolean)
    .map((n) => {
      const rx = { $regex: `^${escapeRegex(n)}$`, $options: "i" };
      return { $or: [{ studentName: rx }, { name: rx }] };
    });

  if (!nameConditions.length) return null;

  // Strategy 1: email + name (strongest)
  if (emailClean) {
    return Student.findOne({
      schoolId,
      email:  emailClean,
      status: { $ne: "rejected" },
      $or:    nameConditions,
    }).lean();
  }

  // Strategy 2: name + dateOfBirth
  if (dateOfBirth) {
    const dob = new Date(dateOfBirth);
    if (!Number.isNaN(dob.getTime())) {
      const hit = await Student.findOne({
        schoolId,
        status:      { $ne: "rejected" },
        dateOfBirth: dob,
        $or:         nameConditions,
      }).lean();
      if (hit) return hit;
    }
  }

  // Strategy 3: name + guardianName
  if (guardianName?.trim()) {
    const gRx = { $regex: `^${escapeRegex(guardianName.trim())}$`, $options: "i" };
    const hit = await Student.findOne({
      schoolId,
      status:       { $ne: "rejected" },
      guardianName: gRx,
      $or:          nameConditions,
    }).lean();
    if (hit) return hit;
  }

  // Strategy 4: name alone, no-email students only (last resort)
  return Student.findOne({
    schoolId,
    email:  { $in: [null, "", undefined] },
    status: { $ne: "rejected" },
    $or:    nameConditions,
  }).lean();
};

const provisionStudentAccount = async ({ student, schoolId, displayName, emailRaw }) => {
  const tempPassword = generateTempPassword();
  const schoolCode   = await resolveSchoolCode(schoolId);
  const seedNo       = await buildEnrollmentNo(schoolCode, new Date().getFullYear());

  let userAccount   = null;
  let isNewUser     = false;
  let emailAttached = false;
  let notice        = null;

  if (emailRaw) {
    const existing = await User.findOne({ email: emailRaw.toLowerCase().trim() });

    if (existing) {
      const isOwnAccount =
        student?.userId && String(existing._id) === String(student.userId);

      if (isOwnAccount) {
        existing.name              = displayName;
        existing.isActive          = true;
        existing.schoolId          = schoolId;
        existing.password          = tempPassword;
        existing.mustResetPassword = true;
        userAccount   = existing;
        emailAttached = true;

      } else if (existing.role === "student") {
        const sibling = await Student.findOne({ userId: existing._id })
          .select("name firstName lastName studentName").lean().catch(() => null);

        const siblingName = sibling
          ? resolveDisplayName(sibling)
          : existing.name || "another student";

        notice =
          `The application email (${emailRaw}) is already used by ` +
          `${siblingName} (a sibling or another student). ` +
          `A separate account has been created for ${displayName} — ` +
          `they will log in using their enrollment number. ` +
          `Login credentials have been sent to ${emailRaw} for the parent to share.`;

      } else {
        notice =
          `The application email (${emailRaw}) belongs to a ` +
          `${existing.role} account (${existing.name}). ` +
          `A separate student account has been created — ${displayName} ` +
          `will log in using their enrollment number. ` +
          `Login credentials have been sent to ${emailRaw} for the parent to share.`;
      }
    }
  }

  if (!userAccount) {
    const canAttachEmail = Boolean(emailRaw) && !notice;

    const userFields = {
      _id:               uuidv4(),
      name:              displayName,
      role:              "student",
      schoolId,
      isActive:          true,
      password:          tempPassword,
      mustResetPassword: true,
      enrollmentNo:      seedNo,
    };

    if (canAttachEmail) userFields.email = emailRaw;

    userAccount   = new User(userFields);
    isNewUser     = true;
    emailAttached = canAttachEmail;
  }

  const targetNo     = userAccount.enrollmentNo || seedNo;
  const enrollmentNo = await saveUserWithUniqueEnrollment(userAccount, targetNo, schoolId);

  return { userAccount, enrollmentNo, tempPassword, notice, emailAttached, isNewUser };
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — PUBLIC ROUTES
// ═════════════════════════════════════════════════════════════════════════════

router.post("/apply", asyncHandler(async (req, res) => {
  const {
    firstName, lastName, name, email, phone, dateOfBirth,
    gender, address, guardianName, guardianPhone, guardianEmail,
    schoolId, classId, documents = [],
  } = req.body;

  if (!schoolId) return sendError(res, 400, "schoolId is required");

  const displayName = name?.trim() ||
    [firstName, lastName].filter(Boolean).join(" ").trim();
  if (!displayName) return sendError(res, 400, "Student name is required");

  const emailClean = (email || "").toLowerCase().trim();

  if (emailClean) {
    const nameCandidates = [
      displayName,
      [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ").trim(),
    ].filter(Boolean);

    const duplicate = await findDuplicateStudent({
      schoolId,
      emailClean,
      nameCandidates,
      dateOfBirth:  dateOfBirth  || null,
      guardianName: guardianName || null,
    });

    if (duplicate) {
      return sendError(
        res, 409,
        duplicate.status === "pending"
          ? `An application for "${displayName}" is already pending review.`
          : `"${displayName}" is already enrolled at this school.`
      );
    }
  }

  const normalisedDocs = (Array.isArray(documents) ? documents : [])
    .filter(Boolean)
    .map((doc, i) => ({
      title:    doc.title    || doc.name    || `Document ${i + 1}`,
      url:      doc.url      || doc.uri     || doc.fileUrl || null,
      type:     doc.type     || "document",
      size:     doc.size     || null,
      mimeType: doc.mimeType || null,
    }));

  const student = await Student.create({
    _id:           uuidv4(),
    firstName:     firstName?.trim()     || null,
    lastName:      lastName?.trim()      || null,
    name:          displayName,
    studentName:   displayName,
    email:         emailClean            || undefined,
    phone:         phone?.trim()         || null,
    dateOfBirth:   dateOfBirth           || null,
    gender:        gender                || null,
    address:       address?.trim()       || null,
    guardianName:  guardianName?.trim()  || null,
    guardianPhone: guardianPhone?.trim() || null,
    guardianEmail: (guardianEmail || "").toLowerCase().trim() || undefined,
    schoolId,
    classId:       classId               || null,
    documents:     normalisedDocs,
    status:        "pending",
  });

  return sendSuccess(res, {
    message: "Application submitted successfully. You will be notified once reviewed.",
    data:    { id: student._id, name: displayName, status: "pending" },
  }, 201);
}));

router.get("/application-status/:id", asyncHandler(async (req, res) => {
  const student = await Student.findById(req.params.id)
    .select("status name firstName lastName studentName rejectionReason classId approvedAt enrollmentNo admissionNo")
    .lean();

  if (!student) return sendError(res, 404, "Application not found");

  return sendSuccess(res, {
    data: {
      id:              student._id,
      status:          student.status,
      name:            resolveDisplayName(student),
      enrollmentNo:    student.enrollmentNo || student.admissionNo || null,
      rejectionReason: student.rejectionReason || null,
      approvedAt:      student.approvedAt      || null,
    },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — TEACHER-FACING ROUTES
// ═════════════════════════════════════════════════════════════════════════════

const resolveAssignedClassIds = async (req, schoolId) => {
  const TeacherAssignment = getTeacherAssignment();
  if (!TeacherAssignment) return [];

  try {
    const assignments = await TeacherAssignment.find({
      $or: [{ teacherId: req.user._id }, { teacher: req.user._id }],
      schoolId,
      ...NOT_DELETED,
    }).select("classId class").lean();

    return [
      ...new Set(
        assignments
          .map((a) => String(a.classId || a.class || ""))
          .filter(Boolean)
      ),
    ];
  } catch (err) {
    console.warn("Could not resolve teacher assignments:", err.message);
    return [];
  }
};

const handleTeacherStudents = asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return sendError(res, 400, "schoolId required");

  const { classId } = req.query;
  const assignedClassIds = await resolveAssignedClassIds(req, schoolId);

  const and = [NOT_DELETED, { schoolId: String(schoolId) }, APPROVED_STATUS];

  if (classId) {
    and.push({ classId: String(classId).trim() });
  } else if (assignedClassIds.length > 0) {
    and.push({ classId: { $in: assignedClassIds } });
  } else {
    return sendSuccess(res, { count: 0, students: [], data: [] });
  }

  const students   = await Student.find({ $and: and })
    .sort({ name: 1, firstName: 1 })
    .lean();
  const normalised = await enrichWithClassNames(students);

  return sendSuccess(res, {
    count: normalised.length, students: normalised, data: normalised,
  });
});

router.get("/teacher/students",    authenticate, teacherOrAdmin, handleTeacherStudents);
router.get("/teacher/my-students", authenticate, teacherOrAdmin, handleTeacherStudents);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — STUDENT PROFILE ROUTES
// ═════════════════════════════════════════════════════════════════════════════

router.get(
  "/profile",
  authenticate, studentOnly,
  asyncHandler(async (req, res) => {
    const userId   = req.user._id?.toString();
    const schoolId = resolveSchoolId(req);
    const student  = await resolveStudentRecord(userId, schoolId);

    if (!student) {
      return sendSuccess(res, {
        data: {
          id:               userId,
          userId,
          firstName:        req.user.name?.split(" ")[0]                 || null,
          lastName:         req.user.name?.split(" ").slice(1).join(" ") || null,
          name:             req.user.name  || "",
          email:            req.user.email || "",
          enrollmentNo:     req.user.enrollmentNo || null,
          schoolId,
          classId:          null,
          class_id:         null,
          className:        null,
          admissionNo:      null,
          profileCompleted: false,
        },
      });
    }

    let className = student.class_name || student.className || null;
    if (!className && student.classId) {
      const cls = await Class.findById(student.classId).select("name section").lean();
      className = cls ? [cls.name, cls.section].filter(Boolean).join(" ") : null;
    }

    return sendSuccess(res, {
      data: {
        id:                student._id,
        userId:            student.userId || userId,
        firstName:         student.firstName        || null,
        lastName:          student.lastName         || null,
        name:              resolveDisplayName(student),
        email:             resolveEmail(student),
        enrollmentNo:      req.user.enrollmentNo    || student.admissionNo || null,
        schoolId:          student.schoolId,
        classId:           student.classId          || null,
        class_id:          student.classId          || null,
        className,
        grade:             student.grade            || null,
        gender:            student.gender           || null,
        dateOfBirth:       student.dateOfBirth      || null,
        phone:             student.phone            || null,
        alternatePhone:    student.alternatePhone   || null,
        address:           student.address          || null,
        city:              student.city             || null,
        state:             student.state            || null,
        nationalId:        student.nationalId       || null,
        admissionNo:       student.admissionNo      || student.admissionNumber || null,
        admissionNumber:   student.admissionNumber  || student.admissionNo     || null,
        guardianName:      student.guardianName     || null,
        guardianPhone:     student.guardianPhone    || null,
        guardianRelation:  student.guardianRelation || null,
        guardianEmail:     student.guardianEmail    || null,
        bloodGroup:        student.bloodGroup       || null,
        medicalConditions: student.medicalConditions|| null,
        bio:               student.bio              || null,
        profileCompleted:  student.profileCompleted || false,
        status:            student.status,
      },
    });
  })
);

router.put(
  "/profile",
  authenticate, studentOnly,
  asyncHandler(async (req, res) => {
    const userId   = req.user._id?.toString();
    const schoolId = resolveSchoolId(req);

    const {
      firstName, lastName, gender, dateOfBirth, nationalId,
      phone, alternatePhone, address, city, state,
      guardianName, guardianPhone, guardianRelation, guardianEmail,
      bloodGroup, medicalConditions, bio, profileCompleted,
    } = req.body;

    const allowedUpdate = {};
    if (firstName         !== undefined) allowedUpdate.firstName         = firstName?.trim()         || null;
    if (lastName          !== undefined) allowedUpdate.lastName          = lastName?.trim()          || null;
    if (gender            !== undefined) allowedUpdate.gender            = gender                    || null;
    if (dateOfBirth       !== undefined) allowedUpdate.dateOfBirth       = dateOfBirth               || null;
    if (nationalId        !== undefined) allowedUpdate.nationalId        = nationalId?.trim()        || null;
    if (phone             !== undefined) allowedUpdate.phone             = phone?.trim()             || null;
    if (alternatePhone    !== undefined) allowedUpdate.alternatePhone    = alternatePhone?.trim()    || null;
    if (address           !== undefined) allowedUpdate.address           = address?.trim()           || null;
    if (city              !== undefined) allowedUpdate.city              = city?.trim()              || null;
    if (state             !== undefined) allowedUpdate.state             = state?.trim()             || null;
    if (guardianName      !== undefined) allowedUpdate.guardianName      = guardianName?.trim()      || null;
    if (guardianPhone     !== undefined) allowedUpdate.guardianPhone     = guardianPhone?.trim()     || null;
    if (guardianRelation  !== undefined) allowedUpdate.guardianRelation  = guardianRelation          || null;
    if (guardianEmail     !== undefined) {
      allowedUpdate.guardianEmail = guardianEmail?.trim()?.toLowerCase() || null;
    }
    if (bloodGroup        !== undefined) allowedUpdate.bloodGroup        = bloodGroup                || null;
    if (medicalConditions !== undefined) allowedUpdate.medicalConditions = medicalConditions?.trim() || null;
    if (bio               !== undefined) allowedUpdate.bio               = bio?.trim()               || null;
    if (profileCompleted  !== undefined) allowedUpdate.profileCompleted  = !!profileCompleted;

    const current = await resolveStudentRecord(userId, schoolId);

    if (allowedUpdate.firstName !== undefined || allowedUpdate.lastName !== undefined) {
      const finalFirst = allowedUpdate.firstName ?? current?.firstName ?? "";
      const finalLast  = allowedUpdate.lastName  ?? current?.lastName  ?? "";
      const finalName  = `${finalFirst} ${finalLast}`.trim() || current?.name || "";
      allowedUpdate.name        = finalName;
      allowedUpdate.studentName = finalName;
    }

    if (!current) {
      return sendSuccess(res, {
        message: "Profile data saved locally. No server student record found.",
        data:    { userId, ...allowedUpdate, profileCompleted: !!profileCompleted },
      });
    }

    const updated = await Student.findByIdAndUpdate(
      current._id,
      { $set: allowedUpdate },
      { returnDocument: "after", runValidators: false }
    ).lean();

    if (allowedUpdate.name) {
      await User.findByIdAndUpdate(userId, { $set: { name: allowedUpdate.name } }).catch(() => {});
    }

    return sendSuccess(res, {
      message: "Profile updated successfully",
      data:    normaliseStudent(updated),
    });
  })
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — STUDENT-FACING ROUTES
// ═════════════════════════════════════════════════════════════════════════════

router.get(
  "/me",
  authenticate, studentOnly,
  asyncHandler(async (req, res) => {
    const userId   = req.user._id?.toString();
    const schoolId = resolveSchoolId(req);
    const student  = await resolveStudentRecord(userId, schoolId);

    if (!student) {
      return sendSuccess(res, {
        data: {
          id:           userId,
          userId,
          name:         req.user.name,
          email:        req.user.email,
          enrollmentNo: req.user.enrollmentNo || null,
          schoolId,
          classId:      null,
          class_id:     null,
          className:    null,
          status:       "approved",
        },
      });
    }

    let className = student.class_name || student.className || null;
    if (!className && student.classId) {
      const cls = await Class.findById(student.classId).select("name section").lean();
      className = cls ? [cls.name, cls.section].filter(Boolean).join(" ") : null;
    }

    return sendSuccess(res, {
      data: {
        id:              student._id,
        userId:          student.userId || userId,
        name:            resolveDisplayName(student),
        firstName:       student.firstName || null,
        lastName:        student.lastName  || null,
        email:           resolveEmail(student),
        enrollmentNo:    req.user.enrollmentNo || student.admissionNo || null,
        schoolId:        student.schoolId,
        classId:         student.classId   || null,
        class_id:        student.classId   || null,
        className,
        gender:          student.gender        || null,
        guardianName:    student.guardianName  || null,
        phone:           student.phone         || null,
        grade:           student.grade         || null,
        admissionNo:     student.admissionNo   || null,
        admissionNumber: student.admissionNumber || student.admissionNo || null,
        status:          student.status,
        approvedAt:      student.approvedAt    || null,
      },
    });
  })
);

router.get(
  "/subject-content",
  authenticate, studentOnly,
  asyncHandler(async (req, res) => {
    const { subjectId, classId, type, search } = req.query;
    if (!subjectId) return sendError(res, 400, "subjectId is required");

    const schoolId = resolveSchoolId(req);
    const userId   = req.user._id?.toString();
    const student  = await resolveStudentRecord(userId, schoolId);

    if (student?.classId && classId) {
      if (String(student.classId) !== String(classId)) {
        return sendError(res, 403, "You are not enrolled in the requested class");
      }
    }

    const filter = { subjectId, status: "active" };
    if (classId)                filter.classId = classId;
    else if (student?.classId)  filter.classId = student.classId;
    if (type && type !== "all") filter.type    = type.toLowerCase();

    let items = await Content.find(filter)
      .populate("subjectId", "name code")
      .populate("classId",   "name section")
      .populate("teacherId", "name")
      .sort({ createdAt: -1 })
      .lean();

    if (search?.trim()) {
      const q = search.toLowerCase();
      items = items.filter(
        (i) =>
          i.title?.toLowerCase().includes(q)       ||
          i.description?.toLowerCase().includes(q) ||
          i.fileName?.toLowerCase().includes(q)
      );
    }

    const normalised = items.map(normaliseContentItem).filter(Boolean);
    const summary    = {
      total: normalised.length,
      syllabus: 0, notes: 0, video: 0,
      audio: 0, document: 0, image: 0,
    };
    normalised.forEach((i) => {
      const t = i.type?.toLowerCase();
      if (t && Object.hasOwn(summary, t)) summary[t]++;
    });

    return sendSuccess(res, { items: normalised, summary });
  })
);

router.get(
  "/announcements",
  authenticate, studentOnly,
  asyncHandler(async (req, res) => {
    const { since, subjectId }  = req.query;
    const { page, limit, skip } = getPagination(req);
    const userId                = req.user._id?.toString();
    const schoolId              = resolveSchoolId(req);

    if (!schoolId) return sendError(res, 400, "schoolId could not be resolved");

    const student        = await resolveStudentRecord(userId, schoolId);
    const studentClassId = student?.classId?.toString() || null;

    const audienceConditions = [{ audience: "all" }];
    if (studentClassId) {
      audienceConditions.push({ audience: "class", targetClasses: studentClassId });
    }

    const now    = new Date();
    const filter = {
      schoolId,
      isActive:  true,
      deletedAt: null,
      $or:       audienceConditions,
      $and: [
        { $or: [{ publishAt: null }, { publishAt: { $lte: now } }] },
        { $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] },
      ],
    };

    if (subjectId) filter.subjectId = subjectId;
    const sinceDate = parseDate(since);
    if (sinceDate) filter.updatedAt = { $gte: sinceDate };

    const [announcements, total] = await Promise.all([
      Announcement.find(filter)
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("author",        "name role")
        .populate("targetClasses", "name section")
        .select("-readBy -acknowledgedBy")
        .lean()
        .maxTimeMS(5000),
      Announcement.countDocuments(filter),
    ]);

    const enriched = announcements.map((a) => ({
      ...a,
      isRead:         false,
      isAcknowledged: false,
    }));

    return sendSuccess(res, {
      announcements: enriched,
      data:          enriched,
      pagination:    { page, limit, total, pages: Math.ceil(total / limit) },
    });
  })
);

router.post(
  "/announcements/:id/read",
  authenticate, studentOnly,
  asyncHandler(async (req, res) => {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) return sendError(res, 404, "Announcement not found");

    const userId      = req.user._id;
    const alreadyRead = (announcement.readBy || []).some(
      (r) => r.user?.toString() === String(userId)
    );

    if (!alreadyRead) {
      announcement.readBy.push({ user: userId, readAt: new Date() });
      await announcement.save();
    }

    return sendSuccess(res, { message: "Marked as read" });
  })
);

router.post(
  "/announcements/:id/acknowledge",
  authenticate, studentOnly,
  asyncHandler(async (req, res) => {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) return sendError(res, 404, "Announcement not found");

    const userId     = req.user._id;
    const alreadyAck = (announcement.acknowledgedBy || []).some(
      (r) => r.user?.toString() === String(userId)
    );

    if (!alreadyAck) {
      announcement.acknowledgedBy.push({ user: userId, acknowledgedAt: new Date() });
      await announcement.save();
    }

    return sendSuccess(res, { message: "Acknowledged" });
  })
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — ADMIN LIST / READ ROUTES
// ═════════════════════════════════════════════════════════════════════════════

router.get("/stats/summary", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  const scope        = { $and: [NOT_DELETED, { schoolId: String(schoolId) }] };
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [pending, approved, rejected, suspended, total, thisMonth] = await Promise.all([
    Student.countDocuments({ $and: [...scope.$and, { status: "pending"   }] }),
    Student.countDocuments({ $and: [...scope.$and, APPROVED_STATUS         ] }),
    Student.countDocuments({ $and: [...scope.$and, { status: "rejected"  }] }),
    Student.countDocuments({ $and: [...scope.$and, { status: "suspended" }] }),
    Student.countDocuments(scope),
    Student.countDocuments({ $and: [...scope.$and, { createdAt: { $gte: startOfMonth } }] }),
  ]);

  const data = { pending, approved, rejected, suspended, total, thisMonth };
  return sendSuccess(res, { data, stats: data });
}));

router.get("/pending", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { since, classId, search } = req.query;
  const { page, limit, skip }      = getPagination(req);
  const schoolId                   = resolveSchoolId(req);

  const filter = buildStudentFilter({
    schoolId, status: "pending", classId, since, search,
  });

  const [applications, total] = await Promise.all([
    Student.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Student.countDocuments(filter),
  ]);

  const normalised = await enrichWithClassNames(applications);

  return sendSuccess(res, {
    count:      normalised.length,
    total,
    students:   normalised,
    data:       normalised,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}));

router.get("/approved", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { classId, since, search } = req.query;
  const { page, limit, skip }      = getPagination(req);
  const schoolId                   = resolveSchoolId(req);

  const filter = buildStudentFilter({
    schoolId, status: "approved", classId, since, search,
  });

  const [students, total] = await Promise.all([
    Student.find(filter)
      .sort({ name: 1, studentName: 1, firstName: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Student.countDocuments(filter),
  ]);

  const normalised = await enrichWithClassNames(students);

  return sendSuccess(res, {
    count:      normalised.length,
    total,
    students:   normalised,
    data:       normalised,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG ROUTE — remove after confirming counts match
// GET /api/students/debug-count
// ─────────────────────────────────────────────────────────────────────────────
router.get("/debug-count", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);

  const [
    rawTotal,
    withSchoolId,
    notDeleted,
    statusBreakdown,
    deletedAtBreakdown,
  ] = await Promise.all([
    Student.countDocuments({}),
    Student.countDocuments({ schoolId: String(schoolId) }),
    Student.countDocuments({
      schoolId: String(schoolId),
      $or: [
        { deletedAt: { $exists: false } },
        { deletedAt: null  },
        { deletedAt: ""    },
        { deletedAt: 0     },
        { deletedAt: false },
      ],
    }),
    Student.aggregate([
      { $match: { schoolId: String(schoolId) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Student.aggregate([
      { $match: { schoolId: String(schoolId) } },
      { $group: { _id: "$deletedAt", count: { $sum: 1 } } },
    ]),
  ]);

  return res.json({
    rawTotal,
    withSchoolId,
    notDeleted,
    statusBreakdown,
    deletedAtBreakdown,
  });
}));

// GET /  — generic admin list (status=approved by default, status=all supported)
router.get("/", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { classId, since, search, status = "approved" } = req.query;
  const { page, limit, skip }                           = getPagination(req);
  const schoolId                                        = resolveSchoolId(req);

  const filter = buildStudentFilter({ schoolId, status, classId, since, search });

  const [students, total] = await Promise.all([
    Student.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Student.countDocuments(filter),
  ]);

  const normalised = await enrichWithClassNames(students);

  return sendSuccess(res, {
    count:      normalised.length,
    total,
    students:   normalised,
    data:       normalised,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — ADMIN LIFECYCLE ACTIONS
// ═════════════════════════════════════════════════════════════════════════════

router.post("/", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return sendError(res, 400, "schoolId is required");

  const {
    firstName, lastName, name, email, phone, dateOfBirth,
    gender, address, guardianName, guardianPhone, guardianEmail,
    classId, documents = [], notes,
  } = req.body;

  const displayName = name?.trim() ||
    [firstName, lastName].filter(Boolean).join(" ").trim();
  if (!displayName) return sendError(res, 400, "Student name is required");
  if (!classId)     return sendError(res, 400, "classId is required for direct enrollment");

  const targetClass = await Class.findById(String(classId).trim()).lean();
  if (!targetClass) return sendError(res, 404, "Class not found");
  if (!canAccess(req, targetClass, schoolId)) {
    return sendError(res, 403, "Class does not belong to your school");
  }
  if (targetClass.isActive === false) {
    return sendError(res, 400, "Cannot enroll a student into an inactive class");
  }

  const emailClean = (email || "").toLowerCase().trim();

  if (emailClean) {
    const nameCandidates = [
      displayName,
      [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ").trim(),
    ].filter(Boolean);

    const duplicate = await findDuplicateStudent({
      schoolId,
      emailClean,
      nameCandidates,
      dateOfBirth:  dateOfBirth  || null,
      guardianName: guardianName || null,
    });
    if (duplicate) {
      return sendError(
        res, 409,
        duplicate.status === "pending"
          ? `An application for "${displayName}" is already pending review.`
          : `"${displayName}" is already enrolled at this school.`,
        { studentId: String(duplicate._id) }
      );
    }
  }

  const normalisedDocs = (Array.isArray(documents) ? documents : [])
    .filter(Boolean)
    .map((doc, i) => ({
      title:    doc.title    || doc.name    || `Document ${i + 1}`,
      url:      doc.url      || doc.uri     || doc.fileUrl || null,
      type:     doc.type     || "document",
      size:     doc.size     || null,
      mimeType: doc.mimeType || null,
    }));

  const now       = new Date();
  const className = [targetClass.name, targetClass.section].filter(Boolean).join(" ");

  const student = await Student.create({
    _id:           uuidv4(),
    firstName:     firstName?.trim()     || null,
    lastName:      lastName?.trim()      || null,
    name:          displayName,
    studentName:   displayName,
    email:         emailClean            || undefined,
    phone:         phone?.trim()         || null,
    dateOfBirth:   dateOfBirth           || null,
    gender:        gender                || null,
    address:       address?.trim()       || null,
    guardianName:  guardianName?.trim()  || null,
    guardianPhone: guardianPhone?.trim() || null,
    guardianEmail: (guardianEmail || "").toLowerCase().trim() || undefined,
    notes:         notes?.trim()         || null,
    schoolId,
    classId:       String(targetClass._id),
    className:     targetClass.name || null,
    grade:         targetClass.name || null,
    documents:     normalisedDocs,
    status:        "approved",
    isActive:      true,
    reviewedBy:    req.user._id,
    reviewedAt:    now,
    approvedAt:    now,
    enrolledAt:    now,
  });

  const {
    userAccount, enrollmentNo, tempPassword, notice, emailAttached,
  } = await provisionStudentAccount({
    student, schoolId, displayName, emailRaw: emailClean,
  });

  student.userId      = userAccount._id;
  student.admissionNo = enrollmentNo;
  await student.save();

  let emailResult = { success: false };
  if (emailClean) {
    const schoolName = await getSchoolName(schoolId);
    emailResult = await sendEmailSafe({
      to:       emailClean,
      template: "studentApproved",
      data: {
        studentName:   displayName,
        enrollmentNo,
        tempPassword,
        className:     targetClass.name,
        schoolName,
        loginUrl:      process.env.APP_LOGIN_URL || null,
        parentIsStaff: !!notice,
      },
      context: "studentEnrolled",
    });
  }

  console.log(
    `✅ Direct enroll: "${displayName}" → ${className} | ${enrollmentNo} ` +
    `| emailAttached: ${emailAttached} | notice: ${notice ? "yes" : "no"}`
  );

  return sendSuccess(res, {
    emailSent: emailResult.success,
    warning:   notice,
    message:   notice
      ? `${displayName} enrolled in ${className}. ${notice}`
      : emailResult.success
        ? `${displayName} enrolled in ${className}. Login details sent to ${emailClean}.`
        : `${displayName} enrolled in ${className}. Share the enrollment number and password manually.`,
    enrollmentNo,
    tempPassword,
    student: { ...normaliseStudent(student.toObject()), className },
    data:    { ...normaliseStudent(student.toObject()), className },
  }, 201);
}));

// ── Approve ───────────────────────────────────────────────────────────────────
const handleApprove = asyncHandler(async (req, res) => {
  const { classId } = req.body;
  if (!classId) return sendError(res, 400, "classId is required to approve");

  const student = await Student.findById(req.params.id);
  if (!student)  return sendError(res, 404, "Student application not found");

  const schoolId = resolveSchoolId(req);
  if (!canAccess(req, student, schoolId)) {
    return sendError(res, 403, "Access denied");
  }
  if (student.status !== "pending") {
    return sendError(res, 409, `Application is already ${student.status}`);
  }

  const targetClass = await Class.findById(String(classId).trim()).lean();
  if (!targetClass) return sendError(res, 404, "Class not found");
  if (targetClass.isActive === false) {
    return sendError(res, 400, "Cannot assign student to an inactive class");
  }
  if (!canAccess(req, targetClass, schoolId)) {
    return sendError(res, 403, "Class does not belong to your school");
  }

  const displayName = resolveDisplayName(student);
  const emailRaw    = resolveEmail(student);
  const schoolName  = await getSchoolName(schoolId);

  const {
    userAccount, enrollmentNo, tempPassword, notice, emailAttached, isNewUser,
  } = await provisionStudentAccount({
    student, schoolId: student.schoolId || schoolId, displayName, emailRaw,
  });

  const now           = new Date();
  student.status      = "approved";
  student.isActive    = true;
  student.classId     = String(targetClass._id);
  student.className   = targetClass.name || null;
  student.grade       = student.grade || targetClass.name || null;
  student.userId      = userAccount._id;
  student.reviewedBy  = req.user._id;
  student.reviewedAt  = now;
  student.approvedAt  = now;
  student.enrolledAt  = student.enrolledAt || now;
  student.admissionNo = enrollmentNo;
  await student.save();

  let emailResult = { success: false };
  if (emailRaw) {
    emailResult = await sendEmailSafe({
      to:       emailRaw,
      template: "studentApproved",
      data: {
        studentName:   displayName,
        enrollmentNo,
        tempPassword,
        className:     targetClass.name,
        schoolName,
        loginUrl:      process.env.APP_LOGIN_URL || null,
        parentIsStaff: !!notice,
      },
      context: "studentApproved",
    });
  }

  console.log(
    `✅ Approved: "${displayName}" → ${targetClass.name} ` +
    `| enrollmentNo: ${enrollmentNo} ` +
    `| newUser: ${isNewUser} ` +
    `| emailAttached: ${emailAttached} ` +
    `| notice: ${notice ? "yes" : "no"}`
  );

  let message;
  if (notice) {
    message = `${displayName} approved and assigned to ${targetClass.name}. ${notice}`;
  } else if (emailResult.success) {
    message =
      `${displayName} approved and assigned to ${targetClass.name}. ` +
      `Login details sent to ${emailRaw}.`;
  } else if (emailRaw) {
    message =
      `${displayName} approved and assigned to ${targetClass.name}. ` +
      `Email to ${emailRaw} failed — share credentials manually.`;
  } else {
    message =
      `${displayName} approved. No email on application — ` +
      `share the enrollment number and password with the student directly.`;
  }

  return sendSuccess(res, {
    emailSent: emailResult.success,
    warning:   notice,
    message,
    enrollmentNo,
    tempPassword,
    student: normaliseStudent(student.toObject()),
    data: {
      studentId:  student._id,
      userId:     userAccount._id,
      classId:    String(targetClass._id),
      className:  targetClass.name,
      status:     "approved",
      enrollmentNo,
      emailAttached,
    },
  });
});

router.post("/:id/approve", authenticate, adminOnly, handleApprove);
router.put( "/:id/approve", authenticate, adminOnly, handleApprove);

// ── Reject ────────────────────────────────────────────────────────────────────
const handleReject = asyncHandler(async (req, res) => {
  const { reason = "" } = req.body;

  const student = await Student.findById(req.params.id);
  if (!student)  return sendError(res, 404, "Student application not found");

  const schoolId = resolveSchoolId(req);
  if (!canAccess(req, student, schoolId)) {
    return sendError(res, 403, "Access denied");
  }
  if (student.status !== "pending") {
    return sendError(res, 409, `Application is already ${student.status}`);
  }

  student.status          = "rejected";
  student.rejectionReason = String(reason).trim() || null;
  student.reviewedBy      = req.user._id;
  student.reviewedAt      = new Date();
  student.rejectedAt      = new Date();
  student.isActive        = false;
  await student.save();

  const email = resolveEmail(student);
  let emailResult = { success: false };

  if (email) {
    const schoolName = await getSchoolName(student.schoolId || schoolId);
    emailResult = await sendEmailSafe({
      to:       email,
      template: "studentRejected",
      data: {
        studentName: resolveDisplayName(student),
        reason:      student.rejectionReason,
        schoolName,
      },
      context: "studentRejected",
    });
  }

  return sendSuccess(res, {
    emailSent: emailResult.success,
    message:   "Application rejected successfully.",
    data:      { studentId: student._id, status: "rejected" },
  });
});

router.post("/:id/reject", authenticate, adminOnly, handleReject);
router.put( "/:id/reject", authenticate, adminOnly, handleReject);

// ── Delete ────────────────────────────────────────────────────────────────────
router.delete("/:id", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  const student  = await Student.findById(req.params.id).lean();
  if (!student) return sendError(res, 404, "Student not found");
  if (!canAccess(req, student, schoolId)) {
    return sendError(res, 403, "Access denied");
  }

  await Student.findByIdAndDelete(student._id);
  if (student.userId) {
    await User.findByIdAndDelete(student.userId).catch(() => {});
  }

  console.log(`🗑️  Student deleted: ${student._id} (${resolveDisplayName(student)})`);

  return sendSuccess(res, {
    message: "Student deleted successfully",
    data:    { studentId: req.params.id },
  });
}));

// ── Suspend ───────────────────────────────────────────────────────────────────
router.patch("/:id/suspend", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  const student  = await Student.findById(req.params.id);
  if (!student) return sendError(res, 404, "Student not found");
  if (!canAccess(req, student, schoolId)) {
    return sendError(res, 403, "Access denied");
  }
  if (student.status === "suspended") {
    return sendError(res, 409, "Student is already suspended");
  }

  student.status    = "suspended";
  student.isActive  = false;
  student.updatedAt = new Date();
  await student.save();

  if (student.userId) {
    await User.findByIdAndUpdate(
      student.userId, { $set: { isActive: false } }
    ).catch(() => {});
  }

  return sendSuccess(res, {
    message: `"${resolveDisplayName(student)}" has been suspended`,
    data:    normaliseStudent(student.toObject()),
  });
}));

// ── Restore ───────────────────────────────────────────────────────────────────
router.patch("/:id/restore", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  const student  = await Student.findById(req.params.id);
  if (!student) return sendError(res, 404, "Student not found");
  if (!canAccess(req, student, schoolId)) {
    return sendError(res, 403, "Access denied");
  }
  if (student.status === "approved") {
    return sendError(res, 409, "Student is already active");
  }

  student.status    = "approved";
  student.isActive  = true;
  student.updatedAt = new Date();
  await student.save();

  if (student.userId) {
    await User.findByIdAndUpdate(
      student.userId, { $set: { isActive: true } }
    ).catch(() => {});
  }

  return sendSuccess(res, {
    message: `"${resolveDisplayName(student)}" has been restored`,
    data:    normaliseStudent(student.toObject()),
  });
}));

// ── Move class ────────────────────────────────────────────────────────────────
router.patch("/:id/move", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { classId } = req.body;
  if (!classId) return sendError(res, 400, "classId is required");

  const schoolId = resolveSchoolId(req);
  const student  = await Student.findById(req.params.id);
  if (!student) return sendError(res, 404, "Student not found");
  if (!canAccess(req, student, schoolId)) {
    return sendError(res, 403, "Access denied");
  }

  const targetClass = await Class.findById(String(classId).trim()).lean();
  if (!targetClass) return sendError(res, 404, "Target class not found");
  if (!canAccess(req, targetClass, schoolId)) {
    return sendError(res, 403, "Target class does not belong to your school");
  }
  if (targetClass.isActive === false) {
    return sendError(res, 400, "Cannot move student to an inactive class");
  }

  const prev        = student.classId;
  student.classId   = String(targetClass._id);
  student.className = targetClass.name || null;
  student.grade     = targetClass.name || student.grade || null;
  student.updatedAt = new Date();
  await student.save();

  const className = [targetClass.name, targetClass.section].filter(Boolean).join(" ");

  console.log(`[move] "${resolveDisplayName(student)}" ${prev} → ${student.classId}`);

  return sendSuccess(res, {
    message: `"${resolveDisplayName(student)}" moved to ${className}`,
    data:    { ...normaliseStudent(student.toObject()), className },
  });
}));

// ── GET /:id — MUST be the last route registered ──────────────────────────────
router.get("/:id", authenticate, adminOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  const { id }   = req.params;

  let record = await Student.findById(id).lean();

  if (!record) {
    const App = getStudentApp();
    if (App) record = await App.findById(id).lean().catch(() => null);
  }

  if (!record) return sendError(res, 404, "Student not found");
  if (!canAccess(req, record, schoolId)) {
    return sendError(res, 404, "Student not found");
  }

  let className = record.className || record.class_name || null;
  if (!className && record.classId) {
    const cls = await Class.findById(record.classId).select("name section").lean();
    className = cls ? [cls.name, cls.section].filter(Boolean).join(" ") : null;
  }

  const normalised = { ...normaliseStudent(record), className, class_name: className };

  let mustResetPassword = false;
  if (record.userId) {
    const u = await User.findById(record.userId)
      .select("mustResetPassword enrollmentNo")
      .lean()
      .catch(() => null);

    if (u) {
      if (!normalised.enrollmentNo && u.enrollmentNo) {
        normalised.enrollmentNo = u.enrollmentNo;
      }
      mustResetPassword = !!u.mustResetPassword;
    }
  }

  return sendSuccess(res, {
    student: { ...normalised, mustResetPassword },
    data:    { ...normalised, mustResetPassword },
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
module.exports = router;