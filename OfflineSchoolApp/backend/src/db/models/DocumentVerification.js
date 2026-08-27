// backend/src/db/models/DocumentVerification.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * One verifiable printed document.
 *
 * A transcript or report card leaves the school and lands on a desk somewhere
 * — another school, an employer, an embassy. This row is what lets that desk
 * check the paper against the school's own records: the printed document
 * carries a QR code and a short code, both resolving to a public page that
 * shows what the school's records say the document should say.
 *
 * One row per document, not per print. Reprinting the same student's
 * transcript reuses the code and refreshes the snapshot, so a document stays
 * verifiable for as long as the school stands behind it — and a snapshot that
 * no longer matches the paper is exactly what a forgery check is for.
 *
 * The snapshot holds only what is already printed on the document itself.
 * The verifier is holding the paper; the page confirms it, it must not
 * volunteer anything more.
 */
const documentVerificationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },

    schoolId: { type: String, required: true, index: true },

    /**
     * The code printed on the document. Unambiguous alphabet (no 0/O, 1/I/L),
     * stored bare; display grouping (XXXX-XXXX-XXXX) is presentation only.
     */
    code: { type: String, required: true, unique: true },

    kind: { type: String, enum: ["transcript", "report_card"], required: true },

    studentId: { type: String, required: true, index: true },

    /** The exam a report card belongs to; "-" for documents with no exam. */
    examId: { type: String, default: "-" },

    /** The facts shown on the verification page — what the paper says. */
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },

    issuedAt:    { type: Date, default: () => new Date() },
    /** Last time the document was (re)printed and the snapshot refreshed. */
    refreshedAt: { type: Date, default: () => new Date() },
    printCount:  { type: Number, default: 1 },

    /** A revoked code answers "no longer vouched for", not "never existed". */
    revokedAt:    { type: Date,   default: null },
    revokeReason: { type: String, default: null },
    revokedBy:    { type: String, default: null },

    deletedAt: { type: Date, default: null },
  },
  { _id: false, timestamps: true }
);

// One code per document: a reprint must find this row, not mint a second code
// for the same paper.
documentVerificationSchema.index(
  { schoolId: 1, kind: 1, studentId: 1, examId: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.DocumentVerification ||
  mongoose.model("DocumentVerification", documentVerificationSchema);
