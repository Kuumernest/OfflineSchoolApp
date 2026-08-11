"use strict";

const express = require("express");
const router  = express.Router();
const { v4: uuidv4 } = require("uuid");

const User              = require("../db/models/User");
const Class             = require("../db/models/Class");
const Subject           = require("../db/models/Subject");
const TeacherAssignment = require("../db/models/TeacherAssignment");

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Admin guard
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ROLES = new Set(["super_admin", "school_admin", "admin"]);

const adminOnly = (req, res, next) => {
  if (!req.user || !ADMIN_ROLES.has(req.user.role)) {
    return res.status(403).json({ message: "Admin only" });
  }
  next();
};

router.use(adminOnly);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const schoolFilter = (schoolId, req) => {
  const school = schoolId || req.user?.schoolId;
  return school ? { schoolId: school } : {};
};

const normaliseAssignment = (a) => ({
  _id:        a._id,
  id:         a._id,
  schoolId:   a.schoolId,
  isActive:   a.isActive,
  validFrom:  a.validFrom,
  validUntil: a.validUntil,
  createdAt:  a.createdAt,
  updatedAt:  a.updatedAt,
  teacher:    a.teacher   || null,
  class:      a.class     || null,
  subject:    a.subject   || null,
  teacherId:  a.teacher?._id  ?? a.teacher  ?? null,
  classId:    a.class?._id    ?? a.class    ?? null,
  subjectId:  a.subject?._id  ?? a.subject  ?? null,
});

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL ASSIGNMENTS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  console.log("📡 GET /api/admin/teacher-assignments");
  try {
    const { teacherId, classId, subjectId, schoolId } = req.query;

    const filter = { ...schoolFilter(schoolId, req) };
    if (teacherId) filter.teacher = teacherId;
    if (classId)   filter.class   = classId;
    if (subjectId) filter.subject = subjectId;

    const assignments = await TeacherAssignment.find(filter)
      .populate("teacher",    "name email role")
      .populate("class",      "name level section")
      .populate("subject",    "name code")
      .populate("assignedBy", "name")
      .sort({ createdAt: -1 })
      .lean()
      .maxTimeMS(8000);

    const normalized = assignments.map(normaliseAssignment);

    return res.json({
      success:     true,
      assignments: normalized,
      count:       normalized.length,
    });
  } catch (err) {
    console.error("❌ GET /teacher-assignments error:", err.message, err.stack);
    return res.status(500).json({
      message: "Failed to fetch assignments",
      detail:  err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET UNASSIGNED SUBJECTS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/unassigned", async (req, res) => {
  try {
    const { schoolId } = req.query;
    const school       = schoolId || req.user?.schoolId;
    const classFilter  = school ? { schoolId: school } : {};

    const [allClasses, allAssignments] = await Promise.all([
      Class.find(classFilter).populate("subjects", "name code").lean(),
      TeacherAssignment.find(school ? { schoolId: school } : {}).lean(),
    ]);

    const assignedKeys = new Set(
      allAssignments.map((a) => `${String(a.class)}::${String(a.subject)}`)
    );

    const unassigned = [];

    for (const klass of allClasses) {
      for (const subject of (klass.subjects || [])) {
        const key = `${String(klass._id)}::${String(subject._id)}`;
        if (!assignedKeys.has(key)) {
          unassigned.push({
            class:   { _id: klass._id,   name: klass.name },
            subject: { _id: subject._id, name: subject.name, code: subject.code },
          });
        }
      }
    }

    return res.json({ success: true, data: unassigned, count: unassigned.length });
  } catch (err) {
    console.error("❌ GET /unassigned error:", err.message);
    return res.status(500).json({
      message: "Failed to fetch unassigned subjects",
      detail:  err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET BY TEACHER
// ─────────────────────────────────────────────────────────────────────────────
router.get("/teacher/:teacherId", async (req, res) => {
  try {
    const assignments = await TeacherAssignment.find({
      teacher: req.params.teacherId,
    })
      .populate("teacher", "name email")
      .populate("class",   "name section level")
      .populate("subject", "name code")
      .sort({ createdAt: -1 })
      .lean()
      .maxTimeMS(8000);

    return res.json({
      success:     true,
      assignments: assignments.map(normaliseAssignment),
      count:       assignments.length,
    });
  } catch (err) {
    console.error("❌ GET /teacher/:id error:", err.message);
    return res.status(500).json({
      message: "Failed to fetch teacher assignments",
      detail:  err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ASSIGNMENT
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  console.log("📡 POST /api/admin/teacher-assignments body:", req.body);
  try {
    const { teacherId, classId, subjectId } = req.body;

    if (!teacherId || !classId || !subjectId) {
      return res.status(400).json({
        message: "teacherId, classId, and subjectId are required",
      });
    }

    const [teacher, classDoc, subjectDoc] = await Promise.all([
      User.findById(teacherId).lean(),
      Class.findById(classId).lean(),
      Subject.findById(subjectId).lean(),
    ]);

    if (!teacher)    return res.status(404).json({ message: "Teacher not found" });
    if (!classDoc)   return res.status(404).json({ message: "Class not found" });
    if (!subjectDoc) return res.status(404).json({ message: "Subject not found" });

    if (ADMIN_ROLES.has(teacher.role)) {
      return res.status(400).json({
        message: `User "${teacher.name}" has role "${teacher.role}" — cannot be assigned as a teacher`,
      });
    }

    const schoolId =
      teacher.schoolId    ||
      classDoc.schoolId   ||
      subjectDoc.schoolId ||
      req.user?.schoolId  ||
      null;

    const existing = await TeacherAssignment.findOne({
      teacher: teacherId,
      class:   classId,
      subject: subjectId,
    }).lean();

    if (existing) {
      return res.status(409).json({
        message:    "Assignment already exists",
        assignment: normaliseAssignment(existing),
        serverId:   existing._id,
      });
    }

    const assignment = await TeacherAssignment.create({
      _id:        uuidv4(),
      schoolId,
      teacher:    teacherId,
      class:      classId,
      subject:    subjectId,
      assignedBy: req.user?._id || req.user?.id || null,
    });

    const populated = await TeacherAssignment.findById(assignment._id)
      .populate("teacher", "name email")
      .populate("class",   "name section level")
      .populate("subject", "name code")
      .lean();

    console.log(`✅ Assignment created: ${assignment._id}`);
    return res.status(201).json({
      success:    true,
      assignment: normaliseAssignment(populated),
      serverId:   assignment._id,
      data:       normaliseAssignment(populated),
    });
  } catch (err) {
    console.error("❌ POST /teacher-assignments error:", err.message, err.stack);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Assignment already exists" });
    }
    return res.status(500).json({
      message: "Failed to create assignment",
      detail:  err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BULK CREATE
// ─────────────────────────────────────────────────────────────────────────────
router.post("/bulk", async (req, res) => {
  try {
    const { teacherId, assignments } = req.body;

    if (!teacherId || !Array.isArray(assignments) || !assignments.length) {
      return res.status(400).json({
        message: "teacherId and assignments[] are required",
      });
    }

    const teacher = await User.findById(teacherId).lean();
    if (!teacher) {
      return res.status(404).json({ message: "Teacher not found" });
    }

    if (ADMIN_ROLES.has(teacher.role)) {
      return res.status(400).json({
        message: `User "${teacher.name}" has role "${teacher.role}" — cannot be assigned as a teacher`,
      });
    }

    const classIds   = [...new Set(assignments.map((a) => a.classId).filter(Boolean))];
    const subjectIds = [...new Set(assignments.map((a) => a.subjectId).filter(Boolean))];

    const [classes, subjects, existingAssignments] = await Promise.all([
      Class.find({ _id: { $in: classIds } }).lean(),
      Subject.find({ _id: { $in: subjectIds } }).lean(),
      TeacherAssignment.find({
        teacher: teacherId,
        class:   { $in: classIds },
        subject: { $in: subjectIds },
      }).lean(),
    ]);

    const classMap   = new Map(classes.map((c)  => [String(c._id), c]));
    const subjectMap = new Map(subjects.map((s) => [String(s._id), s]));
    const existingSet = new Set(
      existingAssignments.map((a) => `${String(a.class)}::${String(a.subject)}`)
    );

    const results = { created: [], skipped: [], failed: [] };

    for (const item of assignments) {
      const { classId, subjectId } = item;

      if (!classId || !subjectId) {
        results.failed.push({ ...item, reason: "Missing classId or subjectId" });
        continue;
      }

      const classDoc   = classMap.get(String(classId));
      const subjectDoc = subjectMap.get(String(subjectId));

      if (!classDoc)   { results.failed.push({ ...item, reason: "Class not found" });   continue; }
      if (!subjectDoc) { results.failed.push({ ...item, reason: "Subject not found" }); continue; }

      const key = `${String(classId)}::${String(subjectId)}`;
      if (existingSet.has(key)) {
        results.skipped.push({ ...item, reason: "Already assigned" });
        continue;
      }

      try {
        const schoolId =
          teacher.schoolId    ||
          classDoc.schoolId   ||
          subjectDoc.schoolId ||
          req.user?.schoolId  ||
          null;

        const created = await TeacherAssignment.create({
          _id:        uuidv4(),
          schoolId,
          teacher:    teacherId,
          class:      classId,
          subject:    subjectId,
          assignedBy: req.user?._id || req.user?.id || null,
        });

        existingSet.add(key);

        results.created.push({
          id:        String(created._id),
          _id:       String(created._id),
          classId:   String(classId),
          subjectId: String(subjectId),
        });
      } catch (e) {
        if (e.code === 11000) {
          results.skipped.push({ ...item, reason: "Duplicate" });
        } else {
          results.failed.push({ ...item, reason: e.message });
        }
      }
    }

    console.log(
      `✅ Bulk: created=${results.created.length}`,
      `skipped=${results.skipped.length}`,
      `failed=${results.failed.length}`
    );

    return res.status(201).json({
      success: true,
      message: `Created ${results.created.length}, skipped ${results.skipped.length}, failed ${results.failed.length}`,
      ...results,
    });
  } catch (err) {
    console.error("❌ POST /bulk error:", err.message, err.stack);
    return res.status(500).json({
      message: "Failed to bulk create assignments",
      detail:  err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE ASSIGNMENT
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await TeacherAssignment.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    console.log(`🗑️ Assignment deleted: ${req.params.id}`);
    return res.json({ success: true, message: "Assignment deleted" });
  } catch (err) {
    console.error("❌ DELETE /:id error:", err.message);
    return res.status(500).json({
      message: "Failed to delete assignment",
      detail:  err.message,
    });
  }
});

module.exports = router;