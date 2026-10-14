// db/models/TimetableSlot.js

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────
// NOTE: This app uses UUIDs (e.g. "0ac69e73-2729-443d-9f72-a26c396c3c59")
// as primary keys across all collections — NOT MongoDB ObjectIds.
// All reference fields must be String type, not ObjectId.
// ─────────────────────────────────────────────────────────────

const TimetableSlotSchema = new mongoose.Schema(
  {
    // ✅ Use String for all IDs — app uses UUIDs, not ObjectIds
    schoolId: {
      type:     String,
      required: [true, "schoolId is required"],
      index:    true,
    },
    classId: {
      type:     String,
      required: [true, "classId is required"],
      index:    true,
    },
    subjectId: {
      type:     String,
      required: [true, "subjectId is required"],
    },
    teacherId: {
      type:     String,
      required: [true, "teacherId is required"],
      index:    true,
    },
    periodId: {
      type:     String,
      required: [true, "periodId is required"],
    },
    dayOfWeek: {
      type:     String,
      required: [true, "dayOfWeek is required"],
      enum: {
        values:  ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
        message: "{VALUE} is not a valid day",
      },
    },
    room: {
      type:    String,
      default: null,
      trim:    true,
    },
    version: {
      type:    Number,
      default: 1,
    },
    deletedAt: {
      type:    Date,
      default: null,
    },
  },
  {
    // Auto-generates createdAt + updatedAt
    timestamps: true,
  }
);

// ─────────────────────────────────────────────────────────────
// INDEXES — prevent double-booking
// partialFilterExpression only enforces uniqueness on
// active (non-deleted) slots
// ─────────────────────────────────────────────────────────────

TimetableSlotSchema.index(
  { classId: 1, dayOfWeek: 1, periodId: 1 },
  {
    unique:                  true,
    partialFilterExpression: { deletedAt: null },
    name:                    "unique_class_day_period",
  }
);

TimetableSlotSchema.index(
  { teacherId: 1, dayOfWeek: 1, periodId: 1 },
  {
    unique:                  true,
    partialFilterExpression: { deletedAt: null },
    name:                    "unique_teacher_day_period",
  }
);

TimetableSlotSchema.index({ schoolId: 1, deletedAt: 1 });


// The change feed's page (GET /api/sync/changes, config/syncFeed.js): filtered
// on schoolId and a keyset of (updatedAt, _id), sorted the same way. Without
// this the planner walked the school's rows in full for every page and every
// idle poll, examining N documents to return none (docs/37). The mobile pull
// (updatedAt >= since) is served by the same prefix.
TimetableSlotSchema.index({ schoolId: 1, updatedAt: 1, _id: 1 });
module.exports = mongoose.model("TimetableSlot", TimetableSlotSchema);