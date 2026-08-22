// backend/routes/attendance.routes.js
"use strict";

const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");

const { StudentAttendance, TeacherAttendance } =
  require("../db/models/Attendance");
const User    = require("../db/models/User");
const Class   = require("../db/models/Class");
const Student = require("../db/models/Student");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const todayStr = () => new Date().toISOString().slice(0, 10);

const dateStr = (d) => {
  if (!d) return todayStr();
  const parsed = new Date(d);
  return isNaN(parsed) ? todayStr() : parsed.toISOString().slice(0, 10);
};

/**
 * Given a user's auth _id, find all Student document IDs that belong to them.
 * Returns an array of string IDs (always includes userId itself as fallback).
 */
const resolveStudentIds = async (userId, schoolId) => {
  const ids = new Set([String(userId)]);

  try {
    const query = {
      $or: [
        { userId:  String(userId) },
        { user_id: String(userId) },
        { authId:  String(userId) },
        { _id:     String(userId) },
      ],
    };
    if (schoolId) query.schoolId = schoolId;

    const students = await Student.find(query)
      .select("_id userId user_id authId")
      .lean();

    for (const s of students) {
      if (s._id)     ids.add(String(s._id));
      if (s.userId)  ids.add(String(s.userId));
      if (s.user_id) ids.add(String(s.user_id));
      if (s.authId)  ids.add(String(s.authId));
    }

    console.log(
      `[resolveStudentIds] userId=${userId} → [${[...ids].join(", ")}]`
    );
  } catch (err) {
    console.warn("[resolveStudentIds] failed:", err.message);
  }

  return [...ids];
};

// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUARDS
//
// This file had none. Every route was reachable by any authenticated user,
// which meant a STUDENT token could read the whole school's roster (every
// name, email and admission number) and — worse — POST to /students/bulk and
// write attendance for the entire school. That was verified, not theoretical.
//
// The shape of the fix:
//
//   • Students keep exactly one thing: their own records. /students/me is
//     already self-scoped, and the generic /students route is now force-scoped
//     for them (see below) rather than blocked, because the mobile student
//     screen calls it and filters client-side.
//
//   • Teachers keep everything they had. Marking a class register is their
//     job, so the student-attendance routes are staffOnly, not adminOnly.
//
//   • Writing STAFF attendance is adminOnly. A teacher marking a colleague
//     present is not a teacher's job, and both clients already assume this —
//     the web console hides the staff register from teachers entirely.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_ROLES = new Set(["super_admin", "school_admin", "admin", "teacher"]);
const ADMIN_ROLES = new Set(["super_admin", "school_admin", "admin"]);

const isStudentRole = (req) => req.user?.role === "student";

const staffOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  if (!STAFF_ROLES.has(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Your role "${req.user.role}" is not permitted.`,
    });
  }
  next();
};

const adminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  if (!ADMIN_ROLES.has(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Admin only. Your role "${req.user.role}" is not permitted.`,
    });
  }
  next();
};

/**
 * For a student caller, resolve which Student ids actually belong to them and
 * stamp them on the request. Downstream handlers use this to override whatever
 * studentId the client asked for — a student cannot read someone else's row by
 * guessing an id, and cannot read the whole school by omitting the filter.
 *
 * Staff pass straight through with no restriction.
 */
