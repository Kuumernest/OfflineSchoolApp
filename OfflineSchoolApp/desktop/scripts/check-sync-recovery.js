// desktop/scripts/check-sync-recovery.js
"use strict";
/**
 * Coming back online, giving up on a refused edit, and two edits to one record.
 *
 * Three things the desktop got wrong, each run here with the real store,
 * outbox, client and engine against a stub server on a real socket:
 *
 *   A. Reconnecting. A request that failed because the network was gone backs
 *      off up to ten minutes. When the connection returns it must go out at
 *      once — on the next cycle that reaches the server, on "Sync now", and on
 *      the connectivity monitor noticing — while a request the server REFUSED
 *      stays blocked, and a 5xx backoff is still respected.
 *
 *   B. Discarding a refused EDIT. The record existed before the edit; dropping
 *      the edit must put the server's version back, not delete the row (the
 *      cursor is already past it, so the pull would never bring it back).
 *      Discarding a refused CREATE still removes the row.
 *
 *   C. Two queued edits to one record, the first accepted and the second not
 *      yet. The record stays protected from the pull until the LAST one
 *      settles, so the screen keeps showing what was typed last.
 *
 *   node scripts/check-sync-recovery.js
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");

const store      = require("../src/main/db/store");
const { outbox, ownOutboxActions } = require("../src/main/db/outbox");
const { client } = require("../src/main/sync/client");
const { engine } = require("../src/main/sync/engine");
const { checkServer } = require("../src/main/serverAddress");

let connectivity = null;
try { ({ connectivity } = require("../src/main/sync/connectivity")); } catch { /* not built yet */ }

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await wait(10); }
  return cond();
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-recovery-"));
const file = path.join(dir, "school.db");

// ── The stub server ─────────────────────────────────────────────────────────
const stubServer = () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const tick = () => new Date(clock += 1000).toISOString();
  const st = {
    down:   false,           // every connection is dropped: the network is gone
    seen:   [],              // writes that arrived: { method, path, body }
    data:   { student: [], feePayment: [] },
    rule:   [],              // (method, path, body) => { status, body } | null
    health: 0,
    tick,
  };
  const server = http.createServer((req, res) => {
    if (st.down) return req.socket.destroy();
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url  = new URL(req.url, "http://localhost");
      const send = (status, payload) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (url.pathname === "/api/health") { st.health++; return send(200, { status: "ok" }); }

      if (url.pathname === "/api/sync/changes") {
        const wanted = (url.searchParams.get("collections") || "").split(",").filter(Boolean);
        let cursors = {};
        try { cursors = JSON.parse(url.searchParams.get("cursors") || "{}"); } catch { /* none */ }
        const collections = {};
        for (const name of wanted) {
          const after = cursors[name] ? JSON.parse(Buffer.from(cursors[name], "base64url").toString("utf8")) : null;
          const page = (st.data[name] ?? [])
            .slice().sort((x, y) => (x.updatedAt === y.updatedAt ? String(x._id).localeCompare(String(y._id)) : x.updatedAt < y.updatedAt ? -1 : 1))
            .filter((d) => !after || d.updatedAt > after.at || (d.updatedAt === after.at && String(d._id) > after.id));
          collections[name] = {
            documents: page, hasMore: false,
            cursor: page.length
              ? Buffer.from(JSON.stringify({ at: page[page.length - 1].updatedAt, id: String(page[page.length - 1]._id) })).toString("base64url")
              : (cursors[name] ?? null),
          };
        }
        return send(200, { success: true, serverTime: new Date().toISOString(), collections, refused: [] });
      }

      const body = raw ? JSON.parse(raw) : {};
      st.seen.push({ method: req.method, path: url.pathname, body });
      for (const r of st.rule) {
        const out = r(req.method, url.pathname, body);
        if (out) return send(out.status, out.body ?? { message: "refused" });
      }
      // Accepted: an edit to /api/<things>/<id> updates the stored record.
      const m = /^\/api\/(students)\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === "PUT") {
        const list = st.data.student;
        const at = list.findIndex((d) => d._id === m[2]);
        const next = { ...(list[at] ?? { _id: m[2] }), ...body, updatedAt: tick() };
        if (at >= 0) list[at] = next; else list.push(next);
        return send(200, { success: true, data: next });
      }
      return send(201, { success: true, data: { ...body, _id: body._id ?? `srv-${st.seen.length}`, updatedAt: tick() } });
    });
  });
  return { st, server };
};

