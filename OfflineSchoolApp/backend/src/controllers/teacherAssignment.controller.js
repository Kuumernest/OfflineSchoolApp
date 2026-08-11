// backend/controllers/teacherAssignment.controller.js

const TeacherAssignment = require("../db/models/TeacherAssignment");
const User    = require("../db/models/User");
const Class   = require("../db/models/Class");
const Subject = require("../db/models/Subject");

// ─────────────────────────────────────────────────────────────
// GET ALL  —  GET /admin/teacher-assignments
// ─────────────────────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const { teacherId, classId, subjectId } = req.query;
    const filter = {};
    if (teacherId) filter.teacher = teacherId;
    if (classId)   filter.class   = classId;
    if (subjectId) filter.subject = subjectId;

    const assignments = await TeacherAssignment.find(filter)
      .populate("teacher", "name email")
      .populate("class",   "name section")
      .populate("subject", "name code")
      .sort({ createdAt: -1 });

    res.json(assignments);
  } catch (err) {
    console.error("getAll assignments error:", err);
    res.status(500).json({ message: "Failed to fetch assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET BY TEACHER  —  GET /admin/teacher-assignments/teacher/:teacherId
// ─────────────────────────────────────────────────────────────
exports.getByTeacher = async (req, res) => {
  try {
    const { teacherId } = req.params;

    const assignments = await TeacherAssignment.find({ teacher: teacherId })
      .populate("teacher", "name email")
      .populate("class",   "name section")
      .populate("subject", "name code")
      .sort({ createdAt: -1 });

    res.json(assignments);
  } catch (err) {
    console.error("getByTeacher error:", err);
    res.status(500).json({ message: "Failed to fetch teacher assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET GROUPED BY TEACHER  —  GET /admin/teacher-assignments/by-teacher
// ─────────────────────────────────────────────────────────────
exports.getGroupedByTeacher = async (req, res) => {
  try {
    const assignments = await TeacherAssignment.find()
      .populate("teacher", "name email")
      .populate("class",   "name section")
      .populate("subject", "name code");

    const grouped = {};
    assignments.forEach((a) => {
      const tId = a.teacher?._id?.toString();
      if (!tId) return;
      if (!grouped[tId]) {
        grouped[tId] = {
          teacher:     a.teacher,
          assignments: [],
        };
      }
      grouped[tId].assignments.push(a);
    });

    res.json(Object.values(grouped));
  } catch (err) {
    console.error("getGroupedByTeacher error:", err);
    res.status(500).json({ message: "Failed to fetch grouped assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// CREATE  —  POST /admin/teacher-assignments
// ─────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { teacherId, classId, subjectId } = req.body;

    if (!teacherId || !classId || !subjectId) {
      return res.status(400).json({
        message: "teacherId, classId, and subjectId are required",
      });
    }

    // ── Validate all references exist ────────────────────────
    const [teacher, klass, subject] = await Promise.all([
      User.findById(teacherId),
      Class.findById(classId),
      Subject.findById(subjectId),
    ]);

    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    if (!klass)   return res.status(404).json({ message: "Class not found" });
    if (!subject) return res.status(404).json({ message: "Subject not found" });

    // ── Duplicate check ──────────────────────────────────────
    // ✅ RULE: The SAME teacher cannot be assigned to the
    //          SAME subject in the SAME class more than once.
    //          But DIFFERENT teachers CAN teach the same
    //          subject in the same class.
    const duplicate = await TeacherAssignment.findOne({
      teacher: teacherId,
      class:   classId,
      subject: subjectId,
    });

    if (duplicate) {
      return res.status(409).json({
        message: "This teacher is already assigned to this subject in this class",
      });
    }

    // ── Create ───────────────────────────────────────────────
    const assignment = await TeacherAssignment.create({
      teacher:    teacherId,
      class:      classId,
      subject:    subjectId,
      assignedBy: req.user?.id || null,
    });

    const populated = await TeacherAssignment.findById(assignment._id)
      .populate("teacher", "name email")
      .populate("class",   "name section")
      .populate("subject", "name code");

    res.status(201).json({
      success: true,
      data:    populated,
    });
  } catch (err) {
    console.error("create assignment error:", err);
    if (err.code === 11000) {
      return res.status(409).json({
        message: "This teacher is already assigned to this subject in this class",
      });
    }
    res.status(500).json({ message: "Failed to create assignment" });
  }
};

// ─────────────────────────────────────────────────────────────
// CREATE BULK  —  POST /admin/teacher-assignments/bulk
// ─────────────────────────────────────────────────────────────
exports.createBulk = async (req, res) => {
  try {
    const { teacherId, assignments } = req.body;

    if (!teacherId || !Array.isArray(assignments) || assignments.length === 0) {
      return res.status(400).json({
        message: "teacherId and assignments array are required",
      });
    }

    const teacher = await User.findById(teacherId);
    if (!teacher) {
      return res.status(404).json({ message: "Teacher not found" });
    }

    const results = { created: [], skipped: [], failed: [] };

    for (const item of assignments) {
      try {
        const { classId, subjectId } = item;

        if (!classId || !subjectId) {
          results.failed.push({ ...item, reason: "Missing classId or subjectId" });
          continue;
        }

        // ✅ Same rule: only block if THIS teacher already has
        //    THIS subject in THIS class
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
          assignedBy: req.user?.id || null,
        });

        results.created.push(created._id);
      } catch (e) {
        results.failed.push({ ...item, reason: e.message });
      }
    }

    res.status(201).json({
      success: true,
      message: `Created ${results.created.length}, skipped ${results.skipped.length}, failed ${results.failed.length}`,
      ...results,
    });
  } catch (err) {
    console.error("createBulk error:", err);
    res.status(500).json({ message: "Failed to create bulk assignments" });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE  —  DELETE /admin/teacher-assignments/:id
// ─────────────────────────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const { id }    = req.params;
    const deleted   = await TeacherAssignment.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ message: "Assignment not found" });
    }

    res.json({ success: true, message: "Assignment removed successfully" });
  } catch (err) {
    console.error("remove assignment error:", err);
    res.status(500).json({ message: "Failed to remove assignment" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET UNASSIGNED  —  GET /admin/teacher-assignments/unassigned
// Returns subjects (per class) with no teacher assigned
// ─────────────────────────────────────────────────────────────
exports.getUnassigned = async (req, res) => {
  try {
    const allClasses     = await Class.find().populate("subjects");
    const allAssignments = await TeacherAssignment.find();

    const unassigned = [];

    for (const klass of allClasses) {
      const subjects = klass.subjects || [];

      for (const subject of subjects) {
        const isAssigned = allAssignments.some(
          (a) =>
            a.class?.toString()   === klass._id.toString() &&
            a.subject?.toString() === subject._id.toString()
        );

        if (!isAssigned) {
          unassigned.push({
            class:   { _id: klass._id,   name: klass.name   },
            subject: { _id: subject._id, name: subject.name },
          });
        }
      }
    }

    res.json({ success: true, data: unassigned });
  } catch (err) {
    console.error("getUnassigned error:", err);
    res.status(500).json({ message: "Failed to fetch unassigned subjects" });
  }
};