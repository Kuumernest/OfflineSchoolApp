// desktop/src/main/api/handlers/messages.js
"use strict";

/**
 * Messaging on the desktop: the last-known threads offline, and sends queued.
 *
 * ── Why this module is unlike every other handler ─────────────────────────
 *
 * Conversation and Message are not in the sync feed (backend/src/config/
 * syncFeed.js excludes them: who may read a thread is decided per THREAD, and
 * the feed can express one capability per collection). So there is no mirror
 * to answer from, and the only copy this machine can ever have is the one the
 * server already handed THIS user. These handlers keep it: a read-through cache.
 *
 * ── Network first while online, cache when not ────────────────────────────
 *
 * Every other read on the desktop is local-first, because the mirror is kept
 * current by the sync loop whatever the screen does. Nothing keeps this cache
 * current except these very requests: answered local-first, a new message from
 * a parent would never appear, because the only thing that refreshes the copy
 * is asking the server. So while the server answers, the server answers — the
 * thread is exactly what a browser would show — and a copy is kept. When the
 * server cannot be reached (no response at all, or the sync loop already knows
 * it is offline), the copy answers. A refusal (401, 403, 404) is NOT a reason
 * to show the copy: the request is declined so the window repeats it itself and
 * gets the real answer — including the 401 the axios layer refreshes on.
 *
 * ── Scoped to one account on one school ──────────────────────────────────
 *
 * An office machine is shared. Every cached row carries a scope —
 * server|school|user — and is read back only under the same one, so a second
 * person signing in on this computer sees nothing of the first person's
 * threads, offline or not. These collections are local-only: nothing in the
 * feed is called this, and they reach the server only as the queued send below.
 *
 * ── Sending ──────────────────────────────────────────────────────────────
 *
 * Online, a send goes straight out, as it always did — a refusal ("this school
 * has not enabled …") is shown in the composer at once, not parked in a queue.
 * Unreachable, it is written to the thread as pending and the POST is queued in
 * the same transaction. The id is the client's (`clientId`), which the server
 * uses as the message's _id, so a replay collides and is answered 200 with the
 * stored message (conversation.service.js postMessage) — on top of the
 * Idempotency-Key the outbox sends. Once anything is queued for this account,
 * later sends queue behind it too, so two messages cannot overtake each other.
 *
 * Not here, deliberately: starting a conversation (the recipient list is
 * computed by the server's policy, and the conversation does not exist until
 * the server makes it), uploading an attachment (a file, not a document), and
 * the read marker (a receipt queued behind somebody's fee payment could block
 * the whole queue on a 404 for a thread they have left — not worth it).
 */

const { randomUUID } = require("crypto");

/** Local-only collections. Never in the feed, never pushed except as a queued send. */
const COL = {
  list:    "localMessageList",     // one per scope: the conversation list
  thread:  "localMessageThread",   // one per scope+conversation: participantReads
  message: "localMessage",         // one per scope+message
};

/**
 * Shorter than the sync client's 30 s: this is a person looking at a screen,
 * and the copy is right here. A hung connection should become "offline" fast.
 */
const NETWORK_TIMEOUT_MS = 8_000;

const scopeOf = (ctx) => {
  const s = ctx.session;
  if (!s?.userId || !ctx.server) return null;
  const server = typeof ctx.server.serverUrl === "function" ? ctx.server.serverUrl() : "";
  return `${server || "-"}|${s.schoolId ?? "-"}|${s.userId}`;
};

/** Never reached the server — the only case where the copy answers. */
const unreachable = (err) =>
  err && err.status == null && (err.code === "OFFLINE" || err.code === "TIMEOUT");

/** The sync loop's own view, so an offline poll does not wait for a timeout. */
const knownOffline = (ctx) => {
  try { return Boolean(ctx.offline?.()); } catch { return false; }
};

const withQuery = (path, query = {}) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
};

/**
 * Ask the server; on success hand back the payload, offline hand back
 * `undefined`, on a refusal throw so the caller declines.
 */
const fromServer = async (ctx, method, path, body, idemKey) => {
  if (knownOffline(ctx)) return undefined;
  try {
    return await ctx.server.request(method, path, body, idemKey, { timeoutMs: NETWORK_TIMEOUT_MS });
  } catch (err) {
    if (unreachable(err)) return undefined;
    throw err;
  }
};

const rowId = (scope, id) => `${scope}|${id}`;

// ── The copy ────────────────────────────────────────────────────────────────

const cachedList = (docs, scope) => {
  const row = docs.get(COL.list, scope);
  return row && row.scope === scope ? row : null;
};

const cachedMessages = (docs, scope, conversationId) =>
  docs.find(COL.message, { scope, conversationId: String(conversationId) });

