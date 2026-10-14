// backend/src/routes/academicStructure.routes.js
"use strict";

const router = require("express").Router();
const AcademicStructure = require("../db/models/AcademicStructure");
const { requirePermission, requireAnyPermission } = require("../../middleware/permissions");
const permissions = require("../services/permissions.service");
const { resolveSchoolId, namedAnotherSchool, guardSchoolParam } = require("../utils/tenant");
const { validateTerms, periodsStillHolding } = require("../../../shared/periodStructure");

// The path names the school, and the door (middleware/auth.js) cannot see a
// path parameter. This is the same refusal, applied where the parameter is.
router.param("schoolId", guardSchoolParam);

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
// Reading is settings.view (administrators, delegable) — with one narrower
// door. A year's shape — its terms, sequences, names and promotion exams — is
// also readable with exams.view, the permission the desktop sync feed already
// ships this document under (config/syncFeed.js): a teacher creating an exam
// or reading term results needs the year's own periods, and REST and the feed
// now follow one rule (docs/39 §4.6j, D4). Such a caller gets the shape only,
// never the rules or their impact counts, and a read of theirs never creates
// a document.
// ─────────────────────────────────────────────────────────────────────────────

const canRead     = requirePermission("settings.view");
const canReadYear = requireAnyPermission("settings.view", "exams.view");
const canManage   = requirePermission("settings.manage");

/** What a caller without settings.view sees of a year: its shape. */
const SHAPE_FIELDS = ["schoolId", "academicYear", "terms", "promotionExams", "passMark", "promotionThreshold"];
const shapeOf = (structure) => Object.fromEntries(SHAPE_FIELDS.map((k) => [k, structure[k] ?? null]));

