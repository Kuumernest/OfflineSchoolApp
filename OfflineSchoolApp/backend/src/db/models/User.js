// backend/src/db/models/User.js
"use strict";

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { generateUUID } = require("../../utils/uuid");

const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;

const uuidSchema = {
  type: String,
  default: generateUUID,
};

const userSchema = new mongoose.Schema(
  {
    _id: uuidSchema,

    // ── Identity ────────────────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },

    // ── Email ───────────────────────────────────────────────────────────────
    // Required for staff (admin / teacher / super_admin).
    // Optional for students — families share one email, so uniqueness
    // is NOT enforced. unique + sparse allows multiple nulls.
    email: {
      type: String,
      lowercase: true,
      trim: true,
      match: [emailRegex, "Please provide a valid email"],
      unique: true,
      sparse: true,
      default: null,
    },

    // ── Authentication ──────────────────────────────────────────────────────
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },

    // ── Authorization ──────────────────────────────────────────────────────
    role: {
      type: String,
      enum: {
        values: ["super_admin", "school_admin", "teacher", "student"],
        message: "Role must be super_admin, school_admin, teacher, or student",
      },
      default: "teacher",
      index: true,
    },

    // ── School & Class ──────────────────────────────────────────────────────
    schoolId: {
      type: String,
      index: true,
      ref: "School",
    },

    classId: {
      type: String,
      ref: "Class",
      index: true,
    },

    // ── Account Status ─────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    mustResetPassword: {
      type: Boolean,
      default: false,
    },

    // ── Password History ────────────────────────────────────────────────────
    passwordChangedAt: Date,
    lastLoginAt: Date,

    // ── Audit ───────────────────────────────────────────────────────────────
    createdBy: {
      type: String,
      ref: "User",
    },
  },
  {
    timestamps: true,
    _id: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────

userSchema.index({ schoolId: 1, role: 1 });
userSchema.index({ isActive: 1, schoolId: 1 });
userSchema.index({ schoolId: 1, classId: 1 });
userSchema.index({ email: 1, isActive: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION — Cross-field rules
// ─────────────────────────────────────────────────────────────────────────────

userSchema.pre("validate", function () {
  // Only enforce on new documents
  if (!this.isNew) return;

  if (this.role === "student") {
    // Students can have null email (they log in via enrollment number)
    // No validation required here
  } else {
    // super_admin, school_admin, teacher
    if (!this.email) {
      this.invalidate("email", "Email is required for staff accounts");
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Password hashing
// ─────────────────────────────────────────────────────────────────────────────

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordChangedAt = new Date();
});

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE METHODS
// ─────────────────────────────────────────────────────────────────────────────

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.passwordChangedAfter = function (jwtTimestamp) {
  if (!this.passwordChangedAt) return false;
  const changedTimestamp = parseInt(
    this.passwordChangedAt.getTime() / 1000,
    10
  );
  return jwtTimestamp < changedTimestamp;
};

userSchema.methods.toSafeObject = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email ?? null,
    role: this.role,
    schoolId: this.schoolId ?? null,
    classId: this.classId ?? null,
    isActive: this.isActive,
    mustResetPassword: this.mustResetPassword ?? false,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────────────────────────────────────

// Find an active staff member by email (includes password for auth)
userSchema.statics.findByEmail = function (email, includePassword = false) {
  const query = this.findOne({
    email: email.toLowerCase().trim(),
    isActive: true,
  });
  return includePassword ? query.select("+password") : query;
};

// Return all staff in a school (excludes students)
userSchema.statics.findStaffBySchool = function (schoolId) {
  return this.find({
    schoolId,
    isActive: true,
    role: { $in: ["school_admin", "teacher"] },
  }).sort({ name: 1 });
};

// Return all active users in a school by role
userSchema.statics.findBySchoolAndRole = function (schoolId, role) {
  return this.find({
    schoolId,
    role,
    isActive: true,
  }).sort({ name: 1 });
};

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────

userSchema.virtual("isStaff").get(function () {
  return ["super_admin", "school_admin", "teacher"].includes(this.role);
});

userSchema.virtual("isStudent").get(function () {
  return this.role === "student";
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.model("User", userSchema);