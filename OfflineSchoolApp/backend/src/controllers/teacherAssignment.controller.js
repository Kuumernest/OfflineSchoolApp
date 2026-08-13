// backend/controllers/teacherAssignment.controller.js
"use strict";

const TeacherAssignment = require("../db/models/TeacherAssignment");
const User              = require("../db/models/User");
const Class             = require("../db/models/Class");
const Subject           = require("../db/models/Subject");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Serialize one assignment document into a consistent shape
 * that the mobile normaliseRow() can always rely on.
 *
 * Guarantees:
 *   • top-level `id`  (string)  alongside Mongoose `_id`
 *   • top-level `teacherId` / `classId` / `subjectId`  (strings)
 *   • nested  `teacher` / `class` / `subject`  objects with `_id` + `id`
 */
const serialize = (doc) => {
  if (!doc) return null;

  const teacherId  = doc.teacher?._id?.toString() ?? doc.teacher?.toString() ?? null;
  const classId    = doc.class?._id?.toString()   ?? doc.class?.toString()   ?? null;
  const subjectId  = doc.subject?._id?.toString() ?? doc.subject?.toString() ?? null;

  const teacherObj =
    doc.teacher && typeof doc.teacher === "object"
      ? {
          _id:   teacherId,
          id:    teacherId,
          name:  doc.teacher.name  ?? null,
          email: doc.teacher.email ?? null,
          role:  doc.teacher.role  ?? null,
        }
      : null;

  const classObj =
    doc.class && typeof doc.class === "object"
      ? {
          _id:     classId,
          id:      classId,
          name:    doc.class.name    ?? null,
          level:   doc.class.level   ?? null,
          section: doc.class.section ?? null,
        }
      : null;

  const subjectObj =
    doc.subject && typeof doc.subject === "object"
      ? {
          _id:  subjectId,
          id:   subjectId,
          name: doc.subject.name ?? null,
          code: doc.subject.code ?? null,
        }
      : null;

  return {
    _id:       doc._id.toString(),
    id:        doc._id.toString(),
    teacherId,
    classId,
    subjectId,
    schoolId:  doc.schoolId?.toString() ?? doc.school?.toString() ?? null,
    teacher:   teacherObj,
    class:     classObj,
    subject:   subjectObj,
    role:      doc.role      ?? null,
    isPrimary: doc.isPrimary ?? false,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
  };
};

/** Standard populate chain reused on every query */
const withPopulate = (query) =>
  query
    .populate("teacher", "name email role")
    .populate("class",   "name level section")
    .populate("subject", "name code");

// ─────────────────────────────────────────────────────────────
// GET ALL  —  GET /admin/teacher-assignments
// ─────────────────────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const { teacherId, classId, subjectId, schoolId } = req.query;

    const filter = {};
    if (teacherId) filter.teacher  = teacherId;
    if (classId)   filter.class    = classId;
    if (subjectId) filter.subject  = subjectId;
    if (schoolId)  filter.schoolId = schoolId;

    const docs = await withPopulate(
      TeacherAssignment.find(filter).sort({ createdAt: -1 })
    );

    const assignments = docs.map(serialize).filter(Boolean);

    res.json({
      success:     true,
      count:       assignments.length,
      assignments,
    });
  } catch (err) {
    console.error("[getAll] assignments error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET BY TEACHER  —  GET /admin/teacher-assignments/teacher/:teacherId
// ─────────────────────────────────────────────────────────────
exports.getByTeacher = async (req, res) => {
  try {
    const { teacherId } = req.params;

    const docs = await withPopulate(
      TeacherAssignment.find({ teacher: teacherId }).sort({ createdAt: -1 })
    );

    const assignments = docs.map(serialize).filter(Boolean);

    res.json({
      success:     true,
      count:       assignments.length,
      assignments,
    });
  } catch (err) {
    console.error("[getByTeacher] error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch teacher assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET GROUPED BY TEACHER  —  GET /admin/teacher-assignments/by-teacher
// ─────────────────────────────────────────────────────────────
exports.getGroupedByTeacher = async (req, res) => {
  try {
    const docs = await withPopulate(TeacherAssignment.find());

    const grouped = {};

    for (const doc of docs) {
      const tId = doc.teacher?._id?.toString();
      if (!tId) continue;

      if (!grouped[tId]) {
        grouped[tId] = {
          teacher: {
            _id:   tId,
            id:    tId,
            name:  doc.teacher.name  ?? null,
            email: doc.teacher.email ?? null,
            role:  doc.teacher.role  ?? null,
          },
          assignments: [],
        };
      }

      grouped[tId].assignments.push(serialize(doc));
    }

    res.json({
      success: true,
      data:    Object.values(grouped),
    });
  } catch (err) {
    console.error("[getGroupedByTeacher] error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch grouped assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// CREATE  —  POST /admin/teacher-assignments
// ─────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { teacherId, classId, subjectId, schoolId } = req.body;

    if (!teacherId || !classId || !subjectId) {
      return res.status(400).json({
        success: false,
        message: "teacherId, classId, and subjectId are required",
      });
    }

    // ── Validate all referenced documents exist ────────────
    const [teacher, klass, subject] = await Promise.all([
      User.findById(teacherId),
      Class.findById(classId),
      Subject.findById(subjectId),
    ]);

    if (!teacher) {
      return res.status(404).json({ success: false, message: "Teacher not found" });
    }
    if (!klass) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }
    if (!subject) {
      return res.status(404).json({ success: false, message: "Subject not found" });
    }

    // ── Duplicate check ────────────────────────────────────
    // Rule: the SAME teacher cannot be assigned to the SAME
    // subject in the SAME class more than once.
    // Different teachers CAN teach the same subject/class.
    const duplicate = await TeacherAssignment.findOne({
      teacher: teacherId,
      class:   classId,
      subject: subjectId,
    });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "This teacher is already assigned to this subject in this class",
      });
    }

    // ── Create ─────────────────────────────────────────────
    const created = await TeacherAssignment.create({
      teacher:    teacherId,
      class:      classId,
      subject:    subjectId,
      schoolId:   schoolId ?? req.user?.schoolId ?? null,
      assignedBy: req.user?.id ?? null,
    });

    const populated = await withPopulate(
      TeacherAssignment.findById(created._id)
    );

    res.status(201).json({
      success:    true,
      assignment: serialize(populated),
    });
  } catch (err) {
    console.error("[create] assignment error:", err);

    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "This teacher is already assigned to this subject in this class",
      });
    }

    res.status(500).json({ success: false, message: "Failed to create assignment" });
  }
};