const scopeToSelfForStudents = async (req, res, next) => {
  if (!isStudentRole(req)) return next();
  try {
    const userId   = req.user?._id || req.user?.id;
    const schoolId = req.query.schoolId || req.user?.schoolId;
    req.selfStudentIds = await resolveStudentIds(userId, schoolId);
    next();
  } catch (err) {
    console.error("[attendance] scopeToSelfForStudents failed:", err.message);
    // Fail closed: if we cannot establish who they are, show them nothing
    // rather than defaulting to everything.
    req.selfStudentIds = [];
    next();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ── STUDENT ATTENDANCE
// ⚠️  Order matters: specific named routes BEFORE the generic /students route
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/attendance/students/me ──────────────────────────────────────────
// Student-only endpoint — returns only the authenticated student's records.
// Teachers and admins should NOT use this endpoint.
router.get("/students/me", async (req, res) => {
  try {
    const userId   = req.user?._id || req.user?.id;
    const schoolId = req.query.schoolId || req.user?.schoolId;

    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    // Resolve all Student._id values linked to this auth user
    const studentIds = await resolveStudentIds(userId, schoolId);

    const query = {
      studentId: { $in: studentIds },
    };
    if (schoolId) query.schoolId = schoolId;

    const { date, startDate, endDate, status } = req.query;
    if (date) {
      query.date = dateStr(date);
    } else if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = dateStr(startDate);
      if (endDate)   query.date.$lte = dateStr(endDate);
    }
    if (status) query.status = status;

    const records = await StudentAttendance.find(query)
      .sort({ date: -1, markedAt: -1 })
      .lean();

    console.log(
      `[/students/me] userId=${userId} ` +
      `studentIds=[${studentIds.join(",")}] → ${records.length} record(s)`
    );

    return res.json({
      success:    true,
      records,
      count:      records.length,
      studentIds, // returned for client-side debugging
    });
  } catch (err) {
    console.error("GET /attendance/students/me error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch your attendance" });
  }
});

// ── GET /api/attendance/students/roster ──────────────────────────────────────
// Used by teachers/admins to get the list of students in a class.
router.get("/students/roster", staffOnly, async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user?.schoolId;
    const classId  = req.query.classId;

    if (!schoolId) {
      return res.status(400).json({ message: "schoolId is required" });
    }

    const query = { schoolId, isActive: { $ne: false } };
    if (classId) query.classId = classId;

    const students = await Student.find(query)
      .select(
        "_id studentName firstName lastName email " +
        "classId className grade admissionNo"
      )
      .sort({ studentName: 1 })
      .lean();

    console.log(
      `🎓 Student roster: ${students.length} for school=${schoolId}`
    );

    return res.json({ success: true, students, count: students.length });
  } catch (err) {
    console.error("GET /attendance/students/roster error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch student roster" });
  }
});

// ── GET /api/attendance/students/today ───────────────────────────────────────
// Used by teachers/admins to view today's attendance for a class.
// ⚠️  Does NOT scope to a single student — that's what /students/me is for.
router.get("/students/today", staffOnly, async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user?.schoolId;
    const classId  = req.query.classId;
    const today    = todayStr();

    const query = { schoolId, date: today };
    if (classId) query.classId = classId;

    const records = await StudentAttendance.find(query).lean();

    let roster = [];
    if (classId) {
      roster = await Student.find({
        classId,
        schoolId,
        isActive: { $ne: false },
      })
        .select("_id studentName email")
        .lean();
    }

    const markedMap = {};
    for (const r of records) {
      markedMap[r.studentId] = r;
    }

    const rosterWithStatus = roster.map((s) => ({
      student:    s,
      attendance: markedMap[String(s._id)] || null,
    }));

    return res.json({
      success: true,
      date:    today,
      records,
      roster:  rosterWithStatus,
      summary: {
        total:   roster.length,
        marked:  records.length,
        present: records.filter((r) => r.status === "present").length,
        absent:  records.filter((r) => r.status === "absent").length,
        late:    records.filter((r) => r.status === "late").length,
        excused: records.filter((r) => r.status === "excused").length,
      },
    });
  } catch (err) {
    console.error("GET /attendance/students/today error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch today's attendance" });
  }
});

