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
/**
 * One device's sign-in.
 *
 * The code is the credential and the row above is the authorisation; neither
 * is a session. Without one the portal handed out a twelve-hour token and
 * nothing else, so every parent typed their code again every morning — a code
 * they were given once, on paper, and were never meant to memorise.
 *
 * `tokenHash` is the SHA-256 of an opaque refresh token the phone keeps. Only
 * the hash is stored, for the same reason only the code's hash is: a copy of
 * the database must not be a copy of every parent's session. The token is 256
 * random bits, so a plain hash is the right tool — bcrypt is for secrets a
 * person chose.
 */
const sessionSchema = new mongoose.Schema(
  {
    _id:        { type: String, default: () => uuidv4() },
    tokenHash:  { type: String, required: true },
    createdAt:  { type: Date, default: () => new Date() },
    lastUsedAt: { type: Date, default: () => new Date() },
    expiresAt:  { type: Date, required: true },
  },
  { _id: false }
);

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

    /**
     * When this guardian last opened their notices.
     *
     * A message thread carries a read marker per participant, so "unread
     * messages" was already arithmetic. Notices had nothing of the kind, so
     * the tab could show a parent four notices and no indication that two of
     * them arrived since they last looked — and a badge that counted every
     * notice would be permanently lit and quickly ignored.
     *
     * Null means "never looked", which correctly counts everything as new.
     */
    noticesSeenAt: { type: Date, default: null },

    /**
     * The devices this guardian is signed in on — see sessionSchema.
     *
     * Emptied whenever the credential changes hands (re-issue, revoke), so a
     * session can never outlive the code that opened it.
     */
    sessions: { type: [sessionSchema], default: [] },

    createdBy: { type: String, default: null },
    deletedAt: { type: Date,   default: null },
  },
  { _id: false, timestamps: true }
);

// Finding the access for a child at sign-in is the hot path: a guardian types
// one admission number and the lookup runs against this multikey index.
guardianAccessSchema.index({ schoolId: 1, studentIds: 1, deletedAt: 1 });

// A refresh presents the token and nothing else — no school, no access id —
// so the row is found by the token's hash.
guardianAccessSchema.index({ "sessions.tokenHash": 1 });

module.exports =
  mongoose.models.GuardianAccess ||
  mongoose.model("GuardianAccess", guardianAccessSchema);