// ─────────────────────────────────────────────────────────────
// CREATE BULK  —  POST /admin/teacher-assignments/bulk
// ─────────────────────────────────────────────────────────────
exports.createBulk = async (req, res) => {
  try {
    const { teacherId, assignments, schoolId } = req.body;

    if (!teacherId || !Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({
        success: false,
        message: "teacherId and assignments array are required",
      });
    }

    const teacher = await User.findById(teacherId);
    if (!teacher) {
      return res.status(404).json({ success: false, message: "Teacher not found" });
    }

    const results = { created: [], skipped: [], failed: [] };

    for (const item of assignments) {
      try {
        const { classId, subjectId } = item;

        if (!classId || !subjectId) {
          results.failed.push({ ...item, reason: "Missing classId or subjectId" });
          continue;
        }

        // Same rule as single create
        const duplicate = await TeacherAssignment.findOne({
          teacher: teacherId,
          class:   classId,
          subject: subjectId,
        });

        if (duplicate) {
          results.skipped.push({
            ...item,
            reason: "Teacher already assigned to this subject in this class",
          });
          continue;
        }

        const created = await TeacherAssignment.create({
          teacher:    teacherId,
          class:      classId,
          subject:    subjectId,
          schoolId:   schoolId ?? req.user?.schoolId ?? null,
          assignedBy: req.user?.id ?? null,
        });

        // ── Populate so the mobile client gets name blobs ──
        const populated = await withPopulate(
          TeacherAssignment.findById(created._id)
        );

        results.created.push(serialize(populated));
      } catch (e) {
        console.error("[createBulk] item error:", e.message);
        results.failed.push({ ...item, reason: e.message });
      }
    }

    res.status(201).json({
      success: true,
      message: `Created ${results.created.length}, skipped ${results.skipped.length}, failed ${results.failed.length}`,
      created: results.created,
      skipped: results.skipped,
      failed:  results.failed,
    });
  } catch (err) {
    console.error("[createBulk] error:", err);
    res.status(500).json({ success: false, message: "Failed to create bulk assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE  —  DELETE /admin/teacher-assignments/:id
// ─────────────────────────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const { id }  = req.params;
    const deleted = await TeacherAssignment.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    res.json({ success: true, message: "Assignment removed successfully" });
  } catch (err) {
    console.error("[remove] assignment error:", err);
    res.status(500).json({ success: false, message: "Failed to remove assignment" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET UNASSIGNED  —  GET /admin/teacher-assignments/unassigned
// Returns subjects (per class) that have no teacher assigned
// ─────────────────────────────────────────────────────────────
exports.getUnassigned = async (req, res) => {
  try {
    const [allClasses, allAssignments] = await Promise.all([
      Class.find().populate("subjects"),
      TeacherAssignment.find({}, "class subject"),
    ]);

    // Build a Set of "classId::subjectId" pairs that are assigned
    const assignedKeys = new Set(
      allAssignments.map(
        (a) => `${a.class?.toString()}::${a.subject?.toString()}`
      )
    );

    const unassigned = [];

    for (const klass of allClasses) {
      for (const subject of klass.subjects ?? []) {
        const key = `${klass._id.toString()}::${subject._id.toString()}`;
        if (!assignedKeys.has(key)) {
          unassigned.push({
            class: {
              _id:  klass._id.toString(),
              id:   klass._id.toString(),
              name: klass.name ?? null,
            },
            subject: {
              _id:  subject._id.toString(),
              id:   subject._id.toString(),
              name: subject.name ?? null,
              code: subject.code ?? null,
            },
          });
        }
      }
    }

    res.json({ success: true, count: unassigned.length, data: unassigned });
  } catch (err) {
    console.error("[getUnassigned] error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch unassigned subjects" });
  }
};