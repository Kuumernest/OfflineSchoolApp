// backend/src/db/models/Conversation.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONVERSATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One thread. Direct messages, class channels, subject channels and ad-hoc
 * groups are all the same shape — they differ only in `kind` and in how
 * their participants were assembled — so read state, ordering and retention
 * are implemented once.
 *
 * Key design decisions:
 *
 *   participants[]
 *     Carries BOTH principal kinds. Guardians are not Users — there is no
 *     "parent" role in the User schema — so a participant is identified by
 *     (kind, id), never by id alone. Two different people could otherwise
 *     collide on the same uuid string.
 *
 *   lastReadSeq (per participant)
 *     Read state lives on the conversation, not on every message. Marking
 *     forty messages read is one write of one number, and "unread count" is
 *     arithmetic rather than a scan. It also degrades honestly offline: a
 *     device that has not synced simply has a stale number.
 *
 *   directKey
 *     A deterministic, sorted key for two-party conversations, uniquely
 *     indexed. Without it, two people opening a chat with each other at the
 *     same moment — entirely normal on a flaky link where both sides retry —
 *     create two threads and each sees half the conversation.
 *
 *   lastMessageSeq / lastMessageAt / lastMessagePreview
 *     Denormalised so a conversation list renders without touching the
 *     message collection. The preview is deliberately short and is not a
 *     substitute for the message.
 *
 *   isArchived vs deletedAt
 *     Archiving stops new posts and keeps history readable. deletedAt hides
 *     the thread from listings. Neither destroys messages: in a school with
 *     minors the records may be needed for a safeguarding question long
 *     after everyone involved would rather they were gone.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const participantSchema = new mongoose.Schema(
  {
    /** "user" for staff and students, "guardian" for portal principals. */
    kind: {
      type:     String,
      enum:     ["user", "guardian"],
      required: true,
    },

    /** User._id or GuardianAccess._id, depending on kind. */
    id: { type: String, required: true },

    /** Denormalised for display; the authoritative record is the User row. */
    name: { type: String, default: null },
    role: { type: String, default: null },

    joinedAt: { type: Date, default: Date.now },

    /**
     * Highest message seq this participant has read. 0 means nothing read.
     * Monotonic — see markRead(), which never moves it backwards.
     */
    lastReadSeq: { type: Number, default: 0 },

    /** Highest seq their device has confirmed receiving. */
    lastDeliveredSeq: { type: Number, default: 0 },

    mutedUntil: { type: Date, default: null },

    /** Set when somebody leaves a group; their history stays readable. */
    leftAt: { type: Date, default: null },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: uuidv4 },

    schoolId: { type: String, required: true, index: true },

    kind: {
      type:     String,
      enum:     ["direct", "class", "subject", "group"],
      required: true,
      index:    true,
    },

    /** Groups and channels are named; direct threads take their name from
     *  the other participant at render time. */
    title: { type: String, default: null, trim: true },

    description: { type: String, default: null, trim: true },

    participants: { type: [participantSchema], default: [] },

    /** Set for kind "class" and "subject". */
    classId:   { type: String, ref: "Class",   default: null, index: true },
    subjectId: { type: String, ref: "Subject", default: null, index: true },

    /**
     * Sorted "kind:id|kind:id" for direct threads, null otherwise.
     * See buildDirectKey(); uniquely indexed below.
     */
    directKey: { type: String, default: null },

    // ── Denormalised tail, for listing without a second query ────────────
    lastMessageAt:      { type: Date,   default: null },
    lastMessageSeq:     { type: Number, default: 0    },
    lastMessagePreview: { type: String, default: null },
    lastMessageSender:  { type: String, default: null },

    // ── State ────────────────────────────────────────────────────────────
    isArchived: { type: Boolean, default: false },
    isReadOnly: { type: Boolean, default: false },

    createdBy: { type: String, default: null },
    deletedAt: { type: Date,   default: null },
  },
  {
    _id:        false,
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Indexes ─────────────────────────────────────────────────────────────────

// One direct thread per pair. Sparse so the null on every group row does not
// collide with every other group row.
conversationSchema.index(
  { schoolId: 1, directKey: 1 },
  { unique: true, sparse: true }
);

// "My conversations, most recent first" — the list screen's only query.
conversationSchema.index({ schoolId: 1, "participants.id": 1, lastMessageAt: -1 });

// Channel lookup.
conversationSchema.index({ schoolId: 1, kind: 1, classId: 1 });
conversationSchema.index({ schoolId: 1, kind: 1, subjectId: 1 });

// One group per class, and only one.
//
// Class groups are provisioned on demand rather than created by hand, so two
// requests arriving together — a student and their teacher both opening
// Messages — would otherwise each create one and split the class in half.
// Partial so it constrains only kind:"class" rows and leaves direct threads
// and ad-hoc groups alone.
conversationSchema.index(
  { schoolId: 1, classId: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: "class" },
    name: "one_group_per_class",
  }
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The deterministic key for a two-party thread.
 *
 * Sorted so that (A, B) and (B, A) produce the same string, which is what
 * makes the unique index able to stop duplicate threads.
 *
 * @param {{kind: string, id: string}} a
 * @param {{kind: string, id: string}} b
 * @returns {string}
 */
conversationSchema.statics.buildDirectKey = function (a, b) {
  const key = (p) =>
    `${p.kind === "guardian" ? "guardian" : "user"}:${String(p.id)}`;
  return [key(a), key(b)].sort().join("|");
};

/** The participant subdocument for this principal, or undefined. */
conversationSchema.methods.participantFor = function (principal) {
  if (!principal) return undefined;
  const kind = principal.kind === "guardian" ? "guardian" : "user";
  return this.participants.find(
    (p) => p.kind === kind && String(p.id) === String(principal.id)
  );
};

/**
 * Unread count for this principal.
 *
 * Derived from lastMessageSeq minus their lastReadSeq, so it costs nothing.
 * Clamped at zero because a participant added to an existing thread starts
 * with lastReadSeq 0 while lastMessageSeq is already high — they should see
 * the backlog as unread, but a stale client that over-reports lastReadSeq
 * must never produce a negative badge.
 */
conversationSchema.methods.unreadFor = function (principal) {
  const p = this.participantFor(principal);
  if (!p) return 0;
  return Math.max(0, (this.lastMessageSeq || 0) - (p.lastReadSeq || 0));
};

module.exports =
  mongoose.models.Conversation ||
  mongoose.model("Conversation", conversationSchema);
