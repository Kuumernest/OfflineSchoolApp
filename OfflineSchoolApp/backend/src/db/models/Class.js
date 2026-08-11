// backend/src/db/models/Class.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const classSchema = new mongoose.Schema(
  {
    // ── Explicit string _id so UUID documents are cast correctly ──────────
    _id: {
      type:    String,
      default: uuidv4,
    },

    schoolId:  { type: String,  required: true, index: true },
    name:      { type: String,  required: true, trim: true  },
    level:     { type: String,  default: null               },
    section:   { type: String,  default: ""                 },
    capacity:  { type: Number,  default: null               },
    isActive:  { type: Boolean, default: true,  index: true },
    deletedAt: { type: Date,    default: null               },
    createdBy: { type: String,  default: null               },
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

classSchema.index({ schoolId: 1, name:      1 });
classSchema.index({ schoolId: 1, isActive:  1 });
classSchema.index({ schoolId: 1, deletedAt: 1 });

module.exports = mongoose.models.Class || mongoose.model("Class", classSchema);