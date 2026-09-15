// backend/src/db/models/AuditLog.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * What a platform administrator did, and to which school.
 *
 * The change logs that already exist — ResultChangeLog, StudentChangeLog,
 * AttendanceChangeLog — each belong to one school and one kind of record, and
 * that is right for them: a school reads its own history of its own marks.
 * A super_admin's actions are the other shape. They reach ACROSS schools
 * (create one, switch one off, appoint its administrator, walk into it), and
 * the row has to survive the school it names being switched off, so it cannot
 * live inside that school's data. One collection, keyed by the TARGET school
 * and never by the actor's own, so "what has been done to this school" and
 * "what has this operator done" are each one query.
 *
 * `before` / `after` hold only the fields that changed, never a whole
 * document: a school row carries a logo, and an audit trail is for reading.
 */

const AUDIT_ACTIONS = [
  "school.created",
  "school.updated",
  "school.activated",
  "school.deactivated",
  "school.entered",
  "admin.created",
  "admin.restored",
  "admin.passwordReset",
  "admin.removed",
];

const auditLogSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    action: { type: String, required: true, enum: AUDIT_ACTIONS, index: true },

    // ── Who ──────────────────────────────────────────────────────────────────
    actorId:   { type: String, default: null, index: true },
    actorName: { type: String, default: null },   // denormalised: people get renamed
    actorRole: { type: String, default: null },

    // ── Where: the school acted UPON ─────────────────────────────────────────
    schoolId:   { type: String, default: null, index: true },
    schoolName: { type: String, default: null },

    // ── What ─────────────────────────────────────────────────────────────────
    resourceType:  { type: String, default: null },   // "school" | "user"
    resourceId:    { type: String, default: null },
    resourceLabel: { type: String, default: null },

    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after:  { type: mongoose.Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },

    // ── From where ───────────────────────────────────────────────────────────
    ip:        { type: String, default: null },
    userAgent: { type: String, default: null },

    at: { type: Date, default: Date.now, index: true },
  },
  { _id: false, timestamps: false }
);

// The two questions an auditor asks.
auditLogSchema.index({ schoolId: 1, at: -1 });
auditLogSchema.index({ actorId:  1, at: -1 });

auditLogSchema.statics.ACTIONS = AUDIT_ACTIONS;

module.exports =
  mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);
