// backend/src/db/models/GateAuthorization.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * An administrator's authorization for a pupil to pass the gate whatever
 * their fees say — the "Authorized" status (shared/compliance.js).
 *
 * The case it exists for: a family whose payment is promised for Friday, a
 * scholarship being processed, a child who must sit an exam. The head teacher
 * decides; the gate sees the decision, its reason and when it ends.
 *
 *   - Issued by gate.authorize — administrators only, never delegable. The
 *     gate staff can see it and never issue it.
 *   - Always has an end (validUntil). An open-ended pass would quietly turn
 *     into a permanent exemption nobody remembers granting.
 *   - Revoked, never deleted: who let a child through, and on whose word, is
 *     a question a school must be able to answer later.
 *
 * It changes nothing in the ledger. What is owed is still owed; this only
 * says the gate should not hold the child back for it.
 */
const gateAuthorizationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId:  { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },

    /** In force from the start of this day. */
    validFrom:  { type: Date, required: true },
    /** …until the end of this day. Required: see above. */
    validUntil: { type: Date, required: true },

    reason: { type: String, required: true, trim: true, maxlength: 2000 },

    grantedBy: { type: String, default: null },
    grantedAt: { type: Date,   default: Date.now },

    revokedAt:    { type: Date,   default: null },
    revokedBy:    { type: String, default: null },
    revokeReason: { type: String, default: null, trim: true, maxlength: 2000 },

    deletedAt: { type: Date, default: null },
  },
  { _id: false, timestamps: true }
);

// The two questions: this pupil's passes, and every pass in force today.
gateAuthorizationSchema.index({ schoolId: 1, studentId: 1, validUntil: -1 });
gateAuthorizationSchema.index({ schoolId: 1, validUntil: 1, revokedAt: 1 });

module.exports =
  mongoose.models.GateAuthorization ||
  mongoose.model("GateAuthorization", gateAuthorizationSchema);
