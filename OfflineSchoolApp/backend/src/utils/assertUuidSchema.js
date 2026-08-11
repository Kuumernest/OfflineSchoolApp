// backend/utils/assertUuidSchema.js
"use strict";

/**
 * Asserts that a Mongoose model's _id field is typed as String.
 * Throws at startup if a UUID-keyed model is mistakenly declared as ObjectId.
 *
 * Usage:
 *   assertUuidSchema(require("./models/Class"),   "Class");
 *   assertUuidSchema(require("./models/Subject"),  "Subject");
 */
const assertUuidSchema = (Model, label) => {
  const idType = Model.schema.path("_id");
  if (!idType) {
    console.warn(`[schema] ⚠️  ${label} has no explicit _id path — Mongoose will default to ObjectId`);
    return;
  }

  const typeName = idType.instance; // "String" | "ObjectID" | …
  if (typeName !== "String") {
    throw new Error(
      `[schema] ❌ ${label}._id is typed as "${typeName}" but UUID strings are stored. ` +
      `Change the schema to: _id: { type: String }`
    );
  }

  console.log(`[schema] ✅ ${label}._id — String (UUID-safe)`);
};

module.exports = assertUuidSchema;