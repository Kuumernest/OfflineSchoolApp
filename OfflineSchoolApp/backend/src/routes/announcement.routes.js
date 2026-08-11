// backend/src/routes/announcement.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");

const Announcement = require("../db/models/Announcement");
const User         = require("../db/models/User");

// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUARDS
// ─────────────────────────────────────────────────────────────────────────────

const adminOnly = (req, res, next) => {
  const allowed = ["super_admin", "school_admin"];
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({
      message: `Admin only. Your role "${req.user?.role}" is not permitted.`,
    });
  }
  next();
};

const adminOrTeacher = (req, res, next) => {
  const allowed = ["super_admin", "school_admin", "teacher"];
  if (!req.user || !allowed.includes(req.user.role)) {
    return res.status(403).json({ message: "Not authorized" });
  }
  next();
};

const authenticated = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  next();
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
  res.on("finish", () => {
    res.removeHeader("ETag");
    res.removeHeader("Last-Modified");
  });
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const resolveStudentClassId = async (userId, schoolId) => {
  try {
    let Student = null;
    try { Student = require("../db/models/Student"); } catch { /* not available */ }

    if (Student) {
      const student = await Student.findOne({
        $or: [
          { user:    userId },
          { user_id: userId },
          { userId:  userId },
          { _id:     userId },
        ],
        ...(schoolId ? { schoolId } : {}),
      })
        .select("class classId class_id")
        .lean();

      if (student) {
        const resolved =
          student.class?._id?.toString() ||
          student.class?.toString()       ||
          student.classId?.toString()     ||
          student.class_id?.toString()    ||
          null;
        if (resolved) return resolved;
      }
    }

    const user = await User.findById(userId)
      .select("classId class_id currentClass")
      .lean();

    return (
      user?.classId?.toString()      ||
      user?.class_id?.toString()     ||
      user?.currentClass?.toString() ||
      null
    );
  } catch (err) {
    console.warn("[resolveStudentClassId] server error:", err.message);
    return null;
  }
};

