// backend/src/routes/termResults.routes.js
"use strict";

const router           = require("express").Router();
const TermResult       = require("../db/models/TermResult");
const termGrading      = require("../services/termGrading.service");
const School             = require("../db/models/School");
const { renderReportCard } = require("../services/reportHtml.service");
const { buildTermCard, loadReportTemplate } =
  require("../services/reportCardData.service");

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

// ── GET /api/term-results/:studentId/report-card ───────────────────────────
/**
 * The term report card, as printable HTML.
 *
 * Its subject marks are the pupil's marks across the term's sequences combined
 * by the school's weights, and each subject's place is a comparison against
 * classmates' equally-combined marks — neither of which is stored, so both are
 * built per request in reportCardData.service.js.
 *
 * It never carries a promotion decision. That belongs to the annual card alone.
 */
router.get(
  "/:studentId/report-card",
  async (req, res) => {
    try {
      const { schoolId, academicYear, term, classId, lang, templateId } = req.query;
      if (!schoolId || !academicYear || !term || !classId) {
        return res.status(400).json({
          success: false,
          error: "schoolId, academicYear, term and classId are required",
        });
      }

      const data = await buildTermCard({
        schoolId, academicYear, term, classId, studentId: req.params.studentId,
      });
      if (!data) {
        return res.status(404).json({ success: false, error: "No term result for this student" });
      }

      const [school, template] = await Promise.all([
        School.findOne({ _id: String(schoolId) }).select("name logo motto").lean(),
        loadReportTemplate(schoolId, templateId),
      ]);

      const rendered = renderReportCard(data, {
        lang:       lang || "en",
        schoolName: school?.name || "School",
        school:     { name: school?.name || "", logo: school?.logo || null, motto: school?.motto || null },
        template,
      });

      res.set("content-type", "text/html; charset=utf-8");
      return res.send(rendered.html);
    } catch (err) {
      console.error("[termResults] report-card error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

module.exports = router;
