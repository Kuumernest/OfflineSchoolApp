// OfflineSchoolApp/shared/reportTokens.js
"use strict";

/**
 * Canonical vocabulary of report-card template tokens.
 *
 * Used by:
 *   - backend/engine/placeholder.engine.js  (resolves tokens at render time)
 *   - desktop/src/main/api/writes/templates.js (validates offline)
 *   - web/src/pages/reports/builder.tsx        (displays the variable picker)
 *
 * Adding a token here automatically makes it valid in templates and available
 * in the builder UI. The engine's buildReplacementMap() supplies the actual
 * values; this file only declares the names so both packages share one list.
 */

// ─── Simple tokens (resolved by buildReplacementMap) ────────────────────────

const SIMPLE_TOKENS = [
  // Student
  "student_name",
  "student_id",
  "admission_number",
  "gender",
  "date_of_birth",

  // Academic context
  "class",
  "stream",
  "term",
  "academic_year",

  // Attendance
  "days_present",
  "days_absent",
  "days_open",
  "attendance_percent",

  // Performance (exam results)
  "average",
  "position",
  "total_students",
  "grade",
  "remark",
  "promotion_status",
  "exam_name",
  "percentage",
  "total_score",
  "subjects_passed",
  "subjects_failed",
  "total_coefficients",
  "weighted_average",

  // Term results (NEW)
  "term_average",
  "term_grade",
  "term_remark",
  "term_class_position",
  "term_total_in_class",
  "sequence_1_average",
  "sequence_2_average",
  "sequence_3_average",
  "sequence_4_average",
  "sequence_5_average",
  "sequence_6_average",

  // Annual results (NEW)
  "annual_average",
  "annual_grade",
  "annual_remark",
  "annual_class_position",
  "annual_total_in_class",
  "term_1_average",
  "term_2_average",
  "term_3_average",

  // School
  "school_name",
  "school_motto",
  "school_address",
  "school_phone",
  "principal_name",

  // Staff / remarks
  "class_teacher",
  "teacher_comment",
  "principal_comment",

  // Dates
  "report_date",
  "next_term_date",

  // The official header: ministry and delegations in both languages, and the
  // period named ("First Sequence Progress Record"). A school building its own
  // header needs these by name, and the ones that can be blank — a delegation
  // it has not filled in — are meant to be gated with {{if}}.
  "header_country_en",
  "header_country_fr",
  "header_peace_en",
  "header_peace_fr",
  "header_ministry_en",
  "header_ministry_fr",
  "header_regional_en",
  "header_regional_fr",
  "header_divisional_en",
  "header_divisional_fr",
  "header_type_en",
  "header_type_fr",
  "header_separator",
  "report_title",
];

// ─── Composite tokens (resolved by dedicated functions) ─────────────────────

const COMPOSITE_TOKENS = [
  "subjects_table",
  "attendance_table",
  "student_photo",
  "school_logo",
  "qr_code",
];

// ─── Control-flow keywords (matched by the tokenizer) ───────────────────────

const CONTROL_KEYWORDS = ["if", "else", "endif", "each"];

// ─── Derived helpers ────────────────────────────────────────────────────────

/**
 * Every token this engine knows how to resolve.
 *
 * @returns {string[]} bare token names, e.g. ["student_name", "average", …]
 */
function knownTokens() {
  return [...new Set([...SIMPLE_TOKENS, ...COMPOSITE_TOKENS, ...CONTROL_KEYWORDS])].sort();
}

/**
 * Tokens in `html` that this engine does not know.
 *
 * Ignores block forms — {{if x}}, {{each xs}}, {{/each}}, {{#raw}} — and
 * reports only plain {{name}} tokens that would render as literal braces.
 *
 * @param {string} html
 * @returns {string[]} unknown bare names
 */
function unknownTokens(html) {
  const known = new Set(knownTokens());
  const found = new Set();
  const re    = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let   m;

  while ((m = re.exec(String(html || ""))) !== null) {
    const raw = m[1].trim();

    if (/^[/#]/.test(raw)) continue;
    if (/^(if|each)\s+/.test(raw)) continue;
    if (raw === "else" || raw === "endif") continue;

    const root = raw.split(".")[0];
    if (!known.has(root)) found.add(raw);
  }

  return [...found];
}

module.exports = {
  knownTokens,
  unknownTokens,
  SIMPLE_TOKENS,
  COMPOSITE_TOKENS,
  CONTROL_KEYWORDS,
};
