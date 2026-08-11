// backend/src/db/models/ExamSubject.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const examSubjectSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    examId:    { type: String, ref: "Exam",    required: true, index: true },
    subjectId: { type: String, ref: "Subject", required: true, index: true },
    classId:   { type: String, ref: "Class",   required: true, index: true },
    schoolId:  { type: String,                 required: true, index: true },
    teacherId: { type: String, ref: "User",    default: null  },

    subjectName: { type: String, default: null },
    teacherName: { type: String, default: null },

    maxScore:    { type: Number,  default: 100   },
    passMark:    { type: Number,  default: 50    },
    weight:      { type: Number,  default: 100   },
    isPractical: { type: Boolean, default: false },
    isTheory:    { type: Boolean, default: true  },
    isOral:      { type: Boolean, default: false },

    submissionStatus: {
      type:    String,
      enum:    ["pending", "submitted", "approved", "rejected"],
      default: "pending",
      index:   true,
    },
    submittedAt:  { type: Date,   default: null },
    submittedBy:  { type: String, default: null },
    approvedAt:   { type: Date,   default: null },
    approvedBy:   { type: String, default: null },
    rejectedAt:   { type: Date,   default: null },
    rejectedBy:   { type: String, default: null },
    rejectReason: { type: String, default: null },

    syncStatus: {
      type:    String,
      enum:    ["synced", "pending", "conflict"],
      default: "synced",
    },
    deletedAt: { type: Date, default: null },
  },
  {
    _id:       false,
    timestamps: true,
    toJSON:    { virtuals: true },
    toObject:  { virtuals: true },
  }
);

examSubjectSchema.index(
  { examId: 1, subjectId: 1, classId: 1 },
  { unique: true }
);
examSubjectSchema.index({ examId: 1, submissionStatus: 1 });

module.exports = mongoose.model("ExamSubject", examSubjectSchema);