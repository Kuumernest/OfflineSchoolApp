const mongoose = require("mongoose");

const gradeSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
    },
    schoolId: {
      type: String,
      required: true,
      ref: "School",
    },
    studentId: {
      type: String,
      required: true,
      ref: "Student",
    },
    classId: {
      type: String,
      required: true,
      ref: "Class",
    },
    subjectId: {
      type: String,
      required: true,
      ref: "Subject",
    },
    examType: {
      type: String,
      enum: ["test", "midterm", "final", "assignment", "quiz"],
      required: true,
    },
    examName: { type: String, required: true },
    score: { type: Number, required: true },
    maxScore: { type: Number, required: true },
    grade: { type: String }, // A, B, C etc
    comment: { type: String, default: "" },
    term: { type: String, required: true },
    academicYear: { type: String, required: true },
    enteredBy: {
      type: String,
      ref: "User",
    },
    version: { type: Number, default: 1 },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id: false,
  }
);

// One grade entry per student per subject per exam
gradeSchema.index(
  {
    schoolId: 1,
    studentId: 1,
    subjectId: 1,
    examName: 1,
    term: 1,
    academicYear: 1,
  },
  { unique: true }
);
gradeSchema.index({ schoolId: 1, classId: 1 });
gradeSchema.index({ deletedAt: 1 });


// The change feed's page (GET /api/sync/changes, config/syncFeed.js): filtered
// on schoolId and a keyset of (updatedAt, _id), sorted the same way. Without
// this the planner walked the school's rows in full for every page and every
// idle poll, examining N documents to return none (docs/37). The mobile pull
// (updatedAt >= since) is served by the same prefix.
gradeSchema.index({ schoolId: 1, updatedAt: 1, _id: 1 });
module.exports = mongoose.model("Grade", gradeSchema);