/** A message as the screen reads it: the server's shape, plus the local flag. */
const asMessage = (row) => ({ ...row.message, _pending: Boolean(row._pending) });

/** Unsent first (newest), then by seq descending — the server's order. */
const newestFirst = (a, b) => {
  const as = a.message?.seq, bs = b.message?.seq;
  if (as == null && bs == null) return String(b.createdAt).localeCompare(String(a.createdAt));
  if (as == null) return -1;
  if (bs == null) return 1;
  return bs - as;
};

const storeThread = (docs, scope, conversationId, data, { replace }) => {
  const convId = String(conversationId);
  docs.tx(() => {
    const incoming = Array.isArray(data?.messages) ? data.messages : [];
    if (replace) {
      // The newest page replaces what was kept, so a deleted or edited message
      // is not shown as it was. Unsent rows are the outbox's, never dropped here.
      for (const row of cachedMessages(docs, scope, convId)) {
        if (!row._pending) docs.forget(COL.message, row._id);
      }
    }
    const pendingIds = new Set(
      cachedMessages(docs, scope, convId).filter((r) => r._pending).map((r) => String(r.message?._id))
    );
    for (const m of incoming) {
      if (!m?._id) continue;
      // Still waiting in the outbox (the server answered the GET before the push
      // landed): leave the pending row to be settled by the engine.
      if (pendingIds.has(String(m._id))) continue;
      docs.put(COL.message, {
        _id: rowId(scope, m._id), scope, conversationId: convId,
        createdAt: m.createdAt ?? null, message: m,
      });
    }
    if (replace || Array.isArray(data?.participantReads)) {
      docs.put(COL.thread, {
        _id: rowId(scope, convId), scope, conversationId: convId,
        participantReads: Array.isArray(data?.participantReads) ? data.participantReads : [],
        fetchedAt: new Date().toISOString(),
      });
    }
  });
};

/** Messages still waiting to go, for this account. */
const unsentCount = (docs, scope) =>
  docs.sql(
    "SELECT COUNT(*) AS n FROM docs WHERE collection = ? AND pending = 1 AND json_extract(json, '$.scope') = ?",
    COL.message, scope
  )[0]?.n ?? 0;

// ─────────────────────────────────────────────────────────────────────────────

