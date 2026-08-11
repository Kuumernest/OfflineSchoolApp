// backend/src/db/models/TeacherAssignment.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const teacherAssignmentSchema = new mongoose.Schema(
  {
    _id:      { type: String, default: uuidv4 },
    schoolId: { type: String, required: true, index: true },
    teacher:  { type: String, ref: "User",    required: true, index: true },
    class:    { type: String, ref: "Class",   required: true, index: true },
    subject:  { type: String, ref: "Subject", required: true, index: true },

    assignedBy: { type: String, ref: "User", default: null },
    isActive:   { type: Boolean, default: true },
    validFrom:  { type: Date,    default: null },
    validUntil: { type: Date,    default: null },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

teacherAssignmentSchema.index(
  { teacher: 1, class: 1, subject: 1 },
  { unique: true }
);
teacherAssignmentSchema.index({ schoolId: 1, teacher: 1 });
teacherAssignmentSchema.index({ schoolId: 1, class:   1 });
teacherAssignmentSchema.index({ schoolId: 1, subject: 1 });

module.exports =
  mongoose.models.TeacherAssignment ||
  mongoose.model("TeacherAssignment", teacherAssignmentSchema);