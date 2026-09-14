// backend/src/db/models/Exam.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const { CA_TYPE } = require("../../../../shared/caAssessment");

/**
 * Exam.type's enum. Exported so the routes and the clients can offer exactly
 * these without keeping their own list — the desktop mirror and both settings
 * screens already proved what a second copy of an enum costs.
 */
const EXAM_TYPES = ["test", "practical", "promotion_exam", CA_TYPE];

const examSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId:  { type: String, required: true, index: true },

    // ── Class references ──────────────────────────────────
    classId:   { type: String, ref: "Class", index: true, default: null },
    className: { type: String, default: null },
    classIds:   { type: [String], default: [] },
    classNames: { type: String,   default: null },

    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    // ── Type ──────────────────────────────────────────────
    // "ca" is continuous assessment: the other half of a sequence, marked
    // through the weeks rather than on the paper. It is an exam like any
    // other on purpose — it gets ExamSubjects, StudentScores, the same entry
    // screens, the same permissions, the same offline queue and the same sync
    // rules, none of which had to learn what CA is.
    type: {
      type:    String,
      enum:    EXAM_TYPES,
      default: "test",
    },

    // The sequence paper this continuous assessment belongs to.
    //
    // Only ever set on a type: "ca" exam, and it is what makes the pairing
    // exact. A CA and a paper can also be matched by school + year + term +
    // sequence, which is the fallback for rows created before this field or by
    // hand — but two classes sitting the same sequence make that ambiguous,
    // and a mark attached to the wrong paper is worse than no mark.
    parentExamId: { type: String, ref: "Exam", default: null, index: true },

    // ── Sequence binding (1–6) ────────────────────────────
    sequenceNumber: {
      type:    Number,
      min:     1,
      max:     6,
      default: null,
    },

    // ── Academic period ───────────────────────────────────
    academicYear: { type: String, required: true },
    term:         { type: Number, required: true, min: 1, max: 3 },

    startDate: { type: String, default: null },
    endDate:   { type: String, default: null },

    status: {
      type:    String,
      enum:    ["draft", "scheduled", "ongoing", "completed", "published", "archived"],
      default: "draft",
      index:   true,
    },

    description:  { type: String, default: null },
    instructions: { type: String, default: null },

    totalMarks: { type: Number, default: 100 },
    passMark:   { type: Number, default: 50  },

    /*
     * ── Weighting: metadata, NOT the calculation's authority ─────────────
     *
     * GradingConfig.caWeight and GradingConfig.testWeight are the
     * authoritative weights for every sequence CA/Test calculation. Exam.weight
     * is retained as exam metadata for display and for backward compatibility,
     * and does not override GradingConfig.
     *
     * The old comment here read "percentage weight within its sequence", which
     * is exactly the sentence that invites somebody to reach for this field
     * when adding up a sequence. Nothing reads it — grep the repository — and
     * nothing should start, because a per-exam copy of a school-wide
     * percentage goes stale the moment an administrator changes the split, and
     * the two would then disagree with no way to tell which produced a mark
     * already printed on a report card.
     *
     * A school's split lives in one document, is edited in one place, and is
     * read through one function: sequenceAssessment.loadCaSettings().
     *
     * (Not to be confused with ExamSubject.weight, which is a different field
     * with the same name: the subject's COEFFICIENT, percentage-style, and
     * genuinely part of the arithmetic.)
     */
    weight: { type: Number, default: 100 },

    // ── Publishing ────────────────────────────────────────
    resultsPublished:   { type: Boolean, default: false },
    resultsLockedAt:    { type: Date,    default: null  },
    resultsPublishedAt: { type: Date,    default: null  },
    publishedBy:        { type: String,  default: null  },

    createdBy: { type: String, ref: "User", default: null },
    updatedBy: { type: String, ref: "User", default: null },

    syncStatus:   { type: String, enum: ["synced", "pending", "conflict"], default: "synced" },
    lastSyncedAt: { type: Date,   default: null },
    deletedAt:    { type: Date,   default: null },
  },
  {
    _id:       false,
    timestamps: true,
    toJSON:    { virtuals: true },
    toObject:  { virtuals: true },
  }
);

examSchema.index({ schoolId: 1, status: 1 });
examSchema.index({ schoolId: 1, academicYear: 1, term: 1 });
examSchema.index({ schoolId: 1, academicYear: 1, term: 1, sequenceNumber: 1 });
examSchema.index({ schoolId: 1, classId: 1, status: 1 });
examSchema.index({ schoolId: 1, classIds: 1 });
// Finding a sequence's continuous assessment from the paper, which every
// sequence result and every sequence report card now does.
examSchema.index({ parentExamId: 1, type: 1 });
examSchema.index({ schoolId: 1, academicYear: 1, term: 1, sequenceNumber: 1, type: 1 });

const Exam = mongoose.model("Exam", examSchema);
Exam.EXAM_TYPES = EXAM_TYPES;

module.exports = Exam;
