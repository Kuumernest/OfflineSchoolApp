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
 * Why:      Student.js declares gateToken with `default: null`, so EVERY
 *           student document is stored with an explicit `gateToken: null`.
 *           Older databases carry a unique NON-sparse `gateToken_1`, and even
 *           the "fixed" sparse version does NOT help: MongoDB sparse indexes
 *           only exclude documents where the field is MISSING — a field that
 *           is present with value null IS indexed, so uniqueness still applies
 *           to null. The second student without a card therefore collides.
 *
 * Fix:      At boot, inspect the live index. If `gateToken_1` exists without
 *           the partialFilterExpression that excludes non-string tokens, drop
 *           it and recreate as
 *             { unique: true,
 *               partialFilterExpression: { gateToken: { $type: "string" } } }
 *           Real tokens stay unique (that is the point of the gate-card lookup
 *           in gate.service); null/absent tokens are excluded from the index
 *           entirely, so any number of card-less students can coexist — no
 *           data migration needed for the existing nulls.
 *           Idempotent — after the first run it no-ops on every later boot.
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

  if (
    current &&
    current.partialFilterExpression &&
    current.partialFilterExpression.gateToken &&
    current.unique
  ) {
    // Already the intended shape — nothing to do.
    console.log("[indexes] students.gateToken_1 is unique+partial ✅");
    return;
  }

  if (current) {
    // 2) Stale index (unique non-sparse, or sparse without the partial
    //    filter) — either shape rejects the second `{ gateToken: null }`.
    console.warn(
      `[indexes] students.gateToken_1 is stale (unique=${!!current.unique}, ` +
        `sparse=${!!current.sparse}, partial=${!!current.partialFilterExpression}) — dropping it`
    );
    await col.dropIndex(current.name);
  }

  // 3) Recreate exactly as the model declares it.
  await col.createIndex(
    { gateToken: 1 },
    {
      unique: true,
      partialFilterExpression: { gateToken: { $type: "string" } },
      name: "gateToken_1",
    }
  );

  const after = await col.indexes();
  const recreated = after.find((ix) => ix.name === "gateToken_1");
  console.log(
    `[indexes] students.gateToken_1 recreated → unique=${!!recreated?.unique}, ` +
      `sparse=${!!recreated?.sparse}`
  );
}

module.exports = { ensureStudentGateTokenIndex };