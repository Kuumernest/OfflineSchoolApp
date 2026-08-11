// backend/src/db/models/Student.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const studentSchema = new mongoose.Schema(
  {
    _id: {
      type:    String,
      default: () => uuidv4(),
    },

    // ── Relationships ─────────────────────────────────────────────────────
    userId: {
      type:     String,
      ref:      "User",
      required: [true, "User ID is required"],
      index:    true,
      unique:   true,
    },

    applicationId: {
      type:    String,
      ref:     "StudentApplication",
      default: null,
      index:   true,
    },

    schoolId: {
      type:     String,
      required: true,
      // ✅ no index: true — covered by compound indexes below
    },

    classId: {
      type:    String,
      ref:     "Class",
      default: null,
      index:   true,
    },

    // ── Enrollment ────────────────────────────────────────────────────────
    enrollmentNo: {
      type:     String,
      uppercase: true,
      trim:     true,
      required: [true, "Enrollment number is required"],
      unique:   true,
      sparse:   true,
      index:    true,
    },

    // ── Personal Info ─────────────────────────────────────────────────────
    studentName: {
      type:     String,
      required: [true, "Student name is required"],
      trim:     true,
    },
    firstName:   { type: String, trim: true,      default: null },
    lastName:    { type: String, trim: true,      default: null },
    email: {
      type:      String,
      lowercase: true,
      trim:      true,
      default:   null,
    },
    phone:       { type: String, trim: true, default: null },
    dateOfBirth: { type: String, trim: true, default: null },
    gender: {
      type:    String,
      enum:    ["male", "female", "other", null],
      default: null,
    },
    address: { type: String, trim: true, default: null },

    // ── Guardian Info ─────────────────────────────────────────────────────
    guardianName:     { type: String, trim: true,      default: null },
    guardianPhone:    { type: String, trim: true,      default: null },
    guardianEmail: {
      type:      String,
      lowercase: true,
      trim:      true,
      default:   null,
    },
    guardianRelation: { type: String, default: null },

    // ── Class Assignment ──────────────────────────────────────────────────
    className: { type: String, trim: true, default: null },
    grade:     { type: String, trim: true, default: null },

    // ── Enrollment Status ─────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["pending", "approved", "rejected", "suspended"],
      default: "approved",
      // ✅ no index: true — covered by compound index below
    },

    isActive: {
      type:    Boolean,
      default: true,
      // ✅ no index: true — covered by compound index below
    },

    // ── Dates ─────────────────────────────────────────────────────────────
    enrolledAt:  { type: Date, default: () => new Date() },
    approvedAt:  { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    deletedAt:   { type: Date, default: null },

    // ── Additional Profile Fields ─────────────────────────────────────────
    alternatePhone:    { type: String, trim: true, default: null },
    city:              { type: String, trim: true, default: null },
    state:             { type: String, trim: true, default: null },
    nationalId:        { type: String, trim: true, default: null },
    bloodGroup:        { type: String,             default: null },
    medicalConditions: { type: String, trim: true, default: null },
    bio:               { type: String, trim: true, default: null },
    profileCompleted:  { type: Boolean,            default: false },

    // ── Admin Notes ───────────────────────────────────────────────────────
    notes: { type: String, default: null },
  },
  {
    timestamps: true,
    _id:        false,
    strict:     true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES — defined ONCE here only
// ─────────────────────────────────────────────────────────────────────────────

studentSchema.index(
  { email: 1, schoolId: 1, studentName: 1 },
  { name: "idx_email_school_name", sparse: true }
);

studentSchema.index({ schoolId: 1, classId:   1 });
studentSchema.index({ schoolId: 1, isActive:  1 });
studentSchema.index({ schoolId: 1, status:    1 }); // ✅ defined ONCE
studentSchema.index({ createdAt: -1             });
studentSchema.index({ enrollmentNo: 1, schoolId: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────

studentSchema.pre("save", async function () {
  if (this.isModified("className") && this.className) {
    this.grade = this.className;
  }
  if (this.isModified("grade") && this.grade && !this.className) {
    this.className = this.grade;
  }
  if (
    (this.isModified("firstName") || this.isModified("lastName")) &&
    (this.firstName || this.lastName)
  ) {
    const computed = [this.firstName, this.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (computed) this.studentName = computed;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────

studentSchema.virtual("displayName").get(function () {
  if (this.studentName?.trim()) return this.studentName.trim();
  const full = [this.firstName, this.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return full || "Unnamed Student";
});

studentSchema.virtual("fullAddress").get(function () {
  return [this.address, this.city, this.state].filter(Boolean).join(", ") || null;
});

studentSchema.virtual("user", {
  ref:        "User",
  localField: "userId",
  foreignField:"_id",
  justOne:    true,
});

studentSchema.virtual("class", {
  ref:        "Class",
  localField: "classId",
  foreignField:"_id",
  justOne:    true,
});

studentSchema.virtual("application", {
  ref:        "StudentApplication",
  localField: "applicationId",
  foreignField:"_id",
  justOne:    true,
});

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────────────────────────────────────

studentSchema.methods.toSafeObject = function () {
  return {
    id:           this._id,
    userId:       this.userId,
    enrollmentNo: this.enrollmentNo,
    studentName:  this.studentName,
    firstName:    this.firstName,
    lastName:     this.lastName,
    email:        this.email        ?? null,
    phone:        this.phone        ?? null,
    schoolId:     this.schoolId,
    classId:      this.classId      ?? null,
    className:    this.className    ?? null,
    status:       this.status,
    isActive:     this.isActive,
    enrolledAt:   this.enrolledAt,
    displayName:  this.displayName,
    createdAt:    this.createdAt,
    updatedAt:    this.updatedAt,
  };
};

studentSchema.methods.suspend = async function () {
  this.status      = "suspended";
  this.isActive    = false;
  this.suspendedAt = new Date();
  return this.save();
};

studentSchema.methods.reactivate = async function () {
  this.status      = "approved";
  this.isActive    = true;
  this.suspendedAt = null;
  return this.save();
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────────────────────────────────────

studentSchema.statics.findByEnrollmentNo = function (enrollmentNo, schoolId) {
  return this.findOne({
    enrollmentNo: enrollmentNo.toUpperCase().trim(),
    schoolId,
    isActive: true,
  }).populate("user", "name email");
};

studentSchema.statics.findByClass = function (classId, schoolId) {
  return this.find({ classId, schoolId, isActive: true })
    .populate("user", "name email")
    .sort({ studentName: 1 });
};

studentSchema.statics.findBySchool = function (schoolId) {
  return this.find({ schoolId, isActive: true })
    .populate("user", "name email")
    .sort({ studentName: 1 });
};

studentSchema.statics.findActiveBySchool = function (schoolId) {
  return this.find({ schoolId, status: "approved", isActive: true })
    .populate("user", "name email")
    .sort({ studentName: 1 });
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports =
  mongoose.models.Student || mongoose.model("Student", studentSchema);