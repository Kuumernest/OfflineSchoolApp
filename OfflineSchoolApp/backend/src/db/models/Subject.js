// backend/src/db/models/Subject.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const subjectSchema = new mongoose.Schema(
  {
    // ── Explicit string _id so UUID documents are cast correctly ──────────
    _id: {
      type:    String,
      default: uuidv4,
    },

    schoolId: { type: String, required: true, index: true },
    name:     { type: String, required: true, trim: true  },
    code:     { type: String, default: ""                 },

    // Dual field — both kept for backwards compatibility
    class:   { type: String, ref: "Class", default: null, index: true },
    classId: { type: String, ref: "Class", default: null, index: true },

    description: { type: String,  default: null },

    // Subject coefficient — the school-wide default weighting for this
    // subject, in the Cameroon sense: 1 = normal, 2 = counts double.
    // Optional; omitting it leaves the subject equally weighted.
    //
    // ExamSubject.weight is percentage-style (100 = coefficient 1), so
    // attaching a subject to an exam seeds weight = coefficient * 100.
    // Kept as a plain multiplier here because that is what an admin types.
    coefficient: { type: Number, default: 1, min: 0.1, max: 20 },

    isActive:    { type: Boolean, default: true },
    deletedAt:   { type: Date,    default: null },
  },
  {
    _id:        false,      // we supply our own string _id
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;  // expose id alias for frontend compatibility
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

subjectSchema.index({ schoolId: 1, name:    1 });
subjectSchema.index({ schoolId: 1, classId: 1 });
subjectSchema.index({ schoolId: 1, class:   1 });

module.exports = mongoose.models.Subject || mongoose.model("Subject", subjectSchema);