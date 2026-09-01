// backend/src/routes/termResults.routes.js
"use strict";

const router           = require("express").Router();
const TermResult       = require("../db/models/TermResult");
const termGrading      = require("../services/termGrading.service");

// ── GET /api/term-results ──────────────────────────────────────────────────
// List term results with filters
router.get(
  "/",
  async (req, res) => {
    try {
      const { schoolId, academicYear, term, classId, page = 1, limit = 50 } = req.query;

      if (!schoolId || !academicYear || !term) {
        return res.status(400).json({
          success: false,
          error: "schoolId, academicYear, and term are required",
        });
      }

      const filter = {
        schoolId,
        academicYear,
        term: Number(term),
        deletedAt: null,
      };
      if (classId) filter.classId = classId;

      const skip = (Number(page) - 1) * Number(limit);

      const [results, total] = await Promise.all([
        TermResult.find(filter)
          .sort({ classPosition: 1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        TermResult.countDocuments(filter),
      ]);

      res.json({
        success: true,
        results,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
      });
    } catch (err) {
      console.error("[termResults] GET error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── GET /api/term-results/student/:studentId ───────────────────────────────
// Get a single student's term results
router.get(
  "/student/:studentId",
  async (req, res) => {
    try {
      const { studentId } = req.params;
      const { schoolId, academicYear } = req.query;

      const filter = { studentId, deletedAt: null };
      if (schoolId)     filter.schoolId = schoolId;
      if (academicYear) filter.academicYear = academicYear;

      const results = await TermResult.find(filter)
        .sort({ term: 1 })
        .lean();

      res.json({ success: true, results });
    } catch (err) {
      console.error("[termResults] GET student error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── POST /api/term-results/compute ─────────────────────────────────────────
// Compute term averages for all students in a class or all classes
router.post(
  "/compute",
  async (req, res) => {
    try {
      const { schoolId, academicYear, term, classId } = req.body;

      if (!schoolId || !academicYear || !term) {
        return res.status(400).json({
          success: false,
          error: "schoolId, academicYear, and term are required",
        });
      }

      let result;
      if (classId) {
        result = await termGrading.computeClassTermAverages({
          schoolId,
          academicYear,
          term: Number(term),
          classId,
        });
      } else {
        result = await termGrading.computeAllClassTermAverages({
          schoolId,
          academicYear,
          term: Number(term),
        });
      }

      res.json({ success: true, ...result });
    } catch (err) {
      console.error("[termResults] COMPUTE error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── POST /api/term-results/publish ─────────────────────────────────────────
// Publish term results
router.post(
  "/publish",
  async (req, res) => {
    try {
      const { schoolId, academicYear, term, classId } = req.body;

      const filter = {
        schoolId,
        academicYear,
        term: Number(term),
        deletedAt: null,
      };
      if (classId) filter.classId = classId;

      const result = await TermResult.updateMany(filter, {
        $set: {
          isPublished: true,
          publishedAt: new Date(),
        },
      });

      res.json({
        success: true,
        published: result.modifiedCount,
      });
    } catch (err) {
      console.error("[termResults] PUBLISH error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

module.exports = router;
