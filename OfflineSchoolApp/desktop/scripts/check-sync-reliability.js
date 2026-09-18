// desktop/scripts/check-sync-reliability.js
"use strict";
/**
 * Does the desktop lose, duplicate or misroute a queued request?
 *
 * The outbox replays the exact HTTP requests the UI made, oldest first, and
 * stops at anything the server refuses. This runs the real store, outbox,
 * client and engine against a fake server that keeps an idempotency memory
 * per (account, key) — as backend/middleware/idempotency.js does — and that
 * can be told to commit and then drop the connection, fail with 5xx for a
 * while, or refuse a path outright.
 *
 * Each scenario asks where the queued request ends up: sent once, preserved
 * for retry, preserved for a person, or gone.
 *
 *   node scripts/check-sync-reliability.js
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");

const store      = require("../src/main/db/store");
const { outbox } = require("../src/main/db/outbox");
const { client } = require("../src/main/sync/client");
const { engine } = require("../src/main/sync/engine");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-reliability-"));
const file = path.join(dir, "school.db");

// ── A server with an idempotency memory that can misbehave ──────────────────
const fakeServer = () => {
  const st = {
    seen:    [],                 // { method, path, token, key, body }
    memory:  new Map(),          // `${token}:${key}` -> { status, body }
    applies: new Map(),          // path -> count of real applications
    rule:    new Map(),          // path -> { status, body, times } | "commit-drop"
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url   = new URL(req.url, "http://localhost");
      const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
      const key   = req.headers["idempotency-key"] ?? null;
      const send  = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (url.pathname === "/api/sync/changes") return send(200, { success: true, serverTime: new Date().toISOString(), collections: {}, refused: [] });
      st.seen.push({ method: req.method, path: url.pathname, token, key, body: body ? JSON.parse(body) : null });
      const memo = st.memory.get(`${token}:${key}`);
      if (memo) return send(memo.status, memo.body);
      const rule = st.rule.get(url.pathname);
      if (rule && typeof rule === "object") {
        if (rule.status >= 500) { rule.times -= 1; if (rule.times <= 0) st.rule.delete(url.pathname); }
        return send(rule.status, rule.body ?? { message: "refused" });
      }
      st.applies.set(url.pathname, (st.applies.get(url.pathname) ?? 0) + 1);
      const parsed = body ? JSON.parse(body) : {};
      const answer = { status: 201, body: { success: true, data: { ...parsed, _id: parsed._id ?? `srv-${st.applies.get(url.pathname)}` } } };
      if (key) st.memory.set(`${token}:${key}`, answer);
      if (rule === "commit-drop") { st.rule.delete(url.pathname); return req.socket.destroy(); }
      return send(answer.status, answer.body);
    });
  });
  return { st, server };
};

const main = async () => {
  const { st, server } = fakeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const db    = store.open(file);
  const docs  = store.documents(db);
  const queue = outbox(db);
  const state = store.state(db);
  const meta  = store.meta(db);
  const api   = client({ meta });
  api.setServerUrl(`http://127.0.0.1:${port}`);

  // Who is signed in on this machine, switchable — the engine asks each cycle.
  const session = { userId: "user-a", token: "token-a" };
  api.setToken(session.token);
  const eng = engine({ docs, queue, state, client: api, feedCollections: [], currentUser: () => session.userId });

  const dueNow = () => db.prepare("UPDATE outbox SET next_try_at = ? WHERE status = 'pending'").run(new Date(0).toISOString());
  const add = (path, body, extra = {}) => queue.add({ method: "POST", path, body, userId: session.userId, ...extra });
  const statusOf = (seq) => queue.all().find((r) => r.seq === seq)?.status ?? "gone";

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. the server commits, the connection drops, the retry is answered from memory ---");
  st.rule.set("/api/fees/payments", "commit-drop");
  const { seq: lost } = add("/api/fees/payments", { studentId: "s1", amount: 30000 });
  await eng.cycle();
  check("the request is kept for retry with one attempt counted", queue.all().filter((r) => r.seq === lost).map((r) => [r.status, r.attempts]), [["pending", 1]]);
  check("  the server had applied it once already", st.applies.get("/api/fees/payments"), 1);
  dueNow();
  await eng.cycle();
  check("the retry reused the key, was answered from memory, and the request left the queue", [st.applies.get("/api/fees/payments"), statusOf(lost)], [1, "gone"]);
  check("  one Idempotency-Key across both attempts", new Set(st.seen.filter((s) => s.path === "/api/fees/payments").map((s) => s.key)).size, 1);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. another account on the same machine does not send the first account's requests ---");
  api.setToken(null);                                             // offline: nothing goes out
  const { seq: a1 } = add("/api/attendance/students", { studentId: "s1", status: "present" });
  const { seq: a2 } = add("/api/attendance/students", { studentId: "s2", status: "late" });
  session.userId = "user-b"; session.token = "token-b";           // B signs in
  api.setToken(session.token);
  st.seen.length = 0;
  await eng.cycle();
  check("signed in as B: A's requests are held, nothing sent with B's token", [st.seen.length, statusOf(a1), statusOf(a2)], [0, "pending", "pending"]);
  const { seq: b1 } = add("/api/attendance/students", { studentId: "s9", status: "present" });
  await eng.cycle();
  check("B's own request goes out while A's wait", [st.seen.map((s) => s.token), statusOf(b1), statusOf(a1)], [["token-b"], "gone", "pending"]);
  session.userId = "user-a"; session.token = "token-a";           // A signs back in
  api.setToken(session.token);
  st.seen.length = 0;
  await eng.cycle();
  check("A signs back in: A's requests go out with A's token, in order", [st.seen.map((s) => [s.token, s.body.studentId]), statusOf(a1), statusOf(a2)], [[["token-a", "s1"], ["token-a", "s2"]], "gone", "gone"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2b. a request queued before migration 4 is held under every account ---");
  //
  // OWNERLESS QUEUED MUTATIONS MUST NEVER BE EXECUTED UNDER A DIFFERENT ACCOUNT.
  db.prepare(`INSERT INTO outbox (idem_key, method, path, body, created_at, next_try_at, status, user_id)
              VALUES ('legacy-1', 'POST', '/api/attendance/students', '{"studentId":"s7","status":"present"}', ?, ?, 'pending', NULL)`)
    .run(new Date().toISOString(), new Date(0).toISOString());
  const legacySeq = queue.all().find((r) => r.idem_key === "legacy-1").seq;
  st.seen.length = 0;
  await eng.cycle();                                                   // signed in as A
  check("as A: not sent, still pending, still ownerless",
    [st.seen.filter((s) => s.body?.studentId === "s7").length, queue.all().filter((r) => r.seq === legacySeq).map((r) => [r.status, r.user_id])],
    [0, [["pending", null]]]);
  check("  the summary names it apart from pending work", queue.summary().ownerless, 1);
  api.setToken(null);                                                  // logout
  session.userId = "user-b"; session.token = "token-b"; api.setToken(session.token);   // B signs in
  await eng.cycle();
  check("as B: not sent, still pending, still ownerless",
    [st.seen.filter((s) => s.body?.studentId === "s7").length, queue.all().filter((r) => r.seq === legacySeq).map((r) => [r.status, r.user_id])],
    [0, [["pending", null]]]);
  check("  B's own line still moves past it", (add("/api/attendance/students", { studentId: "s8", status: "present" }), await eng.cycle(), st.seen.map((s) => s.body?.studentId)), ["s8"]);
  session.userId = "user-a"; session.token = "token-a"; api.setToken(session.token);
  queue.discard(legacySeq);
  check("  a person can discard it", queue.all().some((r) => r.seq === legacySeq), false);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. a malformed queue row is parked, and does not take the queue down ---");
  db.prepare(`INSERT INTO outbox (idem_key, method, path, body, created_at, next_try_at, status, user_id) VALUES ('bad-body', 'POST', '/api/exams/e1/scores', '{not json', ?, ?, 'pending', 'user-a')`)
    .run(new Date().toISOString(), new Date(0).toISOString());
  const badSeq = queue.all().find((r) => r.idem_key === "bad-body").seq;
  const { seq: behind } = add("/api/exams/e1/scores", { studentId: "s1", score: 12 });
  let threw = null;
  try { await eng.cycle(); } catch (e) { threw = e.message; }
  check("the cycle does not throw", threw, null);
  check("the malformed row is blocked with a reason a person can read", queue.all().filter((r) => r.seq === badSeq).map((r) => [r.status, /body/i.test(r.last_error || "")]), [["blocked", true]]);
  check("  the queue stops behind it, as it does for any refusal — the row after it is untouched", statusOf(behind), "pending");
  check("  and the sync screen names it", queue.summary().head?.seq, badSeq);
  queue.discard(badSeq);
  await eng.cycle();
  check("once a person discards it the queue moves again", [statusOf(behind), st.applies.get("/api/exams/e1/scores")], ["gone", 1]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. a server that is temporarily failing is retried until it recovers ---");
  st.rule.set("/api/fees/expenses", { status: 503, body: { message: "boom" }, times: 2 });
  const { seq: flaky } = add("/api/fees/expenses", { amount: 700 });
  await eng.cycle();
  check("503: pending with one attempt, not applied", [statusOf(flaky), queue.all().find((r) => r.seq === flaky).attempts, st.applies.get("/api/fees/expenses") ?? 0], ["pending", 1, 0]);
  await eng.cycle();
  check("  not retried before its backoff is due", queue.all().find((r) => r.seq === flaky).attempts, 1);
  dueNow(); await eng.cycle();
  dueNow(); await eng.cycle();
  check("  applied exactly once when the server recovers", [statusOf(flaky), st.applies.get("/api/fees/expenses")], ["gone", 1]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. a record deleted on the server before the sync: refused, kept, named ---");
  st.rule.set("/api/students/st-gone", { status: 404, body: { message: "Student not found" } });
  const { seq: gone } = add("/api/students/st-gone", { name: "Renamed" }, { method: "PUT" });
  await eng.cycle();
  check("blocked, still in the queue, with the server's reason", queue.all().filter((r) => r.seq === gone).map((r) => [r.status, r.last_status, r.last_error]), [["blocked", 404, "Student not found"]]);
  check("  reported as the stuck head of the queue", queue.summary().stuck.map((s) => s.seq), [gone]);
  queue.discard(gone);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. an expired session stops the cycle and keeps the queue ---");
  api.setToken("expired");
  st.memory.clear();
  const { seq: held } = add("/api/attendance/teachers", { teacherId: "t1", status: "present" });
  // The fake answers 401 for a token it does not know, like the real one.
  st.rule.set("/api/attendance/teachers", { status: 401, body: { message: "jwt expired" } });
  await eng.cycle();
  check("401: the cycle stops as unauthenticated and the request stays pending, unattempted",
    [eng.status().phase, queue.all().filter((r) => r.seq === held).map((r) => [r.status, r.attempts])], ["unauthenticated", [["pending", 0]]]);
  st.rule.delete("/api/attendance/teachers");
  api.setToken(session.token);
  await eng.cycle();
  check("  with a token again it goes out", statusOf(held), "gone");

  console.log(`\n${pass} passed, ${fail} failed`);
  // Close the database and the server, then let the process drain on its
  // own: forcing process.exit() while fetch is still closing its kept-alive
  // sockets trips a libuv assertion on Windows and turns a green run red.
  db.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
  process.exitCode = fail ? 1 : 0;
};

main().catch((e) => { console.error(e); process.exit(1); });
