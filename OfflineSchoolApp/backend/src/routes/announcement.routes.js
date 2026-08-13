// backend/src/routes/announcement.routes.js
"use strict";

const express        = require("express");
const router         = express.Router();
const { v4: uuidv4 } = require("uuid");
const mongoose       = require("mongoose");

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

/**
 * Safely extract the authenticated user's id as a plain string,
 * regardless of which field the JWT middleware attached it to.
 */
const extractUserId = (req) =>
  req.user?._id?.toString() ||
  req.user?.id?.toString()  ||
  req.user?.userId?.toString() ||
  null;

/**
 * Find an announcement by either a MongoDB ObjectId OR a plain string _id.
 *
 * ✅ FIX: The root cause of the 500 errors.
 *
 * The mobile client generates its own ids with nanoid / Math.random (e.g.
 * "iz5q6xic96rmrf64hup"). These are stored as the document's _id on the
 * server when the client POSTs the announcement with its local id.
 * Mongoose's findById() calls ObjectId() on the value before querying,
 * which throws a CastError for non-hex strings. That CastError was caught
 * by the generic catch block and re-thrown as a 500.
 *
 * Fix: try ObjectId first; if it's not a valid ObjectId format, fall back
 * to a plain { _id: id } string query which works for any _id type.
 */