// ── GET /api/attendance/students ─────────────────────────────────────────────
// General-purpose endpoint used by teachers and admins.
// Filters by any combination of schoolId, classId, studentId, date range.
// ⚠️  NO role-based scoping here — teachers need to see all students.
router.get("/students", scopeToSelfForStudents, async (req, res) => {
  try {
    const {
      schoolId: qSchoolId,
      classId,
      studentId,
      date,
      startDate,
      endDate,
      status,
    } = req.query;

    const query = {};

    // schoolId — always required (from query or token)
    query.schoolId = qSchoolId || req.user?.schoolId;

    // Optional filters — all passed explicitly by the caller
    if (classId)   query.classId   = classId;
    if (studentId) query.studentId = studentId;
    if (status)    query.status    = status;

    // ── Self-scope for students ──────────────────────────────────────────────
    // Applied AFTER the caller's filters so it overrides them rather than
    // being overridden. A student asking for someone else's studentId, or
    // omitting it to get the whole school, gets only their own rows either
    // way. scopeToSelfForStudents fails closed, so an unresolvable identity
    // yields an empty list rather than everything.
    //
    // The route stays open to students (rather than staffOnly) because the
    // mobile student attendance screen calls it directly and filters
    // client-side; blocking it would break that screen.
    if (isStudentRole(req)) {
      query.studentId = { $in: req.selfStudentIds ?? [] };
    }

    if (date) {
      query.date = dateStr(date);
    } else if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = dateStr(startDate);
      if (endDate)   query.date.$lte = dateStr(endDate);
    }

    const records = await StudentAttendance.find(query)
      .sort({ date: -1, markedAt: -1 })
      .lean();

    console.log(
      `[/students] schoolId=${query.schoolId} classId=${classId || "*"} ` +
      `studentId=${studentId || "*"} → ${records.length} record(s)`
    );

    return res.json({ success: true, records, count: records.length });
  } catch (err) {
    console.error("GET /attendance/students error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch student attendance" });
  }
});

// ── POST /api/attendance/students/bulk ───────────────────────────────────────
// Used by teachers/admins to mark attendance for an entire class at once.
router.post("/students/bulk", staffOnly, async (req, res) => {
  try {
    const {
      schoolId,
      classId,
      subjectId,
      periodId,
      date,
      records,
    } = req.body;

    if (!classId || !Array.isArray(records) || !records.length) {
      return res.status(400).json({
        message: "classId and records[] are required",
      });
    }

    const resolvedSchoolId = schoolId || req.user?.schoolId;
    const resolvedDate     = dateStr(date);
    const validStatuses    = ["present", "absent", "late", "excused"];

    // ── Verify the students actually exist in this class ─────────────────────
    // Previously the only check was `!row.studentId`, a truthiness test, so any
    // string was accepted and upserted. A replayed request or a client bug
    // could silently create attendance rows for people who are not in the
    // school at all — and those rows cannot be deleted through the API.
    //
    // One query for the whole batch, not one per row: this is a hot path called
    // with a full class register.
    const requestedIds = [
      ...new Set(records.map((x) => x.studentId).filter(Boolean).map(String)),
    ];

    const knownStudents = requestedIds.length
      ? await Student.find({
          _id:      { $in: requestedIds },
          classId,
          schoolId: resolvedSchoolId,
        }).select("_id").lean()
      : [];

    const knownIds = new Set(knownStudents.map((s) => String(s._id)));

    const saved  = [];
    const failed = [];

    for (const row of records) {
      if (!row.studentId || !validStatuses.includes(row.status)) {
        failed.push({ ...row, reason: "Invalid studentId or status" });
        continue;
      }
      if (!knownIds.has(String(row.studentId))) {
        failed.push({
          ...row,
          reason: "Student not found in this class",
        });
        continue;
      }

      try {
        const record = await StudentAttendance.findOneAndUpdate(
          {
            schoolId:  resolvedSchoolId,
            classId,
            subjectId: subjectId || null,
            studentId: row.studentId,
            date:      resolvedDate,
          },
          {
            $set: {
              periodId: periodId || null,
              markedBy: req.user?._id,
              markedAt: new Date(),
              status:   row.status,
              note:     row.note || null,
            },
            $setOnInsert: {
              _id:       uuidv4(),
              schoolId:  resolvedSchoolId,
              classId,
              subjectId: subjectId || null,
              studentId: row.studentId,
              date:      resolvedDate,
            },
          },
          { upsert: true, new: true }
        );
        saved.push(record);
      } catch (e) {
        failed.push({ ...row, reason: e.message });
      }
    }

    console.log(
      `📋 Bulk student attendance: saved=${saved.length} failed=${failed.length}` +
      ` [class=${classId}, date=${resolvedDate}]`
    );

    return res.status(201).json({
      success:       true,
      saved:         saved.length,
      failed:        failed.length,
      failedRecords: failed,
    });
  } catch (err) {
    console.error("POST /attendance/students/bulk error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to bulk mark attendance" });
  }
});

