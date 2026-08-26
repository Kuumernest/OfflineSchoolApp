// backend/src/db/models/User.js
"use strict";

const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");
const { generateUUID } = require("../../utils/uuid");

const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;

const uuidSchema = {
  type:    String,
  default: generateUUID,
};

const userSchema = new mongoose.Schema(
  {
    _id: uuidSchema,

    // ── Identity ──────────────────────────────────────────────────────────────
    name: {
      type:      String,
      required:  [true, "Name is required"],
      trim:      true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },

    // ── Email ─────────────────────────────────────────────────────────────────
    // NOT unique at the DB level.
    //
    // Why: siblings share a parent/guardian email address.
    //   - Staff (admin/teacher) → uniqueness enforced in pre("save") hook below
    //   - Students              → multiple accounts may share the same email
    //
    // Students log in with enrollmentNo, NOT email, so email uniqueness
    // is irrelevant for auth. Staff log in with email — enforced at app level.
    email: {
      type:      String,
      lowercase: true,
      trim:      true,
      match:     [emailRegex, "Please provide a valid email"],
      default:   null,
    },

    // ── Authentication ────────────────────────────────────────────────────────
    password: {
      type:      String,
      required:  [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select:    false,
    },

    // ── Enrollment Number (student login username) ─────────────────────────────
    // Each student gets a unique enrollmentNo — this is their login ID.
    // Null for staff. Unique + sparse enforced by DB index "enrollmentNo_1".
    enrollmentNo: {
      type:    String,
      default: null,
      trim:    true,
    },

    // ── Authorization ─────────────────────────────────────────────────────────
    role: {
      type: String,
      enum: {
        values:  ["super_admin", "school_admin", "teacher", "student"],
        message: "Role must be super_admin, school_admin, teacher, or student",
      },
      default: "teacher",
    },

    // ── School & Class ────────────────────────────────────────────────────────
    schoolId: {
      type: String,
      ref:  "School",
    },

    classId: {
      type: String,
      ref:  "Class",
    },

    // ── Account Status ────────────────────────────────────────────────────────
    isActive: {
      type:    Boolean,
      default: true,
    },

    mustResetPassword: {
      type:    Boolean,
      default: false,
    },

    /**
     * UI language for this person.
     *
     * Null means "follow the device / browser", which is the right default:
     * guessing a language from a name or a school is worse than letting the
     * platform answer. It becomes non-null only when someone chooses.
     *
     * Server-side this is what decides the language of a notification or a
     * report card generated on their behalf — neither of which has a browser
     * to read a preference from.
     */
    language: {
      type:    String,
      enum:    ["en", "fr", null],
      default: null,
    },

    // ── Password History ──────────────────────────────────────────────────────
    passwordChangedAt: Date,
    lastLoginAt:       Date,

    // ── Audit ─────────────────────────────────────────────────────────────────
    createdBy: {
      type: String,
      ref:  "User",
    },
  },
  {
    timestamps: true,
    _id:        false,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// Names match exactly what is already in MongoDB to prevent
// "already exists with different name" errors on restart.
//
// Current DB indexes (from db.users.getIndexes()):
//   _id_                      { _id: 1 }
//   schoolId_1                { schoolId: 1 }
//   role_1                    { role: 1 }
//   isActive_1                { isActive: 1 }
//   schoolId_1_role_1         { schoolId: 1, role: 1 }
//   isActive_1_schoolId_1     { isActive: 1, schoolId: 1 }
//   enrollmentNo_1            { enrollmentNo: 1 } unique sparse
//   classId_1                 { classId: 1 }
//   schoolId_1_classId_1      { schoolId: 1, classId: 1 }
//   email_1_isActive_1        { email: 1, isActive: 1 }
//   email_lookup_sparse       { email: 1 } sparse
// ─────────────────────────────────────────────────────────────────────────────

userSchema.index({ schoolId: 1 },              { name: "schoolId_1"            });
userSchema.index({ role:     1 },              { name: "role_1"                });
userSchema.index({ isActive: 1 },              { name: "isActive_1"            });
userSchema.index({ schoolId: 1, role:    1 },  { name: "schoolId_1_role_1"     });
userSchema.index({ isActive: 1, schoolId: 1 }, { name: "isActive_1_schoolId_1" });
userSchema.index({ classId:  1 },              { name: "classId_1"             });
userSchema.index({ schoolId: 1, classId: 1 },  { name: "schoolId_1_classId_1"  });
userSchema.index({ email:    1, isActive: 1 }, { name: "email_1_isActive_1"    });

// enrollmentNo — unique, but only over rows that actually have one.
//
// This replaces the old "enrollmentNo_1" (unique + sparse), which was broken:
// a sparse index skips a MISSING field but still indexes an explicit null, and
// the field above carries `default: null`. Every staff user therefore landed in
// the index under the same key, so on a fresh database the SECOND teacher or
// admin could not be created at all — E11000 on { enrollmentNo: null }.
//
// A partial filter on $type: "string" indexes only real numbers, so any number
// of users may have none. The index is deliberately given a NEW NAME: declaring
// different options under the old name raises IndexOptionsConflict on connect
// for every existing deployment, which would take the app down at startup.
//
// Existing databases keep the old broken index until it is dropped —
// scripts/fix-enrollment-index.js does that, and must be run once per
// deployment. Fresh databases only ever get this one.
userSchema.index(
  { enrollmentNo: 1 },
  {
    unique: true,
    partialFilterExpression: { enrollmentNo: { $type: "string" } },
    name: "enrollmentNo_unique_present",
  }
);

// email lookup — non-unique sparse (matches "email_lookup_sparse" in DB)
userSchema.index(
  { email: 1 },
  { sparse: true, name: "email_lookup_sparse" }
);

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION — Cross-field rules
// ─────────────────────────────────────────────────────────────────────────────

userSchema.pre("validate", function () {
  // Only enforce on new documents
  if (!this.isNew) return;

  // Staff must have an email — students may omit it (siblings share emails)
  if (this.role !== "student" && !this.email) {
    this.invalidate("email", "Email is required for staff accounts");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE — Password hashing + staff email uniqueness
//
// IMPORTANT: async pre hooks must NOT declare `next` as a parameter.
// Mongoose awaits the returned promise from async hooks.
// Use `throw` to signal errors — do NOT call next(err) or next().
// Calling next() in an async hook causes "next is not a function" error.
// ─────────────────────────────────────────────────────────────────────────────

userSchema.pre("save", async function () {
  // ── Hash password ──────────────────────────────────────────────────────────
  if (this.isModified("password")) {
    this.password          = await bcrypt.hash(this.password, 12);
    this.passwordChangedAt = new Date();
  }

  // ── Staff email uniqueness ─────────────────────────────────────────────────
  // Students can share emails (siblings) — only enforce for non-student roles.
  // This replaces the removed unique:true DB constraint on the email field.
  if (
    this.isModified("email") &&
    this.email                &&
    this.role !== "student"
  ) {
    const conflict = await this.constructor.findOne({
      email: this.email,
      role:  { $ne: "student" },  // only conflict with other staff
      _id:   { $ne: this._id  },  // not self
    });

    if (conflict) {
      const err      = new Error(
        `Email "${this.email}" is already registered to another staff account`
      );
      err.code       = 11000;
      err.statusCode = 409;
      throw err;  // throw — do NOT call next(err)
    }
  }
  // No next() call — async function return resolves the hook automatically
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
    id:                this._id,
    name:              this.name,
    email:             this.email        ?? null,
    enrollmentNo:      this.enrollmentNo ?? null,
    role:              this.role,
    schoolId:          this.schoolId     ?? null,
    classId:           this.classId      ?? null,
    isActive:          this.isActive,
    mustResetPassword: this.mustResetPassword ?? false,
    createdAt:         this.createdAt,
    updatedAt:         this.updatedAt,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an active STAFF member by email.
 * Students are excluded — they log in via enrollmentNo, not email.
 */
userSchema.statics.findByEmail = function (email, includePassword = false) {
  const query = this.findOne({
    email:    email.toLowerCase().trim(),
    isActive: true,
    role:     { $ne: "student" },
  });
  return includePassword ? query.select("+password") : query;
};

/**
 * Find an active STUDENT by enrollment number.
 * This is the primary student login lookup.
 */
userSchema.statics.findByEnrollmentNo = function (
  enrollmentNo,
  includePassword = false
) {
  const query = this.findOne({
    enrollmentNo: enrollmentNo.trim().toUpperCase(),
    isActive:     true,
    role:         "student",
  });
  return includePassword ? query.select("+password") : query;
};

/**
 * Return all active staff in a school (excludes students).
 */
userSchema.statics.findStaffBySchool = function (schoolId) {
  return this.find({
    schoolId,
    isActive: true,
    role:     { $in: ["school_admin", "teacher"] },
  }).sort({ name: 1 });
};

/**
 * Return all active users in a school filtered by role.
 */
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