const resolveTeacherClassIds = async (teacherId, schoolId) => {
  try {
    let TeacherAssignment = null;
    try {
      TeacherAssignment = require("../db/models/TeacherAssignment");
    } catch { /* not available */ }

    if (TeacherAssignment) {
      const assignments = await TeacherAssignment.find({
        $or:       [{ teacher: teacherId }, { teacherId }],
        deletedAt: null,
        ...(schoolId ? { schoolId } : {}),
      })
        .select("class classId class_id")
        .lean();

      const ids = assignments
        .map(
          (a) =>
            a.class?._id?.toString() ||
            a.class?.toString()       ||
            a.classId?.toString()     ||
            a.class_id?.toString()
        )
        .filter(Boolean);

      if (ids.length) return [...new Set(ids)];
    }

    const user = await User.findById(teacherId)
      .select("assignedClasses")
      .lean();

    return (user?.assignedClasses || [])
      .map((c) => c?.toString())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const enrichForUser = (announcement, userId, isAdmin = false) => {
  const enriched = {
    ...announcement,
    isRead: (announcement.readBy || []).some(
      (r) => r.user?.toString() === userId
    ),
    isAcknowledged: (announcement.acknowledgedBy || []).some(
      (r) => r.user?.toString() === userId
    ),
  };

  if (isAdmin) {
    enriched.readCount         = (announcement.readBy         || []).length;
    enriched.acknowledgedCount = (announcement.acknowledgedBy || []).length;
  } else {
    enriched.readBy            = undefined;
    enriched.acknowledgedBy    = undefined;
    enriched.readCount         = undefined;
    enriched.acknowledgedCount = undefined;
  }

  return enriched;
};

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT ANNOUNCEMENTS HANDLER
// ─────────────────────────────────────────────────────────────────────────────

const handleStudentAnnouncements = async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma",        "no-cache");
  res.set("Expires",       "0");
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];

  try {
    const {
      since,
      page      = 1,
      limit     = 50,
      classId:  clientClassId,
      subjectId,
    } = req.query;

    const schoolId = req.user.schoolId;

    if (!schoolId) {
      return res.status(400).json({
        success: false,
        message: "schoolId is required",
      });
    }

    let studentClassId = clientClassId || null;
    if (!studentClassId) {
      studentClassId = await resolveStudentClassId(
        req.user._id?.toString(),
        schoolId
      );
    }

    console.log(
      `[handleStudentAnnouncements]` +
      ` userId=${req.user._id}` +
      ` schoolId=${schoolId}` +
      ` clientClassId=${clientClassId || "none"}` +
      ` resolvedClassId=${studentClassId || "none"}`
    );

    const audienceConditions = [
      { audience: "all"      },
      { audience: "students" },
    ];

    if (studentClassId) {
      audienceConditions.push({
        audience:      "class",
        targetClasses: studentClassId,
      });
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

    if (since) {
      const sinceDate = new Date(since);
      const isEpoch   = sinceDate.getFullYear() <= 1970;
      if (!isEpoch) {
        filter.updatedAt = { $gte: sinceDate };
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [announcements, total] = await Promise.all([
      Announcement.find(filter)
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("author",        "name email role")
        .populate("targetClasses", "name section")
        .lean()
        .maxTimeMS(5000),
      Announcement.countDocuments(filter),
    ]);

    const userId   = req.user._id?.toString();
    const enriched = announcements.map((a) => enrichForUser(a, userId, false));

    console.log(
      `📢 Student announcements` +
      ` schoolId=${schoolId}` +
      ` classId=${studentClassId || "unknown"}` +
      ` subjectId=${subjectId || "none"}` +
      ` since=${since || "none"}` +
      ` → ${enriched.length} / ${total}` +
      ` audiences=[${audienceConditions.map((c) => c.audience).join(",")}]`
    );

    return res.status(200).json({
      success:       true,
      announcements: enriched,
      data:          enriched,
      pagination: {
        page:  parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("Student announcements error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch student announcements",
    });
  }
};

router.handleStudentAnnouncements = handleStudentAnnouncements;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/announcements/stats/summary
// ─────────────────────────────────────────────────────────────────────────────

router.get("/stats/summary", adminOnly, async (req, res) => {
  try {
    const schoolId      = req.user.schoolId;
    const now           = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const [total, thisMonth, urgent, pinned, fromTeachers] = await Promise.all([
      Announcement.countDocuments({ schoolId, isActive: true, deletedAt: null }),
      Announcement.countDocuments({
        schoolId, isActive: true, deletedAt: null,
        createdAt: { $gte: thirtyDaysAgo },
      }),
      Announcement.countDocuments({
        schoolId, isActive: true, deletedAt: null, priority: "urgent",
      }),
      Announcement.countDocuments({
        schoolId, isActive: true, deletedAt: null, isPinned: true,
      }),
      Announcement.countDocuments({
        schoolId, isActive: true, deletedAt: null, authorRole: "teacher",
      }),
    ]);

    res.json({
      success: true,
      data:    { total, thisMonth, urgent, pinned, fromTeachers },
    });
  } catch (err) {
    console.error("GET /announcements/stats/summary error:", err.message);
    res.status(500).json({ message: "Failed to fetch stats" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/announcements/student
// ─────────────────────────────────────────────────────────────────────────────

router.get("/student", authenticated, noCache, handleStudentAnnouncements);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/announcements
// ─────────────────────────────────────────────────────────────────────────────

router.get("/", adminOrTeacher, async (req, res) => {
  try {
    const {
      since,
      audience,
      priority,
      authorRole,
      subjectId,
      page  = 1,
      limit = 50,
    } = req.query;

    const schoolId = req.user.schoolId;
    const userRole = req.user.role;
    const isAdmin  = ["super_admin", "school_admin"].includes(userRole);
    const userId   = req.user._id?.toString();

    const filter = {
      schoolId,
      isActive:  true,
      deletedAt: null,
    };

    if (since)     filter.updatedAt = { $gte: new Date(since) };
    if (priority)  filter.priority  = priority;
    if (subjectId) filter.subjectId = subjectId;

    if (audience && audience !== "all") {
      filter.audience = audience;
    }

    if (authorRole && isAdmin) {
      filter.authorRole = authorRole;
    }

    if (!isAdmin) {
      const teacherConditions = [
        { audience: "all"      },
        { audience: "teachers" },
        { author:   req.user._id },
      ];

      if (filter.audience) {
        filter.$or = teacherConditions.filter(
          (c) => !c.audience || c.audience === filter.audience
        );
        if (!filter.$or.some((c) => c.author)) {
          filter.$or.push({ author: req.user._id });
        }
        delete filter.audience;
      } else {
        filter.$or = teacherConditions;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [announcements, total] = await Promise.all([
      Announcement.find(filter)
        .sort({ isPinned: -1, createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate("author",        "name email role")
        .populate("targetClasses", "name section")
        .lean()
        .maxTimeMS(5000),
      Announcement.countDocuments(filter),
    ]);

    const enriched = announcements.map((a) =>
      enrichForUser(a, userId, isAdmin)
    );

    res.json({
      success:       true,
      announcements: enriched,
      data:          enriched,
      pagination: {
        page:  parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("GET /announcements error:", err.message);
    res.status(500).json({ message: "Failed to fetch announcements" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/announcements/:id
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", authenticated, async (req, res) => {
  try {
    const reserved = ["student", "stats", "public"];
    if (reserved.includes(req.params.id)) {
      return res.status(404).json({ message: "Route not found" });
    }

    const announcement = await Announcement.findById(req.params.id)
      .populate("author",              "name email role")
      .populate("targetClasses",       "name section")
      .populate("readBy.user",         "name")
      .populate("acknowledgedBy.user", "name")
      .lean();

    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId  = req.user._id?.toString();
    const isAdmin = ["super_admin", "school_admin"].includes(req.user.role);

    if (req.user.role === "student") {
      const studentClassId = await resolveStudentClassId(
        userId,
        req.user.schoolId
      );

      const isForAll      = announcement.audience === "all";
      const isForStudents = announcement.audience === "students";
      const isForClass    =
        announcement.audience === "class" &&
        studentClassId &&
        (announcement.targetClasses || []).some(
          (c) =>
            c._id?.toString() === studentClassId ||
            c.toString()      === studentClassId
        );

      if (!isForAll && !isForStudents && !isForClass) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    if (req.user.role === "teacher") {
      const isOwn         = announcement.author?._id?.toString() === userId ||
                            announcement.author?.toString()       === userId;
      const isForAll      = announcement.audience === "all";
      const isForTeachers = announcement.audience === "teachers";

      let isForTheirClass = false;
      if (announcement.audience === "class") {
        const teacherClassIds = await resolveTeacherClassIds(
          userId,
          req.user.schoolId
        );
        isForTheirClass = (announcement.targetClasses || []).some((c) => {
          const cid = c._id?.toString() || c.toString();
          return teacherClassIds.includes(cid);
        });
      }

      if (!isOwn && !isForAll && !isForTeachers && !isForTheirClass) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    const enriched = enrichForUser(announcement, userId, isAdmin);
    res.json({ success: true, data: enriched, announcement: enriched });
  } catch (err) {
    console.error("GET /announcements/:id error:", err.message);
    res.status(500).json({ message: "Failed to fetch announcement" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements
// ─────────────────────────────────────────────────────────────────────────────

router.post("/", adminOrTeacher, async (req, res) => {
  try {
    const {
      id,
      title,
      body,
      audience      = "all",
      targetClasses = [],
      priority      = "normal",
      isPinned      = false,
      publishAt,
      expiresAt,
      subjectId,
      subjectName,
    } = req.body;

    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ message: "title and body are required" });
    }

    const isAdminRole   = ["super_admin", "school_admin"].includes(req.user.role);
    const isTeacherRole = req.user.role === "teacher";

    let resolvedSubjectName = subjectName || null;
    if (subjectId && !resolvedSubjectName) {
      try {
        const Subject = require("../db/models/Subject");
        const subject = await Subject.findById(subjectId).select("name").lean();
        resolvedSubjectName = subject?.name || null;
      } catch { /* non-fatal */ }
    }

    if (isTeacherRole) {
      if (audience === "teachers" || audience === "all") {
        return res.status(403).json({
          message:
            "Teachers can only send announcements to students or specific classes.",
        });
      }
      if (isPinned) {
        return res.status(403).json({
          message: "Only administrators can pin announcements.",
        });
      }
      if (audience === "class") {
        if (!targetClasses.length) {
          return res.status(400).json({
            message: "targetClasses required when audience is 'class'",
          });
        }
        const teacherClassIds = await resolveTeacherClassIds(
          req.user._id?.toString(),
          req.user.schoolId
        );
        if (teacherClassIds.length) {
          const unauthorized = targetClasses.filter(
            (cid) => !teacherClassIds.includes(cid.toString())
          );
          if (unauthorized.length) {
            return res.status(403).json({
              message:
                "You can only send announcements to classes you are assigned to teach.",
            });
          }
        }
      }
    }

    if (!isAdminRole && isPinned) {
      return res.status(403).json({
        message: "Only admins can pin announcements",
      });
    }

    if (audience === "class" && targetClasses.length === 0) {
      return res.status(400).json({
        message: "targetClasses required when audience is 'class'",
      });
    }

    const announcement = await Announcement.create({
      _id:           id || uuidv4(),
      title:         title.trim(),
      body:          body.trim(),
      author:        req.user._id,
      authorName:    req.user.name || req.user.fullName || "Unknown",
      authorRole:    req.user.role,
      schoolId:      req.user.schoolId,
      audience,
      targetClasses: audience === "class" ? targetClasses : [],
      priority,
      isPinned:      isAdminRole ? isPinned : false,
      publishAt:     publishAt ? new Date(publishAt) : null,
      expiresAt:     expiresAt ? new Date(expiresAt) : null,
      subjectId:     subjectId   || null,
      subjectName:   resolvedSubjectName,
    });

    const populated = await Announcement.findById(announcement._id)
      .populate("author",        "name email role")
      .populate("targetClasses", "name section")
      .lean();

    console.log(
      `✅ Announcement created: "${title.trim()}"` +
      ` by ${req.user.name} [${req.user.role}]` +
      ` → audience: ${audience}` +
      (subjectId ? ` subject: ${subjectId}` : "")
    );

    res.status(201).json({
      success:      true,
      announcement: populated,
      data:         populated,
    });
  } catch (err) {
    console.error("POST /announcements error:", err.message);
    if (err.code === 11000) {
      return res.status(409).json({ message: "Announcement already exists" });
    }
    res.status(500).json({ message: "Failed to create announcement" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/announcements/:id
// ─────────────────────────────────────────────────────────────────────────────

router.put("/:id", adminOrTeacher, async (req, res) => {
  try {
    const existing = await Announcement.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId   = req.user._id?.toString();
    const isAdmin  = ["super_admin", "school_admin"].includes(req.user.role);
    const isAuthor = existing.author?.toString() === userId;

    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to edit" });
    }

    if (req.user.role === "teacher") {
      const newAudience = req.body.audience;
      if (newAudience && (newAudience === "teachers" || newAudience === "all")) {
        return res.status(403).json({
          message: "Teachers can only send to students or specific classes",
        });
      }
    }

    const {
      title, body, audience, targetClasses,
      priority, isPinned, expiresAt, subjectId, subjectName,
    } = req.body;

    if (title         !== undefined) existing.title         = title.trim();
    if (body          !== undefined) existing.body          = body.trim();
    if (audience      !== undefined) existing.audience      = audience;
    if (targetClasses !== undefined) existing.targetClasses = targetClasses;
    if (priority      !== undefined) existing.priority      = priority;
    if (expiresAt     !== undefined) existing.expiresAt     = expiresAt ? new Date(expiresAt) : null;
    if (isPinned !== undefined && isAdmin) existing.isPinned = isPinned;

    if (subjectId !== undefined) {
      existing.subjectId = subjectId || null;

      if (subjectId && !subjectName) {
        try {
          const Subject = require("../db/models/Subject");
          const subject = await Subject.findById(subjectId).select("name").lean();
          existing.subjectName = subject?.name || null;
        } catch { /* non-fatal */ }
      } else {
        existing.subjectName = subjectName || null;
      }
    }

    existing.version = (existing.version || 1) + 1;
    await existing.save();

    const populated = await Announcement.findById(existing._id)
      .populate("author",        "name email role")
      .populate("targetClasses", "name section")
      .lean();

    console.log(`✅ Announcement updated: ${existing._id}`);
    res.json({ success: true, announcement: populated, data: populated });
  } catch (err) {
    console.error("PUT /announcements/:id error:", err.message);
    res.status(500).json({ message: "Failed to update announcement" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/announcements/:id
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/:id", adminOrTeacher, async (req, res) => {
  try {
    const existing = await Announcement.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId   = req.user._id?.toString();
    const isAdmin  = ["super_admin", "school_admin"].includes(req.user.role);
    const isAuthor = existing.author?.toString() === userId;

    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to delete" });
    }

    existing.deletedAt = new Date();
    existing.isActive  = false;
    existing.version   = (existing.version || 1) + 1;
    await existing.save();

    console.log(`🗑️  Announcement soft-deleted: ${req.params.id}`);
    res.json({ success: true, message: "Announcement deleted" });
  } catch (err) {
    console.error("DELETE /announcements/:id error:", err.message);
    res.status(500).json({ message: "Failed to delete announcement" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/:id/read
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/read", authenticated, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId      = req.user._id?.toString();
    const alreadyRead = (announcement.readBy || []).some(
      (r) => r.user?.toString() === userId
    );

    if (!alreadyRead) {
      announcement.readBy.push({ user: req.user._id, readAt: new Date() });
      await announcement.save();
    }

    res.json({ success: true, message: "Marked as read" });
  } catch (err) {
    console.error("POST /announcements/:id/read error:", err.message);
    res.status(500).json({ message: "Failed to mark as read" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/read-all
// ─────────────────────────────────────────────────────────────────────────────

router.post("/read-all", authenticated, async (req, res) => {
  try {
    const { schoolId } = req.body;
    const userId       = req.user._id;

    const announcements = await Announcement.find({
      schoolId,
      isActive:       true,
      deletedAt:      null,
      "readBy.user":  { $ne: userId },
    }).select("_id").lean();

    await Promise.all(
      announcements.map((a) =>
        Announcement.updateOne(
          { _id: a._id, "readBy.user": { $ne: userId } },
          { $push: { readBy: { user: userId, readAt: new Date() } } }
        )
      )
    );

    res.json({ success: true, marked: announcements.length });
  } catch (err) {
    console.error("POST /announcements/read-all error:", err.message);
    res.status(500).json({ message: "Failed to mark all as read" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/:id/acknowledge
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/acknowledge", authenticated, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
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
    console.error("POST /announcements/:id/acknowledge error:", err.message);
    res.status(500).json({ message: "Failed to acknowledge" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/students/:id/read
// ─────────────────────────────────────────────────────────────────────────────

router.post("/students/:id/read", authenticated, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId      = req.user._id?.toString();
    const alreadyRead = (announcement.readBy || []).some(
      (r) => r.user?.toString() === userId
    );

    if (!alreadyRead) {
      announcement.readBy.push({ user: req.user._id, readAt: new Date() });
      await announcement.save();
    }

    res.json({ success: true, message: "Marked as read" });
  } catch (err) {
    console.error("POST /announcements/students/:id/read error:", err.message);
    res.status(500).json({ message: "Failed to mark as read" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/students/:id/acknowledge
// ─────────────────────────────────────────────────────────────────────────────

router.post("/students/:id/acknowledge", authenticated, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
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
    console.error("POST /announcements/students/:id/acknowledge error:", err.message);
    res.status(500).json({ message: "Failed to acknowledge" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/:id/pin
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/pin", adminOnly, async (req, res) => {
  try {
    const announcement = await Announcement.findById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    announcement.isPinned = !announcement.isPinned;
    announcement.version  = (announcement.version || 1) + 1;
    await announcement.save();

    console.log(
      `📌 Announcement ${announcement.isPinned ? "pinned" : "unpinned"}: ${req.params.id}`
    );
    res.json({ success: true, isPinned: announcement.isPinned });
  } catch (err) {
    console.error("POST /announcements/:id/pin error:", err.message);
    res.status(500).json({ message: "Failed to toggle pin" });
  }
});

module.exports = router;