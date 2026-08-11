// backend/src/db/models/ReportTemplate.js
"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPORT TEMPLATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One row per template per school.
 *
 * Key design decisions:
 *
 *   version
 *     Increments on every PUT. Never resets. GeneratedReport stores
 *     the version number at generation time so you can always trace
 *     which exact template produced a given report card, even after
 *     the template has been edited many times since.
 *
 *   variables[]
 *     Populated by the backend at save time by scanning the HTML for
 *     {{placeholders}}. Used to warn the admin of typos before saving.
 *
 *   isDefault
 *     When generateStudentReport() is called without an explicit
 *     templateId, the engine loads the template where isDefault = true
 *     for that school. Only one template per school should have this
 *     set. The PUT route enforces this by clearing isDefault on all
 *     other templates first.
 *
 *   html + css stored separately
 *     Keeps the CSS out of the HTML blob. The engine injects them
 *     independently when wrapping the output for PDF generation.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const reportTemplateSchema = new mongoose.Schema(
  {
    _id: {
      type:    String,
      default: uuidv4,
    },

    // ── Ownership ─────────────────────────────────────────────────────────
    schoolId: {
      type:     String,
      required: true,
      index:    true,
    },

    // ── Content ───────────────────────────────────────────────────────────
    name: {
      type:     String,
      required: true,
      trim:     true,
    },

    html: {
      type:     String,
      required: true,
      default:  "",
    },

    css: {
      type:    String,
      default: "",
    },

    // ── Versioning ────────────────────────────────────────────────────────
    // Incremented on every save so GeneratedReport can trace which
    // snapshot of the template was used when a report was issued.
    version: {
      type:    Number,
      default: 1,
      min:     1,
    },

    // ── Variable registry ─────────────────────────────────────────────────
    // Populated on save by scanning html for {{x}} tokens.
    // e.g. ["{{student_name}}", "{{average}}", "{{subjects_table}}"]
    variables: {
      type:    [String],
      default: [],
    },

    // ── Flags ─────────────────────────────────────────────────────────────
    isDefault: {
      type:    Boolean,
      default: false,
    },

    // ── Audit ─────────────────────────────────────────────────────────────
    createdBy: {
      type:    String,
      ref:     "User",
      default: null,
    },
    updatedBy: {
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

// All templates for a school, newest first
reportTemplateSchema.index({ schoolId: 1, updatedAt: -1 });

// Fast lookup of the default template for a school
reportTemplateSchema.index({ schoolId: 1, isDefault: 1 });

// Soft delete filter
reportTemplateSchema.index({ schoolId: 1, deletedAt: 1 });

// ── Model ─────────────────────────────────────────────────────────────────

module.exports = mongoose.model("ReportTemplate", reportTemplateSchema);