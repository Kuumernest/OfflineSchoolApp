// mobile/src/services/message.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MESSAGING — offline-first client
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Conversations and messages are held locally so a thread opens instantly
 * and reads the same on a train with no signal as it does on wifi. Sends go
 * through the shared mutation outbox, so composing without a connection is
 * ordinary rather than an error state.
 *
 * ── Why every message gets its own entityKey ──────────────────────────────
 *
 * MutationQueue.enqueue coalesces: re-enqueueing the same entityKey REPLACES
 * the pending row, which is exactly right for "the user edited this student
 * twice before we synced". It is exactly wrong for messages. Two messages
 * typed thirty seconds apart on a dead link are not two versions of one
 * thing — the first would be silently discarded. So the key is
 * `message:<clientId>`, unique per message, and nothing ever coalesces.
 *
 * ── Why the client picks the id ───────────────────────────────────────────
 *
 * The outbox retries. The server accepts a client-supplied _id and answers a
 * replay with the message it already stored, so a retry after a timeout
 * cannot post twice. The same id is the local row's primary key, which is
 * what lets the queued copy be reconciled in place instead of appearing
 * twice in the thread.
 *
 * ── Message states ────────────────────────────────────────────────────────
 *
 *   queued     written locally, waiting for the outbox
 *   sending    the outbox is attempting it now
 *   sent       the server has it
 *   failed     permanently rejected; shown with a retry affordance
 *
 * "Delivered" and "read" are deliberately NOT in that list. They are claims
 * about somebody else's device, they arrive late or never on this kind of
 * link, and they belong to the recipient's read marker rather than to the
 * sender's outbox row.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import "react-native-get-random-values";
import { v4 as uuidv4 } from "uuid";

import api                from "./api";
import { getDatabase }    from "../db/database";
import { MutationQueue, registerReconciler } from "./mutationQueue.service";

// ── Local schema ────────────────────────────────────────────────────────────

const CONVERSATIONS = "conversations";
const MESSAGES      = "messages";

let schemaReady = null;

/**
 * Create the local tables once per app run.
 *
 * Kept here rather than in the central schema because messaging is additive:
 * a device upgrading from a build without it must not need a migration to
 * open any other screen.
 */