module.exports = [
  {
    route: "GET /api/messages/conversations",
    handler: async ({ query }, ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return null;
      try {
        const data = await fromServer(ctx, "GET", withQuery("/api/messages/conversations", query));
        if (data !== undefined) {
          // Only the first page is kept: it is what the screen opens on.
          if (!query?.before && Array.isArray(data?.conversations)) {
            ctx.docs.put(COL.list, {
              _id: scope, scope, conversations: data.conversations,
              fetchedAt: new Date().toISOString(),
            });
          }
          return { status: 200, data };
        }
      } catch {
        return null;
      }
      if (query?.before) return null;
      const cached = cachedList(ctx.docs, scope);
      if (!cached) return null;
      return {
        status: 200,
        data: { success: true, count: cached.conversations.length, conversations: cached.conversations },
      };
    },
  },

  {
    route: "GET /api/messages/conversations/:id",
    handler: async ({ params }, ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return null;
      try {
        const data = await fromServer(ctx, "GET", `/api/messages/conversations/${encodeURIComponent(params.id)}`);
        if (data !== undefined) return { status: 200, data };
      } catch {
        return null;
      }
      const conversation = cachedList(ctx.docs, scope)?.conversations
        ?.find((c) => String(c._id) === String(params.id));
      if (!conversation) return null;
      return { status: 200, data: { success: true, conversation, viaAudit: false } };
    },
  },

  {
    route: "GET /api/messages/conversations/:id/messages",
    handler: async ({ params, query }, ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return null;
      const convId = String(params.id);
      const path = withQuery(`/api/messages/conversations/${encodeURIComponent(convId)}/messages`, query);

      let data;
      try {
        data = await fromServer(ctx, "GET", path);
      } catch {
        return null;
      }

      if (data !== undefined) {
        // An administrator reading as audit sees unredacted rows: never kept.
        if (!data?.viaAudit) {
          storeThread(ctx.docs, scope, convId, data, { replace: query?.beforeSeq == null });
        }
        // Anything this account queued and the server has not got yet is still
        // shown, at the bottom, marked as waiting.
        const have = new Set((data?.messages ?? []).map((m) => String(m._id)));
        const unsent = query?.beforeSeq == null
          ? cachedMessages(ctx.docs, scope, convId)
              .filter((r) => r._pending && !have.has(String(r.message?._id)))
              .sort(newestFirst).map(asMessage)
          : [];
        if (!unsent.length) return { status: 200, data };
        const messages = [...unsent, ...(data.messages ?? [])];
        return { status: 200, data: { ...data, count: messages.length, messages } };
      }

      // Offline: the copy, or nothing (never opened on this machine as this
      // person — the request then fails as it would have).
      const thread = ctx.docs.get(COL.thread, rowId(scope, convId));
      if (!thread || thread.scope !== scope) return null;

      const limit = Math.min(Number(query?.limit) || 50, 100);
      const before = query?.beforeSeq != null ? Number(query.beforeSeq) : null;
      const rows = cachedMessages(ctx.docs, scope, convId).sort(newestFirst);
      const unsent = before == null ? rows.filter((r) => r.message?.seq == null) : [];
      const sent = rows
        .filter((r) => r.message?.seq != null && (before == null || r.message.seq < before))
        .slice(0, limit);
      const messages = [...unsent, ...sent].map(asMessage);

      return {
        status: 200,
        data: {
          success: true, count: messages.length, messages,
          participantReads: thread.participantReads ?? [], viaAudit: false,
        },
      };
    },
  },

  {
    route: "POST /api/messages/conversations/:id/messages",
    handler: async ({ params, body = {} }, ctx) => {
      const scope = scopeOf(ctx);
      if (!scope) return null;
      const convId = String(params.id);

      const text = String(body.body ?? "").trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      // Empty: the server's own 400 says so better than a copy of its rule.
      if (!text && attachments.length === 0) return null;

      const clientId = body.clientId ? String(body.clientId) : randomUUID();
      const now = new Date().toISOString();
      const path = `/api/messages/conversations/${encodeURIComponent(convId)}/messages`;
      const request = { ...body, clientId, deviceCreatedAt: body.deviceCreatedAt ?? now };
      // One operation, one key, whether it goes now or from the queue: a direct
      // send that timed out after arriving is then answered from the server's
      // memory rather than run twice (and clientId would catch it anyway).
      const idemKey = `message:${clientId}`;

      // Behind an earlier queued message, wait in line rather than overtake it.
      if (unsentCount(ctx.docs, scope) === 0) {
        let data;
        try {
          data = await fromServer(ctx, "POST", path, request, idemKey);
        } catch {
          // A refusal: declined, so the window sends it itself and shows the
          // server's reason. Same clientId, so it cannot post twice.
          return null;
        }
        if (data !== undefined) {
          if (data?.message?._id) {
            ctx.docs.put(COL.message, {
              _id: rowId(scope, data.message._id), scope, conversationId: convId,
              createdAt: data.message.createdAt ?? now, message: data.message,
            });
          }
          return { status: data?.duplicate ? 200 : 201, data };
        }
      }

      // ── Queued ────────────────────────────────────────────────────────────
      // Only into a conversation this person already has, as last seen from the
      // server. A thread missing from the copy, or read-only, goes to the
      // network to be refused (or answered) properly.
      const list = cachedList(ctx.docs, scope);
      const conversation = list?.conversations?.find((c) => String(c._id) === convId);
      if (!conversation || conversation.isReadOnly || conversation.isArchived) return null;

      const message = {
        _id: clientId,
        conversationId: convId,
        // The server assigns order. Unsent has none — the screen draws it last.
        seq: null,
        sender: { kind: "user", id: String(ctx.session.userId), name: null, role: ctx.session.role ?? null },
        body: text,
        attachments,
        replyTo: body.replyTo ?? null,
        systemEvent: null,
        reactions: [],
        deviceCreatedAt: request.deviceCreatedAt,
        createdAt: now,
        editedAt: null,
        isDeleted: false,
      };
      const docId = rowId(scope, clientId);

      const queued = ctx.docs.tx(() => {
        ctx.docs.put(COL.message, { _id: docId, scope, conversationId: convId, createdAt: now, message }, { pending: true });
        // The list shows the latest line too, so the thread does not look empty
        // from the outside.
        const { _pending: _ignored, ...listRow } = list;
        ctx.docs.put(COL.list, {
          ...listRow,
          conversations: list.conversations.map((c) => String(c._id) === convId
            ? { ...c, lastMessageAt: now, lastMessagePreview: text.slice(0, 140) || "[attachment]", lastMessageSender: String(ctx.session.userId) }
            : c),
        });
        return ctx.queue.add({
          method: "POST", path, body: request,
          collection: COL.message, docId, idemKey,
          userId: ctx.session.userId,
        });
      });

      return {
        status: 201,
        data: { success: true, duplicate: false, message: { ...message, _pending: true } },
        queued: true, seq: queued.seq, duplicate: queued.duplicate,
      };
    },
  },
];

module.exports.COL = COL;
module.exports.NETWORK_TIMEOUT_MS = NETWORK_TIMEOUT_MS;
