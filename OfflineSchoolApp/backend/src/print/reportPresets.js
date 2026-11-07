// backend/src/print/reportPresets.js
"use strict";

/**
 * Ready-made report-card layouts (C12).
 *
 * A school picks one of three instead of editing HTML. All three are the
 * shipped template (defaultReportTemplate.js) — the same tokens, the same
 * {{if section_x}} gates, so every section switch in Settings > Report layout
 * works on each of them — and differ only in CSS appended after the shipped
 * CSS. Nothing a preset does can drop a field or ignore a switch.
 *
 * Raw HTML stays available as the advanced path (the template builder).
 */

const { DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS } = require("./defaultReportTemplate");

const COMPACT_CSS = `
  /* ── Compact: one page, tighter spacing ─────────────── */
  body                { font-size: 10.5px; }
  .report-wrapper     { padding: 14px; border-width: 1px; }
  .report-title       { font-size: 13px; padding: 5px; margin: 8px 0; }
  .student-info-grid  { padding: 8px; margin-bottom: 10px; gap: 2px 12px; }
  .info-row           { font-size: 10.5px; }
  .subjects-table th,
  .subjects-table td  { padding: 3px 5px; }
  .subjects-table     { margin-bottom: 10px; }
`;

const CLEAR_CSS = `
  /* ── Clear: larger type, banded rows, sober colours ─── */
  body                { font-size: 13px; }
  .report-wrapper     { border: 1px solid #111; border-radius: 0; padding: 28px; }
  .report-title       { background: #111; font-size: 16px; letter-spacing: 2px; }
  .student-info-grid  { background: #fff; border: 1px solid #d1d5db; border-radius: 0; }
  .subjects-table thead { background: #f3f4f6; color: #111; font-size: 12px; }
  .subjects-table th,
  .subjects-table td  { border-color: #d1d5db; padding: 8px 10px; }
  .subjects-table tr:nth-child(even) { background: #f3f4f6; }
`;

const PRESETS = Object.freeze([
  { id: "classic", name: "Classic report card",
    description: "The standard card: official header, blue title band, full subject table.",
    css: DEFAULT_TEMPLATE_CSS },
  { id: "compact", name: "Compact report card",
    description: "The same card in smaller type and tighter spacing, to fit a long subject list on one page.",
    css: DEFAULT_TEMPLATE_CSS + COMPACT_CSS },
  { id: "clear", name: "Clear report card",
    description: "Larger type and black-and-white bands — easiest to read and to photocopy.",
    css: DEFAULT_TEMPLATE_CSS + CLEAR_CSS },
]);

const presetById = (id) => PRESETS.find((p) => p.id === id) ?? null;

module.exports = { PRESETS, presetById, PRESET_HTML: DEFAULT_TEMPLATE_HTML };
