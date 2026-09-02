// backend/src/routes/annualResults.routes.js
"use strict";

const router           = require("express").Router();
const AnnualResult     = require("../db/models/AnnualResult");
const annualGrading    = require("../services/annualGrading.service");
const staleness        = require("../services/resultStaleness.service");
const School             = require("../db/models/School");
const { renderReportCard } = require("../services/reportHtml.service");
const { buildAnnualCard, loadReportTemplate, absoluteLogoUrl } =
  require("../services/reportCardData.service");

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

      // Stale against the TERM results, not the marks: an annual average is
      // built from term averages, so a corrected mark makes the term stale
      // first. Reporting the year as stale before its term has been recomputed
      // would tell a school to redo the year when it needs to redo one term.
      const { staleIds, latestTerm } = await staleness.annualStaleness({
        schoolId, academicYear, results,
      });
      const stamped = staleness.withStaleness(results, staleIds);

      res.json({
        success: true,
        results:    stamped.results,
        staleCount: stamped.staleCount,
        latestTerm,
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

// ── GET /api/annual-results/:studentId/report-card ─────────────────────────
/**
 * The final annual report card, as printable HTML.
 *
 * The only card that carries a promotion decision, and it carries it alongside
 * the annual average and the annual position — which is the whole reason a
 * promotion may appear here and nowhere else.
 */
router.get(
  "/:studentId/report-card",
  async (req, res) => {
    try {
      const { schoolId, academicYear, classId, lang, templateId } = req.query;
      if (!schoolId || !academicYear || !classId) {
        return res.status(400).json({
          success: false,
          error: "schoolId, academicYear and classId are required",
        });
      }

      const data = await buildAnnualCard({
        schoolId, academicYear, classId, studentId: req.params.studentId,
      });
      if (!data) {
        return res.status(404).json({ success: false, error: "No annual result for this student" });
      }

      const [school, template] = await Promise.all([
        // .catch, as the sequence card's route already does. A schoolId that
        // does not cast to an ObjectId throws here, and losing the whole report
        // card because its letterhead could not be looked up is the wrong
        // trade: the renderer falls back to the school name it was given.
        School.findOne({ _id: String(schoolId) })
          .select("name logo motto").lean().catch(() => null),
        loadReportTemplate(schoolId, templateId),
      ]);

      const rendered = renderReportCard(data, {
        lang:       lang || "en",
        schoolName: school?.name || "School",
        school:     { name:  school?.name || "",
                     logo:  absoluteLogoUrl(school?.logo, req),
                     motto: school?.motto || null },
        template,
      });

      res.set("content-type", "text/html; charset=utf-8");
      return res.send(rendered.html);
    } catch (err) {
      console.error("[annualResults] report-card error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

module.exports = router;