async function ensureSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    const db = await getDatabase();

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${CONVERSATIONS} (
        id                   TEXT PRIMARY KEY,
        school_id            TEXT,
        kind                 TEXT,
        title                TEXT,
        class_id             TEXT,
        subject_id           TEXT,
        participants         TEXT,
        last_message_at      TEXT,
        last_message_seq     INTEGER DEFAULT 0,
        last_message_preview TEXT,
        last_read_seq        INTEGER DEFAULT 0,
        is_archived          INTEGER DEFAULT 0,
        is_read_only         INTEGER DEFAULT 0,
        updated_at           TEXT
      )
    `);

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${MESSAGES} (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT NOT NULL,
        seq               INTEGER,
        sender_kind       TEXT,
        sender_id         TEXT,
        sender_name       TEXT,
        body              TEXT,
        attachments       TEXT,
        reply_to          TEXT,
        system_event      TEXT,
        is_deleted        INTEGER DEFAULT 0,
        device_created_at TEXT,
        created_at        TEXT,
        state             TEXT DEFAULT 'sent',
        error             TEXT
      )
    `);

    // The thread read. seq DESC because a thread opens at its newest end.
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_messages_thread
       ON ${MESSAGES}(conversation_id, seq DESC)`
    );

    // Queued messages have no seq yet; this is how they are found and shown
    // at the bottom of the thread.
    await db.execAsync(
      `CREATE INDEX IF NOT EXISTS idx_messages_state
       ON ${MESSAGES}(state, created_at)`
    );

    return true;
  })();

  return schemaReady;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const json  = (v) => { try { return JSON.stringify(v ?? null); } catch { return null; } };
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

const rowToMessage = (r) => ({
  _id:             r.id,
  conversationId:  r.conversation_id,
  seq:             r.seq,
  sender:          { kind: r.sender_kind, id: r.sender_id, name: r.sender_name },
  body:            r.body,
  attachments:     parse(r.attachments, []),
  replyTo:         r.reply_to,
  systemEvent:     r.system_event,
  isDeleted:       r.is_deleted === 1,
  deviceCreatedAt: r.device_created_at,
  createdAt:       r.created_at,
  state:           r.state,
  error:           r.error,
});

const rowToConversation = (r) => ({
  _id:                r.id,
  kind:               r.kind,
  title:              r.title,
  classId:            r.class_id,
  subjectId:          r.subject_id,
  participants:       parse(r.participants, []),
  lastMessageAt:      r.last_message_at,
  lastMessageSeq:     r.last_message_seq,
  lastMessagePreview: r.last_message_preview,
  isArchived:         r.is_archived === 1,
  isReadOnly:         r.is_read_only === 1,
  unread:             Math.max(0, (r.last_message_seq || 0) - (r.last_read_seq || 0)),
});

// ── Local writes ────────────────────────────────────────────────────────────

async function upsertConversation(db, c, myId, myKind) {
  const mine = (c.participants || []).find(
    (p) => p.kind === myKind && String(p.id) === String(myId)
  );

  await db.runAsync(
    `INSERT OR REPLACE INTO ${CONVERSATIONS}
      (id, school_id, kind, title, class_id, subject_id, participants,
       last_message_at, last_message_seq, last_message_preview,
       last_read_seq, is_archived, is_read_only, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      c._id, c.schoolId ?? null, c.kind ?? null, c.title ?? null,
      c.classId ?? null, c.subjectId ?? null, json(c.participants ?? []),
      c.lastMessageAt ?? null, c.lastMessageSeq ?? 0, c.lastMessagePreview ?? null,
      mine?.lastReadSeq ?? 0,
      c.isArchived ? 1 : 0, c.isReadOnly ? 1 : 0,
      new Date().toISOString(),
    ]
  );
}

