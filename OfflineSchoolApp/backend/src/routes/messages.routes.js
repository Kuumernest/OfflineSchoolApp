// backend/src/routes/messages.routes.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MESSAGING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Direct messages, class and subject channels, and groups.
 *
 * Every route asks communication/policy.service.js before it acts. None of
 * them decides anything about who may talk to whom on its own — that
 * decision lives in one pure module so it can be tested exhaustively and so
 * a new endpoint cannot quietly invent looser rules.
 *
 * Mounted under an authenticate() in server.js for staff and students.
 * Guardians reach messaging through the portal router instead, because a
 * portal token identifies a GuardianAccess row and not a User.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require("express");
const path    = require("path");
const fs      = require("fs");
const router  = express.Router();

const Conversation = require("../db/models/Conversation");
const Message      = require("../db/models/Message");

const policy = require("../services/communication/policy.service");
const svc    = require("../services/communication/conversation.service");
const permissions = require("../services/permissions.service");

// Optional, exactly as the content routes treat it: a deployment without
// multer should lose file attachments, not the whole messaging module.
let multer;
try {
  multer = require("multer");
} catch {
  console.warn("⚠️  multer not installed — message attachments disabled");
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ── Attachment upload ───────────────────────────────────────────────────────

const ATTACHMENT_DIR = path.join(__dirname, "..", "uploads", "messages");

/** Which of the model's four attachment kinds a mime type belongs to. */
const kindForMime = (mime) => {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
};

// Executables and scripts are refused outright. A school messaging system
// handing one pupil a runnable file from another is not a feature.
const BLOCKED_EXT = new Set([
  ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1",
  ".sh", ".apk", ".jar", ".vbs", ".js", ".jse", ".wsf", ".lnk",
]);

let _upload = null;

const getUpload = () => {
  if (!multer) return null;
  if (_upload) return _upload;

  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
      cb(null, ATTACHMENT_DIR);
    },
    filename(_req, file, cb) {
      // The original name is sanitised rather than trusted: it reaches a
      // filesystem path, and "../" in an upload name is a directory traversal.
      const ext  = path.extname(file.originalname || "").toLowerCase();
      const base = path
        .basename(file.originalname || "file", ext)
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_\-]/g, "")
        .slice(0, 60) || "file";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}${ext}`);
    },
  });

  _upload = multer({
    storage,
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase();
      if (BLOCKED_EXT.has(ext)) {
        const err = new Error(`Files of type ${ext} cannot be sent`);
        err.code = "INVALID_MIME";
        return cb(err);
      }
      cb(null, true);
    },
    // 25MB: big enough for a photo of the board or a marked script, small
    // enough to be sendable on the connections this app is built for.
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  return _upload;
};

/** Resolve the caller, or answer 401. */
const requirePrincipal = (req, res) => {
  const me = svc.principalFromRequest(req);
  if (!me || !me.schoolId) {
    res.status(401).json({ success: false, error: "Not authenticated" });
    return null;
  }
  return me;
};

/**
 * Load a conversation the caller is allowed to READ, or answer.
 *
 * Returns { conversation, principal, audit } or null when it has already
 * responded. `audit` is true when the caller is only seeing this because
 * they are an administrator, which the caller uses to decide whether to
 * reveal deleted bodies and to log the access.
 */
async function loadReadable(req, res) {
  const me = requirePrincipal(req, res);
  if (!me) return null;

  const conversation = await Conversation.findOne({
    _id:       String(req.params.id),
    deletedAt: null,
  }).lean();

  if (!conversation) {
    res.status(404).json({ success: false, error: "Conversation not found" });
    return null;
  }

  const settings = await svc.loadSettings(me.schoolId);
  const verdict  = policy.canReadConversation(me, conversation, settings);

  if (!verdict.allowed) {
    // 404 rather than 403: telling somebody a conversation exists but is not
    // theirs is itself a disclosure.
    res.status(404).json({ success: false, error: "Conversation not found" });
    return null;
  }

  return { conversation, principal: me, audit: verdict.reason === "admin-audit" };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/conversations
// ─────────────────────────────────────────────────────────────────────────────

router.get("/conversations", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  // A class is a group, so the caller's class channels are provisioned and
  // their rosters reconciled here — the moment their view has to be right.
  // Failure is non-fatal: they should still see their direct threads.
  await svc.ensureClassConversationsFor(me).catch((err) =>
    console.warn("[comms] class group provisioning failed:", err.message)
  );

  const rows = await svc.listFor(me, {
    limit:  req.query.limit,
    before: req.query.before,
  });

  const conversations = rows.map((c) => {
    const mine = (c.participants || []).find(
      (p) => p.kind === (me.kind === "guardian" ? "guardian" : "user") &&
             String(p.id) === String(me.id)
    );
    return {
      _id:                c._id,
      kind:               c.kind,
      title:              c.title,
      classId:            c.classId,
      subjectId:          c.subjectId,
      participants:       c.participants,
      lastMessageAt:      c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      lastMessageSender:  c.lastMessageSender,
      isArchived:         c.isArchived,
      isReadOnly:         c.isReadOnly,
      unread: Math.max(0, (c.lastMessageSeq || 0) - (mine?.lastReadSeq || 0)),
    };
  });

  return res.json({ success: true, count: conversations.length, conversations });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/recipients?q=
//
// Who may this caller start a conversation with?
//
// The client must not work this out for itself. It does not know the school's
// settings, it cannot see GuardianAccess links, and a picker built from a
// guessed rule would offer people the server then refuses — or worse, would
// be trusted. Every candidate here is put through the same canMessage() the
// send path uses, so the picker and the policy cannot disagree.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/recipients", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  const settings = await svc.loadSettings(me.schoolId);
  const q        = String(req.query.q || "").trim();
  const limit    = Math.min(Number(req.query.limit) || 40, 100);

  const candidates = await svc.findCandidateRecipients(me, settings, { q, limit });

  // The policy is the gate, not the query above — the query only narrows.
  const allowed = candidates
    .filter((c) => policy.canMessage(me, c, settings).allowed)
    .map((c) => ({
      kind:     c.kind,
      id:       c.id,
      name:     c.name,
      role:     c.kind === "guardian" ? "guardian" : c.role,
      subtitle: c.subtitle ?? null,
    }));

  return res.json({ success: true, count: allowed.length, recipients: allowed });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages/conversations/:id/attachments
//
// Upload one file and get back the attachment metadata to send with a message.
//
// Two steps rather than one multipart send-with-file, because the mobile
// outbox posts JSON: a message composed offline queues as JSON and is retried,
// while its file has to be uploaded once a connection exists. Splitting them
// means the retry path stays simple and a half-uploaded file never becomes a
// half-sent message.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/conversations/:id/attachments", (req, res, next) => {
  const upload = getUpload();
  if (!upload) {
    return res.status(503).json({
      success: false,
      error:   "File attachments are not available on this server",
    });
  }
  // Membership is checked AFTER the upload middleware has parsed the request,
  // because the body is not readable until then. The file is discarded below
  // if the caller turns out not to belong here.
  upload.single("file")(req, res, (err) => (err ? next(err) : next()));
}, asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  const discard = () => {
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
  };

  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file was uploaded" });
  }

  const conversation = await Conversation.findOne({
    _id: String(req.params.id), deletedAt: null,
  }).lean();

  if (!conversation) {
    discard();
    return res.status(404).json({ success: false, error: "Conversation not found" });
  }

  const verdict = policy.canPostToConversation(me, conversation);
  if (!verdict.allowed) {
    // Do not keep a file uploaded into a conversation they cannot post to.
    discard();
    return res.status(403).json({ success: false, error: verdict.reason });
  }

  const attachment = {
    kind:     kindForMime(req.file.mimetype),
    url:      `/uploads/messages/${req.file.filename}`,
    name:     req.file.originalname || req.file.filename,
    mimeType: req.file.mimetype || null,
    size:     req.file.size ?? null,
  };

  return res.status(201).json({ success: true, attachment });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages/conversations/direct
// Open (or reuse) the thread with one other person.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/conversations/direct", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  const { kind = "user", id } = req.body || {};
  if (!id) {
    return res.status(400).json({ success: false, error: "id is required" });
  }

  const target = await svc.resolveTargetPrincipal(me.schoolId, kind, id);
  if (!target) {
    return res.status(404).json({ success: false, error: "Recipient not found" });
  }

  const settings = await svc.loadSettings(me.schoolId);
  const verdict  = policy.canMessage(me, target, settings);

  if (!verdict.allowed) {
    return res.status(403).json({ success: false, error: verdict.reason });
  }

  const conversation = await svc.openDirect(me, target);
  return res.status(201).json({ success: true, conversation });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Class groups are NOT created here.
//
// A class IS a group: the conversation for it is provisioned on demand by
// ensureClassConversationsFor() when somebody lists their conversations, and
// its membership is reconciled against the live roster every time. That keeps
// it right as pupils are enrolled, promoted or moved without anybody
// remembering to edit a member list — and it means there is no hand-built
// channel to drift out of step with the register.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/conversations/:id
// ─────────────────────────────────────────────────────────────────────────────

router.get("/conversations/:id", asyncHandler(async (req, res) => {
  const loaded = await loadReadable(req, res);
  if (!loaded) return;

  return res.json({
    success:      true,
    conversation: loaded.conversation,
    viaAudit:     loaded.audit,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/conversations/:id/messages
// ─────────────────────────────────────────────────────────────────────────────

router.get("/conversations/:id/messages", asyncHandler(async (req, res) => {
  const loaded = await loadReadable(req, res);
  if (!loaded) return;

  const docs = await svc.listMessages(loaded.conversation._id, {
    limit:     req.query.limit,
    beforeSeq: req.query.beforeSeq,
  });

  if (loaded.audit) {
    console.warn(
      `[audit] ${loaded.principal.id} read conversation ` +
      `${loaded.conversation._id} as administrator`
    );
  }

  return res.json({
    success:  true,
    count:    docs.length,
    // An admin auditing sees the real rows, including deleted bodies — that
    // is the point of an audit. Everyone else gets the redacted view.
    messages: docs.map((m) => (loaded.audit ? m.toObject() : m.toClientJSON())),
    viaAudit: loaded.audit,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages/conversations/:id/messages
// ─────────────────────────────────────────────────────────────────────────────

router.post("/conversations/:id/messages", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  const conversation = await Conversation.findOne({
    _id:       String(req.params.id),
    deletedAt: null,
  });

  if (!conversation) {
    return res.status(404).json({ success: false, error: "Conversation not found" });
  }

  // Posting requires membership — auditing does not grant it.
  const verdict = policy.canPostToConversation(me, conversation);
  if (!verdict.allowed) {
    return res.status(403).json({ success: false, error: verdict.reason });
  }

  const {
    body, attachments = [], replyTo = null,
    clientId = null, deviceCreatedAt = null,
  } = req.body || {};

  const { message, duplicate } = await svc.postMessage({
    conversation, principal: me,
    body, attachments, replyTo, clientId, deviceCreatedAt,
  });

  // 200 rather than 201 on a replay, so a retrying outbox can tell that its
  // earlier attempt had in fact landed.
  return res.status(duplicate ? 200 : 201).json({
    success:   true,
    duplicate,
    message:   message.toClientJSON(),
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages/conversations/:id/read
// ─────────────────────────────────────────────────────────────────────────────

router.post("/conversations/:id/read", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  const { seq, delivered } = req.body || {};
  if (seq == null) {
    return res.status(400).json({ success: false, error: "seq is required" });
  }

  // Only a participant has a read marker to move; an auditing admin has none.
  const conversation = await Conversation.findOne({
    _id: String(req.params.id), deletedAt: null,
  }).lean();

  if (!conversation || !policy.isParticipant(me, conversation)) {
    return res.status(404).json({ success: false, error: "Conversation not found" });
  }

  await svc.markRead(conversation._id, me, seq);
  if (delivered != null) {
    await svc.markDelivered(conversation._id, me, delivered);
  }

  return res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/messages/audit/conversations
//
// Find conversations across the school. Administrators only, and only when
// the school has left auditing enabled.
//
// This exists because per-conversation audit permission is useless without
// it: a safeguarding question begins "what has this student been sending",
// and an administrator who cannot find the thread cannot answer it. It
// returns metadata only — reading the messages is a second, logged request.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/audit/conversations", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  // A capability rather than a persona: reading a thread you are not part of is
  // the strongest right in this module, and messages.audit is non-delegable so
  // a school cannot hand it out. Equivalent to the persona check it replaces —
  // messages.audit defaults to ADMIN_ROLES, and a guardian principal carries no
  // role at all, so can() answers false for them as principalKind did.
  if (!(await permissions.can(me, "messages.audit"))) {
    return res.status(403).json({ success: false, error: "Administrator access required" });
  }

  const settings = await svc.loadSettings(me.schoolId);
  if (!settings.adminAudit) {
    return res.status(403).json({
      success: false,
      error:   "Administrator auditing is disabled for this school",
    });
  }

  const { participantId, kind, conversationKind, limit = 50 } = req.query;

  const filter = { schoolId: String(me.schoolId), deletedAt: null };
  if (participantId) {
    // $elemMatch so both conditions land on the same participant — see
    // conversation.service.js listFor() for why the dotted form is wrong.
    filter.participants = {
      $elemMatch: {
        id:   String(participantId),
        kind: kind === "guardian" ? "guardian" : "user",
      },
    };
  }
  if (conversationKind) filter.kind = String(conversationKind);

  const conversations = await Conversation.find(filter)
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(Number(limit) || 50, 100))
    .select("-lastMessagePreview")  // metadata search should not leak content
    .lean();

  console.warn(
    `[audit] ${me.id} searched conversations` +
    (participantId ? ` for participant ${participantId}` : "")
  );

  return res.json({ success: true, count: conversations.length, conversations });
}));

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/messages/:messageId
// Soft delete. Senders may retract their own; admins may remove any.
// ─────────────────────────────────────────────────────────────────────────────

router.delete("/:messageId", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  const message = await Message.findOne({
    _id:      String(req.params.messageId),
    schoolId: String(me.schoolId),
  });

  if (!message) {
    return res.status(404).json({ success: false, error: "Message not found" });
  }

  const isSender = message.sender.kind === (me.kind === "guardian" ? "guardian" : "user") &&
                   String(message.sender.id) === String(me.id);
  const isAdmin  = policy.principalKind(me) === "admin";

  if (!isSender && !isAdmin) {
    return res.status(403).json({
      success: false,
      error:   "You can only delete your own messages",
    });
  }

  if (message.deletedAt) {
    return res.json({ success: true, alreadyDeleted: true });
  }

  // Soft only. The row survives so a safeguarding question months later can
  // still be answered; see the model header.
  message.deletedAt    = new Date();
  message.deletedBy    = String(me.id);
  message.deleteReason = isAdmin && !isSender ? "removed_by_admin" : "retracted_by_sender";
  await message.save();

  return res.json({ success: true });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/messages/:messageId/reactions
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:messageId/reactions", asyncHandler(async (req, res) => {
  const me = requirePrincipal(req, res);
  if (!me) return;

  const { key } = req.body || {};
  if (!key || String(key).length > 16) {
    return res.status(400).json({ success: false, error: "A short reaction key is required" });
  }

  const message = await Message.findOne({
    _id: String(req.params.messageId), schoolId: String(me.schoolId),
  });
  if (!message || message.deletedAt) {
    return res.status(404).json({ success: false, error: "Message not found" });
  }

  const conversation = await Conversation.findOne({
    _id: message.conversationId, deletedAt: null,
  }).lean();

  const verdict = policy.canPostToConversation(me, conversation);
  if (!verdict.allowed) {
    return res.status(403).json({ success: false, error: verdict.reason });
  }

  const kind = me.kind === "guardian" ? "guardian" : "user";
  const mine = message.reactions.findIndex(
    (r) => r.kind === kind && String(r.by) === String(me.id) && r.key === key
  );

  // Tapping the same reaction again removes it.
  if (mine >= 0) message.reactions.splice(mine, 1);
  else           message.reactions.push({ key, kind, by: String(me.id) });

  await message.save();
  return res.json({ success: true, reactions: message.reactions });
}));

module.exports = router;
