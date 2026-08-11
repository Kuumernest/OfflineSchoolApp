// backend/src/db/models/GeneratedReport.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GENERATED REPORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One row per student per exam. Re-generating updates the existing row.
 *
 * Key design decisions:
 *
 *   templateId + templateVersion
 *     Together these identify exactly which snapshot of the template
 *     was used. If the school edits their template after reports are
 *     issued, this pair lets you know the issued report looked different
 *     from the current template.
 *
 *   variablePayload
 *     The exact data object passed to the engine at generation time.
 *     Stored so the report can be re-rendered identically even if
 *     the underlying result data changes later.
 *
 *   renderedHtml
 *     The final filled HTML. This is the frozen legal record.
 *     A parent printing this report two years later gets exactly
 *     what was issued, regardless of template changes since then.
 *
 *   pdfPath
 *     Device filesystem path written by expo-file-system.
 *     Only meaningful on the device that generated the report.
 *     Always null on the server. Never synced.
 *
 *   examId + studentId unique index
 *     Prevents duplicate rows. Re-generation uses findOneAndUpdate
 *     with upsert rather than insert, so only one record exists
 *     per student per exam at any time.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const generatedReportSchema = new mongoose.Schema(
  {
    _id: {
      type:    String,
      default: uuidv4,
    },

    // ── Core references ───────────────────────────────────────────────────
    schoolId: {
      type:     String,
      required: true,
      index:    true,
    },

    examId: {
      type:    String,
      ref:     "Exam",
      index:   true,
      default: null,
    },

    studentId: {
      type:     String,
      ref:      "Student",
      required: true,
      index:    true,
    },

    // ── Template traceability ─────────────────────────────────────────────
    templateId: {
      type:    String,
      ref:     "ReportTemplate",
      
      default: null},

    // Which version of that template was active at generation time
    templateVersion: {
      type:    Number,
      default: 1,
    },

    // ── Frozen output ─────────────────────────────────────────────────────
    // The exact variable values fed into the engine at generation time
    variablePayload: {
      type:    mongoose.Schema.Types.Mixed,
      default: {},
    },

    // The final rendered HTML frozen at generation time
    // This is the source of truth for what was issued
    renderedHtml: {
      type:    String,
      default: "",
    },

    // ── Device path ───────────────────────────────────────────────────────
    // Local path on the device that ran expo-file-system
    // Null on the server, never synced
    pdfPath: {
      type:    String,
      default: null,
    },

    // ── Academic context ──────────────────────────────────────────────────
    term: {
      type:    String,
      default: null,
    },

    academicYear: {
      type:    String,
      default: null,
    },

    // ── Status ────────────────────────────────────────────────────────────
    isPublished: {
      type:    Boolean,
      default: false,
      index:   true,
    },

    publishedAt: {
      type:    Date,
      default: null,
    },

    // ── Audit ─────────────────────────────────────────────────────────────
    generatedBy: {
      type:    String,
      ref:     "User",
      default: null,
    },

    // ── Soft delete ───────────────────────────────────────────────────────
    deletedAt: {
      type:    Date,
      default: null,
    },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────

// One record per student per exam — re-generation updates this row
generatedReportSchema.index(
  { examId: 1, studentId: 1 },
  { unique: true, sparse: true }
);

// All reports for a school, newest first
generatedReportSchema.index({ schoolId: 1, createdAt: -1 });

// All reports for a student across all exams
generatedReportSchema.index({ studentId: 1, academicYear: 1, term: 1 });

// Published reports for a school
generatedReportSchema.index({ schoolId: 1, isPublished: 1 });

// Template usage tracking
generatedReportSchema.index({ templateId: 1 });

// ── Model ─────────────────────────────────────────────────────────────────

module.exports = mongoose.model("GeneratedReport", generatedReportSchema);