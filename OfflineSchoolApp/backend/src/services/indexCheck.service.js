// backend/src/services/indexCheck.service.js
"use strict";

/**
 * Every index the models declare, checked against the database at boot
 * (docs/40 0.19).
 *
 * Mongoose builds declared indexes in the background and says nothing when
 * one fails (a duplicate in old data, a user without createIndex), so a
 * missing index used to be found by a slow page or a duplicate row. This
 * compares, once, what each schema declares with what each collection has,
 * logs one line per missing index, then a summary:
 *
 *   [indexes] missing on students: { schoolId: 1, enrollmentNo: 1 } (unique)
 *   [indexes] Indexes verified: 212, missing: 1
 *
 * It never stops the server: a missing index costs speed (or, for a unique
 * one, lets a duplicate in), which the line makes visible; refusing to boot
 * would cost a school its day.
 */

const mongoose = require("mongoose");

/** A key spec as a stable string; a text index compares as text. */
const keyOf = (key) => {
  const entries = Object.entries(key || {});
  if (entries.some(([, v]) => v === "text")) return "text";
  return JSON.stringify(entries.map(([k, v]) => [k, Number.isFinite(Number(v)) ? Number(v) : v]));
};
const textOf = (ix) => (ix.key?._fts === "text" ? "text" : keyOf(ix.key));

/**
 * @param {object} [opts]
 * @param {mongoose.Connection} [opts.connection]
 * @param {(line: string) => void} [opts.log]   where lines go (console by default)
 * @returns {Promise<{ verified: number, missing: Array<{ collection: string, key: object, unique: boolean }> }>}
 */
async function verifyDeclaredIndexes({ connection = mongoose.connection, log = null } = {}) {
  const say = log ?? ((line) => console.log(line));
  const warn = log ?? ((line) => console.warn(line));
  const missing = [];
  let verified = 0;

  for (const name of connection.modelNames()) {
    const model = connection.model(name);
    const declared = model.schema.indexes();   // [[key, options], …]; _id is implicit
    if (!declared.length) continue;
    let have = [];
    try {
      have = await model.collection.indexes();
    } catch {
      have = [];                               // no collection yet: every declared index is missing
    }
    const present = new Set(have.map(textOf));
    for (const [key, options] of declared) {
      if (present.has(keyOf(key))) { verified += 1; continue; }
      const entry = { collection: model.collection.collectionName, key, unique: Boolean(options?.unique) };
      missing.push(entry);
      const spec = Object.entries(key).map(([k, v]) => `${k}: ${v}`).join(", ");
      warn(`[indexes] missing on ${entry.collection}: { ${spec} }${entry.unique ? " (unique)" : ""}`);
    }
  }
  say(`[indexes] Indexes verified: ${verified}, missing: ${missing.length}`);
  return { verified, missing };
}

module.exports = { verifyDeclaredIndexes, keyOf };
