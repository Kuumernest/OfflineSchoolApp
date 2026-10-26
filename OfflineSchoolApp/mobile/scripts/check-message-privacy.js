// mobile/scripts/check-message-privacy.js
"use strict";

/**
 * A phone shows each person only their own conversations, and tells a pupil
 * why a message was not sent.
 *
 * Reported 2026-10-24: signed in as a student, a tester saw threads between an
 * administrator and parents. The server never sent them to the student. An
 * admin had used the phone earlier; the one schoolapp.db kept their threads,
 * the inbox read every stored row, and nothing cleared them at sign-out. And a
 * refused message showed only "Not sent — tap to retry", with axios's
 * "Request failed with status code 403" kept as the reason.
 *
 * Runs the real message.service and outbox over a real SQLite (node:sqlite)
 * with a fake server, and asserts:
 *
 *   reads      the inbox, a thread, its header and the badge show only threads
 *              the signed-in person is a participant in
 *   cleanup    a sync deletes stored threads that are not theirs, and threads
 *              the server's full list no longer contains; a thread the server
 *              answers 404 for is deleted; sign-out empties the store
 *   wiring     sign-in and sign-out clear other accounts' messages and the
 *              guardian portal session
 *   failure    a refused send keeps the server's reason, and the bubble shows it
 *
 *   node scripts/check-message-privacy.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  withTransactionAsync: async (fn) => { await fn(); },
});

const makeLoader = (stubs, pkgStubs) => {
  const cache = new Map();
  const load = (abs) => {
    if (stubs.has(abs)) return stubs.get(abs);
    if (cache.has(abs)) return cache.get(abs).exports;
    const file = fs.existsSync(abs) ? abs : `${abs}.js`;
    const { code } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(abs, mod);
    const dir = path.dirname(file);
    const req = (id) => {
      if (id.startsWith(".")) return load(path.resolve(dir, id).replace(/\.js$/, ""));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel).replace(/\.js$/, ""));
};

(async () => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  // Who is signed in, changed between blocks.
  let signedIn = { _id: "u-admin", role: "school_admin", schoolId: "sch" };

  const httpError = (status, data) => { const e = new Error(`Request failed with status code ${status}`); e.response = { status, data }; return e; };
  const server = { conversations: [], threads: new Map(), refuse: null };
  const fakeApi = {
    get: async (url) => {
      if (url === "/messages/conversations") return { data: { conversations: server.conversations } };
      const m = url.match(/^\/messages\/conversations\/([^/]+)\/messages$/);
      if (m) {
        if (!server.threads.has(m[1])) throw httpError(404, { success: false, error: "Conversation not found" });
        return { data: { messages: server.threads.get(m[1]), participantReads: [] } };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    request: async ({ url }) => {
      if (server.refuse) throw httpError(403, { success: false, error: server.refuse });
      return { status: 201, data: { success: true, message: { _id: "srv", seq: 9 } } };
    },
    post: async () => ({ data: {} }),
  };

  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"),  { getDatabase: async () => db }],
    [path.join(MOBILE, "src/db/dbService"), { DB: { query: async (sql, p = []) => raw.prepare(sql).all(...(p ?? [])), queryFirst: async (sql, p = []) => raw.prepare(sql).get(...(p ?? [])) ?? null } }],
    [path.join(MOBILE, "src/services/api"), { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
    [path.join(MOBILE, "src/services/content.service"), { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
    [path.join(MOBILE, "src/utils/authHelpers"), {
      isAuthenticated: () => true,
      getCurrentAuth:  () => ({ user: signedIn, token: "t", role: signedIn?.role, schoolId: "sch" }),
    }],
  ]);
  const pkgStubs = new Map([
    ["react-native-get-random-values", {}],
    ["@react-native-community/netinfo", { __esModule: true, default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) } }],
  ]);
  const load = makeLoader(stubs, pkgStubs);
  const svc  = load("src/services/message.service.js");
  const { MutationQueue } = load("src/services/mutationQueue.service.js");
  svc.registerMessageReconcilers();

  const conv = (id, ids, extra = {}) => ({
    _id: id, schoolId: "sch", kind: "direct", title: null,
    participants: ids.map(([kind, pid]) => ({ kind, id: pid, lastReadSeq: 0 })),
    lastMessageAt: "2026-10-20T10:00:00Z", lastMessageSeq: 2, lastMessagePreview: "…", ...extra,
  });
  const ADMIN_PARENT = conv("c-admin-parent", [["user", "u-admin"], ["guardian", "acc-1"]]);
  const PUPIL_TEACH  = conv("c-pupil-teacher", [["user", "u-stu"], ["user", "u-teacher"]]);
  const msg = (id, seq, body) => ({ _id: id, seq, body, sender: { kind: "user", id: "u-admin" }, createdAt: "2026-10-20T10:00:00Z" });

  // ── The state a phone was left in before this fix ───────────────────────
  // The student's own thread from an earlier session, then an admin's thread
  // with a parent and its messages from the admin's. (Synced today, the
  // admin's session would already delete the student's thread: they are not
  // in it.)
  await svc.listConversations();   // creates the tables
  raw.prepare(`INSERT INTO conversations (id, school_id, kind, participants, last_message_seq, last_read_seq) VALUES ('c-pupil-teacher', 'sch', 'direct', ?, 2, 0)`)
    .run(JSON.stringify(PUPIL_TEACH.participants));
  server.conversations = [ADMIN_PARENT];
  server.threads.set("c-admin-parent", [msg("m1", 1, "Your child's fees"), msg("m2", 2, "Thank you")]);
  raw.prepare(`INSERT INTO conversations (id, school_id, kind, participants, last_message_seq, last_read_seq) VALUES ('c-admin-parent', 'sch', 'direct', ?, 2, 0)`)
    .run(JSON.stringify(ADMIN_PARENT.participants));
  for (const m of server.threads.get("c-admin-parent")) {
    raw.prepare(`INSERT INTO messages (id, conversation_id, seq, body) VALUES (?, 'c-admin-parent', ?, ?)`).run(m._id, m.seq, m.body);
  }
  const stored = () => ({
    conversations: raw.prepare("SELECT id FROM conversations ORDER BY id").all().map((r) => r.id),
    messages:      raw.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
  });
  check("setup: the admin's thread with a parent and its messages are on the phone",
    stored(), { conversations: ["c-admin-parent", "c-pupil-teacher"], messages: 2 });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a student signs in on the same phone, before any sync ---");
  signedIn = { _id: "u-stu", role: "student", schoolId: "sch" };
  check("the inbox shows only the student's own thread",
    (await svc.listConversations()).map((c) => c._id), ["c-pupil-teacher"]);
  check("the admin's thread cannot be opened from the store",
    [await svc.getConversation("c-admin-parent"), (await svc.listMessages("c-admin-parent")).length], [null, 0]);
  check("the badge counts only the student's thread", await svc.unreadTotal(), 2);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the student's first sync deletes what is not theirs ---");
  server.conversations = [PUPIL_TEACH];
  server.threads.delete("c-admin-parent");
  await svc.syncConversations({ myId: "u-stu" });
  check("the admin's thread and its messages are gone from the phone",
    stored(), { conversations: ["c-pupil-teacher"], messages: 0 });

  // A thread the student IS listed in locally, but the server no longer lists
  // (removed from a group), goes when the server's answer is the whole list.
  raw.prepare(`INSERT INTO conversations (id, school_id, kind, participants) VALUES ('c-left-group', 'sch', 'group', ?)`)
    .run(JSON.stringify([{ kind: "user", id: "u-stu" }]));
  await svc.syncConversations({ myId: "u-stu" });
  check("a thread the server no longer lists for them is deleted", stored().conversations, ["c-pupil-teacher"]);

  // A thread opened from a stale link: the server says not found.
  raw.prepare(`INSERT INTO conversations (id, school_id, kind, participants) VALUES ('c-stale', 'sch', 'direct', ?)`)
    .run(JSON.stringify([{ kind: "user", id: "u-stu" }]));
  raw.prepare(`INSERT INTO messages (id, conversation_id, seq, body) VALUES ('m-stale', 'c-stale', 1, 'old')`).run();
  const goneRes = await svc.syncMessages("c-stale", "u-stu");
  check("a thread the server answers 404 for is deleted, and the screen is told",
    [goneRes.gone, stored().conversations.includes("c-stale"), raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id='c-stale'").get().n],
    [true, false, 0]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a refused message says why ---");
  server.refuse = "This school has disabled student messages to administrators";
  const { clientId } = await svc.sendMessage({ conversationId: "c-pupil-teacher", body: "Hello sir", sender: { kind: "user", id: "u-stu" } })
    .then((r) => ({ clientId: r?.clientId ?? r?._id ?? r?.message?._id ?? null }));
  await MutationQueue.drain({ limit: 100, includeUploads: false });
  const bubble = raw.prepare("SELECT state, error FROM messages WHERE body = 'Hello sir'").get();
  check("the bubble is failed with the server's reason, not 'status code 403'",
    [bubble?.state, bubble?.error], ["failed", "This school has disabled student messages to administrators"]);
  void clientId;

  const thread = fs.readFileSync(path.join(MOBILE, "app/messages/[id].js"), "utf8");
  check("the thread screen shows the reason under a failed message", /item\.error && <Text style=\{s\.failedReason\}>\{item\.error\}/.test(thread), true);
  check("and says a thread is unavailable instead of showing it empty", /msgMobile\.unavailable/.test(thread) && /res\?\.gone/.test(thread), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- sign-in and sign-out clear other people's messages ---");
  await svc.purgeNotMine("u-teacher");
  check("signing in as another person keeps only their threads", stored().conversations, ["c-pupil-teacher"]);
  await svc.purgeNotMine("u-bursar");
  check("and a person in none of them keeps nothing", stored(), { conversations: [], messages: 0 });
  raw.prepare(`INSERT INTO conversations (id, participants) VALUES ('c-x', ?)`).run(JSON.stringify([{ kind: "user", id: "u-stu" }]));
  await svc.clearLocalMessages();
  check("signing out empties the store", stored(), { conversations: [], messages: 0 });

  const authSrc = fs.readFileSync(path.join(MOBILE, "src/store/auth.store.js"), "utf8");
  const loginEnd = authSrc.indexOf("forgetOtherPeoplesMessages(String(user?.id");
  check("login, online or offline, purges other accounts' threads before the session is set",
    loginEnd > 0 && loginEnd < authSrc.indexOf("refreshTokenValue: refreshToken || null"), true);
  check("logout clears every thread", /await get\(\)\._clearStorage\(\);[\s\S]{0,200}forgetOtherPeoplesMessages\(null\)/.test(authSrc), true);
  check("and both sign out a guardian portal session left on the phone",
    /portal\.hasSession\(\)\) await portal\.signOut\(\)/.test(authSrc), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("\nHarness error:", err); process.exit(1); });