const main = async () => {
  const { st, server } = stubServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  const db    = store.open(file);
  const docs  = store.documents(db);
  const queue = outbox(db);
  const state = store.state(db);
  const meta  = store.meta(db);
  const api   = client({ meta });
  api.setServerUrl(serverUrl);
  api.setToken("token-u1");

  let onPhase = () => {};
  const eng = engine({
    docs, queue, state, client: api,
    feedCollections: ["student", "feePayment"],
    currentUser: () => "u1",
    onChange: (s) => onPhase(s.phase),
  });
  const actions = ownOutboxActions({ queue, docs, state, currentUser: () => "u1" });

  const add = (o) => queue.add({ userId: "u1", ...o });
  const statusOf = (seq) => queue.all().find((r) => r.seq === seq)?.status ?? "gone";
  const nextTry = (seq) => queue.all().find((r) => r.seq === seq)?.next_try_at ?? null;
  const sentPaths = () => st.seen.map((s) => `${s.method} ${s.path}`);
  // A network failure repeated until the backoff is at its ten-minute ceiling.
  const networkBackoff = (seq) => {
    for (let i = 0; i < 5; i++) queue.markFailed(seq, { status: null, message: "fetch failed" });
  };
  // A blocked row or a backoff left over from one scenario would hold the line
  // in the next: start each with an empty queue.
  const clearQueue = () => db.prepare("DELETE FROM outbox").run();
  const syncNow = () => (eng.syncNow ? eng.syncNow() : eng.cycle());

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- A1. the first cycle that reaches the server again sends a network-backoff row at once ---");
  st.down = true;
  const { seq: r1 } = add({ method: "POST", path: "/api/attendance/students", body: { studentId: "s1" } });
  await eng.cycle();
  check("offline: the cycle says so and the row is waiting", [eng.status().phase, statusOf(r1)], ["offline", "pending"]);
  networkBackoff(r1);
  check("  its backoff is now ten minutes out", Date.parse(nextTry(r1)) - Date.now() > 500_000, true);
  const { seq: r2 } = add({ method: "POST", path: "/api/fees/payments", body: { amount: 1 } });
  queue.markFailed(r2, { status: 422, message: "Fee structure deactivated" });
  st.down = false;
  st.seen.length = 0;
  await eng.cycle();                                   // the 15 s offline timer, connection back
  check("back online: the row goes out on that cycle, not ten minutes later", [statusOf(r1), sentPaths()], ["gone", ["POST /api/attendance/students"]]);
  check("  the refused row behind it stays blocked and is not sent", statusOf(r2), "blocked");
  clearQueue();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- A2. \"Sync now\" brings a network backoff forward, and only a network backoff ---");
  const { seq: r3 } = add({ method: "POST", path: "/api/attendance/students", body: { studentId: "s3" } });
  networkBackoff(r3);
  st.seen.length = 0;
  await eng.cycle();
  check("a plain cycle respects the backoff", [statusOf(r3), st.seen.length], ["pending", 0]);
  await syncNow();
  check("Sync now sends it", [statusOf(r3), sentPaths()], ["gone", ["POST /api/attendance/students"]]);

  const { seq: r4 } = add({ method: "POST", path: "/api/exams", body: { name: "Mock" } });
  queue.markFailed(r4, { status: 503, message: "Service unavailable" });
  const r4Due = nextTry(r4);
  st.seen.length = 0;
  await syncNow();
  check("a 5xx backoff is the server asking for time: Sync now leaves it", [statusOf(r4), nextTry(r4) === r4Due, st.seen.length], ["pending", true, 0]);
  const { seq: r5 } = add({ method: "POST", path: "/api/fees/payments", body: { amount: 2 } });
  queue.markFailed(r5, { status: 403, message: "Forbidden" });
  clearQueue();
  const { seq: r6 } = add({ method: "POST", path: "/api/fees/payments", body: { amount: 3 } });
  queue.markFailed(r6, { status: 403, message: "Forbidden" });
  await syncNow();
  check("a refused row is not released by Sync now", [statusOf(r6), queue.all().find((r) => r.seq === r6)?.next_try_at ?? null], ["blocked", null]);
  void r5;
  clearQueue();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- A3. the connectivity monitor ---");
  if (!connectivity) {
    check("sync/connectivity.js exists", false, true);
  } else {
    // Online, idle: nothing polls.
    let onlineCalls = 0, osOnline = true, reconnects = 0, probes = 0, lastKick = null;
    const mon = connectivity({
      isOnline: () => { onlineCalls++; return osOnline; },
      probe: async () => { probes++; return (await checkServer(serverUrl, (u, i) => fetch(u, i), 2000)).ok; },
      onReconnect: () => { reconnects++; lastKick = eng.reconnected ? eng.reconnected() : eng.cycle(); return lastKick; },
      pollMs: 20, settleMs: 60, probeBackoffMs: [40, 80],
    });
    onPhase = (phase) => mon.engineStatus(phase);
    mon.start();
    onlineCalls = 0;
    await wait(200);
    check("online and idle: no polling at all", [mon.state(), onlineCalls, probes], ["online", 0, 0]);

    // The network goes, a write waits ten minutes, the network comes back.
    st.down = true;
    osOnline = false;
    const { seq: r7 } = add({ method: "POST", path: "/api/attendance/students", body: { studentId: "s7" } });
    await eng.cycle();
    networkBackoff(r7);
    check("the engine going offline puts the monitor into offline mode", mon.state(), "offline");

    // Flapping: up for less than the settle time, then down again. No probe.
    osOnline = true; await wait(30); osOnline = false;
    await wait(150);
    check("a flap shorter than the settle time is ignored (no probe, no cycle)", [probes, reconnects], [0, 0]);

    // Up, but the server is not answering yet: probed, stays offline, backs off.
    osOnline = true;
    await until(() => probes >= 1, 1000);
    await wait(30);
    check("the OS says online but the server is unreachable: still offline, nothing sent", [mon.state(), reconnects, statusOf(r7)], ["offline", 0, "pending"]);

    // The server answers: one reconnect, and the waiting row goes out at once.
    st.down = false;
    st.seen.length = 0;
    const t0 = Date.now();
    await until(() => statusOf(r7) === "gone", 2000);
    check("reconnected: one cycle, and the ten-minute row is sent within a second", [reconnects, statusOf(r7), Date.now() - t0 < 1000], [1, "gone", true]);
    check("  the monitor is back to online (no more polling)", mon.state(), "online");
    onlineCalls = 0;
    await wait(150);
    check("  and makes no calls once online", onlineCalls, 0);

    // The window's own online/offline events, relayed over the preload.
    mon.signal(false);
    check("the window's offline event puts it offline", mon.state(), "offline");
    const before = reconnects;
    mon.signal(true);
    await until(() => reconnects > before, 1000);
    check("the window's online event, confirmed by the probe, reconnects once", [reconnects - before, mon.state()], [1, "online"]);
    await lastKick;
    mon.stop();
    onPhase = () => {};
  }
  clearQueue();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- B. discarding a refused change ---");
  st.data.student.push({ _id: "s1", schoolId: "S1", name: "Ada Nkeng", updatedAt: st.tick() });
  st.data.feePayment.push({ _id: "p1", schoolId: "S1", amount: 30000, updatedAt: st.tick() });
  await eng.cycle();
  check("the server's student and payment are in the mirror", [docs.get("student", "s1")?.name, docs.get("feePayment", "p1")?.amount], ["Ada Nkeng", 30000]);

  // An edit the server refuses.
  const { seq: e1 } = docs.tx(() => {
    docs.put("student", { _id: "s1", schoolId: "S1", name: "Ada Nkeng-Fon", updatedAt: "2026-01-01T00:00:00.000Z" }, { pending: true });
    return add({ method: "PUT", path: "/api/students/s1", body: { name: "Ada Nkeng-Fon" }, collection: "student", docId: "s1" });
  });
  st.rule = [(method, p) => (p === "/api/students/s1" ? { status: 422, body: { message: "Name locked" } } : null)];
  await eng.cycle();
  check("the edit is refused and blocked; the mirror shows it pending", [statusOf(e1), docs.get("student", "s1")?.name, docs.get("student", "s1")?._pending], ["blocked", "Ada Nkeng-Fon", true]);
  actions.discard(e1);
  check("discarded: the server's version is back, settled", [docs.get("student", "s1")?.name ?? null, docs.get("student", "s1")?._pending ?? null], ["Ada Nkeng", false]);
  st.rule = [];
  await eng.cycle();
  check("  and it stays after the next pull (the cursor is past it)", docs.get("student", "s1")?.name ?? null, "Ada Nkeng");

  // A create the server refuses: the row goes.
  const { seq: c1 } = docs.tx(() => {
    docs.put("student", { _id: "s-new", schoolId: "S1", name: "New Pupil" }, { pending: true });
    return add({ method: "POST", path: "/api/students", body: { _id: "s-new", name: "New Pupil" }, collection: "student", docId: "s-new" });
  });
  st.rule = [(method, p) => (p === "/api/students" ? { status: 422 } : null)];
  await eng.cycle();
  actions.discard(c1);
  check("a discarded refused CREATE removes the local row", docs.get("student", "s-new"), null);

  // A reversal: a new row AND a stamp on an existing payment.
  const { seq: v1 } = docs.tx(() => {
    docs.put("feePayment", { _id: "rv1", schoolId: "S1", amount: -30000, reversalOf: "p1" }, { pending: true });
    docs.put("feePayment", { _id: "p1", schoolId: "S1", amount: 30000, reversedById: "rv1" }, { pending: true });
    return add({ method: "POST", path: "/api/fees/payments/p1/reverse", body: { reason: "x" }, collection: "feePayment", docId: "rv1", extraDocs: [{ collection: "feePayment", docId: "p1" }] });
  });
  st.rule = [(method, p) => (p === "/api/fees/payments/p1/reverse" ? { status: 409, body: { code: "ALREADY_REVERSED" } } : null)];
  await eng.cycle();
  actions.discard(v1);
  check("a discarded reversal: its new row goes, the original payment comes back unstamped",
    [docs.get("feePayment", "rv1"), docs.get("feePayment", "p1")?.amount ?? null, docs.get("feePayment", "p1")?.reversedById ?? null, docs.get("feePayment", "p1")?._pending ?? null],
    [null, 30000, null, false]);
  st.rule = [];

  // A row made pending before migration 5 kept no server version. Its edit
  // discarded: not deleted — un-pended, and the collection re-pulled so the
  // server's copy comes back.
  const { seq: l1 } = docs.tx(() => {
    docs.put("student", { _id: "s1", schoolId: "S1", name: "Legacy edit" }, { pending: true });
    db.prepare("UPDATE docs SET base_json = NULL, base_state = NULL WHERE collection = 'student' AND id = 's1'").run();
    return add({ method: "PUT", path: "/api/students/s1", body: { name: "Legacy edit" }, collection: "student", docId: "s1" });
  });
  queue.markFailed(l1, { status: 422, message: "no" });
  actions.discard(l1);
  check("a legacy edit discarded: the row is kept, no longer pending, and its collection will be re-pulled",
    [docs.get("student", "s1")?._pending ?? null, state.cursorFor("student")], [false, null]);
  await eng.cycle();
  check("  the next pull brings the server's version back", docs.get("student", "s1")?.name ?? null, "Ada Nkeng");
  clearQueue();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- C. two queued edits to one record: the first lands, the second waits ---");
  st.data.student.push({ _id: "s2", schoolId: "S1", name: "Bih", updatedAt: st.tick() });
  await eng.cycle();
  const edit = (name) => docs.tx(() => {
    const cur = docs.get("student", "s2");
    const { _pending, ...plain } = cur;
    docs.put("student", { ...plain, name }, { pending: true });
    return add({ method: "PUT", path: "/api/students/s2", body: { name }, collection: "student", docId: "s2" });
  });
  const { seq: x1 } = edit("Bih Mbah");
  const { seq: x2 } = edit("Bih Mbah-Tanyi");
  let failSecond = true;
  st.rule = [(method, p, body) => (failSecond && body?.name === "Bih Mbah-Tanyi" ? { status: 503, body: { message: "busy" } } : null)];
  await eng.cycle();
  check("the first edit is sent, the second waits", [statusOf(x1), statusOf(x2)], ["gone", "pending"]);
  check("  the server has the first edit", st.data.student.find((d) => d._id === "s2").name, "Bih Mbah");
  check("the pull did not revert the screen: it shows the last thing typed, still pending",
    [docs.get("student", "s2")?.name, docs.get("student", "s2")?._pending], ["Bih Mbah-Tanyi", true]);
  await eng.cycle();
  check("  nor does a second pull", docs.get("student", "s2")?.name, "Bih Mbah-Tanyi");

  failSecond = false;
  db.prepare("UPDATE outbox SET next_try_at = ? WHERE status = 'pending'").run(new Date(0).toISOString());
  await eng.cycle();
  check("the second edit goes out and the record settles on it",
    [statusOf(x2), st.data.student.find((d) => d._id === "s2").name, docs.get("student", "s2")?.name, docs.get("student", "s2")?._pending],
    ["gone", "Bih Mbah-Tanyi", "Bih Mbah-Tanyi", false]);

  // The same, but the second is refused and then discarded: the record goes
  // back to what the server holds — the FIRST edit — not to the original.
  const { seq: y1 } = edit("Bih A");
  const { seq: y2 } = edit("Bih B");
  st.rule = [(method, p, body) => (body?.name === "Bih B" ? { status: 422, body: { message: "no" } } : null)];
  await eng.cycle();
  check("first accepted, second refused; the screen still shows the second", [statusOf(y1), statusOf(y2), docs.get("student", "s2")?.name], ["gone", "blocked", "Bih B"]);
  actions.discard(y2);
  check("discarding the second shows the server's copy, which has the first",
    [docs.get("student", "s2")?.name ?? null, docs.get("student", "s2")?._pending ?? null], ["Bih A", false]);
  st.rule = [];

  db.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error(err); process.exit(1); });
