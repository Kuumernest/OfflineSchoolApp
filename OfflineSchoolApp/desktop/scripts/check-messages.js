// desktop/scripts/check-messages.js
"use strict";

/**
 * Messaging on the desktop, offline: the last-known threads, and sends queued.
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *
 *   online reads are the server's   or a parent's new message never appears
 *   offline reads are the copy      or the screen is empty on a dead line
 *   the copy is one account's       or the next person at this PC reads the
 *                                    last person's threads
 *   an offline send is shown AND    or it vanishes, or is shown and never sent
 *     queued, in one transaction
 *   a replay posts once             or a parent gets the message twice
 *   online sends go straight out    or a refusal blocks the queue instead of
 *                                    being shown in the composer
 *   a new conversation is not       or a thread exists only on this machine
 *     answered locally
 *
 * Against a real temp node:sqlite store and a real HTTP server that can be
 * told to vanish — the failure is about the network, so a stubbed client would
 * be asserting the stub.
 *
 *   node scripts/check-messages.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");

const store      = require("../src/main/db/store");
const { outbox } = require("../src/main/db/outbox");
const { client } = require("../src/main/sync/client");
const { engine } = require("../src/main/sync/engine");
const api        = require("../src/main/api");
const { COL }    = require("../src/main/api/handlers/messages");
const { isOnlineOnly } = require("../src/main/api/coverage");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-messages-"));
const file = path.join(dir, "school.db");
const cleanup = () => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (err) { console.log(`  (could not remove ${dir}: ${err.code})`); }
};

// ─────────────────────────────────────────────────────────────────────────────
// A messaging server, reduced to what the desktop asks of it
// ─────────────────────────────────────────────────────────────────────────────

const fakeServer = () => {
  const st = {
    down: false,
    // Store the message, then drop the connection before answering.
    loseNextResponse: false,
    conversations: [
      { _id: "c1", kind: "direct", participants: [{ kind: "user", id: "u1" }, { kind: "guardian", id: "g1" }], lastMessageSeq: 2, isReadOnly: false, unread: 0 },
      { _id: "c2", kind: "class",  participants: [{ kind: "user", id: "u1" }], lastMessageSeq: 0, isReadOnly: true, unread: 0 },
    ],
    messages: [
      { _id: "m1", conversationId: "c1", seq: 1, sender: { kind: "guardian", id: "g1" }, body: "Bonjour", attachments: [], createdAt: "2026-11-01T08:00:00.000Z" },
      { _id: "m2", conversationId: "c1", seq: 2, sender: { kind: "user", id: "u1" },     body: "Hello",   attachments: [], createdAt: "2026-11-01T08:05:00.000Z" },
    ],
    posts: [],   // { clientId, key, duplicate }
    hits:  0,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (st.down) { req.socket.destroy(); return; }
      st.hits++;
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const body = raw ? JSON.parse(raw) : {};
      const p = url.pathname;

      if (p === "/api/sync/changes") return send(200, { success: true, collections: {}, refused: [] });
      if (p === "/api/messages/conversations" && req.method === "GET") {
        return send(200, { success: true, count: st.conversations.length, conversations: st.conversations });
      }
      let m = p.match(/^\/api\/messages\/conversations\/([^/]+)\/messages$/);
      if (m && req.method === "GET") {
        const rows = st.messages.filter((x) => x.conversationId === m[1]).sort((a, b) => b.seq - a.seq);
        return send(200, { success: true, count: rows.length, messages: rows,
          participantReads: [{ kind: "guardian", id: "g1", lastReadSeq: 1, lastDeliveredSeq: 2 }], viaAudit: false });
      }
      if (m && req.method === "POST") {
        const conv = st.conversations.find((c) => c._id === m[1]);
        if (!conv) return send(404, { success: false, error: "Conversation not found" });
        if (conv.isReadOnly) return send(403, { success: false, error: "Read-only" });
        // The real dedupe: clientId is the _id, a second insert collides.
        const existing = st.messages.find((x) => x._id === body.clientId);
        const key = req.headers["idempotency-key"] ?? null;
        if (existing) {
          st.posts.push({ clientId: body.clientId, key, duplicate: true });
          return send(200, { success: true, duplicate: true, message: existing });
        }
        const seq = Math.max(0, ...st.messages.filter((x) => x.conversationId === m[1]).map((x) => x.seq)) + 1;
        const msg = { _id: body.clientId, conversationId: m[1], seq, sender: { kind: "user", id: "u1" },
          body: body.body, attachments: body.attachments ?? [], createdAt: new Date().toISOString() };
        st.messages.push(msg);
        conv.lastMessageSeq = seq;
        st.posts.push({ clientId: body.clientId, key, duplicate: false });
        if (st.loseNextResponse) { st.loseNextResponse = false; req.socket.destroy(); return; }
        return send(201, { success: true, duplicate: false, message: msg });
      }
      m = p.match(/^\/api\/messages\/conversations\/([^/]+)$/);
      if (m && req.method === "GET") {
        const conv = st.conversations.find((c) => c._id === m[1]);
        return conv ? send(200, { success: true, conversation: conv, viaAudit: false }) : send(404, { success: false });
      }
      return send(404, { success: false, error: `no route ${req.method} ${p}` });
    });
  });

  return { st, server };
};

// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  const { st, server } = fakeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const db    = store.open(file);
  const docs  = store.documents(db);
  const queue = outbox(db);
  const state = store.state(db);
  const meta  = store.meta(db);

  const net = client({ meta });
  net.setServerUrl(base);
  net.setToken("token-u1");

  let offlineFlag = false;
  const ctxFor = (session) => ({
    docs, meta, queue, state, session, server: net, offline: () => offlineFlag,
  });
  const u1 = ctxFor({ userId: "u1", schoolId: "s1", role: "teacher" });
  const u2 = ctxFor({ userId: "u2", schoolId: "s1", role: "teacher" });

  const call = (ctx, method, p, { query = {}, body } = {}) =>
    api.handle({ method, path: p, query, body }, ctx);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- online: the server answers, and a copy is kept ---");

  const list = await call(u1, "GET", "/api/messages/conversations");
  check("the list is the server's", list?.data?.conversations?.map((c) => c._id), ["c1", "c2"]);
  check("a copy of the list is kept for this account", Boolean(docs.get(COL.list, `${base}|s1|u1`)), true);

  const thread = await call(u1, "GET", "/api/messages/conversations/c1/messages", { query: { limit: 100 } });
  check("the thread is the server's", thread?.data?.messages?.map((m) => m._id), ["m2", "m1"]);
  check("its messages are kept", docs.count(COL.message, { scope: `${base}|s1|u1`, conversationId: "c1" }), 2);

  st.messages.push({ _id: "m3", conversationId: "c1", seq: 3, sender: { kind: "guardian", id: "g1" }, body: "Merci", attachments: [], createdAt: "2026-11-01T09:00:00.000Z" });
  const fresh = await call(u1, "GET", "/api/messages/conversations/c1/messages", { query: { limit: 100 } });
  check("online, a new message from the parent appears (not served stale)", fresh?.data?.messages?.[0]?._id, "m3");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- offline: the copy answers ---");

  st.down = true;
  const offList = await call(u1, "GET", "/api/messages/conversations");
  check("offline, the list is the last-known one", offList?.data?.conversations?.map((c) => c._id), ["c1", "c2"]);
  check("with the server's status", offList?.status, 200);

  const offThread = await call(u1, "GET", "/api/messages/conversations/c1/messages", { query: { limit: 100 } });
  check("offline, the thread is the last-known one, newest first",
    offThread?.data?.messages?.map((m) => m._id), ["m3", "m2", "m1"]);
  check("with the participants' read markers", offThread?.data?.participantReads?.[0]?.lastReadSeq, 1);
  check("not flagged as pending", offThread?.data?.messages?.some((m) => m._pending), false);

  const offOne = await call(u1, "GET", "/api/messages/conversations/c1");
  check("offline, one conversation comes from the list copy", offOne?.data?.conversation?._id, "c1");

  check("offline, a thread never opened here is not invented",
    await call(u1, "GET", "/api/messages/conversations/c2/messages"), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- another person on the same machine reads none of it ---");

  check("u2 offline: no list", await call(u2, "GET", "/api/messages/conversations"), null);
  check("u2 offline: no thread", await call(u2, "GET", "/api/messages/conversations/c1/messages"), null);
  check("u2 offline: no conversation", await call(u2, "GET", "/api/messages/conversations/c1"), null);
  check("u2 offline: cannot queue into u1's conversation",
    await call(u2, "POST", "/api/messages/conversations/c1/messages", { body: { body: "hi" } }), null);
  const otherSchool = ctxFor({ userId: "u1", schoolId: "s2", role: "teacher" });
  check("the same person in another school: no list",
    await call(otherSchool, "GET", "/api/messages/conversations"), null);
  check("signed out: nothing answered here",
    await call(ctxFor(null), "GET", "/api/messages/conversations"), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- offline send: shown pending and queued, together ---");

  const before = queue.all().length;
  const sent = await call(u1, "POST", "/api/messages/conversations/c1/messages", { body: { body: "Rendez-vous lundi", clientId: "k1" } });
  check("answered as created", sent?.status, 201);
  check("with the server's shape and the local flag", [sent?.data?.success, sent?.data?.message?._id, sent?.data?.message?._pending, sent?.data?.message?.seq], [true, "k1", true, null]);
  check("marked as queued for the dispatcher", sent?.queued, true);

  const rows = queue.all();
  check("exactly one outbox row", rows.length - before, 1);
  const row = rows[rows.length - 1];
  check("the row is the real POST", [row.method, row.path], ["POST", "/api/messages/conversations/c1/messages"]);
  check("carrying the clientId", JSON.parse(row.body).clientId, "k1");
  check("under one stable Idempotency-Key", row.idem_key, "message:k1");
  check("owned by this account", row.user_id, "u1");
  check("the local row is pending", docs.get(COL.message, `${base}|s1|u1|k1`)?._pending, true);

  const withPending = await call(u1, "GET", "/api/messages/conversations/c1/messages", { query: { limit: 100 } });
  check("the thread shows it, newest, pending",
    withPending?.data?.messages?.map((m) => [m._id, m._pending]), [["k1", true], ["m3", false], ["m2", false], ["m1", false]]);
  const listAfter = await call(u1, "GET", "/api/messages/conversations");
  check("the list shows the latest line", listAfter?.data?.conversations?.[0]?.lastMessagePreview, "Rendez-vous lundi");

  const sent2 = await call(u1, "POST", "/api/messages/conversations/c1/messages", { body: { body: "Et mardi", clientId: "k2" } });
  check("a second offline send queues behind the first", [sent2?.status, queue.all().length - before], [201, 2]);

  check("offline, a read-only conversation is not queued into",
    await call(u1, "POST", "/api/messages/conversations/c2/messages", { body: { body: "x" } }), null);
  check("offline, an unknown conversation is not queued into",
    await call(u1, "POST", "/api/messages/conversations/nope/messages", { body: { body: "x" } }), null);
  check("an empty message is left to the server's 400",
    await call(u1, "POST", "/api/messages/conversations/c1/messages", { body: { body: "  " } }), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a new conversation stays online-only ---");

  check("POST /conversations/direct is not answered locally",
    await call(u1, "POST", "/api/messages/conversations/direct", { body: { id: "g1", kind: "guardian" } }), null);
  check("and the census says so", isOnlineOnly("POST /messages/conversations/direct"), true);
  check("recipients likewise", await call(u1, "GET", "/api/messages/recipients"), null);
  check("attachments likewise", isOnlineOnly("POST /messages/conversations/:id/attachments"), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- back online: each queued message is posted once ---");

  st.down = false;
  // The first send lands but its answer is lost on the way back.
  st.loseNextResponse = true;
  const eng = engine({ docs, queue, state, client: net, feedCollections: ["student"], currentUser: () => "u1" });
  await eng.cycle();
  check("the first POST arrived", st.posts.map((p) => p.clientId), ["k1"]);
  check("and is still queued (no answer came back)", queue.all().length - before, 2);

  // Make the backoff due now rather than waiting five seconds.
  db.prepare("UPDATE outbox SET next_try_at = ?").run(new Date(Date.now() - 1000).toISOString());
  await eng.cycle();
  check("the replay is recognised, the second goes once",
    st.posts.map((p) => [p.clientId, p.duplicate]), [["k1", false], ["k1", true], ["k2", false]]);
  check("the replay carried the same Idempotency-Key", st.posts.filter((p) => p.clientId === "k1").map((p) => p.key), ["message:k1", "message:k1"]);
  check("the server holds each message once",
    st.messages.filter((m) => m._id === "k1" || m._id === "k2").length, 2);
  check("the queue is empty", queue.all().length - before, 0);
  check("the local rows are settled", [docs.get(COL.message, `${base}|s1|u1|k1`)?._pending, docs.get(COL.message, `${base}|s1|u1|k2`)?._pending], [false, false]);

  await eng.cycle();
  check("another cycle sends nothing more", st.posts.length, 3);

  const after = await call(u1, "GET", "/api/messages/conversations/c1/messages", { query: { limit: 100 } });
  check("the thread now has them with the server's order, none pending",
    after?.data?.messages?.slice(0, 2).map((m) => [m._id, m.seq, Boolean(m._pending)]), [["k2", 5], ["k1", 4]].map(([a, b]) => [a, b, false]));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- online sends go straight out ---");

  const rowsBefore = queue.all().length;
  const direct = await call(u1, "POST", "/api/messages/conversations/c1/messages", { body: { body: "Direct", clientId: "k3" } });
  check("answered by the server", [direct?.status, direct?.data?.message?.seq, direct?.queued], [201, 6, undefined]);
  check("nothing queued", queue.all().length, rowsBefore);
  check("sent with the stable key", st.posts[st.posts.length - 1].key, "message:k3");
  check("a refusal is declined to the window, not queued",
    [await call(u1, "POST", "/api/messages/conversations/c2/messages", { body: { body: "x", clientId: "k4" } }), queue.all().length],
    [null, rowsBefore]);

  // The window may be told offline by the sync loop before a request fails.
  offlineFlag = true;
  const hits = st.hits;
  const known = await call(u1, "GET", "/api/messages/conversations");
  check("known offline: the copy, without asking the server", [known?.data?.conversations?.length, st.hits], [2, hits]);
  offlineFlag = false;

  // A pending message the server has not got yet is shown beside the server's answer.
  st.down = true;
  await call(u1, "POST", "/api/messages/conversations/c1/messages", { body: { body: "Later", clientId: "k5" } });
  st.down = false;
  const merged = await call(u1, "GET", "/api/messages/conversations/c1/messages", { query: { limit: 100 } });
  check("online with one still queued: the server's thread plus the pending one",
    [merged?.data?.messages?.[0]?._id, merged?.data?.messages?.[0]?._pending, merged?.data?.messages?.[1]?._id], ["k5", true, "k3"]);
  check("and the GET did not drop the pending row", docs.get(COL.message, `${base}|s1|u1|k5`)?._pending, true);

  server.close();
  db.close();
};

main()
  .catch((err) => { fail++; console.log(`  FAIL threw: ${err.stack}`); })
  .finally(() => {
    cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
