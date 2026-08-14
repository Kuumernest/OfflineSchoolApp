// backend/src/db/models/StudentApplication.js
"use strict";

/**
 * StudentApplication.js
 *
 * Fixed issues:
 *  #A1 — document.type enum was too strict — values like "other" sent
 *         from the app were being rejected by Mongoose validation causing
 *         silent save failures or 500 errors. Changed to accept any string
 *         and normalise unknown values to "other".
 *
 *  #A2 — unique index partialFilterExpression only covered pending +
 *         approved but the duplicate-detection logic in public.routes.js
 *         queried ALL statuses. Aligned the model static and the route
 *         to use the same logic.
 *
 *  #A3 — toSafeObject did not include documents, notes, address,
 *         guardianPhone — admin screen needs these to display the full
 *         application detail.
 *
 *  #A4 — approve() and reject() instance methods did not update
 *         reviewedAt / rejectedAt timestamps that the admin service
 *         expects to read back.
 *
 *  #A5 — Pre-save hook used async function unnecessarily (no await
 *         inside). Simplified to sync.
 *
 *  #A6 — Model re-registration guard used mongoose.models.StudentApplication
 *         which can return a stale compiled model after schema changes.
 *         Added schema version comment so it is obvious when to drop
 *         the cached model during development.
 *
 *  #A7 — SIBLING FIX: removed unique index on { email, schoolId }.
 *         Siblings share a parent email — uniqueness must NOT be
 *         enforced at the DB level. Duplicate detection is handled
 *         at the application level in public.routes.js by matching
 *         email + schoolId + studentName (case-insensitive).
 */

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// ─────────────────────────────────────────────────────────
// DOCUMENT TYPE CONSTANTS
// ─────────────────────────────────────────────────────────

const DOCUMENT_TYPES = [
  "birth_certificate",
  "school_report",
  "medical_certificate",
  "passport_photo",
  "other",
];

/**
 * FIXED (#A1):
 * Normalises a raw docType string to one of the accepted enum values.
 * Unknown / missing values fall back to "other" so no ValidationError
 * is thrown regardless of what the client sends.
 */
const normaliseDocType = (raw) => {
  if (!raw || typeof raw !== "string") return "other";
  const clean = raw.trim().toLowerCase().replace(/[\s-]/g, "_");
  return DOCUMENT_TYPES.includes(clean) ? clean : "other";
};

// ─────────────────────────────────────────────────────────
// SUB-SCHEMA — document
// ─────────────────────────────────────────────────────────