const findAnnouncementById = async (id) => {
  if (!id) return null;

  // Fast path — valid ObjectId
  if (mongoose.Types.ObjectId.isValid(id)) {
    const doc = await Announcement.findById(id);
    if (doc) return doc;
    // Could be a string id that happens to pass isValid (24-char hex) —
    // fall through to string query as well.
  }

  // String id path (nanoid, UUID, client-generated random ids)
  return Announcement.findOne({ _id: id });
};

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
    delete enriched.readBy;
    delete enriched.acknowledgedBy;
    delete enriched.readCount;
    delete enriched.acknowledgedCount;
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
        extractUserId(req),
        schoolId
      );
    }

    console.log(
      `[handleStudentAnnouncements]` +
      ` userId=${extractUserId(req)}` +
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
      if (!isEpoch) filter.updatedAt = { $gte: sinceDate };
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

    const userId   = extractUserId(req);
    const enriched = announcements.map((a) => enrichForUser(a, userId, false));

    console.log(
      `📢 Student announcements` +
      ` schoolId=${schoolId}` +
      ` classId=${studentClassId || "unknown"}` +
      ` since=${since || "none"}` +
      ` → ${enriched.length} / ${total}`
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
// ⚠️  ROUTE ORDER MATTERS IN EXPRESS
//
// Express matches routes top-to-bottom. Any route with a static segment
// (e.g. "/stats/summary", "/read-all", "/student") MUST be declared BEFORE
// wildcard param routes (e.g. "/:id") — otherwise Express will try to use
// the wildcard handler and treat the static segment as the :id value.
//
// Correct order:
//   1. Static GET  routes   (/stats/summary, /student)
//   2. Static POST routes   (/read-all)
//   3. Wildcard GET routes  (/:id)
//   4. Wildcard PUT/DELETE  (/:id)
//   5. Wildcard POST routes (/:id/read, /:id/acknowledge, /:id/pin)
//      — these must come AFTER /read-all and student routes
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/announcements/stats/summary          [STATIC — must be first]
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
// GET /api/announcements/student               [STATIC — must be before /:id]
// ─────────────────────────────────────────────────────────────────────────────

router.get("/student", authenticated, noCache, handleStudentAnnouncements);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/read-all             [STATIC — must be before /:id]
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
// ✅ FIX: /students/:id/* routes — declared BEFORE /:id/* wildcards
//    so Express doesn't treat "students" as an :id value.
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/announcements/students/:id/read
router.post("/students/:id/read", authenticated, async (req, res) => {
  try {
    // ✅ FIX: use findAnnouncementById so nanoid / UUID _ids don't CastError
    const announcement = await findAnnouncementById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId      = extractUserId(req);
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

// POST /api/announcements/students/:id/acknowledge
router.post("/students/:id/acknowledge", authenticated, async (req, res) => {
  try {
    const announcement = await findAnnouncementById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId     = extractUserId(req);
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
// GET /api/announcements                       [collection]
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
    const userId   = extractUserId(req);

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
// POST /api/announcements                      [create]
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
          message: "Teachers can only send announcements to students or specific classes.",
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
              message: "You can only send announcements to classes you are assigned to teach.",
            });
          }
        }
      }
    }

    if (!isAdminRole && isPinned) {
      return res.status(403).json({ message: "Only admins can pin announcements" });
    }

    if (audience === "class" && targetClasses.length === 0) {
      return res.status(400).json({
        message: "targetClasses required when audience is 'class'",
      });
    }

    // ✅ Use client-supplied id (nanoid) if provided, otherwise generate UUID.
    //    This is what allows findAnnouncementById to later find the doc by
    //    the same string id the client stored locally.
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
      subjectId:     subjectId         || null,
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
// GET /api/announcements/:id
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", authenticated, async (req, res) => {
  try {
    // These static sub-paths should never reach here due to route order above,
    // but guard anyway for safety.
    const reserved = ["student", "stats", "public", "read-all"];
    if (reserved.includes(req.params.id)) {
      return res.status(404).json({ message: "Route not found" });
    }

    // ✅ FIX: use findAnnouncementById to handle both ObjectId and string ids
    const announcement = await findAnnouncementById(req.params.id);

    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    // Populate manually since findAnnouncementById returns a Mongoose doc
    await announcement.populate([
      { path: "author",              select: "name email role" },
      { path: "targetClasses",       select: "name section"   },
      { path: "readBy.user",         select: "name"           },
      { path: "acknowledgedBy.user", select: "name"           },
    ]);

    const announcementObj = announcement.toObject();
    const userId  = extractUserId(req);
    const isAdmin = ["super_admin", "school_admin"].includes(req.user.role);

    if (req.user.role === "student") {
      const studentClassId = await resolveStudentClassId(userId, req.user.schoolId);
      const isForAll      = announcementObj.audience === "all";
      const isForStudents = announcementObj.audience === "students";
      const isForClass    =
        announcementObj.audience === "class" &&
        studentClassId &&
        (announcementObj.targetClasses || []).some(
          (c) =>
            c._id?.toString() === studentClassId ||
            c.toString()      === studentClassId
        );

      if (!isForAll && !isForStudents && !isForClass) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    if (req.user.role === "teacher") {
      const isOwn         = announcementObj.author?._id?.toString() === userId ||
                            announcementObj.author?.toString()       === userId;
      const isForAll      = announcementObj.audience === "all";
      const isForTeachers = announcementObj.audience === "teachers";

      let isForTheirClass = false;
      if (announcementObj.audience === "class") {
        const teacherClassIds = await resolveTeacherClassIds(userId, req.user.schoolId);
        isForTheirClass = (announcementObj.targetClasses || []).some((c) => {
          const cid = c._id?.toString() || c.toString();
          return teacherClassIds.includes(cid);
        });
      }

      if (!isOwn && !isForAll && !isForTeachers && !isForTheirClass) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    const enriched = enrichForUser(announcementObj, userId, isAdmin);
    res.json({ success: true, data: enriched, announcement: enriched });
  } catch (err) {
    console.error("GET /announcements/:id error:", err.message);
    res.status(500).json({ message: "Failed to fetch announcement" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/announcements/:id
// ─────────────────────────────────────────────────────────────────────────────

router.put("/:id", adminOrTeacher, async (req, res) => {
  try {
    // ✅ FIX: use findAnnouncementById
    const existing = await findAnnouncementById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId   = extractUserId(req);
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
    // ✅ FIX: use findAnnouncementById
    const existing = await findAnnouncementById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId   = extractUserId(req);
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
    // ✅ FIX: use findAnnouncementById — the core fix for the 500 error.
    //    The client id "iz5q6xic96rmrf64hup" is a nanoid string.
    //    Mongoose.findById() calls new ObjectId(id) which throws CastError
    //    for non-hex strings. findAnnouncementById falls back to findOne({ _id })
    //    which works for any _id type stored in MongoDB.
    const announcement = await findAnnouncementById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId = extractUserId(req);

    // ✅ Guard: don't create a read receipt for your own announcement
    const authorId = announcement.author?.toString();
    if (authorId && authorId === userId) {
      return res.status(200).json({ success: true, message: "Own announcement — skipped" });
    }

    const alreadyRead = (announcement.readBy || []).some(
      (r) => r.user?.toString() === userId
    );

    if (!alreadyRead) {
      announcement.readBy.push({ user: req.user._id, readAt: new Date() });
      await announcement.save();
    }

    res.json({ success: true, message: "Marked as read" });
  } catch (err) {
    // ✅ FIX: removed `next(err)` — next was never injected so calling it
    //    threw "next is not a function", which produced the 500.
    console.error("POST /announcements/:id/read error:", err.message);
    res.status(500).json({ message: "Failed to mark as read" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/announcements/:id/acknowledge
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/acknowledge", authenticated, async (req, res) => {
  try {
    // ✅ FIX: use findAnnouncementById
    const announcement = await findAnnouncementById(req.params.id);
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const userId = extractUserId(req);

    // ✅ Guard: don't acknowledge your own announcement
    const authorId = announcement.author?.toString();
    if (authorId && authorId === userId) {
      return res.status(200).json({ success: true, message: "Own announcement — skipped" });
    }

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
// POST /api/announcements/:id/pin
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/pin", adminOnly, async (req, res) => {
  try {
    // ✅ FIX: use findAnnouncementById
    const announcement = await findAnnouncementById(req.params.id);
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