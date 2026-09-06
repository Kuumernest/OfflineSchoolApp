// backend/src/routes/academicStructure.routes.js
"use strict";

const router = require("express").Router();
const AcademicStructure = require("../db/models/AcademicStructure");
const { requirePermission } = require("../../middleware/permissions");
const { resolveSchoolId, namedAnotherSchool } = require("../utils/tenant");

// ─────────────────────────────────────────────────────────────────────────────
// THE SCHOOL IS THE CALLER'S, NOT THE URL'S
//
// Every route here took :schoolId from the path and used it as given, and none
// of them asked who was calling. With records in two schools, a pupil of one
// could read the other's structure and PUT over it. This document holds
// passMark, promotionThreshold, annualAverageMethod and the term list — the
// rules by which every result and every promotion in the school is decided —
// so a write here is not an edit to one record, it is an edit to all of them.
//
// Reads are corrected to the caller's school; writes refuse outright, because
// silently redirecting an update to a different school than the URL named
// would be its own kind of wrong.
//
// The read permission is settings.view rather than something narrower: the
// results screens need passMark to render a grade at all, and every staff role
// that sees a result needs it.
// ─────────────────────────────────────────────────────────────────────────────

const canRead   = requirePermission("settings.view");
const canManage = requirePermission("settings.manage");

// ── GET /api/academic-structure/:schoolId/:year ────────────────────────────
// Year like "2026/2027" must be URI-encoded by the client (2026%2F2027).
router.get(
  "/:schoolId/:year",
  canRead,
  async (req, res) => {
    try {
      const { year } = req.params;
      const schoolId = resolveSchoolId(req, req.params.schoolId);
      if (!schoolId) return res.status(400).json({ success: false, error: "No school on this session" });

      let structure = await AcademicStructure.findOne({
        schoolId,
        academicYear: year,
        deletedAt: null,
      }).lean();

      // Auto-create default structure if none exists
      if (!structure) {
        const doc = await AcademicStructure.create({
          schoolId,
          academicYear: year,
          createdBy: req.user?._id ?? null,
        });
        structure = doc.toObject();
      }

      res.json({ success: true, structure });
    } catch (err) {
      console.error("[academicStructure] GET error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── PUT /api/academic-structure/:schoolId/:year ────────────────────────────
router.put(
  "/:schoolId/:year",
  canManage,
  async (req, res) => {
    try {
      const { year } = req.params;

      // A write names its target, so a mismatch is refused rather than
      // redirected — see the note at the top of this file.
      if (namedAnotherSchool(req, req.params.schoolId)) {
        return res.status(403).json({ success: false, error: "Not your school" });
      }
      const schoolId = resolveSchoolId(req, req.params.schoolId);
      if (!schoolId) return res.status(400).json({ success: false, error: "No school on this session" });

      const updates = req.body;

      // Whitelist allowed fields
      const allowed = [
        "terms",
        "annualAverageMethod",
        "promotionExams",
        "promotionThreshold",
        "passMark",
        "maxAbsences",
      ];

      const sets = {};
      for (const key of allowed) {
        if (updates[key] !== undefined) sets[key] = updates[key];
      }
      sets.updatedBy = req.user?._id ?? null;

      const structure = await AcademicStructure.findOneAndUpdate(
        { schoolId, academicYear: year, deletedAt: null },
        { $set: sets },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
      );

      res.json({ success: true, structure });
    } catch (err) {
      console.error("[academicStructure] PUT error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── GET /api/academic-structure/:schoolId ──────────────────────────────────
// List all structures for a school
router.get(
  "/:schoolId",
  canRead,
  async (req, res) => {
    try {
      const schoolId = resolveSchoolId(req, req.params.schoolId);
      if (!schoolId) return res.status(400).json({ success: false, error: "No school on this session" });

      const structures = await AcademicStructure.find({
        schoolId,
        deletedAt: null,
      })
        .sort({ academicYear: -1 })
        .lean();

      res.json({ success: true, structures });
    } catch (err) {
      console.error("[academicStructure] LIST error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

module.exports = router;
