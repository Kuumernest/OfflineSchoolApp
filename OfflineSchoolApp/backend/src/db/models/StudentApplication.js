// backend/src/db/models/StudentApplication.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const documentSchema = new mongoose.Schema(
  {
    title:    { type: String, default: null },
    filename: { type: String, default: null },
    path:     { type: String, default: null },
    url:      { type: String, default: null },
    type: {
      type: String,
      enum: [
        "birth_certificate",
        "school_report",
        "medical_certificate",
        "passport_photo",
        "other",
      ],
      default: "other",
    },
    size:     { type: Number, default: 0 },
    mimeType: { type: String, default: null },
  },
  { _id: false }
);

const studentApplicationSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: () => uuidv4(),
    },

    // ── School ────────────────────────────────────────────
    schoolId: {
      type:     String,
      required: [true, "School ID is required"],
      // ✅ removed index: true — defined below in schema.index()
    },

    // ── Applicant Details ─────────────────────────────────
    studentName: {
      type:     String,
      required: [true, "Student name is required"],
      trim:     true,
    },
    firstName: { type: String, trim: true,      default: null },
    lastName:  { type: String, trim: true,      default: null },
    email: {
      type:      String,
      lowercase: true,
      trim:      true,
      default:   null,
    },
    phone:       { type: String, trim: true, default: null },
    dateOfBirth: { type: String, trim: true, default: null },
    gender:      { type: String,             default: null },
    address:     { type: String, trim: true, default: null },

    // ── Guardian Details ──────────────────────────────────
    guardianName:  { type: String, trim: true,      default: null },
    guardianPhone: { type: String, trim: true,      default: null },
    guardianEmail: {
      type:      String,
      lowercase: true,
      trim:      true,
      default:   null,
    },

    // ── Class Selection ───────────────────────────────────
    classId:   { type: String, ref: "Class",   default: null },
    className: { type: String, trim: true,     default: null },

    // ── Documents ─────────────────────────────────────────
    documents: { type: [documentSchema], default: [] },

    // ── Status ───────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["pending", "approved", "rejected"],
      default: "pending",
      // ✅ removed index: true — defined below in schema.index()
    },
    isActive: { type: Boolean, default: true },

    // ── Review ────────────────────────────────────────────
    notes:        { type: String, default: null },
    rejectReason: { type: String, default: null },

    // ── Links set during approval ─────────────────────────
    userId: {
      type:    String,
      ref:     "User",
      default: null,
      // ✅ removed index: true — defined below in schema.index()
    },
    studentId: {
      type:    String,
      ref:     "Student",
      default: null,
      // ✅ removed index: true — defined below in schema.index()
    },

    // ── Soft Delete ───────────────────────────────────────
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id:        false,
    strict:     true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────
// INDEXES — defined ONCE here only
// ─────────────────────────────────────────────────────────

studentApplicationSchema.index(
  { email: 1, schoolId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["pending", "approved"] } },
    name: "unique_active_application",
  }
);

studentApplicationSchema.index({ schoolId: 1, status:  1 });
studentApplicationSchema.index({ schoolId: 1, classId: 1 });
studentApplicationSchema.index({ createdAt: -1 });
studentApplicationSchema.index({ userId:    1 });
studentApplicationSchema.index({ studentId: 1 });

// ─────────────────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────────────────

studentApplicationSchema.virtual("documentCount").get(function () {
  return this.documents?.length || 0;
});

studentApplicationSchema.virtual("submittedAt").get(function () {
  return this.createdAt;
});

studentApplicationSchema.virtual("displayName").get(function () {
  if (this.studentName?.trim()) return this.studentName.trim();
  const full = [this.firstName, this.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return full || "Unnamed Applicant";
});

studentApplicationSchema.virtual("isApproved").get(function () {
  return this.status === "approved";
});

studentApplicationSchema.virtual("isRejected").get(function () {
  return this.status === "rejected";
});

studentApplicationSchema.virtual("isPending").get(function () {
  return this.status === "pending";
});

// ─────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────

studentApplicationSchema.pre("save", async function () {
  if (this.email) {
    this.email = this.email.toLowerCase().trim();
  }
});

// ─────────────────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────────────────

studentApplicationSchema.methods.toSafeObject = function () {
  return {
    id:            this._id,
    schoolId:      this.schoolId,
    studentName:   this.displayName,
    email:         this.email         ?? null,
    phone:         this.phone         ?? null,
    guardianName:  this.guardianName  ?? null,
    classId:       this.classId       ?? null,
    className:     this.className     ?? null,
    status:        this.status,
    submittedAt:   this.submittedAt,
    documentCount: this.documentCount,
    userId:        this.userId        ?? null,
    studentId:     this.studentId     ?? null,
  };
};

studentApplicationSchema.methods.approve = async function (userId) {
  if (this.status !== "pending") {
    throw new Error("Only pending applications can be approved");
  }
  this.status = "approved";
  this.userId = userId;
  return this.save();
};

studentApplicationSchema.methods.reject = async function (reason) {
  if (this.status !== "pending") {
    throw new Error("Only pending applications can be rejected");
  }
  this.status      = "rejected";
  this.rejectReason = reason || null;
  return this.save();
};

// ─────────────────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────────────────

studentApplicationSchema.statics.findPendingBySchool = function (schoolId) {
  return this.find({ schoolId, status: "pending",  isActive: true })
    .sort({ createdAt: -1 });
};

studentApplicationSchema.statics.findApprovedBySchool = function (schoolId) {
  return this.find({ schoolId, status: "approved", isActive: true })
    .sort({ createdAt: -1 });
};

studentApplicationSchema.statics.findBySchoolAndStatus = function (schoolId, status) {
  return this.find({ schoolId, status, isActive: true })
    .sort({ createdAt: -1 });
};

studentApplicationSchema.statics.findByEmail = function (email, schoolId) {
  return this.findOne({
    email: email.toLowerCase().trim(),
    schoolId,
  });
};

// ─────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────

module.exports =
  mongoose.models.StudentApplication ||
  mongoose.model("StudentApplication", studentApplicationSchema);