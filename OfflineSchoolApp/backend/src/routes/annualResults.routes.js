// backend/src/routes/annualResults.routes.js
"use strict";

const router           = require("express").Router();
const AnnualResult     = require("../db/models/AnnualResult");
const annualGrading    = require("../services/annualGrading.service");

// ── GET /api/annual-results ────────────────────────────────────────────────
router.get(
  "/",
  async (req, res) => {
    try {
      const { schoolId, academicYear, classId, page = 1, limit = 50 } = req.query;

      if (!schoolId || !academicYear) {
        return res.status(400).json({
          success: false,
          error: "schoolId and academicYear are required",
        });
      }

      const filter = {
        schoolId,
        academicYear,
        deletedAt: null,
      };
      if (classId) filter.classId = classId;

      const skip = (Number(page) - 1) * Number(limit);

      const [results, total] = await Promise.all([
        AnnualResult.find(filter)
          .sort({ classPosition: 1 })
          .skip(skip)
          .limit(Number(limit))
          .lean(),
        AnnualResult.countDocuments(filter),
      ]);

      res.json({
        success: true,
        results,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit)),
      });
    } catch (err) {
      console.error("[annualResults] GET error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── GET /api/annual-results/student/:studentId ─────────────────────────────
router.get(
  "/student/:studentId",
  async (req, res) => {
    try {
      const { studentId } = req.params;
      const { schoolId, academicYear } = req.query;

      const filter = { studentId, deletedAt: null };
      if (schoolId)     filter.schoolId = schoolId;
      if (academicYear) filter.academicYear = academicYear;

      const result = await AnnualResult.findOne(filter).lean();

      res.json({ success: true, result });
    } catch (err) {
      console.error("[annualResults] GET student error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── POST /api/annual-results/compute ───────────────────────────────────────
router.post(
  "/compute",
  async (req, res) => {
    try {
      const { schoolId, academicYear, classId } = req.body;

      if (!schoolId || !academicYear) {
        return res.status(400).json({
          success: false,
          error: "schoolId and academicYear are required",
        });
      }

      let result;
      if (classId) {
        result = await annualGrading.computeClassAnnualAverages({
          schoolId,
          academicYear,
          classId,
        });
      } else {
        result = await annualGrading.computeAllClassAnnualAverages({
          schoolId,
          academicYear,
        });
      }

      res.json({ success: true, ...result });
    } catch (err) {
      console.error("[annualResults] COMPUTE error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ── POST /api/annual-results/publish ───────────────────────────────────────
router.post(
  "/publish",
  async (req, res) => {
    try {
      const { schoolId, academicYear, classId } = req.body;

      const filter = {
        schoolId,
        academicYear,
        deletedAt: null,
      };
      if (classId) filter.classId = classId;

      const result = await AnnualResult.updateMany(filter, {
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
      console.error("[annualResults] PUBLISH error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

module.exports = router;