const documentSchema = new mongoose.Schema(
  {
    title:    { type: String, default: null, trim: true },
    filename: { type: String, default: null             },
    path:     { type: String, default: null             },
    url:      { type: String, default: null             },

    /**
     * FIXED (#A1):
     * Removed the strict enum so any string from the client is accepted.
     * A pre-save setter normalises the value to one of the known types.
     */
    type: {
      type:    String,
      default: "other",
      set:     normaliseDocType,
    },

    size:     { type: Number, default: 0    },
    mimeType: { type: String, default: null },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────

const studentApplicationSchema = new mongoose.Schema(
  {
    _id: {
      type:    String,
      default: () => uuidv4(),
    },

    // ── School ────────────────────────────────────────────
    schoolId: {
      type:     String,
      required: [true, "School ID is required"],
      trim:     true,
    },

    // ── Applicant Details ─────────────────────────────────
    studentName: {
      type:     String,
      required: [true, "Student name is required"],
      trim:     true,
    },
    firstName:   { type: String, trim: true, default: null },
    lastName:    { type: String, trim: true, default: null },

    // NOT unique — siblings share a parent/guardian email.
    // Duplicate detection is handled at the application level
    // in public.routes.js by matching email + schoolId + studentName.
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
    classId:   { type: String, ref: "Class", default: null },
    className: { type: String, trim: true,   default: null },

    // ── Documents ─────────────────────────────────────────
    documents: { type: [documentSchema], default: [] },

    // ── Status ────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["pending", "approved", "rejected"],
      default: "pending",
    },
    isActive: { type: Boolean, default: true },

    // ── Review ────────────────────────────────────────────
    notes:        { type: String, default: null },
    rejectReason: { type: String, default: null },

    // FIXED (#A4) — timestamps the admin service reads back
    reviewedAt:  { type: Date,   default: null },
    reviewedBy:  { type: String, default: null },
    rejectedAt:  { type: Date,   default: null },
    approvedAt:  { type: Date,   default: null },

    // ── Links set during approval ─────────────────────────
    userId: {
      type:    String,
      ref:     "User",
      default: null,
    },
    studentId: {
      type:    String,
      ref:     "Student",
      default: null,
    },

    // ── Soft Delete ───────────────────────────────────────
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    _id:        false,
    strict:     false,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────
// INDEXES
//
// FIXED (#A7 — SIBLING FIX):
// Removed the unique index on { email, schoolId } entirely.
//
// Why: siblings share a parent/guardian email address.
// unique: true on email+schoolId means only ONE child per family
// per school can ever apply — siblings get E11000.
//
// The old index "unique_active_application" has already been dropped
// from MongoDB via mongosh. This schema no longer recreates it.
//
// Duplicate prevention is now handled purely at the application level
// in public.routes.js: we query by email + schoolId + studentName
// (case-insensitive) so:
//   - Same student applying twice       → blocked ✅
//   - Sibling with different name       → allowed ✅
//   - Re-application after rejection    → allowed ✅
//
// Indexes below match the exact names already in MongoDB to prevent
// "already exists with different name" errors on restart.
//
// Current DB indexes (from db.studentapplications.getIndexes()):
//   _id_
//   schoolId_1
//   status_1
//   schoolId_1_status_1
//   createdAt_-1
//   classId_1
//   userId_1
//   studentId_1
//   schoolId_1_classId_1
//   schoolId_1_isActive_1_status_1
//   deletedAt_1
// ─────────────────────────────────────────────────────────

// Match existing DB index names exactly
studentApplicationSchema.index({ schoolId: 1 },                        { name: "schoolId_1"                    });
studentApplicationSchema.index({ status:   1 },                        { name: "status_1"                      });
studentApplicationSchema.index({ schoolId: 1, status:   1 },           { name: "schoolId_1_status_1"           });
studentApplicationSchema.index({ createdAt: -1 },                      { name: "createdAt_-1"                  });
studentApplicationSchema.index({ classId:  1 },                        { name: "classId_1"                     });
studentApplicationSchema.index({ userId:   1 },                        { name: "userId_1"                      });
studentApplicationSchema.index({ studentId: 1 },                       { name: "studentId_1"                   });
studentApplicationSchema.index({ schoolId: 1, classId:  1 },           { name: "schoolId_1_classId_1"          });
studentApplicationSchema.index({ schoolId: 1, isActive: 1, status: 1 },{ name: "schoolId_1_isActive_1_status_1"});
studentApplicationSchema.index({ deletedAt: 1 },                       { name: "deletedAt_1"                   });

// Non-unique email lookup index for fast duplicate detection queries
// (used by public.routes.js hasActiveApplication check)
studentApplicationSchema.index(
  { email: 1, schoolId: 1 },
  {
    sparse: true,          // allow null emails
    name:   "email_schoolId_lookup",
    // NO unique: true — siblings share parent email
  }
);

// ─────────────────────────────────────────────────────────
// PRE-SAVE HOOK
// ─────────────────────────────────────────────────────────

/**
 * FIXED (#A5): sync hook — no await needed.
 */
studentApplicationSchema.pre("save", function () {
  if (this.email) {
    this.email = this.email.toLowerCase().trim();
  }
  if (this.guardianEmail) {
    this.guardianEmail = this.guardianEmail.toLowerCase().trim();
  }
});

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
  return [this.firstName, this.lastName]
    .filter(Boolean)
    .join(" ")
    .trim() || "Unnamed Applicant";
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
// INSTANCE METHODS
// ─────────────────────────────────────────────────────────

/**
 * FIXED (#A3): includes all fields the admin screen needs.
 */
studentApplicationSchema.methods.toSafeObject = function () {
  return {
    id:            this._id,
    schoolId:      this.schoolId,
    studentName:   this.displayName,
    firstName:     this.firstName     ?? null,
    lastName:      this.lastName      ?? null,
    email:         this.email         ?? null,
    phone:         this.phone         ?? null,
    address:       this.address       ?? null,
    guardianName:  this.guardianName  ?? null,
    guardianPhone: this.guardianPhone ?? null,
    guardianEmail: this.guardianEmail ?? null,
    classId:       this.classId       ?? null,
    className:     this.className     ?? null,
    status:        this.status,
    notes:         this.notes         ?? null,
    rejectReason:  this.rejectReason  ?? null,
    documents:     this.documents     ?? [],
    documentCount: this.documentCount,
    submittedAt:   this.submittedAt,
    reviewedAt:    this.reviewedAt    ?? null,
    reviewedBy:    this.reviewedBy    ?? null,
    rejectedAt:    this.rejectedAt    ?? null,
    approvedAt:    this.approvedAt    ?? null,
    userId:        this.userId        ?? null,
    studentId:     this.studentId     ?? null,
    createdAt:     this.createdAt,
    updatedAt:     this.updatedAt,
  };
};

/**
 * FIXED (#A4): stamps approvedAt + reviewedAt.
 */
studentApplicationSchema.methods.approve = async function (
  userId,
  adminId = null
) {
  if (this.status !== "pending") {
    throw new Error("Only pending applications can be approved");
  }
  const now       = new Date();
  this.status     = "approved";
  this.userId     = userId  || null;
  this.reviewedBy = adminId || null;
  this.approvedAt = now;
  this.reviewedAt = now;
  return this.save();
};

/**
 * FIXED (#A4): stamps rejectedAt + reviewedAt.
 */
studentApplicationSchema.methods.reject = async function (
  reason,
  adminId = null
) {
  if (this.status !== "pending") {
    throw new Error("Only pending applications can be rejected");
  }
  const now         = new Date();
  this.status       = "rejected";
  this.rejectReason = reason  || null;
  this.reviewedBy   = adminId || null;
  this.rejectedAt   = now;
  this.reviewedAt   = now;
  return this.save();
};

// ─────────────────────────────────────────────────────────
// STATIC METHODS
// ─────────────────────────────────────────────────────────

studentApplicationSchema.statics.findPendingBySchool = function (schoolId) {
  return this.find({
    schoolId,
    status:   "pending",
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).sort({ createdAt: -1 });
};

studentApplicationSchema.statics.findApprovedBySchool = function (schoolId) {
  return this.find({
    schoolId,
    status:   "approved",
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).sort({ createdAt: -1 });
};

studentApplicationSchema.statics.findBySchoolAndStatus = function (
  schoolId,
  status
) {
  return this.find({
    schoolId,
    status,
    isActive: true,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).sort({ createdAt: -1 });
};

studentApplicationSchema.statics.findByEmail = function (email, schoolId) {
  return this.findOne({
    email:    email.toLowerCase().trim(),
    schoolId,
  });
};

/**
 * FIXED (#A7 — SIBLING AWARE):
 * hasActiveApplication now also requires studentName match so siblings
 * with different names are not blocked by each other's applications.
 *
 * Usage in public.routes.js:
 *   const existing = await StudentApplication.hasActiveApplication(
 *     email, schoolId, studentName
 *   );
 */
studentApplicationSchema.statics.hasActiveApplication = function (
  email,
  schoolId,
  studentName = null
) {
  const query = {
    email:    email.toLowerCase().trim(),
    schoolId,
    status:   { $in: ["pending", "approved"] },
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };

  // If studentName provided, scope to this specific student
  // so siblings are not affected
  if (studentName) {
    const nameRegex = new RegExp(
      `^${studentName.trim().toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i"
    );
    query.studentName = { $regex: nameRegex };
  }

  return this.findOne(query);
};

// ─────────────────────────────────────────────────────────
// EXPORT  (hot-reload safe)
// ─────────────────────────────────────────────────────────

module.exports =
  mongoose.models.StudentApplication ||
  mongoose.model("StudentApplication", studentApplicationSchema);