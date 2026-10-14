// backend/src/db/models/ReportTemplateVersion.js
"use strict";

const mongoose = require("mongoose");

/**
 * One version of a school's report-card layout (docs/39 §6.5, Phase 2d).
 *
 * Which sections the school's report cards print (shared/reportSections.js).
 * A school's CURRENT layout is its highest version; a school with none has
 * the default — every section on — which is the card every school printed
 * before this existed.
 *
 * ── Immutable, and versioned by insertion ─────────────────────────────────
 *
 * A version that has been used to issue a report card is part of that card's
 * record, so no version is ever edited: changing a toggle inserts version
 * n+1 and leaves n exactly as it was. Every issued card (GeneratedReport)
 * keeps the id of the version it was printed under and a copy of its
 * sections, so it reprints with the layout it was issued with however many
 * versions follow. Append-only at the model layer, like ResultChangeLog.
 *
 * ── Keyed `${schoolId}:v${version}` ───────────────────────────────────────
 *
 * Two administrators saving at once both compute n+1; the `_id` makes exactly
 * one of them win, on the one index MongoDB always has rather than on a
 * declared unique index production may not have built (docs/37 §15). The
 * loser retries on n+2 (services/reportLayout.service.js). The key also
 * carries the school, so an id can never name another school's version
 * without the scoped lookup noticing.
 *
 * Presentation only. Nothing here is read by any calculation.
 */

const reportTemplateVersionSchema = new mongoose.Schema(
  {
    // `${schoolId}:v${version}`
    _id: { type: String, required: true },

    schoolId: { type: String, required: true },
    version:  { type: Number, required: true, min: 1 },

    // Every known section, explicitly: { results: true, remarks: false, … }.
    // Stored complete rather than as a diff so a version reads the same
    // whatever defaults a later release ships.
    sections: { type: mongoose.Schema.Types.Mixed, required: true },

    // The version this one was changed from (null for a school's first).
    basedOnVersion: { type: Number, default: null },

    createdBy: { type: String, default: null },
  },
  {
    _id:        false,
    timestamps: { createdAt: true, updatedAt: false },
    minimize:   false,
  }
);

// "This school's versions, newest first" — the current layout and the history.
reportTemplateVersionSchema.index({ schoolId: 1, version: -1 });

const refuse = (verb) => async function () {
  throw new Error(`ReportTemplateVersion is append-only — ${verb} is not permitted`);
};

reportTemplateVersionSchema.pre("findOneAndUpdate",  refuse("update"));
reportTemplateVersionSchema.pre("updateOne",         { query: true, document: false }, refuse("update"));
reportTemplateVersionSchema.pre("updateMany",        refuse("update"));
reportTemplateVersionSchema.pre("replaceOne",        refuse("replace"));
reportTemplateVersionSchema.pre("findOneAndReplace", refuse("replace"));
reportTemplateVersionSchema.pre("findOneAndDelete",  refuse("delete"));
reportTemplateVersionSchema.pre("deleteOne",         { query: true, document: false }, refuse("delete"));
reportTemplateVersionSchema.pre("deleteMany",        refuse("delete"));

reportTemplateVersionSchema.pre("save", async function () {
  if (!this.isNew) {
    throw new Error("ReportTemplateVersion is append-only — update is not permitted");
  }
});

module.exports =
  mongoose.models.ReportTemplateVersion ||
  mongoose.model("ReportTemplateVersion", reportTemplateVersionSchema);