// ── POST /api/attendance/students ────────────────────────────────────────────
// Used by teachers/admins to mark a single student's attendance.
router.post("/students", staffOnly, async (req, res) => {
  try {
    const {
      schoolId,
      classId,
      subjectId,
      periodId,
      studentId,
      date,
      status,
      note,
    } = req.body;

    if (!classId || !studentId || !status) {
      return res.status(400).json({
        message: "classId, studentId and status are required",
      });
    }

    const validStatuses = ["present", "absent", "late", "excused"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const resolvedSchoolId = schoolId || req.user?.schoolId;
    const resolvedDate     = dateStr(date);

    // Same gap as the bulk route had: the upsert would happily create a row for
    // a studentId that belongs to nobody, and there is no DELETE route to undo
    // it. Verify first.
    const exists = await Student.exists({
      _id:      String(studentId),
      classId,
      schoolId: resolvedSchoolId,
    });
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: "Student not found in this class",
      });
    }

    const record = await StudentAttendance.findOneAndUpdate(
      {
        schoolId:  resolvedSchoolId,
        classId,
        subjectId: subjectId || null,
        studentId,
        date:      resolvedDate,
      },
      {
        $set: {
          periodId: periodId || null,
          markedBy: req.user?._id,
          markedAt: new Date(),
          status,
          note:     note || null,
        },
        $setOnInsert: {
          _id:       uuidv4(),
          schoolId:  resolvedSchoolId,
          classId,
          subjectId: subjectId || null,
          studentId,
          date:      resolvedDate,
        },
      },
      { upsert: true, new: true }
    );

    console.log(
      `📋 Student attendance: studentId=${studentId} → ${status} [${resolvedDate}]`
    );

    return res.status(201).json({ success: true, record });
  } catch (err) {
    console.error("POST /attendance/students error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to mark attendance" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── TEACHER ATTENDANCE
// ⚠️  Specific named routes BEFORE the generic /teachers route
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/attendance/teachers/me ──────────────────────────────────────────
// Teacher-only: returns the authenticated teacher's own attendance records.
router.get("/teachers/me", staffOnly, async (req, res) => {
  try {
    const teacherId = String(req.user?._id || req.user?.id || "");
    const schoolId  = req.query.schoolId || req.user?.schoolId;

    if (!teacherId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const query = { teacherId, schoolId };

    const { date, startDate, endDate, status } = req.query;
    if (date) {
      query.date = dateStr(date);
    } else if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = dateStr(startDate);
      if (endDate)   query.date.$lte = dateStr(endDate);
    }
    if (status) query.status = status;

    const records = await TeacherAttendance.find(query)
      .sort({ date: -1 })
      .lean();

    console.log(
      `[/teachers/me] teacherId=${teacherId} → ${records.length} record(s)`
    );

    return res.json({ success: true, records, count: records.length });
  } catch (err) {
    console.error("GET /attendance/teachers/me error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch your attendance" });
  }
});

// ── GET /api/attendance/teachers/roster ──────────────────────────────────────
// Used by admins to get the list of all teachers in a school.
router.get("/teachers/roster", staffOnly, async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user?.schoolId;

    if (!schoolId) {
      return res.status(400).json({ message: "schoolId is required" });
    }

    const teachers = await User.find({
      schoolId,
      role:     "teacher",
      isActive: true,
    })
      .select("_id name email role")
      .lean();

    console.log(
      `👩‍🏫 Teacher roster: ${teachers.length} for school=${schoolId}`
    );

    return res.json({ success: true, teachers, count: teachers.length });
  } catch (err) {
    console.error("GET /attendance/teachers/roster error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch teacher roster" });
  }
});

