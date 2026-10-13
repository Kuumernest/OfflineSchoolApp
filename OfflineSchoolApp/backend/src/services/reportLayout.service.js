// backend/src/services/reportLayout.service.js
"use strict";

/**
 * A school's report-card layout: which sections its cards print (docs/39
 * §10, Phase 2d).
 *
 *   currentLayout(schoolId)            → the layout new cards print with
 *   listVersions(schoolId)             → every version, newest first
 *   getVersion(schoolId, version)      → one version, this school's only
 *   updateLayout({ schoolId, body })   → validate; insert version n+1 if anything changed
 *   layoutForSequenceCard({ … })       → the layout an exam card prints with:
 *                                        the one it was ISSUED with, if it was
 *   templateCompatibility(tpl, layout) → sections a token template cannot hide
 *
 * ── Which layout a card prints with ───────────────────────────────────────
 *
 *   issued   a sequence card already archived (GeneratedReport) that recorded
 *            its layout: that layout, whatever the school has changed since.
 *   legacy   a card archived before layouts existed: every section, which is
 *            what it was issued with — the only layout there was.
 *   current  anything not yet issued: the school's current version, or the
 *            default (every section) for a school that has none.
 *
 * Term and annual cards are never archived today (they re-render from live
 * data on every request), so they always print with the current layout.
 *
 * Presentation only: nothing here touches a mark, a result or a decision.
 */

const ReportTemplateVersion = require("../db/models/ReportTemplateVersion");
const GeneratedReport       = require("../db/models/GeneratedReport");

const {
  SECTION_IDS, DEFAULT_SECTIONS, resolveSections, validateSectionsInput, ungatedDisabledSections,
} = require("../../../shared/reportSections");

const failure = (status, code, error, details) => {
  const err = new Error(error);
  err.status = status;
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
};

const requireSchool = (schoolId) => {
  if (!schoolId) throw failure(400, "SCHOOL_REQUIRED", "A school must be selected");
  return String(schoolId);
};

const isDuplicateKey = (err) => err && (err.code === 11000 || err.code === 11001);

const versionId = (schoolId, version) => `${schoolId}:v${version}`;

/** A stored version as the API and the renderers see it. */
const present = (doc) => ({
  id:             doc._id,
  schoolId:       doc.schoolId,
  version:        doc.version,
  sections:       resolveSections(doc.sections),
  basedOnVersion: doc.basedOnVersion ?? null,
  createdBy:      doc.createdBy ?? null,
  createdAt:      doc.createdAt ?? null,
  source:         "configured",
});

/** The layout of a school that has configured nothing. */
const defaultLayout = (schoolId) => ({
  id: null, schoolId, version: 0, sections: { ...DEFAULT_SECTIONS },
  basedOnVersion: null, createdBy: null, createdAt: null, source: "default",
});

async function currentLayout(schoolId) {
  schoolId = requireSchool(schoolId);
  const doc = await ReportTemplateVersion.findOne({ schoolId }).sort({ version: -1 }).lean();
  return doc ? present(doc) : defaultLayout(schoolId);
}

async function listVersions(schoolId) {
  schoolId = requireSchool(schoolId);
  const docs = await ReportTemplateVersion.find({ schoolId }).sort({ version: -1 }).lean();
  return docs.map(present);
}

async function getVersion(schoolId, version) {
  schoolId = requireSchool(schoolId);
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) return null;
  // Scoped twice over: the id names the school, and so does the filter.
  const doc = await ReportTemplateVersion.findOne({ _id: versionId(schoolId, n), schoolId }).lean();
  return doc ? present(doc) : null;
}

/**
 * Apply a change to the school's sections.
 *
 * A body that changes nothing inserts nothing — a version is a change, not a
 * save. Otherwise version n+1 is inserted from the current sections with the
 * change applied; a concurrent save that took n+1 first makes this one retry
 * on top of it, so neither change is lost.
 *
 * @returns {Promise<{ changed: boolean, layout: object }>}
 */
async function updateLayout({ schoolId, body, userId = null }) {
  schoolId = requireSchool(schoolId);
  const verdict = validateSectionsInput(body);
  if (!verdict.ok) throw failure(400, verdict.code, verdict.error, verdict.details);

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await currentLayout(schoolId);
    const next = { ...current.sections, ...verdict.sections };
    if (SECTION_IDS.every((id) => next[id] === current.sections[id])) {
      return { changed: false, layout: current };
    }
    const version = current.version + 1;
    try {
      const created = await ReportTemplateVersion.create({
        _id: versionId(schoolId, version),
        schoolId,
        version,
        sections: next,
        basedOnVersion: current.version || null,
        createdBy: userId ? String(userId) : null,
      });
      return { changed: true, layout: present(created.toObject()) };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Someone else saved n+1 in the meantime: re-read and apply on top.
    }
  }
  throw failure(409, "LAYOUT_CONFLICT", "The layout is being changed by someone else; try again");
}

/**
 * The layout an exam-keyed (sequence) card prints with — see the header.
 *
 * @returns {Promise<object>} a layout, with `source` "issued" | "legacy" | "current" | "default"
 */
async function layoutForSequenceCard({ schoolId, examId, studentId }) {
  schoolId = requireSchool(schoolId);
  const issued = await GeneratedReport.findOne({
    examId: String(examId), studentId: String(studentId), schoolId,
  }).select("layoutVersionId layoutVersion layoutSections").lean();

  if (issued) {
    if (issued.layoutSections) {
      return {
        id: issued.layoutVersionId ?? null, schoolId, version: issued.layoutVersion ?? 0,
        sections: resolveSections(issued.layoutSections), source: "issued",
      };
    }
    return { ...defaultLayout(schoolId), source: "legacy" };
  }
  const current = await currentLayout(schoolId);
  return { ...current, source: current.source === "default" ? "default" : "current" };
}

/**
 * Sections a token template cannot hide under this layout (it prints them
 * without a {{if section_x}}), and so prints regardless. Empty for the
 * built-in layout, which honours every section.
 */
const templateCompatibility = (template, layout) =>
  (template?.html ? ungatedDisabledSections(template.html, layout.sections) : []);

/** What an issued card records about its layout (GeneratedReport fields). */
const issuedFields = (layout) => ({
  layoutVersionId: layout.id ?? null,
  layoutVersion:   layout.version ?? 0,
  layoutSections:  resolveSections(layout.sections),
});

/** Layout facts for an API response. */
const describe = (layout, template = null) => ({
  versionId: layout.id ?? null,
  version:   layout.version ?? 0,
  source:    layout.source,
  sections:  resolveSections(layout.sections),
  sectionsNotHiddenByTemplate: templateCompatibility(template, layout),
});

module.exports = {
  currentLayout,
  listVersions,
  getVersion,
  updateLayout,
  layoutForSequenceCard,
  templateCompatibility,
  issuedFields,
  describe,
  versionId,
};
