// backend/src/routes/academicStructure.routes.js
"use strict";

const router = require("express").Router();
const AcademicStructure = require("../db/models/AcademicStructure");

// ── GET /api/academic-structure/:schoolId/:year ────────────────────────────
// Year like "2026/2027" must be URI-encoded by the client (2026%2F2027).
router.get(
  "/:schoolId/:year",
  async (req, res) => {
    try {
      const { schoolId, year } = req.params;

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
  async (req, res) => {
    try {
      const { schoolId, year } = req.params;
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
  async (req, res) => {
    try {
      const structures = await AcademicStructure.find({
        schoolId: req.params.schoolId,
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
