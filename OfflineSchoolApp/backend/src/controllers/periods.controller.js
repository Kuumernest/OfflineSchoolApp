// backend/controllers/periods.controller.js

const Period = require("../db/models/Period");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Convert "HH:MM" → total minutes
const toMinutes = (t) => {
  if (!t || typeof t !== "string") return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

// Validate "HH:MM" format
const isValidTime = (t) => {
  if (!t || typeof t !== "string") return false;
  return /^\d{2}:\d{2}$/.test(t);
};

// Resolve schoolId from query → body → JWT (in that order)
const resolveSchoolId = (req) => {
  return (
    req.query.schoolId ||
    req.body.schoolId  ||
    req.user?.schoolId ||
    null
  );
};

// Check for time overlaps excluding a specific period (for updates)
const checkOverlap = async (schoolId, startTime, endTime, excludeId = null) => {
  const startMin = toMinutes(startTime);
  const endMin   = toMinutes(endTime);

  const existing = await Period.find({
    schoolId,
    isActive:  true,
    deletedAt: null,
    ...(excludeId && { _id: { $ne: excludeId } }),
  });

  for (const p of existing) {
    const pStart = toMinutes(p.startTime);
    const pEnd   = toMinutes(p.endTime);
    if (startMin < pEnd && endMin > pStart) {
      return p;
    }
  }

  return null;
};

// ─────────────────────────────────────────────────────────────
// GET ALL  —  GET /admin/periods
// ─────────────────────────────────────────────────────────────
exports.getAll = async (req, res) => {
  try {
    const schoolId = resolveSchoolId(req);

    if (!schoolId) {
      return res.status(400).json({
        success: false,
        message: "schoolId required",
      });
    }

    const filter = {
      schoolId,
      deletedAt: null,
    };

    if (req.query.includeInactive !== "true") {
      filter.isActive = true;
    }

    const periods = await Period.find(filter).sort({
      sortOrder: 1,
      startTime: 1,
    });

    res.json({
      success: true,
      data:    periods,
      count:   periods.length,
    });
  } catch (err) {
    console.error("Periods getAll error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch periods",
    });
  }
};

