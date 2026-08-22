// mobile/src/services/document.service.js
"use strict";

/**
 * Printed documents on the phone.
 *
 * The sheets themselves are built server-side, in backend/src/print — the same
 * strings the web console prints, so a register run off a phone and one run off
 * a laptop are the same document. What lives here is only the phone's half:
 * turning that HTML into a PDF and handing it to the printer or a share sheet.
 *
 * The HTML is cached per document. A teacher who wants the register for their
 * own class wants it in the corridor with no signal, and a roster does not
 * change between the staffroom and the classroom.
 */

import * as Print   from "expo-print";
import * as Sharing from "expo-sharing";

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import api                   from "./api";

const CACHE = "document_cache";

const ensureSchema = async (db) => {
  await ensureTableSchema(CACHE, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${CACHE} (
      doc_key     TEXT PRIMARY KEY,
      school_id   TEXT,
      html        TEXT NOT NULL,
      _fetched_at TEXT
    )`);
  }, db);
};

/** One row per document, so re-fetching replaces rather than accumulates. */
const keyFor = ({ kind, id, variant, lang }) =>
  `${kind}:${id}:${variant ?? "-"}:${lang ?? "en"}`;

const cacheGet = async (key) => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(
    `SELECT html, _fetched_at FROM ${CACHE} WHERE doc_key = ?`, [key]
  ).catch(() => null);
  return row ? { html: row.html, fetchedAt: row._fetched_at, stale: true } : null;
};

const cachePut = async (key, schoolId, html) => {
  const db = await getDatabase();
  await ensureSchema(db);
  await db.runAsync(
    `INSERT OR REPLACE INTO ${CACHE} (doc_key, school_id, html, _fetched_at)
     VALUES (?, ?, ?, ?)`,
    [key, schoolId, html, new Date().toISOString()]
  ).catch(() => {});
};

/**
 * Fetch a document, falling back to the last copy of THIS document.
 *
 * The fallback is deliberately narrow — same class, same variant, same language.
 * Handing back a different sheet because it happened to be cached is how someone
 * ends up carrying last term's register into a classroom.
 */
const fetchDocument = async ({ kind, path, id, schoolId, variant, lang }) => {
  const key = keyFor({ kind, id, variant, lang });

  try {
    const { data } = await api.get(path, {
      params: { schoolId, format: "html", variant, lang },
      // Without this the HTML body is run through the JSON parser and arrives
      // unusable.
      responseType: "text",
      transformResponse: [(body) => body],
    });

    const html = typeof data === "string" ? data : String(data ?? "");
    if (!html.trim()) throw new Error("Empty document");

    await cachePut(key, schoolId, html);
    return { html, stale: false, fetchedAt: new Date().toISOString() };
  } catch (err) {
    const cached = await cacheGet(key);
    if (cached) return cached;
    throw err;
  }
};

export const getClassListHtml = ({ schoolId, classId, variant = "plain", lang = "en" }) =>
  fetchDocument({
    kind: "class-list", path: `/documents/class-list/${classId}`,
    id: classId, schoolId, variant, lang,
  });

export const getTranscriptHtml = ({ schoolId, studentId, lang = "en" }) =>
  fetchDocument({
    kind: "transcript", path: `/documents/transcript/${studentId}`,
    id: studentId, schoolId, lang,
  });

/** A class of ID cards, ten to an A4 sheet. */
export const getIdCardsHtml = ({ schoolId, classId, lang = "en" }) =>
  fetchDocument({
    kind: "id-cards", path: `/documents/id-cards/${classId}`,
    id: classId, schoolId, lang,
  });

// ─────────────────────────────────────────────────────────────────────────────
// PUTTING IT ON PAPER
// ─────────────────────────────────────────────────────────────────────────────

/** Straight to a printer, if one is reachable. */
export const printDocument = async (html) => {
  await Print.printAsync({ html });
};

/**
 * Render to a PDF and open the share sheet.
 *
 * The common case on a phone is not a printer at all — it is sending the sheet
 * to someone on WhatsApp, or saving it to open later at a machine that has one.
 */
export const shareDocument = async (html, fileName = "document") => {
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  if (!(await Sharing.isAvailableAsync())) {
    // Nothing to share to, but the file exists — the caller can still say where.
    return { uri, shared: false };
  }

  await Sharing.shareAsync(uri, {
    mimeType: "application/pdf",
    dialogTitle: fileName,
    UTI: "com.adobe.pdf",
  });
  return { uri, shared: true };
};

export default {
  getClassListHtml,
  getTranscriptHtml,
  getIdCardsHtml,
  printDocument,
  shareDocument,
};
