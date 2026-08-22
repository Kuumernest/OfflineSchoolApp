"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const submissionSchema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  studentId: { type: String, required: true },
  text: { type: String, default: null, maxlength: 10000 },
  attachmentUrl: { type: String, default: null },
  submittedAt: { type: Date, default: () => new Date() },
  score: { type: Number, default: null, min: 0 },
  feedback: { type: String, default: null, maxlength: 5000 },
  gradedBy: { type: String, default: null },
  gradedAt: { type: Date, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  _id: { type: String, default: uuidv4 },
  schoolId: { type: String, required: true, index: true },
  classId: { type: String, required: true, index: true },
  subjectId: { type: String, required: true },
  createdBy: { type: String, required: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  instructions: { type: String, default: null },
  dueDate: { type: String, default: null },
  maxScore: { type: Number, default: 100 },
  allowLate: { type: Boolean, default: true },
  latePenalty: { type: Number, default: 0 },
  attachmentUrl: { type: String, default: null },
  attachmentName: { type: String, default: null },
  attachmentType: { type: String, default: null },
  isPublished: { type: Boolean, default: false },
  version: { type: Number, default: 1 },
  deletedAt: { type: Date, default: null },
  submissions: { type: [submissionSchema], default: [] },
}, { timestamps: true, _id: false });

schema.index({ schoolId: 1, classId: 1, dueDate: 1 });
module.exports = mongoose.models.Homework || mongoose.model("Homework", schema);