// ─────────────────────────────────────────────────────────────
// GET BY ID  —  GET /admin/periods/:id
// ─────────────────────────────────────────────────────────────
exports.getById = async (req, res) => {
  try {
    const period = await Period.findById(req.params.id);

    if (!period || period.deletedAt) {
      return res.status(404).json({
        success: false,
        message: "Period not found",
      });
    }

    res.json({
      success: true,
      data:    period,
    });
  } catch (err) {
    console.error("Periods getById error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────
// CREATE  —  POST /admin/periods
// ─────────────────────────────────────────────────────────────
exports.create = async (req, res) => {
  try {
    const { name, startTime, endTime, isBreak } = req.body;
    const schoolId = resolveSchoolId(req);

    // ── Validate required fields ─────────────────────────────
    const missing = [];
    if (!name)      missing.push("name");
    if (!startTime) missing.push("startTime");
    if (!endTime)   missing.push("endTime");
    if (!schoolId)  missing.push("schoolId");

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`,
      });
    }

    // ── Validate time format ─────────────────────────────────
    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return res.status(400).json({
        success: false,
        message: "Times must be in HH:MM format",
      });
    }

    // ── Validate time range ──────────────────────────────────
    if (toMinutes(endTime) <= toMinutes(startTime)) {
      return res.status(400).json({
        success: false,
        message: "End time must be after start time",
      });
    }

    // ── Check overlap ────────────────────────────────────────
    const overlap = await checkOverlap(schoolId, startTime, endTime);
    if (overlap) {
      return res.status(409).json({
        success: false,
        message: `Time overlaps with "${overlap.name}" (${overlap.startTime}–${overlap.endTime})`,
      });
    }

    // ── Auto-assign sortOrder ────────────────────────────────
    const last = await Period.findOne({ schoolId, deletedAt: null })
      .sort({ sortOrder: -1 })
      .select("sortOrder");
    const sortOrder = (last?.sortOrder ?? 0) + 1;

    // ── Create ───────────────────────────────────────────────
    const period = await Period.create({
      schoolId,
      name:       name.trim(),
      startTime,
      endTime,
      sortOrder,
      isBreak:    !!isBreak,
      assignedBy: req.user?.id || null,
    });

    res.status(201).json({
      success: true,
      data:    period,
    });
  } catch (err) {
    console.error("Create period error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create period",
    });
  }
};

// ─────────────────────────────────────────────────────────────
// UPDATE  —  PUT /admin/periods/:id
// ─────────────────────────────────────────────────────────────
exports.update = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, startTime, endTime, isBreak } = req.body;

    const existing = await Period.findById(id);

    if (!existing || existing.deletedAt) {
      return res.status(404).json({
        success: false,
        message: "Period not found",
      });
    }

    const newStart = startTime || existing.startTime;
    const newEnd   = endTime   || existing.endTime;

    // ── Validate time format ─────────────────────────────────
    if (!isValidTime(newStart) || !isValidTime(newEnd)) {
      return res.status(400).json({
        success: false,
        message: "Times must be in HH:MM format",
      });
    }

    // ── Validate time range ──────────────────────────────────
    if (toMinutes(newEnd) <= toMinutes(newStart)) {
      return res.status(400).json({
        success: false,
        message: "End time must be after start time",
      });
    }

    // ── Check overlap (excluding self) ───────────────────────
    const overlap = await checkOverlap(existing.schoolId, newStart, newEnd, id);
    if (overlap) {
      return res.status(409).json({
        success: false,
        message: `Time overlaps with "${overlap.name}" (${overlap.startTime}–${overlap.endTime})`,
      });
    }

    const updated = await Period.findByIdAndUpdate(
      id,
      {
        name:      name?.trim() || existing.name,
        startTime: newStart,
        endTime:   newEnd,
        isBreak:   isBreak !== undefined ? !!isBreak : existing.isBreak,
        version:   existing.version + 1,
      },
      { new: true }
    );

    res.json({
      success: true,
      data:    updated,
    });
  } catch (err) {
    console.error("Update period error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update period",
    });
  }
};

// ─────────────────────────────────────────────────────────────
// TOGGLE ACTIVE  —  PATCH /admin/periods/:id/toggle
// ─────────────────────────────────────────────────────────────
exports.toggleActive = async (req, res) => {
  try {
    const period = await Period.findById(req.params.id);

    if (!period || period.deletedAt) {
      return res.status(404).json({
        success: false,
        message: "Period not found",
      });
    }

    period.isActive  = !period.isActive;
    period.version  += 1;
    await period.save();

    res.json({
      success: true,
      data:    period,
    });
  } catch (err) {
    console.error("Toggle period error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────
// REORDER  —  POST /admin/periods/:id/reorder
// ─────────────────────────────────────────────────────────────
exports.reorder = async (req, res) => {
  try {
    const { id }        = req.params;
    const { direction } = req.body;

    if (!["up", "down"].includes(direction)) {
      return res.status(400).json({
        success: false,
        message: "direction must be 'up' or 'down'",
      });
    }

    const period = await Period.findById(id);

    if (!period) {
      return res.status(404).json({
        success: false,
        message: "Period not found",
      });
    }

    const swapWith = await Period.findOne({
      schoolId:  period.schoolId,
      deletedAt: null,
      sortOrder:
        direction === "up"
          ? { $lt: period.sortOrder }
          : { $gt: period.sortOrder },
    }).sort(direction === "up" ? { sortOrder: -1 } : { sortOrder: 1 });

    if (!swapWith) {
      return res.status(400).json({
        success: false,
        message: `Cannot move period ${direction} any further`,
      });
    }

    const temp         = period.sortOrder;
    period.sortOrder   = swapWith.sortOrder;
    swapWith.sortOrder = temp;

    await Promise.all([period.save(), swapWith.save()]);

    res.json({
      success: true,
      data:    [period, swapWith],
    });
  } catch (err) {
    console.error("Reorder period error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE (soft)  —  DELETE /admin/periods/:id
// ─────────────────────────────────────────────────────────────
exports.remove = async (req, res) => {
  try {
    const period = await Period.findById(req.params.id);

    if (!period) {
      return res.status(404).json({
        success: false,
        message: "Period not found",
      });
    }

    if (period.deletedAt) {
      return res.status(410).json({
        success: false,
        message: "Period already deleted",
      });
    }

    period.deletedAt  = new Date();
    period.version   += 1;
    await period.save();

    res.json({
      success: true,
      message: "Period deleted",
    });
  } catch (err) {
    console.error("Delete period error:", err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};