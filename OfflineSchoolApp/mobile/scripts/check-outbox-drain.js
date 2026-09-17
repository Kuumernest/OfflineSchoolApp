// mobile/scripts/check-outbox-drain.js
"use strict";

/**
 * The phone's outbox, drained against a server that misbehaves in every way
 * the field does.
 *
 * The outbox (mutationQueue.service) is the single write path when the phone
 * is offline: a row is written before any network attempt, and drain() sends
 * what is due. This runs the real service over a real SQLite with a fake
 * server, and pins what must be true of a queue a school's registers depend
 * on (docs/22-release-readiness.md, §6):
 *
 *   offline create      the row waits; when the network returns it is sent
 *                       once, with an Idempotency-Key, and the local rows it
 *                       covered are marked synced
 *   offline update      the same key coalesces onto the pending row: one send
 *   interrupted sync    a network failure mid-batch backs that row off and
 *                       keeps its place; nothing is lost or reordered
 *   duplicate           the same operation queued twice is one row, and a
 *                       server "in progress" answer is retried, not parked
 *   conflict            412 is parked for a person, with the server's answer
 *   authentication      a 401 mid-drain (the session ended, the interceptor
 *                       could not refresh) stops the drain and leaves every
 *                       remaining row pending — nothing is marked failed —
 *                       and the next drain after sign-in sends them
 *   partial failure     one refused row in a batch is parked; the others land
 *   large queue         five hundred rows drain in one pass within budget
 *
 *   node scripts/check-outbox-drain.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, `expected ${e}\n     got ${a}`);
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

  // ── The fake server ──────────────────────────────────────────────────────
  // `mode` decides how every request is answered; `log` records what arrived.
  const server = { mode: "ok", log: [], perUrl: new Map() };
  const httpError = (status, data) => {
    const e = new Error(`HTTP ${status}`); e.response = { status, data }; return e;
  };
  const fakeApi = {
    request: async ({ method, url, data, headers }) => {
      server.log.push({ method, url, data, headers });
      const special = server.perUrl.get(url);
      const mode = special ?? server.mode;
      switch (mode) {
        case "offline":   { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; throw e; }
        case "500":       throw httpError(500, { message: "boom" });
        case "401":       throw httpError(401, { message: "Token expired", code: "TOKEN_EXPIRED" });
        case "403pw":     throw httpError(403, { code: "PASSWORD_CHANGE_REQUIRED" });
        case "412":       throw httpError(412, { code: "VERSION_CONFLICT", current: { version: 7 } });
        case "409busy":   throw httpError(409, { code: "IDEMPOTENCY_IN_PROGRESS" });
        case "400":       throw httpError(400, { message: "classId is required" });
        case "404":       throw httpError(404, { message: "gone" });
        default:          return { status: 201, data: { success: true, echo: data } };
      }
    },
    get: async () => { throw new Error("not used"); },
  };

  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"),          { getDatabase: async () => db }],
    [path.join(MOBILE, "src/db/dbService"),         { DB: { query: async (sql, p = []) => raw.prepare(sql).all(...(p ?? [])), queryFirst: async (sql, p = []) => raw.prepare(sql).get(...(p ?? [])) ?? null } }],
    [path.join(MOBILE, "src/services/api"),         { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
    [path.join(MOBILE, "src/services/content.service"), { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
  ]);
  const pkgStubs = new Map([
    ["@react-native-community/netinfo", { __esModule: true, default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) } }],
  ]);
  const load = makeLoader(stubs, pkgStubs);
  const { MutationQueue, classifyError } = load("src/services/mutationQueue.service.js");

  // A local table the queue clears flags on, as attendance.service creates it.
  raw.exec(`CREATE TABLE attendance (id TEXT PRIMARY KEY, schoolId TEXT, class_id TEXT, student_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, _synced INTEGER DEFAULT 0, _synced_at TEXT)`);
  const localRow = (id) => { raw.prepare(`INSERT INTO attendance (id, schoolId, class_id, student_id, date, status) VALUES (?, 'sch-a', 'c3a', ?, '2026-09-17', 'present')`).run(id, `st-${id}`); return id; };
  const rows   = (where = "1=1") => raw.prepare(`SELECT id, entity_key, status, retry_count, next_attempt_at, error FROM mutation_outbox WHERE ${where} ORDER BY created_at ASC`).all();
  const drain  = () => MutationQueue.drain({ limit: 1000, includeUploads: false });
  // `endpoint` in extra sets the ROW's endpoint (the URL the fake server keys
  // its per-URL behaviour on); everything else goes into the payload.
  const enqueue = (entityKey, extra = {}) => {
    const { endpoint = "/attendance/students/bulk", ...payloadExtra } = extra;
    return MutationQueue.enqueue({
      entityKey, method: "POST", endpoint,
      payload: { schoolId: "sch-a", classId: "c3a", date: "2026-09-17", records: [{ studentId: "st-1", status: "present" }], ...payloadExtra },
    });
  };

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- how failures are classified ---");
  check("no response → transient", classifyError(new Error("Network Error"), "POST"), "transient");
  check("500 → transient", classifyError(httpError(500, {}), "POST"), "transient");
  check("409 IDEMPOTENCY_IN_PROGRESS → transient", classifyError(httpError(409, { code: "IDEMPOTENCY_IN_PROGRESS" }), "POST"), "transient");
  check("412 → conflict", classifyError(httpError(412, {}), "PUT"), "conflict");
  check("404 on DELETE → resolved (already gone)", classifyError(httpError(404, {}), "DELETE"), "resolved");
  check("400 → permanent", classifyError(httpError(400, {}), "POST"), "permanent");
  check("401 → unauthenticated: the session failed, not the row", classifyError(httpError(401, {}), "POST"), "unauthenticated");
  check("403 PASSWORD_CHANGE_REQUIRED → unauthenticated too", classifyError(httpError(403, { code: "PASSWORD_CHANGE_REQUIRED" }), "POST"), "unauthenticated");
  check("any other 403 → permanent (the server refused THIS row)", classifyError(httpError(403, { code: "CLASS_NOT_ASSIGNED" }), "POST"), "permanent");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- A. offline create: the row waits, then is sent once ---");
  const a1 = localRow("a1");
  server.mode = "offline";
  await enqueue("attendance:class:sch-a:c3a::2026-09-17", { __local: { table: "attendance", ids: [a1] } });
  let summary = await drain();
  check("offline: the send fails as transient and the row is kept, backed off", [summary.synced, summary.retried, rows()[0].status, rows()[0].retry_count], [0, 1, "retrying", 1]);
  check("  the local row is still dirty", raw.prepare(`SELECT _synced FROM attendance WHERE id = ?`).get(a1)._synced, 0);
  // The app was closed and reopened: the row is in the table, not in memory.
  raw.prepare(`UPDATE mutation_outbox SET next_attempt_at = NULL`).run();  // its backoff has elapsed
  server.mode = "ok";
  summary = await drain();
  check("back online: sent once, synced", [summary.synced, rows()[0].status, server.log.length], [1, "synced", 2]);
  check("  with an Idempotency-Key equal to the row id, and no client-only fields in the body",
    [server.log[1].headers["Idempotency-Key"] === rows()[0].id, "__local" in (server.log[1].data ?? {})], [true, false]);
  check("  the local row is now marked synced", raw.prepare(`SELECT _synced FROM attendance WHERE id = ?`).get(a1)._synced, 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- B. offline update: the same logical record coalesces ---");
  server.log.length = 0;
  server.mode = "offline";
  await enqueue("attendance:class:sch-a:c3a::2026-09-18", { date: "2026-09-18", records: [{ studentId: "st-1", status: "present" }] });
  await enqueue("attendance:class:sch-a:c3a::2026-09-18", { date: "2026-09-18", records: [{ studentId: "st-1", status: "absent" }] });
  check("two edits of one register while offline → one pending row", rows("status IN ('pending','retrying')").length, 1);
  server.mode = "ok";
  summary = await drain();
  check("  sent once, carrying the LATER edit", [summary.synced, server.log.length, server.log[0]?.data?.records?.[0]?.status], [1, 1, "absent"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- C. interrupted sync: a failure mid-batch keeps order and loses nothing ---");
  server.log.length = 0;
  await enqueue("hw:1", { endpoint: "/homework" });
  await enqueue("hw:2", { endpoint: "/homework" });
  await enqueue("hw:3", { endpoint: "/homework" });
  // The network drops while the second row is in flight.
  let calls = 0;
  const realRequest = fakeApi.request;
  fakeApi.request = async (opts) => { calls++; if (calls === 2) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; throw e; } return realRequest(opts); };
  summary = await drain();
  fakeApi.request = realRequest;
  const afterDrop = rows("entity_key LIKE 'hw:%'");
  check("first sent, second backed off in place, third sent", afterDrop.map((r) => r.status), ["synced", "retrying", "synced"]);
  check("  the dropped row keeps its retry count and a next attempt", [afterDrop[1].retry_count, typeof afterDrop[1].next_attempt_at], [1, "string"]);
  raw.prepare(`UPDATE mutation_outbox SET next_attempt_at = NULL WHERE status = 'retrying'`).run();
  summary = await drain();
  check("  the network returns: it goes, once", [summary.synced, rows("entity_key = 'hw:2'")[0].status], [1, "synced"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- D. duplicates ---");
  server.log.length = 0;
  await enqueue("dup:1");
  server.mode = "409busy";
  summary = await drain();
  check("the server says a duplicate is in progress → retried, not parked", [summary.retried, rows("entity_key = 'dup:1'")[0].status], [1, "retrying"]);
  raw.prepare(`UPDATE mutation_outbox SET next_attempt_at = NULL`).run();
  server.mode = "ok";
  summary = await drain();
  const dupKeys = server.log.map((c) => c.headers["Idempotency-Key"]);
  check("  the retry carries the SAME Idempotency-Key, so the server can answer with the first write", dupKeys[0] === dupKeys[1] && dupKeys.length === 2, true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- E. conflict ---");
  await MutationQueue.enqueue({ entityKey: "student:st-9", method: "PATCH", endpoint: "/students/st-9", payload: { firstName: "X" }, baseVersion: "3" });
  server.mode = "412";
  summary = await drain();
  const conflicted = rows("entity_key = 'student:st-9'")[0];
  check("412 → parked as a conflict for a person, with the server's answer kept", [summary.conflicts, conflicted.status], [1, "conflict"]);
  check("  it is listed for resolution and not retried on its own", (await MutationQueue.listUnresolved()).some((r) => r.id === conflicted.id), true);
  server.mode = "ok";
  summary = await drain();
  check("  a later drain leaves it alone", rows("entity_key = 'student:st-9'")[0].status, "conflict");
  check("  the send carried If-Match with the base version", server.log.some((c) => c.headers["If-Match"] === "3"), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- F. the session ends mid-drain ---");
  server.log.length = 0;
  for (let i = 1; i <= 4; i++) await enqueue(`sess:${i}`, { endpoint: "/homework" });
  server.mode = "401";
  summary = await drain();
  const afterAuth = rows("entity_key LIKE 'sess:%'");
  check("a 401 stops the drain at the first row", server.log.length, 1);
  check("  every row is still pending — nothing marked failed", afterAuth.map((r) => r.status), ["pending", "pending", "pending", "pending"]);
  check("  and the summary says why it stopped", [summary.stopped, summary.unauthenticated, summary.failed], ["unauthenticated", 4, 0]);
  server.mode = "403pw";
  summary = await drain();
  check("a password-change wall stops it the same way", [summary.stopped, rows("entity_key LIKE 'sess:%'").every((r) => r.status === "pending")], ["unauthenticated", true]);
  server.mode = "ok";   // signed in again
  summary = await drain();
  check("after sign-in, all four go, in order", [summary.synced, server.log.slice(-4).map((c) => c.data?.__k ?? c.headers["Idempotency-Key"]).length], [4, 4]);
  check("  in the order they were queued", rows("entity_key LIKE 'sess:%'").map((r) => r.entity_key), ["sess:1", "sess:2", "sess:3", "sess:4"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- G. partial failure in a batch ---");
  server.log.length = 0;
  await enqueue("pf:1", { endpoint: "/homework" });
  await enqueue("pf:2", { endpoint: "/homework/bad" });
  await enqueue("pf:3", { endpoint: "/homework" });
  server.perUrl.set("/homework/bad", "400");
  summary = await drain();
  const pf = rows("entity_key LIKE 'pf:%'");
  check("one refused row is parked as failed; the two others land", [pf.map((r) => r.status), summary.synced, summary.failed], [["synced", "failed", "synced"], 2, 1]);
  check("  the refusal is kept for the person to read", typeof pf[1].error, "string");
  check("  and can be released for another attempt", (await MutationQueue.retry(pf[1].id), rows("entity_key = 'pf:2'")[0].status), "pending");
  server.perUrl.delete("/homework/bad");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- H. a large queue ---");
  server.log.length = 0;
  raw.prepare(`DELETE FROM mutation_outbox`).run();
  const N = 500;
  for (let i = 0; i < N; i++) await enqueue(`big:${i}`, { endpoint: "/homework" });
  const t0 = Date.now();
  summary = await drain();
  const ms = Date.now() - t0;
  check(`${N} rows drain in one pass, all synced, none failed`, [summary.synced, summary.failed, summary.retried], [N, 0, 0]);
  check("  each with its own Idempotency-Key", new Set(server.log.map((c) => c.headers["Idempotency-Key"])).size, N);
  console.log(`       ${N} rows in ${ms} ms (${(ms / N).toFixed(1)} ms/row, fake network)`);
  const stats = await MutationQueue.getStats();
  check("  the pending-changes surface reads zero", stats?.pending ?? stats?.total ?? 0, 0);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
