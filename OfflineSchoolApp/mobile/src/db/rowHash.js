// mobile/src/db/rowHash.js
"use strict";

/**
 * A content fingerprint of a database row, for the per-user migration's
 * accounting (docs/40 §8): "this row in the shared file is the same row that
 * is now in that account's file". Not a security hash — nothing here is a
 * secret and nothing is authenticated by it. Two independent 32-bit FNV-1a
 * passes give 64 bits, which over the few thousand rows one phone holds makes
 * a collision a non-event.
 *
 * Stable across files and runs: keys are sorted, and each value is tagged with
 * its type, so 1 and "1" (SQLite storage classes INTEGER and TEXT) differ, and
 * NULL differs from "".
 */

const fnv = (str, seed) => {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

const tag = (v) => {
  if (v === null || v === undefined) return ["n"];
  if (typeof v === "number") return ["d", Number.isInteger(v) ? String(v) : v.toPrecision(17)];
  if (typeof v === "bigint") return ["d", v.toString()];
  if (typeof v === "boolean") return ["d", v ? "1" : "0"];
  if (v instanceof Uint8Array) return ["b", Array.from(v).join(",")];
  return ["s", String(v)];
};

/** Canonical text of a row: [[column, tag, value]…] sorted by column. */
export const canonicalRow = (row, { columns = null, exclude = [] } = {}) => {
  const skip = new Set(exclude);
  const keys = (columns ?? Object.keys(row ?? {})).filter((k) => !skip.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, ...tag(row?.[k])]));
};

/** 16 hex characters. */
export const hashText = (text) => {
  const a = fnv(text, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv(text, 0x050c5d1f).toString(16).padStart(8, "0");
  return a + b;
};

export const hashRow = (row, options) => hashText(canonicalRow(row, options));

export default { canonicalRow, hashText, hashRow };
