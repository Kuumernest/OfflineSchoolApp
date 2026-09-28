// backend/src/db/models/DevelopmentPlan.js
"use strict";

/**
 * A development plan: an objective a pupil and a teacher work on together,
 * with controlled actions, observable milestones, a review schedule, the
 * pupil's participation, reviews, adaptations, reflections and constraints.
 *
 * ── Why this is its own collection ────────────────────────────────────────
 *
 * The existing records were considered first. An Intervention is one
 * support action with its own eight-state lifecycle; a plan aggregates
 * guidance items and interventions, carries milestones with their own state
 * machine, reviews with a system reading beside a human decision,
 * adaptations that replace actions without deleting them, the pupil's
 * reflections and documented constraints, and runs a ten-state lifecycle.
 * Folding that into Intervention would give the legacy readers (the class
 * page, the sync feed, the outcome page) rows that are not interventions and
 * a status they cannot derive. StrengthProfileSnapshot is immutable history
 * and must stay so; ExplorationEvidence, ExplorationReflection and
 * ExplorationObservation are exploration-scoped and mirrored (or deliberately
 * not) under their own rules. None can carry a plan's lifecycle safely.
 *
 * ── What it deliberately does NOT store ───────────────────────────────────
 *
 * A copy of the evidence: the plan references the evidence boundary hash
 * and the source guidance and intervention ids, and every review references
 * the boundaries it was made on. No mark, no name, no reflection text from
 * the exploration loop, no socioeconomic anything — a constraint is an
 * explicit operational fact recorded by an authorised person.
 *
 * ── Append-only ───────────────────────────────────────────────────────────
 *
 * Status moves, milestone moves, reviews, adaptations, reflections and
 * constraints are appended with their time; nothing is edited in place, so
 * the plan as of any date is reconstructable (shared/developmentPlanning
 * reconstruct). The client may mint the id offline.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const move = new mongoose.Schema({ from: String, to: String, action: String, by: String, role: String, at: Date, note: { type: String, default: null, maxlength: 1000 }, reason: { type: String, default: null } }, { _id: false });

const developmentPlanSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },
    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    classId:   { type: String, default: null, index: true },
    dimension: { type: String, default: null },
    subjectId: { type: String, default: null },

    objective: { type: new mongoose.Schema({ category: String, code: String, evidenceFamilies: [String], completion: { requiredMilestones: Number, independentObservations: Number } }, { _id: false }), required: true },
    rationale: { type: mongoose.Schema.Types.Mixed, default: null },
    sourceGuidanceIds:     { type: [String], default: [] },
    sourceInterventionIds: { type: [String], default: [] },

    actions: { type: [new mongoose.Schema({ actionType: String, explanation: String, addedAt: Date, replacedAt: { type: Date, default: null } }, { _id: false })], default: [] },
    milestones: { type: [new mongoose.Schema({ milestoneId: String, kind: String, owner: String, order: Number, evidenceFamily: String, state: String, reason: { type: String, default: null }, createdAt: { type: Date, default: null }, adaptationIndex: { type: Number, default: null }, history: { type: [move], default: [] } }, { _id: false })], default: [] },
    reviewSchedule: { type: new mongoose.Schema({ startDate: Date, reviewDate: Date, intervalDays: Number }, { _id: false }), required: true },

    ownerRole: { type: String, enum: ["STUDENT", "TEACHER", "PARENT", "SCHOOL_ADMIN"], default: "TEACHER" },
    studentParticipation: { type: new mongoose.Schema({ required: { type: Boolean, default: true }, acceptedAt: { type: Date, default: null }, acceptedBy: { type: String, default: null }, declinedAt: { type: Date, default: null }, reflections: { type: Number, default: 0 } }, { _id: false }), default: () => ({}) },

    status: { type: String, enum: ["DRAFT", "PROPOSED", "ACCEPTED", "ACTIVE", "REVIEW_DUE", "ADAPTING", "COMPLETED", "PAUSED", "CLOSED", "DECLINED"], default: "DRAFT", index: true },
    statusHistory: { type: [move], default: [] },

    reviews: { type: [new mongoose.Schema({ reviewId: String, at: Date, by: String, role: String, asOf: Date, evidenceBoundaryHash: String, developmentObservationBoundary: { type: String, default: null },
      teacherReview: { type: new mongoose.Schema({ code: String, note: { type: String, default: null, maxlength: 2000 } }, { _id: false }), default: null },
      system: mongoose.Schema.Types.Mixed, decision: String, engineVersions: mongoose.Schema.Types.Mixed }, { _id: false })], default: [] },
    adaptations: { type: [mongoose.Schema.Types.Mixed], default: [] },
    reflections: { type: [new mongoose.Schema({ at: Date, by: String, codes: [String], note: { type: String, default: null, maxlength: 1000 } }, { _id: false })], default: [] },
    constraints: { type: [new mongoose.Schema({ code: String, at: Date, by: String, role: String, note: { type: String, default: null, maxlength: 500 }, resolvedAt: { type: Date, default: null } }, { _id: false })], default: [] },

    evidenceBoundaryHash: { type: String, default: null },
    engineVersions: { type: mongoose.Schema.Types.Mixed, default: null },
    explanation: { type: mongoose.Schema.Types.Mixed, default: null },

    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    version:   { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

developmentPlanSchema.index({ schoolId: 1, studentId: 1, status: 1 });

module.exports = mongoose.models.DevelopmentPlan || mongoose.model("DevelopmentPlan", developmentPlanSchema);