// ── GET /api/academic-structure/:schoolId/:year ────────────────────────────
// Year like "2026/2027" must be URI-encoded by the client (2026%2F2027).
router.get(
  "/:schoolId/:year",
  canReadYear,
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

      if (!(await permissions.can(req.user, "settings.view"))) {
        // The default year, unsaved, when the school has not set one up.
        const shown = structure ?? new AcademicStructure({ schoolId, academicYear: year }).toObject();
        return res.json({ success: true, structure: shapeOf(shown) });
      }

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

      // A school may shape its own year (docs/39 Phase 6, shared/
      // periodStructure.js) — within the bounds every stored record lives in,
      // and never by removing or moving a period that already has exams.
      if (sets.terms !== undefined) {
        const shape = validateTerms(sets.terms);
        if (!shape.ok) {
          return res.status(400).json({ success: false, code: "INVALID_STRUCTURE", errors: shape.errors });
        }
        const exams = await require("mongoose").model("Exam").find({
          schoolId, academicYear: year, deletedAt: null,
        }).select("_id name term sequenceNumber").lean();
        const orphaned = periodsStillHolding(sets.terms, exams);
        if (orphaned.length > 0) {
          return res.status(409).json({
            success: false, code: "PERIODS_IN_USE",
            error: "Some exams belong to a term or sequence this change would remove or move.",
            exams: orphaned.slice(0, 20),
          });
        }
        // Promotion exams are sequence numbers; drop any the year no longer has.
        const seqNumbers = new Set(sets.terms.flatMap((t) => t.sequences.map((q) => q.number)));
        if (Array.isArray(sets.promotionExams)) {
          sets.promotionExams = sets.promotionExams.filter((n) => seqNumbers.has(Number(n)));
        }
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

// ═════════════════════════════════════════════════════════════════════════════
// CALCULATION RULES (docs/39 Phase 4, shared/academicRules.js)
//
// The decisions that change real results — which sequence average is
// official (D1), where promotion reads and what rule it applies (D1b, D2),
// whether published results may be recomputed in place (D3), and whose grade
// bands a term/annual row stores (§12) — are the school's, per year. Every
// default is the behaviour before rules existed, so a school that never opens
// this computes exactly as before.
//
//   GET  …/:year/rules          the year's rules, their definitions, the impact
//   POST …/:year/rules/preview  what a proposed change would change, with counts
//   PUT  …/:year/rules          change them (validated, audited)
//
// Published results are never rewritten by a change here: a rule applies to
// what is computed after it. The preview says how many results are already
// published (they keep their figures) and how many would be recomputed the
// next time their exam, term or year is processed.
// ═════════════════════════════════════════════════════════════════════════════

const academicRules = require("../../../shared/academicRules");
const { recordAudit } = require("../services/audit.service");

const yearImpact = async (schoolId, academicYear) => {
  const mongoose = require("mongoose");
  const M = (n) => mongoose.model(n);
  const examIds = (await M("Exam").find({ schoolId, academicYear, deletedAt: null }).select("_id").lean())
    .map((e) => e._id);
  const split = async (model, filter) => {
    const [published, total] = await Promise.all([
      M(model).countDocuments({ ...filter, isPublished: true }),
      M(model).countDocuments(filter),
    ]);
    return { published, unpublished: total - published };
  };
  const [sequence, term, annual, draftRuns] = await Promise.all([
    examIds.length ? split("ResultSummary", { schoolId, examId: { $in: examIds }, deletedAt: null })
                   : { published: 0, unpublished: 0 },
    split("TermResult",   { schoolId, academicYear, deletedAt: null }),
    split("AnnualResult", { schoolId, academicYear, deletedAt: null }),
    M("PromotionRun").countDocuments({ schoolId, fromYear: academicYear, status: "draft", deletedAt: null }),
  ]);
  return { sequence, term, annual, draftPromotionRuns: draftRuns };
};

/** What moves from `before` to `after`, rule by rule, and what each affects. */
const ruleChanges = (before, after) => {
  const affects = {
    sequenceAverage:  ["sequence", "term", "annual"],
    gradingAuthority: ["term", "annual"],
    promotionRule:    ["annual", "promotion"],
    publishedResults: [],
    promotionThreshold: ["annual", "promotion"],
    classThresholds:    ["annual", "promotion"],
  };
  const changes = [];
  for (const key of [...academicRules.RULE_KEYS, "promotionThreshold", "classThresholds"]) {
    const a = JSON.stringify(before[key]), b = JSON.stringify(after[key]);
    if (a !== b) changes.push({ rule: key, from: before[key], to: after[key], affects: affects[key] });
  }
  return changes;
};

const loadYear = async (req, res) => {
  const schoolId = resolveSchoolId(req, req.params.schoolId);
  if (!schoolId) {
    res.status(400).json({ success: false, code: "SCHOOL_REQUIRED", error: "A school must be selected" });
    return null;
  }
  const structure = await AcademicStructure.findOne({
    schoolId, academicYear: req.params.year, deletedAt: null,
  }).lean();
  return { schoolId, structure };
};

/** A proposed body merged onto the current rules, checked; or a 400 sent. */
const proposedRules = (req, res, current) => {
  const body = req.body?.rules ?? req.body;
  const checked = academicRules.validateRules(body);
  if (!checked.ok) {
    res.status(400).json({ success: false, code: "INVALID_RULES", errors: checked.errors });
    return null;
  }
  const merged = academicRules.effectiveRules({ ...current, ...checked.value });
  const incoherent = academicRules.coherenceErrors(merged);
  if (incoherent.length) {
    res.status(400).json({ success: false, code: "INVALID_RULES", errors: incoherent });
    return null;
  }
  return merged;
};

router.get(
  "/:schoolId/:year/rules",
  canRead,
  async (req, res) => {
    try {
      const loaded = await loadYear(req, res);
      if (!loaded) return;
      const rules = academicRules.effectiveRules(loaded.structure?.rules);
      res.json({
        success: true,
        academicYear: req.params.year,
        rules,
        isDefault: academicRules.isDefault(rules),
        defaults: academicRules.DEFAULT_RULES,
        definitions: academicRules.RULES,
        impact: await yearImpact(loaded.schoolId, req.params.year),
      });
    } catch (err) {
      console.error("[academicStructure] RULES GET error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.post(
  "/:schoolId/:year/rules/preview",
  canManage,
  async (req, res) => {
    try {
      if (namedAnotherSchool(req, req.params.schoolId)) {
        return res.status(403).json({ success: false, code: "SCHOOL_ACCESS_DENIED", error: "Not your school" });
      }
      const loaded = await loadYear(req, res);
      if (!loaded) return;
      const current = academicRules.effectiveRules(loaded.structure?.rules);
      const next = proposedRules(req, res, current);
      if (!next) return;
      res.json({
        success: true,
        changes: ruleChanges(current, next),
        rules: next,
        impact: await yearImpact(loaded.schoolId, req.params.year),
      });
    } catch (err) {
      console.error("[academicStructure] RULES PREVIEW error:", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

router.put(
  "/:schoolId/:year/rules",
  canManage,
  async (req, res) => {
    try {
      if (namedAnotherSchool(req, req.params.schoolId)) {
        return res.status(403).json({ success: false, code: "SCHOOL_ACCESS_DENIED", error: "Not your school" });
      }
      const loaded = await loadYear(req, res);
      if (!loaded) return;
      if (!loaded.structure) {
        return res.status(404).json({ success: false, code: "NO_STRUCTURE", error: "This year has no academic structure yet" });
      }
      const current = academicRules.effectiveRules(loaded.structure.rules);
      const next = proposedRules(req, res, current);
      if (!next) return;

      const changes = ruleChanges(current, next);
      if (changes.length === 0) return res.json({ success: true, changed: false, rules: current });

      // A draft promotion run was proposed under the current rule; changing
      // the rule underneath it would leave its proposals unexplained.
      if (changes.some((c) => c.affects.includes("promotion"))) {
        const drafts = await require("mongoose").model("PromotionRun").countDocuments({
          schoolId: loaded.schoolId, fromYear: req.params.year, status: "draft", deletedAt: null,
        });
        if (drafts > 0) {
          return res.status(409).json({
            success: false, code: "PROMOTION_RUN_DRAFT",
            error: "A draft promotion run exists for this year. Commit or discard it before changing the promotion rule.",
          });
        }
      }

      // Stored complete-but-minimal: only what differs from the default.
      const stored = academicRules.nonDefaultRules(next);
      await AcademicStructure.updateOne(
        { _id: loaded.structure._id },
        Object.keys(stored).length
          ? { $set: { rules: stored, updatedBy: req.user?._id ?? null } }
          : { $unset: { rules: 1 }, $set: { updatedBy: req.user?._id ?? null } }
      );

      await recordAudit(req, {
        action: "academic.rulesChanged",
        schoolId: loaded.schoolId,
        resource: { type: "AcademicStructure", id: loaded.structure._id, label: req.params.year },
        before: current,
        after: next,
        reason: typeof req.body?.reason === "string" ? req.body.reason : null,
      });

      res.json({
        success: true, changed: true, rules: next, changes,
        impact: await yearImpact(loaded.schoolId, req.params.year),
      });
    } catch (err) {
      console.error("[academicStructure] RULES PUT error:", err.message);
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
