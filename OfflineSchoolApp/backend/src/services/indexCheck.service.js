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

/** Stable JSON: object keys sorted, so equal filters compare equal. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * What an index ENFORCES, normalised: unique, sparse, partial filter, TTL.
 * Two indexes on one key with different values here are different indexes —
 * a plain index where a unique one is declared enforces nothing, and this used
 * to count it as "verified" because only the key pattern was compared.
 */
function enforcing(opts = {}) {
  return stable({
    unique: Boolean(opts.unique),
    sparse: Boolean(opts.sparse),
    partialFilterExpression: opts.partialFilterExpression ?? null,
    expireAfterSeconds: opts.expireAfterSeconds ?? null,
    // A collation changes what counts as equal ("Biology" = "biology" at
    // strength 2). Compared on locale and strength: listIndexes fills in every
    // other collation field with its default.
    collation: opts.collation ? { locale: opts.collation.locale, strength: opts.collation.strength ?? 3 } : null,
  });
}

/**
 * One declared index against the live ones:
 *   "present"      same key, same enforcing options (and the declared name,
 *                  if one is declared, is not taken by another key)
 *   "incompatible" same key with other options, or the name on another key
 *   "missing"      neither
 */
function compareIndex(key, options, live) {
  const sameKey = live.filter((ix) => textOf(ix) === keyOf(key));
  const nameClash = options?.name && live.find((ix) => ix.name === options.name && textOf(ix) !== keyOf(key));
  if (nameClash) return { status: "incompatible", detail: `the name ${options.name} is used by another key (${nameClash.name})` };
  if (!sameKey.length) return { status: "missing" };
  if (keyOf(key) === "text" || sameKey.some((ix) => enforcing(ix) === enforcing(options))) return { status: "present" };
  return { status: "incompatible", detail: `same key with other options (${sameKey.map((ix) => ix.name).join(", ")})` };
}

/** A unique or TTL index: data correctness, not speed, depends on it. */
const isCritical = (options) => Boolean(options?.unique) || options?.expireAfterSeconds != null;

// The last result, for /api/health/ready (services/readiness.service.js).
let lastState = { checkedAt: null, criticalProblems: null, missing: null, incompatible: null };

/**
 * @param {object} [opts]
 * @param {mongoose.Connection} [opts.connection]
 * @param {(line: string) => void} [opts.log]   where lines go (console by default)
 * @returns {Promise<{ verified: number,
 *   missing: Array<{ collection: string, key: object, unique: boolean }>,
 *   incompatible: Array<{ collection: string, key: object, unique: boolean, detail: string }>,
 *   criticalProblems: number }>}
 */
async function verifyDeclaredIndexes({ connection = mongoose.connection, log = null } = {}) {
  const say  = log ?? ((line) => console.log(line));
  const warn = log ?? ((line) => console.warn(line));
  // A missing or wrong unique index lets duplicates in: an error, not a warning.
  const err  = log ?? ((line) => console.error(line));
  const missing = [];
  const incompatible = [];
  let verified = 0;
  let criticalProblems = 0;
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
    for (const [key, options] of declared) {
      const { status, detail } = compareIndex(key, options, have);
      if (status === "present") { verified += 1; continue; }
      const entry = { collection: model.collection.collectionName, key, unique: Boolean(options?.unique) };
      const spec = Object.entries(key).map(([k, v]) => `${k}: ${v}`).join(", ");
      const critical = isCritical(options);
      if (critical) criticalProblems += 1;
      const say1 = critical ? err : warn;
      if (status === "missing") {
        missing.push(entry);
        say1(`[indexes] missing on ${entry.collection}: { ${spec} }${entry.unique ? " (unique)" : ""}`);
      } else {
        incompatible.push({ ...entry, detail });
        say1(`[indexes] INCOMPATIBLE on ${entry.collection}: { ${spec} }${entry.unique ? " (unique)" : ""} — ${detail}`);
      }
    }
  }
  say(`[indexes] Indexes verified: ${verified}, missing: ${missing.length}` +
      (incompatible.length ? `, incompatible: ${incompatible.length}` : ""));
  if (criticalProblems) {
    err(`[indexes] ${criticalProblems} unique/TTL index(es) missing or incompatible: duplicates can be written. ` +
        "Run scripts/provision-indexes.js (docs/17, Index provisioning).");
  }
  lastState = { checkedAt: new Date(), criticalProblems, missing: missing.length, incompatible: incompatible.length };
  return { verified, missing, incompatible, criticalProblems };
}

/** The last verification's outcome; checkedAt null if none has completed. */
const indexState = () => ({ ...lastState });

module.exports = { verifyDeclaredIndexes, indexState, compareIndex, enforcing, isCritical, keyOf, stable };
