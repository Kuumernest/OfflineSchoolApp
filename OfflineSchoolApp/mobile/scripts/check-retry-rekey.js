// mobile/scripts/check-retry-rekey.js
"use strict";

/**
 * Retrying on the phone: refused changes get a new key; uploads carry one and
 * never stay stuck.
 *
 *   - MutationQueue.retry / retryAllFailed: a row the server REFUSED (4xx)
 *     goes out under a new Idempotency-Key — the server replays a stored
 *     refusal for the old key for 14 days, so it was never looked at again.
 *     A row that failed for want of an answer keeps its key.
 *   - Content uploads send Idempotency-Key (they sent none: a timeout after the
 *     server stored the file meant a second copy), re-key the same way on
 *     retry, and an upload cut off mid-send (left 'uploading') is queued again
 *     instead of stuck for good.
 *
 * The real services and table setup over a real SQLite (node:sqlite); the
 * network is a stub that records what was sent.
 *
 *   node scripts/check-retry-rekey.js
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
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  withTransactionAsync: async (fn) => { await fn(); },
  closeAsync:    async () => {},
});

const makeLoader = (pkgStubs, relStubs) => {
  const cache = new Map();
  const load = (abs) => {
    const key = abs.replace(/\.js$/, "");
    for (const [rel, stub] of relStubs) if (key.endsWith(rel)) return stub;
    if (cache.has(key)) return cache.get(key).exports;
    const file = fs.existsSync(`${key}.js`) ? `${key}.js` : `${key}/index.js`;
    const { code } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller: { name: "check", supportsStaticESM: false }, babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(key, mod);
    const dir = path.dirname(file);
    const req = (id) => {
      if (id.startsWith(".")) return load(path.resolve(dir, id));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel));
};

(async () => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);
  const sent = [];
  let answer = () => ({ status: 200, data: { success: true } });
  const api = {
    request: async (config) => { sent.push({ url: config.url, key: config.headers?.["Idempotency-Key"] }); return answer(config); },
    post:    async (url, data, config) => { sent.push({ url, key: config?.headers?.["Idempotency-Key"] }); return answer({ url }); },
  };
  const noop = () => {};
  const load = makeLoader(new Map([
    ["expo-sqlite", { openDatabaseAsync: async () => db, openDatabaseSync: () => db }],
    ["expo-secure-store", { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }],
    ["@react-native-community/netinfo", { default: { fetch: async () => ({ isConnected: true }) }, fetch: async () => ({ isConnected: true }), addEventListener: () => noop }],
    ["react-native", { AppState: { addEventListener: () => ({ remove: noop }) }, Platform: { OS: "android" } }],
  ]), new Map([
    ["src/services/api", { default: api, ...api }],
    ["src/utils/authHelpers", { getCurrentAuth: () => ({ user: { _id: "u1" } }), isAuthenticated: () => true, hasRole: () => true, hasPermission: () => true }],
  ]));
  const { getDatabase } = load("src/db/database");
  await getDatabase();
  const { MutationQueue } = load("src/services/mutationQueue.service");
  const content = load("src/services/content.service");
  const q = (sql, p = []) => raw.prepare(sql).all(...p);

  // ═══ the outbox ═══
  console.log("--- the outbox ---");
  const add = (id, status, lastStatus) => raw.prepare(
    `INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, owner_id, last_status)
     VALUES (?, ?, 'POST', '/admin/classes', '{}', ?, 3, ?, 'u1', ?)`
  ).run(id, `class:${id}`, status, new Date().toISOString(), lastStatus);
  // Created by the schema setup on first use.
  await MutationQueue.retry("nothing-yet");
  add("refused", "failed", 403);
  add("conflicted", "conflict", 409);
  add("no-answer", "failed", null);
  await MutationQueue.retry("refused");
  let rows = Object.fromEntries(q("SELECT id, status, idem_key, last_status FROM mutation_outbox").map((r) => [r.id, r]));
  check("retrying a refused row (403): pending again, under a new key, its refusal cleared",
    [rows.refused.status, Boolean(rows.refused.idem_key) && rows.refused.idem_key !== "refused", rows.refused.last_status], ["pending", true, null]);
  const n = await MutationQueue.retryAllFailed();
  rows = Object.fromEntries(q("SELECT id, status, idem_key FROM mutation_outbox").map((r) => [r.id, r]));
  check("retry all: the conflicted (409) row re-keyed too; the unanswered one keeps the row id as its key",
    [n, Boolean(rows.conflicted.idem_key), rows["no-answer"].idem_key], [2, true, null]);

  sent.length = 0;
  await MutationQueue.processPending();
  const keyOf = (id) => sent.find((s) => s.key === (rows[id].idem_key || id))?.key;
  check("sending them: each under its own key — the new one where re-keyed, the row id otherwise",
    [keyOf("refused") === rows.refused.idem_key, keyOf("conflicted") === rows.conflicted.idem_key, keyOf("no-answer")],
    [true, true, "no-answer"]);

  // ═══ uploads ═══
  console.log("--- uploads ---");
  await content.getPendingUploads();   // creates the table
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const up = (id, status, updatedMsAgo, extra = {}) => raw.prepare(
    `INSERT INTO upload_queue (id, type, status, attempts, max_attempts, payload, created_at, updated_at${extra.last_status != null ? ", last_status" : ""})
     VALUES (?, 'content', ?, ?, 5, ?, ?, ?${extra.last_status != null ? ", ?" : ""})`
  ).run(id, status, extra.attempts ?? 1, JSON.stringify({ title: `T ${id}`, subjectId: "s1", classId: "c1", contentType: "link", url: "https://x" }),
        iso(updatedMsAgo), iso(updatedMsAgo), ...(extra.last_status != null ? [extra.last_status] : []));
  up("cut-off", "uploading", 30 * 60 * 1000);      // the app died mid-send half an hour ago
  up("in-flight", "uploading", 30 * 1000);         // being sent right now
  const pending = await content.getPendingUploads();
  check("an upload cut off mid-send is queued again; one still being sent is left alone",
    [pending.some((p) => p.id === "cut-off"), q("SELECT status FROM upload_queue WHERE id = 'in-flight'")[0].status],
    [true, "uploading"]);

  sent.length = 0;
  await content.processPendingUploads();
  check("an upload goes out with Idempotency-Key = its row id",
    sent.find((s) => s.url === "/teacher/content")?.key, "cut-off");

  up("refused-up", "failed", 60 * 1000, { attempts: 5, last_status: 400 });
  up("timeout-up", "failed", 60 * 1000, { attempts: 5 });
  await content.retryFailedUpload("refused-up");
  await content.retryFailedUpload("timeout-up");
  const u = Object.fromEntries(q("SELECT id, status, idem_key FROM upload_queue").map((r) => [r.id, r]));
  check("retrying a refused upload re-keys it; one that timed out keeps its key",
    [u["refused-up"].status, Boolean(u["refused-up"].idem_key), u["timeout-up"].status, u["timeout-up"].idem_key],
    ["pending", true, "pending", null]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