async function upsertMessage(db, conversationId, m, state = "sent") {
  await db.runAsync(
    `INSERT OR REPLACE INTO ${MESSAGES}
      (id, conversation_id, seq, sender_kind, sender_id, sender_name, body,
       attachments, reply_to, system_event, is_deleted, device_created_at,
       created_at, state, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      m._id, conversationId, m.seq ?? null,
      m.sender?.kind ?? null, m.sender?.id ?? null, m.sender?.name ?? null,
      m.body ?? null, json(m.attachments ?? []), m.replyTo ?? null,
      m.systemEvent ?? null, m.isDeleted ? 1 : 0,
      m.deviceCreatedAt ?? null, m.createdAt ?? null,
      state, null,
    ]
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Conversations, from the local store.
 *
 * Reads local first and returns immediately; the network refresh runs after
 * and the caller re-reads. A list that only appears once the server answers
 * is useless on the links this app is built for.
 */
export async function listConversations() {
  await ensureSchema();
  const db   = await getDatabase();
  const rows = await db.getAllAsync(
    `SELECT * FROM ${CONVERSATIONS}
     WHERE is_archived = 0
     ORDER BY COALESCE(last_message_at, updated_at) DESC`
  );
  return rows.map(rowToConversation);
}

/** Pull conversations from the server and reconcile locally. */
export async function syncConversations({ myId, myKind = "user" } = {}) {
  await ensureSchema();
  try {
    const res  = await api.get("/messages/conversations", { timeout: 10000 });
    const list = res.data?.conversations ?? [];
    const db   = await getDatabase();

    for (const c of list) await upsertConversation(db, c, myId, myKind);

    return { ok: true, count: list.length };
  } catch (err) {
    // Offline is the expected case, not an error worth surfacing.
    return { ok: false, reason: err?.message };
  }
}

/**
 * Messages in a thread, newest last.
 *
 * Queued messages have no seq yet, so they sort after everything the server
 * has numbered — which puts them at the bottom of the thread where the
 * person who just typed them expects to see them.
 */
export async function listMessages(conversationId, { limit = 50 } = {}) {
  await ensureSchema();
  const db   = await getDatabase();
  const rows = await db.getAllAsync(
    `SELECT * FROM ${MESSAGES}
     WHERE conversation_id = ?
     ORDER BY COALESCE(seq, 2147483647) DESC, created_at DESC
     LIMIT ?`,
    [String(conversationId), Number(limit) || 50]
  );
  return rows.map(rowToMessage).reverse();
}

/** Pull a thread from the server and reconcile locally. */
export async function syncMessages(conversationId) {
  await ensureSchema();
  try {
    const res  = await api.get(
      `/messages/conversations/${conversationId}/messages`,
      { timeout: 10000 }
    );
    const list = res.data?.messages ?? [];
    const db   = await getDatabase();

    for (const m of list) await upsertMessage(db, conversationId, m, "sent");

    return { ok: true, count: list.length };
  } catch (err) {
    return { ok: false, reason: err?.message };
  }
}

/**
 * Send a message.
 *
 * Writes locally first and returns, so the thread updates at once whatever
 * the network is doing, then hands the send to the outbox.
 *
 * entityKey is `message:<clientId>` — unique per message. Anything shared
 * across messages would make the outbox coalesce them and drop all but the
 * last, which is the one bug this whole path has to avoid.
 */
export async function sendMessage({
  conversationId, body, attachments = [], replyTo = null, sender,
}) {
  await ensureSchema();

  const clientId = uuidv4();
  const now      = new Date().toISOString();
  const db       = await getDatabase();

  const optimistic = {
    _id:             clientId,
    seq:             null,
    sender,
    body:            String(body ?? "").trim(),
    attachments,
    replyTo,
    deviceCreatedAt: now,
    createdAt:       now,
  };

  await upsertMessage(db, conversationId, optimistic, "queued");

  // Keep the conversation list ordered correctly while the send is pending.
  await db.runAsync(
    `UPDATE ${CONVERSATIONS}
     SET last_message_at = ?, last_message_preview = ?
     WHERE id = ?`,
    [now, optimistic.body.slice(0, 140) || "[attachment]", String(conversationId)]
  );

  await MutationQueue.enqueue({
    entityKey: `message:${clientId}`,
    method:    "POST",
    endpoint:  `/messages/conversations/${conversationId}/messages`,
    payload: {
      clientId,
      body:            optimistic.body,
      attachments,
      replyTo,
      deviceCreatedAt: now,
      // Reconciled through the outbox's own mechanism rather than a bespoke
      // callback, so a message settles the same way every other queued
      // mutation does — including when the queue is drained by sync rather
      // than by this screen.
      __reconcile: { kind: "message", clientId },
    },
  });

  return rowToMessage({
    id: clientId, conversation_id: conversationId, seq: null,
    sender_kind: sender?.kind, sender_id: sender?.id, sender_name: sender?.name,
    body: optimistic.body, attachments: json(attachments), reply_to: replyTo,
    system_event: null, is_deleted: 0, device_created_at: now,
    created_at: now, state: "queued", error: null,
  });
}

/**
 * Reconcile a queued message once the server has accepted it.
 *
 * Called by the outbox's success handler. The server's seq is what fixes the
 * message's place in the thread; until then it floats at the bottom.
 */
export async function confirmSent(clientId, serverMessage) {
  await ensureSchema();
  const db = await getDatabase();

  await db.runAsync(
    `UPDATE ${MESSAGES}
     SET seq = ?, created_at = ?, state = 'sent', error = NULL
     WHERE id = ?`,
    [serverMessage?.seq ?? null, serverMessage?.createdAt ?? null, String(clientId)]
  );
}

/** Mark a queued message permanently failed, so the UI can offer a retry. */
export async function markFailed(clientId, reason) {
  await ensureSchema();
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE ${MESSAGES} SET state = 'failed', error = ? WHERE id = ?`,
    [String(reason ?? "Send failed"), String(clientId)]
  );
}

/**
 * Move this device's read marker.
 *
 * Queued silently: a read receipt that fails to sync is not the user's work
 * going missing, and must not appear in the pending-changes count as though
 * it were.
 */
