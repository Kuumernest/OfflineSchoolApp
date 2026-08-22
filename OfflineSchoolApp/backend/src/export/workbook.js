// backend/src/export/workbook.js
"use strict";

const writeXlsx = require("write-excel-file/node");

/**
 * Spreadsheet exports.
 *
 * Real .xlsx, not CSV, and the reason is this school specifically. It runs in
 * English and French, and CSV cannot survive that:
 *
 *   · French Excel expects `;` between fields, English expects `,`. A file
 *     written for one opens as a single unusable column in the other.
 *   · Accented names — Nkeng Estelle Éboué — arrive as mojibake unless the file
 *     carries a UTF-8 BOM, which some readers then show as a stray character in
 *     cell A1.
 *   · Excel autodetects types in CSV. "GVA00/2026/002" becomes a date, and a
 *     leading zero on an enrolment number is silently dropped.
 *
 * An .xlsx carries types and encoding in the file, so none of those apply. It
 * is built here rather than in the clients for the same reason the printed
 * documents are: there are two clients, and one copy cannot drift from another.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CELL BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

const HEADER = {
  fontWeight: "bold",
  backgroundColor: "#ECEEF3",
  color: "#2B3242",
  align: "left",
  wrap: true,
  borderColor: "#C8CDD8",
  borderStyle: "thin",
};

/** Text. Empty stays empty rather than becoming the string "null". */
const text = (value) => ({
  type: String,
  value: value === null || value === undefined || value === "" ? null : String(value),
});

/**
 * Whole XAF.
 *
 * `#,##0` with no decimal places, because the franc has no minor unit — a
 * column formatted to two places invites someone to type 1500.50 into it.
 */
const money = (value) => ({
  type: Number,
  value: typeof value === "number" && Number.isFinite(value) ? value : null,
  format: "#,##0",
});

const number = (value, format = "0") => ({
  type: Number,
  value: typeof value === "number" && Number.isFinite(value) ? value : null,
  format,
});

/**
 * A date cell, from whatever the record holds.
 *
 * Falls back to text when the value will not parse. Some records store a date
 * of birth as free text, and forcing an unparseable string into a Date cell
 * writes an empty cell — losing the only copy of that information.
 */
const date = (value) => {
  if (!value) return { type: String, value: null };
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return { type: String, value: String(value) };
  return { type: Date, value: d, format: "dd/mm/yyyy" };
};

const bool = (value) => ({ type: Boolean, value: Boolean(value) });

// ─────────────────────────────────────────────────────────────────────────────
// SHEET ASSEMBLY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn rows of plain objects into a sheet.
 *
 * @param {object}   sheet
 * @param {string}   sheet.name     tab name
 * @param {Array}    sheet.columns  [{ key, label, width, cell }]
 * @param {Array}    sheet.rows     source records
 */
const buildSheet = ({ columns, rows }) => {
  const header = columns.map((c) => ({ ...HEADER, type: String, value: c.label }));
  // The index is passed 1-based so a "No." column can be written as a plain
  // cell function rather than every export having to pre-number its rows.
  const body = rows.map((row, i) =>
    columns.map((c) => (c.cell ? c.cell(row, i + 1) : text(row[c.key])))
  );
  return [header, ...body];
};

/**
 * Excel refuses a tab name over 31 characters or containing : \ / ? * [ ]
 * — and rejects the whole workbook rather than fixing it, so a class called
 * "Form 5 / Science" would fail the export instead of naming a tab awkwardly.
 */
const safeSheetName = (name, fallback = "Sheet1") => {
  const cleaned = String(name ?? "").replace(/[:\\/?*[\]]/g, " ").trim();
  return (cleaned || fallback).slice(0, 31);
};

/**
 * Write a workbook to a Buffer.
 *
 * Two shapes of this library's API bite here, both silently in the sense that
 * they fail at call time rather than at review time:
 *
 *   · a multi-sheet file takes an array of sheet OBJECTS, not an array of sheet
 *     data with names passed alongside — the older shape throws outright;
 *   · the Node build returns a handle with toBuffer()/toStream()/toFile(),
 *     NOT the bytes, so a `buffer: true` option does nothing and the caller
 *     ends up trying to send an object as a file body.
 *
 * @param {Array} sheets  [{ name, columns, rows }]
 * @returns {Promise<Buffer>}
 */
const buildWorkbook = async (sheets) =>
  writeXlsx(
    sheets.map((s, i) => ({
      name:    safeSheetName(s.name, `Sheet${i + 1}`),
      data:    buildSheet(s),
      columns: s.columns.map((c) => ({ width: c.width ?? 18 })),
      // The header stays put while a bursar scrolls two hundred rows of arrears.
      stickyRowsCount: 1,
    }))
  ).toBuffer();

/**
 * A filename that survives the trip to a phone and back.
 *
 * Accents are folded away rather than percent-escaped: Content-Disposition
 * encoding rules differ between browsers, and a download that arrives named
 * "eleves-form-5.xlsx" beats one named "%C3%A9l%C3%A8ves.xlsx".
 *
 * The fold is done by code point rather than by a regex character class. A
 * class of combining marks has to be written with literal invisible characters
 * or with escapes that every re-encode of this file threatens; a numeric range
 * check cannot be corrupted by either.
 */
const stripAccents = (value) =>
  String(value)
    .normalize("NFD")
    .split("")
    .filter((ch) => {
      const c = ch.codePointAt(0);
      // U+0300..U+036F — the combining diacritical marks NFD just split off.
      return c < 0x0300 || c > 0x036f;
    })
    .join("");

const safeFileName = (parts) => {
  const joined = stripAccents(parts.filter(Boolean).join("-"));
  const cleaned = joined
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
  return cleaned || "export";
};

module.exports = {
  text, money, number, date, bool,
  buildWorkbook, safeSheetName, safeFileName,
  HEADER,
};