// ── GET /api/attendance/teachers/today ───────────────────────────────────────
// Used by admins to view all teachers' attendance today.
router.get("/teachers/today", staffOnly, async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user?.schoolId;
    const today    = todayStr();

    const [records, teachers] = await Promise.all([
      TeacherAttendance.find({ schoolId, date: today }).lean(),
      User.find({ schoolId, role: "teacher", isActive: true })
        .select("_id name email")
        .lean(),
    ]);

    const markedMap = {};
    for (const r of records) {
      markedMap[r.teacherId] = r;
    }

    const rosterWithStatus = teachers.map((t) => ({
      teacher:    t,
      attendance: markedMap[String(t._id)] || null,
    }));

    return res.json({
      success: true,
      date:    today,
      records,
      roster:  rosterWithStatus,
      summary: {
        total:    teachers.length,
        marked:   records.length,
        present:  records.filter((r) => r.status === "present").length,
        absent:   records.filter((r) => r.status === "absent").length,
        late:     records.filter((r) => r.status === "late").length,
        on_leave: records.filter((r) => r.status === "on_leave").length,
      },
    });
  } catch (err) {
    console.error("GET /attendance/teachers/today error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch today's teacher attendance" });
  }
});

// ── GET /api/attendance/teachers ─────────────────────────────────────────────
// Used by admins to view teacher attendance records.
// ⚠️  NO role-based scoping — admins need to see all teachers.
router.get("/teachers", staffOnly, async (req, res) => {
  try {
    const {
      schoolId: qSchoolId,
      teacherId,
      date,
      startDate,
      endDate,
      status,
    } = req.query;

    const query = {};

    query.schoolId = qSchoolId || req.user?.schoolId;

    if (teacherId) query.teacherId = teacherId;
    if (status)    query.status    = status;

    if (date) {
      query.date = dateStr(date);
    } else if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = dateStr(startDate);
      if (endDate)   query.date.$lte = dateStr(endDate);
    }

    const records = await TeacherAttendance.find(query)
      .sort({ date: -1, markedAt: -1 })
      .lean();

    console.log(
      `[/teachers] schoolId=${query.schoolId} teacherId=${teacherId || "*"} ` +
      `→ ${records.length} record(s)`
    );

    return res.json({ success: true, records, count: records.length });
  } catch (err) {
    console.error("GET /attendance/teachers error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to fetch teacher attendance" });
  }
});

// ── POST /api/attendance/teachers/bulk ───────────────────────────────────────
// Used by admins to mark attendance for multiple teachers at once.
router.post("/teachers/bulk", adminOnly, async (req, res) => {
  try {
    const { schoolId, date, records } = req.body;

    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ message: "records[] is required" });
    }

    const resolvedSchoolId = schoolId || req.user?.schoolId;
    const resolvedDate     = dateStr(date);
    const validStatuses    = ["present", "absent", "late", "on_leave"];

    // Verify the teachers exist and belong to this school — one query for the
    // batch. Without this the upsert creates staff attendance rows for
    // arbitrary ids, which the API offers no way to remove.
    const requestedIds = [
      ...new Set(records.map((x) => x.teacherId).filter(Boolean).map(String)),
    ];

    const knownTeachers = requestedIds.length
      ? await User.find({
          _id:      { $in: requestedIds },
          schoolId: resolvedSchoolId,
          role:     "teacher",
        }).select("_id").lean()
      : [];

    const knownIds = new Set(knownTeachers.map((t) => String(t._id)));

    const saved  = [];
    const failed = [];

    for (const row of records) {
      if (!row.teacherId || !validStatuses.includes(row.status)) {
        failed.push({ ...row, reason: "Invalid teacherId or status" });
        continue;
      }
      if (!knownIds.has(String(row.teacherId))) {
        failed.push({ ...row, reason: "Teacher not found in this school" });
        continue;
      }

      try {
        const record = await TeacherAttendance.findOneAndUpdate(
          {
            schoolId:  resolvedSchoolId,
            teacherId: row.teacherId,
            date:      resolvedDate,
          },
          {
            $set: {
              markedBy:     req.user?._id,
              markedAt:     new Date(),
              status:       row.status,
              checkInTime:  row.checkInTime  || null,
              checkOutTime: row.checkOutTime || null,
              note:         row.note         || null,
            },
            $setOnInsert: {
              _id:       uuidv4(),
              schoolId:  resolvedSchoolId,
              teacherId: row.teacherId,
              date:      resolvedDate,
            },
          },
          { upsert: true, new: true }
        );
        saved.push(record);
      } catch (e) {
        failed.push({ ...row, reason: e.message });
      }
    }

    console.log(
      `📋 Bulk teacher attendance: saved=${saved.length} failed=${failed.length}` +
      ` [date=${resolvedDate}]`
    );

    return res.status(201).json({
      success:       true,
      saved:         saved.length,
      failed:        failed.length,
      failedRecords: failed,
    });
  } catch (err) {
    console.error("POST /attendance/teachers/bulk error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to bulk mark teacher attendance" });
  }
});

