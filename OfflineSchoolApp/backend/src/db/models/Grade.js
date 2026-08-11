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

module.exports = mongoose.model("Grade", gradeSchema);