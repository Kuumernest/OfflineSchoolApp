// mobile/scripts/check-sync-reliability.js
"use strict";
/**
 * Does the phone lose, duplicate or misroute a queued mutation?
 *
 * The outbox (services/mutationQueue.service) is the only path a write takes
 * off the device. This runs its real code over a real SQLite against a fake
 * server that behaves like the real one where it matters — it remembers every
 * Idempotency-Key and answers a repeat from memory rather than acting twice —
 * and that can be told to misbehave: drop a response after committing, fail
 * with 5xx for a while, refuse a stale id, lose a record.
 *
 * What is asked, scenario by scenario, is where each queued row ends up:
 * reconciled, preserved for retry, preserved for a person, or gone. Gone is
 * the only unacceptable answer.
 *
 *   node scripts/check-sync-reliability.js
 */
const path  = require("path");
const fs    = require("fs");
const os    = require("os");
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

/** expo-sqlite's async surface, over a real synchronous SQLite. */
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
  // The database lives in a file so the "phone restarted" scenario can close
  // and reopen it, as the app does.
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-outbox-"));
  const file = path.join(dir, "phone.db");
  let raw = new DatabaseSync(file);
  let db  = adapt(raw);

  // Who is signed in, switchable mid-run.
  const auth = { user: { _id: "teacher-a", role: "teacher", schoolId: "sch-a" } };

  // ── The fake server ──────────────────────────────────────────────────────
  //
  // Idempotent, like the real one: a key it has answered before is answered
  // again from memory. `state` is what it holds per URL (the last payload it
  // applied); `applies` counts real applications; `mode` per URL says how the
  // next request there is treated.
  const server = { log: [], keys: new Map(), state: new Map(), applies: new Map(), mode: new Map(), default: "ok" };
  const httpError = (status, data) => { const e = new Error(`HTTP ${status}`); e.response = { status, data }; return e; };
  const netError  = () => { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; return e; };
  const fakeApi = {
    request: async ({ method, url, data, headers }) => {
      server.log.push({ method, url, data, headers, user: auth.user?._id ?? null });
      if (!url) throw httpError(404, { message: "no such route" });
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(String(method).toUpperCase())) throw netError();
      const key = `${auth.user?._id}:${headers?.["Idempotency-Key"]}`;
      if (server.keys.has(key)) return server.keys.get(key);
      const mode = server.mode.get(url) ?? server.default;
      if (mode === "offline") throw netError();
      if (typeof mode === "object" && mode.status >= 500) {
        mode.times -= 1;
        if (mode.times <= 0) server.mode.delete(url);
        throw httpError(mode.status, { message: "boom" });
      }
      if (typeof mode === "object") throw httpError(mode.status, mode.body ?? { message: "refused" });
      // Applied.
      server.applies.set(url, (server.applies.get(url) ?? 0) + 1);
      server.state.set(url, data);
      const response = { status: 201, data: { success: true, echo: data } };
      server.keys.set(key, response);
      if (mode === "commit-drop") { server.mode.delete(url); throw netError(); }
      return response;
    },
    get: async () => { throw new Error("not used"); },
  };

  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"),  { getDatabase: async () => db }],
    [path.join(MOBILE, "src/db/dbService"), { DB: { query: async (sql, p = []) => raw.prepare(sql).all(...(p ?? [])), queryFirst: async (sql, p = []) => raw.prepare(sql).get(...(p ?? [])) ?? null } }],
    [path.join(MOBILE, "src/services/api"), { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
    [path.join(MOBILE, "src/services/content.service"), { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
    [path.join(MOBILE, "src/utils/authHelpers"), {
      isAuthenticated: () => Boolean(auth.user),
      getCurrentAuth:  () => ({ user: auth.user, token: auth.user ? "t" : null, role: auth.user?.role ?? null, schoolId: auth.user?.schoolId ?? null }),
    }],
  ]);
  const pkgStubs = new Map([
    ["@react-native-community/netinfo", { __esModule: true, default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) } }],
  ]);
  const load = makeLoader(stubs, pkgStubs);
  const { MutationQueue } = load("src/services/mutationQueue.service.js");

  const rows   = (where = "1=1") => raw.prepare(`SELECT id, entity_key, status, retry_count, error FROM mutation_outbox WHERE ${where} ORDER BY created_at ASC, rowid ASC`).all();
  const drain  = () => MutationQueue.drain({ limit: 1000, includeUploads: false });
  const dueNow = () => raw.prepare("UPDATE mutation_outbox SET next_attempt_at = NULL WHERE status IN ('pending','retrying')").run();
  const sentTo = (url) => server.log.filter((c) => c.url === url);
  const enqueue = (entityKey, endpoint, payload, method = "POST") =>
    MutationQueue.enqueue({ entityKey, method, endpoint, payload });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. a queued mutation survives the phone being restarted ---");
  server.default = "offline";
  await enqueue("att:restart", "/attendance/students/bulk", { classId: "c1", records: [{ studentId: "s1", status: "present" }] });
  let r = await drain();
  check("offline: the row is kept and backs off", [r.synced, r.retried, rows("entity_key='att:restart'")[0].status], [0, 1, "retrying"]);
  raw.close();
  raw = new DatabaseSync(file);
  db  = adapt(raw);
  check("after a restart the row is still there, with its attempt counted",
    rows("entity_key='att:restart'").map((x) => [x.status, x.retry_count]), [["retrying", 1]]);
  server.default = "ok";
  dueNow();
  r = await drain();
  check("and goes out on the next connected drain, once", [r.synced, server.applies.get("/attendance/students/bulk")], [1, 1]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. draining twice sends nothing twice ---");
  await enqueue("score:dup", "/exams/e1/scores", { studentId: "s1", score: 12 });
  await drain();
  const applied = server.applies.get("/exams/e1/scores");
  await drain();
  check("a second drain finds nothing to send", [applied, server.applies.get("/exams/e1/scores"), rows("entity_key='score:dup'")[0].status], [1, 1, "synced"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the server commits, the response is lost, the phone retries ---");
  server.mode.set("/exams/e2/scores", "commit-drop");
  await enqueue("score:lost", "/exams/e2/scores", { studentId: "s1", score: 9 });
  r = await drain();
  check("the phone saw a network error and kept the row for retry", [r.retried, rows("entity_key='score:lost'")[0].status], [1, "retrying"]);
  check("  while the server had already applied it once", server.applies.get("/exams/e2/scores"), 1);
  dueNow();
  r = await drain();
  check("the retry carries the same key and is answered from memory: applied once, settled", [r.synced, server.applies.get("/exams/e2/scores"), rows("entity_key='score:lost'")[0].status], [1, 1, "synced"]);
  check("  both attempts used one Idempotency-Key", new Set(sentTo("/exams/e2/scores").map((c) => c.headers["Idempotency-Key"])).size, 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. an edit made after a lost-response attempt must not be answered with the old result ---");
  //
  // Coalescing a fresh edit onto a row that has already been sent once would
  // reuse that row's key; the server, having committed the first version,
  // would answer the retry from memory and the second version would vanish.
  server.mode.set("/exams/e3/scores", "commit-drop");
  await enqueue("score:coalesce", "/exams/e3/scores", { studentId: "s1", score: 10 });
  await drain();                                    // v1 committed, response lost
  await enqueue("score:coalesce", "/exams/e3/scores", { studentId: "s1", score: 15 });  // the teacher corrects it
  dueNow();
  r = await drain();
  check("the server ends with the correction", server.state.get("/exams/e3/scores")?.score, 15);
  check("  applied exactly twice: the first version, then the correction", server.applies.get("/exams/e3/scores"), 2);
  check("  nothing left unsent for that entity", rows("entity_key='score:coalesce' AND status != 'synced'").length, 0);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. another account on the same phone does not send the first account's work ---");
  server.default = "offline";
  await enqueue("att:owner-1", "/attendance/students", { classId: "c1", studentId: "s1", status: "present" });
  await enqueue("att:owner-2", "/attendance/students", { classId: "c1", studentId: "s2", status: "late" });
  await drain();
  server.default = "ok";
  dueNow();
  auth.user = { _id: "teacher-b", role: "teacher", schoolId: "sch-a" };   // teacher B signs in on the same phone
  server.log.length = 0;
  r = await drain();
  check("signed in as B: A's rows are held, not sent", [server.log.length, rows("entity_key LIKE 'att:owner-%' AND status = 'synced'").length], [0, 0]);
  check("  and the drain says how many it held for another account", r.heldForOtherUser, 2);
  check("  B's unsent count does not include A's work", (await MutationQueue.getStats()).unsent, 0);
  check("  and A's rows were not re-stamped as B's", raw.prepare("SELECT DISTINCT owner_id FROM mutation_outbox WHERE entity_key LIKE 'att:owner-_'").all().map((x) => x.owner_id), ["teacher-a"]);
  await enqueue("att:owner-b", "/attendance/students", { classId: "c2", studentId: "s9", status: "present" });
  r = await drain();
  check("B's own row goes out while A's still wait", [r.synced, rows("entity_key='att:owner-b'")[0].status, rows("entity_key IN ('att:owner-1','att:owner-2') AND status='synced'").length], [1, "synced", 0]);
  auth.user = { _id: "teacher-a", role: "teacher", schoolId: "sch-a" };   // A signs back in
  r = await drain();
  check("A signs back in: A's two rows go out, in order", [r.synced, server.log.filter((c) => c.user === "teacher-a").map((c) => c.data.studentId)], [2, ["s1", "s2"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5b. a row queued before ownership was recorded is held under every account ---");
  //
  // OWNERLESS QUEUED MUTATIONS MUST NEVER BE EXECUTED UNDER A DIFFERENT ACCOUNT.
  // A row with owner_id NULL was queued by an account nobody can name; it is
  // not sent by A, not sent by B, not stamped with either, and still there.
  raw.prepare(`INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, owner_id)
               VALUES ('legacy-1', 'att:legacy', 'POST', '/attendance/students', '{"classId":"c1","studentId":"s7","status":"present"}', 'pending', 0, ?, NULL)`)
    .run(new Date().toISOString());
  server.log.length = 0;
  r = await drain();                                                   // signed in as A
  check("as A: not sent, still pending, still ownerless",
    [server.log.filter((c) => c.data?.studentId === "s7").length, raw.prepare("SELECT status, owner_id FROM mutation_outbox WHERE id='legacy-1'").get()],
    [0, { status: "pending", owner_id: null }]);
  check("  the drain reports it as held ownerless", r.heldOwnerless, 1);
  check("  the badge names it apart from this account's unsent work", (await MutationQueue.getStats()).ownerless, 1);
  auth.user = null;                                                    // logout
  auth.user = { _id: "teacher-b", role: "teacher", schoolId: "sch-a" }; // B signs in
  r = await drain();
  check("as B: not sent, still pending, still ownerless",
    [server.log.filter((c) => c.data?.studentId === "s7").length, raw.prepare("SELECT status, owner_id FROM mutation_outbox WHERE id='legacy-1'").get()],
    [0, { status: "pending", owner_id: null }]);
  auth.user = { _id: "teacher-a", role: "teacher", schoolId: "sch-a" };
  check("  a person can still discard it", (await MutationQueue.discard("legacy-1"), raw.prepare("SELECT COUNT(*) AS n FROM mutation_outbox WHERE id='legacy-1'").get().n), 0);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. a server that is temporarily failing is retried until it recovers ---");
  server.mode.set("/fees/payments", { status: 503, times: 2 });
  await enqueue("pay:503", "/fees/payments", { studentId: "s1", amount: 5000 });
  r = await drain();
  check("503: kept, backing off, not applied", [r.retried, rows("entity_key='pay:503'")[0].status, server.applies.get("/fees/payments") ?? 0], [1, "retrying", 0]);
  r = await drain();
  check("  not sent again before its time (deferred, not dropped)", [r.synced + r.retried, r.deferred], [0, 1]);
  dueNow(); await drain();
  dueNow(); r = await drain();
  check("  once the server recovers it is applied exactly once", [r.synced, server.applies.get("/fees/payments"), rows("entity_key='pay:503'")[0].retry_count], [1, 1, 2]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 7. the record was deleted on the server before the phone synced ---");
  server.mode.set("/students/st-gone", { status: 404, body: { message: "Student not found" } });
  await enqueue("student:gone", "/students/st-gone", { name: "Renamed" }, "PUT");
  await enqueue("student:gone-del", "/students/st-gone", {}, "DELETE");
  r = await drain();
  check("an update to a vanished record is parked as failed, with the reason kept", rows("entity_key='student:gone'").map((x) => [x.status, x.error]), [["failed", "HTTP 404"]]);
  check("a delete of a vanished record has nothing left to do and settles", rows("entity_key='student:gone-del'")[0].status, "synced");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. a stale or foreign id is refused by the server and kept for a person ---");
  server.mode.set("/attendance/students/bulk-stale", { status: 403, body: { code: "SCHOOL_ACCESS_DENIED" } });
  await enqueue("att:stale", "/attendance/students/bulk-stale", { schoolId: "sch-b", classId: "c-other" });
  await enqueue("att:after-stale", "/attendance/students/bulk", { classId: "c1", records: [] });
  r = await drain();
  check("the refused row is failed and preserved, the row behind it still goes", [rows("entity_key='att:stale'")[0].status, rows("entity_key='att:after-stale'")[0].status], ["failed", "synced"]);
  check("  a person can release it", (await MutationQueue.retry(rows("entity_key='att:stale'")[0].id), rows("entity_key='att:stale'")[0].status), "pending");
  server.mode.delete("/attendance/students/bulk-stale");

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 9. a malformed queue row cannot take the queue down with it ---");
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, owner_id) VALUES ('bad-json', 'bad:json', 'POST', '/attendance/students/bulk-bad', 'this is not json', 'pending', 0, ?, 'teacher-a')`).run(now);
  raw.prepare(`INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, owner_id) VALUES ('bad-method', 'bad:method', 'FOO', '/attendance/students/bulk', '{}', 'pending', 7, ?, 'teacher-a')`).run(now);
  raw.prepare(`INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, owner_id) VALUES ('bad-endpoint', 'bad:endpoint', 'POST', '', '{}', 'pending', 0, ?, 'teacher-a')`).run(now);
  server.mode.set("/attendance/students/bulk-bad", { status: 400, body: { message: "records[] is required" } });
  await enqueue("att:healthy", "/attendance/students/bulk", { classId: "c1", records: [] });
  let threw = null;
  try { r = await drain(); } catch (e) { threw = e.message; }
  check("the drain does not throw", threw, null);
  check("unparseable payload: sent as nothing, refused, parked", rows("entity_key='bad:json'")[0].status, "failed");
  check("unknown method: treated as unreachable and, its budget spent, parked", rows("entity_key='bad:method'").map((x) => [x.status, x.retry_count]), [["failed", 8]]);
  check("empty endpoint: refused, parked", rows("entity_key='bad:endpoint'")[0].status, "failed");
  check("the healthy row beside them went out", rows("entity_key='att:healthy'")[0].status, "synced");
  check("nothing was silently dropped: every row is still in the table", rows("entity_key LIKE 'bad:%'").length, 3);
  for (let i = 0; i < 5; i++) { dueNow(); await drain(); }
  check("five more drains later the parked rows are still parked, not looping", rows("entity_key LIKE 'bad:%' AND status='failed'").length, 3);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 10. two hundred rows, one refusal in the middle, nothing lost or doubled ---");
  server.log.length = 0;
  for (let i = 0; i < 200; i++) {
    await enqueue(`bulk:${String(i).padStart(3, "0")}`, `/exams/bulk/${i % 20}`, { i });
  }
  server.mode.set("/exams/bulk/7", { status: 400, body: { message: "bad" } });
  r = await drain();
  check("ten rows refused, one hundred and ninety applied", [r.failed, r.synced], [10, 190]);
  check("  in the order they were queued", server.log.filter((c) => c.url.startsWith("/exams/bulk/") && c.data && typeof c.data.i === "number").map((c) => c.data.i).every((v, i, arr) => i === 0 || v > arr[i - 1]), true);
  check("  every row accounted for", rows("entity_key LIKE 'bulk:%'").length, 200);
  check("  no URL applied more than its rows", [...server.applies.entries()].filter(([u]) => u.startsWith("/exams/bulk/")).every(([, n]) => n === 10), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  raw.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