// ── POST /api/attendance/teachers ────────────────────────────────────────────
// Used by admins to mark a single teacher's attendance.
router.post("/teachers", adminOnly, async (req, res) => {
  try {
    const {
      schoolId,
      teacherId,
      date,
      status,
      checkInTime,
      checkOutTime,
      note,
    } = req.body;

    if (!teacherId || !status) {
      return res.status(400).json({
        message: "teacherId and status are required",
      });
    }

    const validStatuses = ["present", "absent", "late", "on_leave"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const resolvedSchoolId = schoolId || req.user?.schoolId;
    const resolvedDate     = dateStr(date);

    // Verify the teacher exists in this school before upserting a row for them.
    const exists = await User.exists({
      _id:      String(teacherId),
      schoolId: resolvedSchoolId,
      role:     "teacher",
    });
    if (!exists) {
      return res.status(404).json({
        success: false,
        message: "Teacher not found in this school",
      });
    }

    const record = await TeacherAttendance.findOneAndUpdate(
      { schoolId: resolvedSchoolId, teacherId, date: resolvedDate },
      {
        $set: {
          markedBy:     req.user?._id,
          markedAt:     new Date(),
          status,
          checkInTime:  checkInTime  || null,
          checkOutTime: checkOutTime || null,
          note:         note         || null,
        },
        $setOnInsert: {
          _id:       uuidv4(),
          schoolId:  resolvedSchoolId,
          teacherId,
          date:      resolvedDate,
        },
      },
      { upsert: true, new: true }
    );

    console.log(
      `📋 Teacher attendance: teacherId=${teacherId} → ${status} [${resolvedDate}]`
    );

    return res.status(201).json({ success: true, record });
  } catch (err) {
    console.error("POST /attendance/teachers error:", err.message);
    return res
      .status(500)
      .json({ message: "Failed to mark teacher attendance" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ── REPORTS
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/attendance/report/overview ──────────────────────────────────────
router.get("/report/overview", staffOnly, async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user?.schoolId;
    const date     = dateStr(req.query.date);

    const [studentRecords, teacherRecords, totalStudents, totalTeachers] =
      await Promise.all([
        StudentAttendance.find({ schoolId, date }).lean(),
        TeacherAttendance.find({ schoolId, date }).lean(),
        Student.countDocuments({ schoolId, isActive: { $ne: false } }),
        User.countDocuments({ schoolId, role: "teacher", isActive: true }),
      ]);

    const studentSummary = {
      total:    totalStudents,
      marked:   studentRecords.length,
      present:  studentRecords.filter((r) => r.status === "present").length,
      absent:   studentRecords.filter((r) => r.status === "absent").length,
      late:     studentRecords.filter((r) => r.status === "late").length,
      excused:  studentRecords.filter((r) => r.status === "excused").length,
      unmarked: totalStudents - studentRecords.length,
      rate: totalStudents > 0
        ? Math.round(
            (studentRecords.filter((r) => r.status === "present").length /
              totalStudents) * 100
          )
        : 0,
    };

    const teacherSummary = {
      total:    totalTeachers,
      marked:   teacherRecords.length,
      present:  teacherRecords.filter((r) => r.status === "present").length,
      absent:   teacherRecords.filter((r) => r.status === "absent").length,
      late:     teacherRecords.filter((r) => r.status === "late").length,
      on_leave: teacherRecords.filter((r) => r.status === "on_leave").length,
      unmarked: totalTeachers - teacherRecords.length,
      rate: totalTeachers > 0
        ? Math.round(
            (teacherRecords.filter((r) => r.status === "present").length /
              totalTeachers) * 100
          )
        : 0,
    };

    return res.json({
      success: true,
      date,
      students: studentSummary,
      teachers: teacherSummary,
    });
  } catch (err) {
    console.error("GET /attendance/report/overview error:", err.message);
    return res.status(500).json({ message: "Failed to fetch overview" });
  }
});

// ── GET /api/attendance/report/weekly ────────────────────────────────────────
router.get("/report/weekly", staffOnly, async (req, res) => {
  try {
    const schoolId = req.query.schoolId || req.user?.schoolId;

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    const startDate = days[0];
    const endDate   = days[days.length - 1];

    const [studentRecords, teacherRecords, totalStudents, totalTeachers] =
      await Promise.all([
        StudentAttendance.find({
          schoolId,
          date: { $gte: startDate, $lte: endDate },
        }).lean(),
        TeacherAttendance.find({
          schoolId,
          date: { $gte: startDate, $lte: endDate },
        }).lean(),
        Student.countDocuments({ schoolId, isActive: { $ne: false } }),
        User.countDocuments({ schoolId, role: "teacher", isActive: true }),
      ]);

    const trend = days.map((day) => {
      const dayStudents = studentRecords.filter((r) => r.date === day);
      const dayTeachers = teacherRecords.filter((r) => r.date === day);

      return {
        date: day,
        students: {
          present: dayStudents.filter((r) => r.status === "present").length,
          absent:  dayStudents.filter((r) => r.status === "absent").length,
          late:    dayStudents.filter((r) => r.status === "late").length,
          excused: dayStudents.filter((r) => r.status === "excused").length,
          total:   totalStudents,
          rate: totalStudents > 0
            ? Math.round(
                (dayStudents.filter((r) => r.status === "present").length /
                  totalStudents) * 100
              )
            : 0,
        },
        teachers: {
          present:  dayTeachers.filter((r) => r.status === "present").length,
          absent:   dayTeachers.filter((r) => r.status === "absent").length,
          late:     dayTeachers.filter((r) => r.status === "late").length,
          on_leave: dayTeachers.filter((r) => r.status === "on_leave").length,
          total:    totalTeachers,
          rate: totalTeachers > 0
            ? Math.round(
                (dayTeachers.filter((r) => r.status === "present").length /
                  totalTeachers) * 100
              )
            : 0,
        },
      };
    });

    return res.json({ success: true, trend, days });
  } catch (err) {
    console.error("GET /attendance/report/weekly error:", err.message);
    return res.status(500).json({ message: "Failed to fetch weekly report" });
  }
});

// ── GET /api/attendance/report/class/:classId ─────────────────────────────────
router.get("/report/class/:classId", staffOnly, async (req, res) => {
  try {
    const schoolId  = req.query.schoolId || req.user?.schoolId;
    const classId   = req.params.classId;
    const startDate = dateStr(req.query.startDate);
    const endDate   = dateStr(req.query.endDate || new Date());

    const [records, roster] = await Promise.all([
      StudentAttendance.find({
        schoolId,
        classId,
        date: { $gte: startDate, $lte: endDate },
      }).lean(),
      Student.find({ classId, schoolId, isActive: { $ne: false } })
        .select("_id studentName email")
        .lean(),
    ]);

    const studentSummary = roster.map((student) => {
      const studentRecords = records.filter(
        (r) => r.studentId === String(student._id)
      );
      const present = studentRecords.filter((r) => r.status === "present").length;
      const absent  = studentRecords.filter((r) => r.status === "absent").length;
      const late    = studentRecords.filter((r) => r.status === "late").length;
      const excused = studentRecords.filter((r) => r.status === "excused").length;
      const total   = studentRecords.length;

      return {
        student,
        present, absent, late, excused, total,
        rate: total > 0 ? Math.round((present / total) * 100) : 0,
      };
    });

    return res.json({
      success: true,
      classId,
      startDate,
      endDate,
      students: studentSummary,
      overall: {
        totalStudents: roster.length,
        totalRecords:  records.length,
        present:  records.filter((r) => r.status === "present").length,
        absent:   records.filter((r) => r.status === "absent").length,
        late:     records.filter((r) => r.status === "late").length,
        excused:  records.filter((r) => r.status === "excused").length,
      },
    });
  } catch (err) {
    console.error("GET /attendance/report/class error:", err.message);
    return res.status(500).json({ message: "Failed to fetch class report" });
  }
});

module.exports = router;