// backend/src/db/ensureStudentIndexes.js
"use strict";

const mongoose = require("mongoose");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SELF-HEAL: students.gateToken unique index
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Symptom:  POST /api/students → 409 "E11000 duplicate key error collection:
 *           ... students index: gateToken_1 dup key: { gateToken: null }"
 *
 * Why:      Student.js declares the index as
 *           `studentSchema.index({ gateToken: 1 }, { unique: true, sparse: true })`
 *           so the many students who do not have a gate card yet (null token)
 *           can coexist. But databases created before sparse was added carry
 *           the ORIGINAL index — unique, NOT sparse — under the same name
 *           `gateToken_1`. MongoDB will not rewrite an existing index whose
 *           options conflict with a new createIndex call (IndexOptionsConflict),
 *           so Mongoose's autoIndex silently fails and the stale non-sparse
 *           index keeps rejecting every extra null token.
 *
 * Fix:      At boot (and in the one-off repair script), inspect the live index.
 *           If `gateToken_1` exists without `sparse`, drop it and recreate it
 *           as `{ unique: true, sparse: true }`. Idempotent — after the first
 *           run it no-ops on every later boot.
 *
 * A non-null token stays unique (that is the point of the gate-card lookup in
 * gate.service). Only absent/null tokens are allowed to repeat.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function ensureStudentGateTokenIndex() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error(
      "ensureStudentGateTokenIndex: no MongoDB connection available"
    );
  }

  const col = db.collection("students");

  // 1) What does the live index look like?
  const indexes = await col.indexes();
  const current = indexes.find(
    (ix) =>
      ix.name === "gateToken_1" ||
      (ix.key && ix.key.gateToken !== undefined && Object.keys(ix.key).length === 1)
  );

  if (current) {
    if (current.sparse) {
      // Already the intended shape — nothing to do.
      console.log("[indexes] students.gateToken_1 is unique+sparse ✅");
      return;
    }

    // 2) Stale non-sparse unique index — drop it.
    console.warn(
      `[indexes] students.gateToken_1 is unique but NOT sparse (stale) — dropping it`
    );
    await col.dropIndex(current.name);
  }

  // 3) Recreate exactly as the model declares it.
  await col.createIndex(
    { gateToken: 1 },
    { unique: true, sparse: true, name: "gateToken_1" }
  );

  const after = await col.indexes();
  const recreated = after.find((ix) => ix.name === "gateToken_1");
  console.log(
    `[indexes] students.gateToken_1 recreated → unique=${!!recreated?.unique}, ` +
      `sparse=${!!recreated?.sparse}`
  );
}

module.exports = { ensureStudentGateTokenIndex };