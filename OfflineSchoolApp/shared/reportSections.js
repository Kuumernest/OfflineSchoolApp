// OfflineSchoolApp/shared/reportSections.js
"use strict";

/**
 * The sections a report card is made of, and which of them a school shows.
 *
 * ── Where the list comes from (docs/39 §10, Phase 2d) ─────────────────────
 *
 * Not invented: these are the blocks the built-in layout
 * (backend/src/services/reportHtml.service.js renderReportCardHtml) has always
 * printed, in the order it prints them, and the blocks the shipped token
 * template (backend/src/print/defaultReportTemplate.js) has. Nothing new is
 * printed because this file exists — attendance, stamp, signatures images and
 * custom fields are not sections here because no renderer prints them today.
 * Adding one is: an entry below, a block in each renderer that gates on it,
 * and a decision about its default.
 *
 * ── Presentation only ─────────────────────────────────────────────────────
 *
 * A section's switch decides whether the card PRINTS that block. It changes
 * no mark, average, rank, decision or intelligence input, and nothing is
 * deleted: the results behind a hidden "results" section are exactly where
 * they were, and switching it back on prints them again.
 *
 * ── The default ───────────────────────────────────────────────────────────
 *
 * Every section on. That is the card every school has printed until now, so
 * a school that never configures anything — and every card issued before
 * configuration existed — keeps exactly the card it had. Turning a section
 * off is always a school's own, explicit choice.
 *
 * Pure: no database. Shared so the desktop and the web builder can offer the
 * same list without a copy of it.
 */

const SECTIONS = Object.freeze([
  // Drawn by the server around EVERY card, a school template's included
  // (reportHtml.service wrapTemplateHtml), so the server hides it itself.
  { id: "watermark",    label: "Watermark", appliedByServer: true,
    description: "The school's logo, faint, behind the whole card." },
  { id: "header",       label: "Official header",
    description: "Ministry and delegations, school name, logo, motto, and the card's title." },
  { id: "studentInfo",  label: "Student information",
    description: "Name, admission number, gender, date of birth, class and year." },
  { id: "results",      label: "Academic results",
    description: "The subject table: marks, coefficients, grades, remarks, subject positions, totals and the pass/decision rows under it." },
  { id: "performance",  label: "Performance summary",
    description: "The pupil's rank, average, overall grade and (annual card only) the council's decision." },
  { id: "classProfile", label: "Class profile",
    description: "The class average, best and lowest." },
  { id: "conduct",      label: "Conduct",
    description: "The work, behaviour and observation boxes filled in by hand." },
  { id: "remarks",      label: "Remarks",
    description: "The class teacher's and the head's remarks, with their signature lines." },
  { id: "verification", label: "Verification strip",
    description: "The QR code and code a registrar uses to check the card." },
  { id: "footer",       label: "Footer",
    description: "Date of issue and the school's name at the foot of the card." },
]);

const SECTION_IDS = Object.freeze(SECTIONS.map((s) => s.id));

/** Sections the server applies around any card, template or not. */
const SERVER_APPLIED = new Set(SECTIONS.filter((s) => s.appliedByServer).map((s) => s.id));

/** Every section on: the card as it was before configuration existed. */
const DEFAULT_SECTIONS = Object.freeze(Object.fromEntries(SECTION_IDS.map((id) => [id, true])));

/**
 * A complete map from whatever was stored or passed: every known section,
 * missing ones at their default. Unknown ids are dropped, not kept — a
 * section a newer server knows and this one does not cannot be printed by
 * this one anyway.
 *
 * @param {object|null|undefined} stored  { id: boolean }
 * @returns {Record<string, boolean>}
 */
const resolveSections = (stored) => {
  const out = { ...DEFAULT_SECTIONS };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const id of SECTION_IDS) {
      if (typeof stored[id] === "boolean") out[id] = stored[id];
    }
  }
  return out;
};

/**
 * Is this request body a valid change to a school's sections?
 *
 * Accepts { sections: { id: boolean, … } } with at least one entry. Partial
 * is allowed — the rest keep their current values. Refuses unknown section
 * ids, non-boolean values, a missing or non-object `sections`, and any other
 * top-level key (a typo there would otherwise be silently ignored).
 *
 * @returns {{ok: true, sections: object} | {ok: false, code: string, error: string, details?: any}}
 */
const validateSectionsInput = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "INVALID_BODY", error: "Expected an object with a `sections` map" };
  }
  const extra = Object.keys(body).filter((k) => k !== "sections" && k !== "schoolId");
  if (extra.length) {
    return { ok: false, code: "UNKNOWN_FIELD", error: `Unexpected field(s): ${extra.join(", ")}`, details: extra };
  }
  const { sections } = body;
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
    return { ok: false, code: "INVALID_SECTIONS", error: "`sections` must be an object of { sectionId: true|false }" };
  }
  const keys = Object.keys(sections);
  if (!keys.length) {
    return { ok: false, code: "INVALID_SECTIONS", error: "`sections` names no section" };
  }
  const unknown = keys.filter((k) => !SECTION_IDS.includes(k));
  if (unknown.length) {
    return { ok: false, code: "UNKNOWN_SECTION", error: `Unknown section(s): ${unknown.join(", ")}`, details: unknown };
  }
  const notBoolean = keys.filter((k) => typeof sections[k] !== "boolean");
  if (notBoolean.length) {
    return { ok: false, code: "INVALID_SECTION_VALUE", error: `Section value(s) must be true or false: ${notBoolean.join(", ")}`, details: notBoolean };
  }
  return { ok: true, sections: { ...sections } };
};

/** The template-engine flag for a section: {{if section_results}} … {{endif}}. */
const flagFor = (id) => `section_${id}`;

/** { section_watermark: true, … } for the template engine. */
const sectionFlags = (sections) => {
  const resolved = resolveSections(sections);
  return Object.fromEntries(SECTION_IDS.map((id) => [flagFor(id), resolved[id]]));
};

/**
 * Sections switched OFF that a token template has no {{if section_x}} for.
 *
 * A school's own template is its own document and is never rewritten
 * (scripts/repair-report-templates.js says why), so a section it prints
 * unconditionally cannot be hidden from inside it. Reported, never silently
 * ignored: the layout API and the render result both carry this list.
 *
 * @param {string} html      the template's html
 * @param {object} sections  resolved sections
 * @returns {string[]} section ids
 */
const ungatedDisabledSections = (html, sections) => {
  const resolved = resolveSections(sections);
  const text = String(html || "");
  return SECTION_IDS.filter((id) => resolved[id] === false &&
    !SERVER_APPLIED.has(id) &&
    !new RegExp(`\\{\\{\\s*if\\s+${flagFor(id)}\\s*\\}\\}`).test(text));
};

module.exports = {
  SECTIONS,
  SECTION_IDS,
  DEFAULT_SECTIONS,
  resolveSections,
  validateSectionsInput,
  flagFor,
  sectionFlags,
  ungatedDisabledSections,
};