export async function markRead(conversationId, seq) {
  await ensureSchema();
  const db = await getDatabase();

  await db.runAsync(
    `UPDATE ${CONVERSATIONS} SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?`,
    [Number(seq) || 0, String(conversationId)]
  );

  await MutationQueue.enqueue({
    entityKey: `message-read:${conversationId}`,   // coalescing is CORRECT here
    method:    "POST",
    endpoint:  `/messages/conversations/${conversationId}/read`,
    payload:   { seq: Number(seq) || 0 },
    silent:    true,
  });
}

/**
 * Upload one attachment and get back its metadata.
 *
 * Deliberately NOT queued through the outbox. The outbox carries JSON and
 * retries it; a multipart body with a file on disk is a different shape, and
 * a retried upload would leave orphaned copies on the server. So attaching a
 * file needs a connection, while the message that carries it does not — the
 * caller uploads first, then sends, and the send is what survives going
 * offline.
 *
 * @param {string} conversationId
 * @param {{uri: string, name?: string, mimeType?: string}} file
 * @returns {Promise<object>} attachment metadata for sendMessage()
 */
export async function uploadAttachment(conversationId, file) {
  const form = new FormData();

  // React Native's FormData takes this shape for a local file rather than a
  // Blob; the uri is what the native layer streams from.
  form.append("file", {
    uri:  file.uri,
    name: file.name || "attachment",
    type: file.mimeType || "application/octet-stream",
  });

  const res = await api.post(
    `/messages/conversations/${conversationId}/attachments`,
    form,
    {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 60000,
    }
  );

  return res.data?.attachment ?? null;
}

/**
 * Who this user may start a conversation with.
 *
 * Server-answered and never cached: the school's settings can change, and a
 * stale picker that offers somebody the send path refuses is worse than a
 * picker that needs a connection. Starting a NEW conversation is the one part
 * of messaging that legitimately requires one — an existing thread can still
 * be read and written to offline.
 */
export async function fetchRecipients(q = "", limit = 40) {
  const res = await api.get("/messages/recipients", {
    params:  { q, limit },
    timeout: 10000,
  });
  return res.data?.recipients ?? [];
}

/** Open, or reuse, a direct thread. Needs a connection. */
export async function openDirect({ id, kind = "user", myId, myKind = "user" }) {
  const res = await api.post("/messages/conversations/direct", { id, kind });
  const conversation = res.data?.conversation;

  if (conversation) {
    await ensureSchema();
    const db = await getDatabase();
    await upsertConversation(db, conversation, myId, myKind);
  }

  return conversation;
}

/** Total unread across every thread, for a badge. */
export async function unreadTotal() {
  await ensureSchema();
  const db  = await getDatabase();
  const row = await db.getFirstAsync(
    `SELECT SUM(MAX(0, last_message_seq - last_read_seq)) AS n
     FROM ${CONVERSATIONS} WHERE is_archived = 0`
  );
  return row?.n ?? 0;
}

// ── Outbox reconciliation ───────────────────────────────────────────────────

let _registered = false;

/**
 * Teach the outbox how to settle a sent message.
 *
 * Called once at startup. Idempotent, because the sync layer and a screen
 * may both reasonably try to make sure messaging is wired up.
 */
export const registerMessageReconcilers = () => {
  if (_registered) return;
  _registered = true;

  registerReconciler("message", async ({ response, args }) => {
    const sent = response?.data?.message ?? response?.data?.data ?? null;
    if (!args?.clientId) return;

    // A replay the server recognised comes back with duplicate:true and the
    // message it already holds. Either way the local row becomes "sent" and
    // takes the server's seq, which is what fixes its place in the thread.
    await confirmSent(args.clientId, sent);
  });
};

export default {
  registerMessageReconcilers,
  fetchRecipients,
  uploadAttachment,
  listConversations,
  syncConversations,
  listMessages,
  syncMessages,
  sendMessage,
  confirmSent,
  markFailed,
  markRead,
  openDirect,
  unreadTotal,
};
