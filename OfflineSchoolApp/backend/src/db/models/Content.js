// backend/db/models/Content.js
"use strict";

const mongoose = require("mongoose");

const contentSchema = new mongoose.Schema(
  {
    // ── Core ──────────────────────────────────────────────
    title: {
      type:     String,
      required: true,
      trim:     true,
    },
    description: {
      type:    String,
      default: "",
      trim:    true,
    },

    // ── Type ──────────────────────────────────────────────
    type: {
      type:      String,
      required:  true,
      lowercase: true,
      enum:      ["syllabus", "notes", "video", "audio", "document", "image"],
    },

    // ── Ownership ─────────────────────────────────────────
    // ✅ No "index: true" on fields — all indexes declared once below
    teacherId: {
      type:     String,
      required: true,
    },
    subjectId: {
      type:     String,
      required: true,
    },
    subjectName: {
      type:    String,
      default: "",
    },

    classId: {
      type: String,
    },
    className: {
      type:    String,
      default: "",
    },

    classIds: {
      type:    [String],
      default: [],
    },
    classNames: {
      type:    [String],
      default: [],
    },

    schoolId: {
      type: String,
    },

    // ── File info ─────────────────────────────────────────
    url: {
      type: String,   // legacy / json-body uploads
    },
    fileUrl: {
      type: String,   // multer / cloud storage
    },
    fileName: {
      type: String,
    },
    fileSize: {
      type:    Number,
      default: 0,
    },
    mimeType: {
      type: String,
    },
    thumbnail: {
      type: String,
    },

    // ── Status ────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["active", "draft", "archived"],
      default: "active",
    },

    // ── Soft delete ───────────────────────────────────────
    deletedAt: {
      type:    Date,
      default: null,
    },

    // ── Analytics ─────────────────────────────────────────
    viewCount: {
      type:    Number,
      default: 0,
    },
    downloadCount: {
      type:    Number,
      default: 0,
    },
  },
  {
    timestamps:  true,
    collection:  "contents",
    versionKey:  false,
  }
);

// ── Indexes — declared ONCE here, NOT on field definitions ───────────────────

// Single-field
contentSchema.index({ teacherId: 1 });
contentSchema.index({ subjectId: 1 });
contentSchema.index({ classId:   1 });
contentSchema.index({ schoolId:  1 });
contentSchema.index({ status:    1 });
contentSchema.index({ deletedAt: 1 });

// Compound — teacher queries
contentSchema.index({ teacherId: 1, createdAt: -1 });
contentSchema.index({ teacherId: 1, type:      1  });
contentSchema.index({ teacherId: 1, status:    1  });

// Compound — student queries
contentSchema.index({ subjectId: 1, status:    1 });
contentSchema.index({ subjectId: 1, classId:   1 });
contentSchema.index({ schoolId:  1, status:    1 });
contentSchema.index({ schoolId:  1, subjectId: 1, status: 1 });
contentSchema.index({ schoolId:  1, classId:   1, status: 1 });

// ── Virtual — unified fileUrl accessor ───────────────────────────────────────
contentSchema.virtual("resolvedFileUrl").get(function () {
  return this.fileUrl || this.url || null;
});

// ── toJSON ───────────────────────────────────────────────────────────────────
contentSchema.set("toJSON", {
  virtuals:  true,
  transform: (_doc, ret) => {
    if (!ret.fileUrl && ret.url) ret.fileUrl = ret.url;
    delete ret.__v;
    return ret;
  },
});

// ── Soft delete helper ────────────────────────────────────────────────────────
contentSchema.methods.softDelete = function () {
  this.deletedAt = new Date();
  this.status    = "archived";
  return this.save();
};

module.exports =
  mongoose.models.Content ||
  mongoose.model("Content", contentSchema);