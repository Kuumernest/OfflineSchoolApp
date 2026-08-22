// backend/src/db/models/GuardianAccess.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One guardian's access to one or more children.
 *
 * The first version of this hung a code off each Student, which works until a
 * parent has two children at the school — then they hold two codes and sign in
 * twice to answer one question. Guardians are the unit here, not students.
 *
 * The link is stated by the office, never inferred. Matching siblings on
 * guardianPhone was the obvious shortcut and the data says no: on this school's
 * roster 2 of 16 students have a phone recorded, none have an email, and no two
 * students share either. Inferring would link almost nothing today and, as the
 * field fills in, would silently start linking unrelated children whose parents
 * mistyped or share a number. A list the office chooses is auditable — the
 * codes screen shows exactly which children a code unlocks before it is handed
 * over.
 */
const guardianAccessSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },

    /** How the office recognises this access — "Mrs Tem (672 44 79 79)". */
    label: { type: String, default: null, trim: true },

    /** Every child this code opens. Order is the order the office chose. */
    studentIds: { type: [String], default: [], index: true },

    // Only the hash is stored. `hint` is the last two characters, so the office
    // can confirm which code a parent is holding without being able to read it.
    codeHash: { type: String, default: null },
    codeHint: { type: String, default: null },
    codeSetAt: { type: Date, default: null },

    revokedAt: { type: Date, default: null },

    // Lockout state, reset on a successful sign-in.
    failedTries: { type: Number, default: 0 },
    lockedUntil: { type: Date,   default: null },
    lastSeenAt:  { type: Date,   default: null },

    createdBy: { type: String, default: null },
    deletedAt: { type: Date,   default: null },
  },
  { _id: false, timestamps: true }
);

// Finding the access for a child at sign-in is the hot path: a guardian types
// one admission number and the lookup runs against this multikey index.
guardianAccessSchema.index({ schoolId: 1, studentIds: 1, deletedAt: 1 });

module.exports =
  mongoose.models.GuardianAccess ||
  mongoose.model("GuardianAccess", guardianAccessSchema);
