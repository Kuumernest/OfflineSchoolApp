// backend/src/db/models/Intervention.js
"use strict";

/**
 * What a school DID about a pupil the intelligence layer flagged.
 *
 * ── Why this is a collection when StudentInsight deliberately is not ──────
 *
 * Everything under services/intelligence is derived: recomputed from published
 * marks on every request, owned by nobody, and safe to throw away. That is a
 * decision taken on purpose — a stored insight goes stale the moment a mark is
 * corrected, and a stale claim about a child is worse than no claim.
 *
 * This is the opposite kind of thing. A teacher decided to do something, and
 * nothing in the school's existing records says so. It cannot be recomputed
 * from marks because it is not a fact about marks; it is a fact about people.
 *
 * ── Why no existing model could carry it ──────────────────────────────────
 *
 * Homework is coursework set to a whole class, with submissions — it has no
 * notion of a pupil-scoped support action, an assigned colleague, a status or
 * an outcome. Messages are correspondence, governed by a per-thread policy
 * layer rather than a capability, and a support plan is not a conversation.
 * StudentScore.teacherRemark and ResultSummary.principalRemark are free text
 * bound to one assessment, with no lifecycle and no way to ask "what is still
 * open for this child". None of them can answer the question this exists for.
 *
 * ── What it deliberately does NOT store ───────────────────────────────────
 *
 * A snapshot of the guidance that prompted it. Only `sourceType` and
 * `sourceCode` — the stable machine code, not the evidence behind it. Copying
 * the evidence in would freeze figures that the authoritative results can still
 * change, and a school would end up holding an intervention that disagrees with
 * the report card about the same term. The evidence is recomputed from source
 * when anybody asks, exactly as everywhere else in this stack.
 *
 * It also stores no mark, no grade and no money. An intervention records a
 * decision; it is an input to nothing the school computes.
 *
 * ── Identity ──────────────────────────────────────────────────────────────
 *
 * A String uuid, defaulted here but usually chosen by the client. Offline
 * devices write locally first and resend through their outbox, so the id has to
 * exist before the server sees the row — the same pattern StudentScore and the
 * rest of the offline-writable collections already follow.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One move, kept for ever.
 *
 * The whole point of the record is that somebody can ask, a term later, who
 * started this and when it was closed. A status field alone answers neither.
 */
const statusChangeSchema = new mongoose.Schema(
  {
    from: { type: String },
    to:   { type: String },
    by:   { type: String },
    at:   { type: Date, default: Date.now },
  },
  { _id: false }
);

const interventionSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    // ── Tenancy and subject ────────────────────────────────────────────────
    // classId is stored rather than read through the pupil, because it is what
    // the sync feed's taughtStudentsOnly scope filters on and what decides
    // whether a teacher may see the row. A pupil who changes class mid-year
    // keeps the interventions recorded while they were in the old one, which
    // is the honest history.
    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    classId:   { type: String, required: true, index: true },

    // ── People ─────────────────────────────────────────────────────────────
    createdBy:  { type: String, required: true },
    updatedBy:  { type: String, required: true },
    assignedTo: { type: String, default: null },

    // ── What was decided ───────────────────────────────────────────────────
    // sourceCode is a guidance rationale code when sourceType is "guidance";
    // actionCode is one of the recommended action codes, or a school's own.
    // Codes rather than sentences, so both travel in the reader's language
    // through the existing i18n catalogues — the same rule the watch list's
    // signals already follow.
    sourceType: { type: String, enum: ["guidance", "other"], default: "other" },
    sourceCode: { type: String, default: null, maxlength: 80 },
    actionCode: { type: String, required: true, maxlength: 80 },
    notes:      { type: String, default: null, maxlength: 2000 },

    /*
     * Which subject this was about, when it was about one.
     *
     * The id alone, not the name and emphatically not the guidance that
     * prompted it: the evidence behind that guidance is recomputed from
     * published marks whenever anybody asks, and a copy frozen here would drift
     * from the report card the moment a mark was corrected.
     *
     * It is stored because without it "did anything change afterwards" cannot
     * be answered honestly. Comparing a Mathematics intervention against the
     * pupil's whole average would let a good term in three other subjects read
     * as a Mathematics recovery. Null is a real and common value — a pupil-wide
     * action, a monitoring follow-up — and the comparison says so rather than
     * picking a subject to stand in.
     */
    subjectId:  { type: String, default: null },

    // ── Lifecycle ──────────────────────────────────────────────────────────
    // The moves themselves are services/intervention.service.js; this is only
    // where they are stored.
    status: {
      type:    String,
      enum:    ["planned", "active", "completed", "cancelled"],
      default: "planned",
    },
    statusHistory: { type: [statusChangeSchema], default: [] },
    startedAt:   { type: Date },
    completedAt: { type: Date },
    cancelledAt: { type: Date },

    // ── What happened afterwards ───────────────────────────────────────────
    // A human's assessment, from a fixed vocabulary, entered by the teacher who
    // ran the intervention. Nothing computes it and nothing acts on it: it is
    // evidence for the next conversation, not a signal fed back into grading.
    outcomeCode: {
      type:    String,
      enum:    ["improved", "no_change", "further_support", "not_assessed", null],
      default: null,
    },
    outcomeNotes: { type: String, default: null, maxlength: 2000 },

    // ── Offline concurrency ────────────────────────────────────────────────
    // Two devices may hold the same row. The version is what lets the server
    // tell a stale edit from a current one and answer 409 rather than silently
    // letting whoever synced last win — the explicit-conflict policy the rest
    // of this application already keeps.
    version: { type: Number, default: 1 },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

// The one query the routes make: this pupil's record, newest first.
interventionSchema.index({ schoolId: 1, studentId: 1, updatedAt: -1 });
// And the one the sync feed makes, which scopes by class.
interventionSchema.index({ schoolId: 1, classId: 1, updatedAt: -1 });

module.exports =
  mongoose.models.Intervention || mongoose.model("Intervention", interventionSchema);
