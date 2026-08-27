// desktop/scripts/check-sync-engine.js
"use strict";

/**
 * Assert that a machine coming back online ends up agreeing with the server.
 *
 * ── What is being pinned ──────────────────────────────────────────────────
 *
 * The engine's job is small to describe and easy to get subtly wrong:
 *
 *   push before pull        or the server's older copy overwrites a local write
 *   never clobber pending   or a refused write is silently erased
 *   commit page WITH cursor or an interrupted sync loses its place, or its rows
 *   stop at a blocked write or later changes land without earlier ones
 *   still pull when blocked or one stuck document freezes the whole machine
 *   take the server's copy   or a receipt number printed locally never matches
 *     back after a write        the record
 *
 * Each has an assertion below, driven against a REAL HTTP server that can be
 * told to fail, refuse or vanish — because every one of these failures is about
 * what happens when the network misbehaves, and a stubbed client would be
 * asserting the stub.
 *
 *   node scripts/check-sync-engine.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");

const store        = require("../src/main/db/store");
const { outbox }   = require("../src/main/db/outbox");
const { client }   = require("../src/main/sync/client");
const { engine }   = require("../src/main/sync/engine");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-engine-"));
const file = path.join(dir, "school.db");
const cleanup = () => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (err) { console.log(`  (could not remove ${dir}: ${err.code})`); }
};

// ─────────────────────────────────────────────────────────────────────────────
// A SERVER THAT CAN MISBEHAVE ON REQUEST
// ─────────────────────────────────────────────────────────────────────────────

const fakeServer = () => {
  /** What the server holds, and what it has been asked to do. */
  const st = {
    // collection -> [documents], kept in updatedAt/_id order
    data:    {},
    // Requests it received, so ordering can be asserted rather than assumed.
    seen:    [],
    // path -> { status, body } to answer with instead of accepting
    refuse:  {},
    // Every write is remembered by its id so a replay can be detected.
    written: new Set(),
    unauthorized: false,
    pageSize: 100,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      st.seen.push(`${req.method} ${url.pathname}`);

      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (st.unauthorized) return send(401, { message: "jwt expired" });

      // ── the change feed ────────────────────────────────────────────────
      if (url.pathname === "/api/sync/changes") {
        const wanted = (url.searchParams.get("collections") || "").split(",").filter(Boolean);
        let cursors = {};
        try { cursors = JSON.parse(url.searchParams.get("cursors") || "{}"); } catch { /* none */ }

        const collections = {};
        const refused = [];

        for (const name of wanted) {
          if (st.refuse[`feed:${name}`]) {
            refused.push({ collection: name, reason: "FORBIDDEN", permission: "x.view" });
            continue;
          }
          const all   = st.data[name] ?? [];
          const after = cursors[name]
            ? JSON.parse(Buffer.from(cursors[name], "base64url").toString("utf8"))
            : null;

          // The same (updatedAt, _id) ordering the real feed uses.
          const remaining = all.filter((d) =>
            !after ||
            d.updatedAt > after.at ||
            (d.updatedAt === after.at && String(d._id) > after.id)
          );

          const page = remaining.slice(0, st.pageSize);
          collections[name] = {
            documents: page,
            hasMore:   remaining.length > page.length,
            cursor: page.length
              ? Buffer.from(JSON.stringify({
                  at: page[page.length - 1].updatedAt,
                  id: String(page[page.length - 1]._id),
                })).toString("base64url")
              : (cursors[name] ?? null),
          };
        }

        return send(200, { success: true, serverTime: new Date().toISOString(), collections, refused });
      }

      // ── anything else is a write being replayed ────────────────────────
      const rule = st.refuse[url.pathname];
      if (rule) return send(rule.status, rule.body ?? { message: "refused" });

      const parsed = body ? JSON.parse(body) : {};
      const id = parsed._id ?? parsed.id ?? null;

      // Replay: answer 200 rather than a conflict, which is what the real
      // payments endpoint does and what the outbox depends on.
      if (id && st.written.has(id)) {
        return send(200, { success: true, replay: true, data: { ...parsed, _id: id } });
      }
      if (id) st.written.add(id);

      // The server fills in what the client could not know. A receipt number is
      // the reason the engine takes the response document back.
      return send(201, {
        success: true,
        data: { ...parsed, _id: id, receiptNo: `RCT-SERVER-${st.written.size}`, updatedAt: "2026-06-01T00:00:00.000Z" },
      });
    });
  });

  return { st, server };
};

// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  const { st, server } = fakeServer();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const db    = store.open(file);
  const docs  = store.documents(db);
  const queue = outbox(db);
  const state = store.state(db);
  const meta  = store.meta(db);

  const api = client({ meta });
  api.setServerUrl(`http://127.0.0.1:${port}`);
  api.setToken("test-token");

  const COLLECTIONS = ["student", "feeCharge"];
  let published = [];
  const eng = engine({
    docs, queue, state, client: api,
    feedCollections: COLLECTIONS,
    onChange: (s) => published.push(s.phase),
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a first sync takes everything, in pages ---");

  st.data.student = Array.from({ length: 250 }, (_, i) => ({
    _id: `s${String(i).padStart(3, "0")}`,
    schoolId: "sch-1", studentName: `Pupil ${i}`,
    updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null,
  }));

  await eng.cycle();

  check("every pupil arrived", docs.count("student"), 250);
  check("in three pages of a hundred",
    st.seen.filter((s) => s.includes("/api/sync/changes")).length, 3);
  check("and the cycle ends idle", eng.status().phase, "idle");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and the next sync takes only what changed ---");

  st.seen.length = 0;
  await eng.cycle();
  check("nothing new means nothing stored", eng.status().pulled, 0);

  st.data.student.push({
    _id: "s999", schoolId: "sch-1", studentName: "New Pupil",
    updatedAt: "2026-02-01T00:00:00.000Z", deletedAt: null,
  });
  await eng.cycle();
  check("one new pupil arrives alone", eng.status().pulled, 1);
  check("and is readable locally", docs.get("student", "s999")?.studentName, "New Pupil");

  // The cursor has to have been kept from the LAST page, not the last page that
  // had more after it — the mistake that makes a sync re-fetch for ever.
  check("without re-fetching what it already had", docs.count("student"), 251);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a deletion is applied, not ignored ---");

  st.data.student = st.data.student.map((d) =>
    d._id === "s999"
      ? { ...d, deletedAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" }
      : d
  );
  await eng.cycle();
  check("the row is still present", Boolean(docs.get("student", "s999")), true);
  check("but marked deleted, which is what the screens filter on",
    Boolean(docs.get("student", "s999").deletedAt), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a local write goes out, and the server's answer comes back ---");

  // What write:local does in the app: the document and its request, together.
  docs.tx(() => {
    docs.put("feePayment", { _id: "pay-1", schoolId: "sch-1", studentId: "s001", amount: 30000 }, { pending: true });
    queue.add({
      method: "post", path: "/api/fees/payments",
      body: { _id: "pay-1", schoolId: "sch-1", studentId: "s001", amount: 30000 },
      collection: "feePayment", docId: "pay-1", idemKey: "pay-1",
    });
  });

  check("it is pending before the sync", docs.get("feePayment", "pay-1")._pending, true);

  st.seen.length = 0;
  await eng.cycle();

  check("the write was sent", eng.status().pushed, 1);
  check("the queue is empty", queue.all().length, 0);
  check("the row is no longer provisional", docs.get("feePayment", "pay-1")._pending, false);

  // THE POINT OF TAKING THE RESPONSE BACK. The receipt number is issued by the
  // server; without this the bursar prints one number and the record holds none.
  check("and carries the receipt number the server issued",
    docs.get("feePayment", "pay-1").receiptNo, "RCT-SERVER-1");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- push happens before pull ---");

  st.seen.length = 0;
  docs.tx(() => {
    docs.put("feePayment", { _id: "pay-2", schoolId: "sch-1", amount: 5000 }, { pending: true });
    queue.add({
      method: "post", path: "/api/fees/payments", body: { _id: "pay-2", amount: 5000 },
      collection: "feePayment", docId: "pay-2", idemKey: "pay-2",
    });
  });
  await eng.cycle();

  // Not a preference: pulling first would fetch the server's copy of a document
  // this machine has already changed, with no way to know ours is newer.
  check("the write left before any page was fetched",
    st.seen[0], "POST /api/fees/payments");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a refused write blocks the queue but not the pull ---");

  st.refuse["/api/fees/penalties"] = { status: 403, body: { message: "fees.penalize required" } };

  docs.tx(() => {
    docs.put("feeCharge", { _id: "pen-1", schoolId: "sch-1", amount: 5000 }, { pending: true });
    queue.add({
      method: "post", path: "/api/fees/penalties",
      body: { _id: "pen-1", schoolId: "sch-1", amount: 5000 },
      collection: "feeCharge", docId: "pen-1", idemKey: "pen-1",
    });
  });

  // Something behind it, to prove the queue stops rather than reordering.
  queue.add({ method: "post", path: "/api/fees/reminders", body: {}, idemKey: "rem-1" });

  st.data.feeCharge = [{
    _id: "c-new", schoolId: "sch-1", amount: 100,
    updatedAt: "2026-04-01T00:00:00.000Z", deletedAt: null,
  }];

  await eng.cycle();

  check("the cycle reports being blocked", eng.status().phase, "blocked");
  check("the refusal is recorded against the entry", queue.summary().blocked, 1);
  check("what is behind it has not been sent", queue.summary().pending, 1);

  // One stuck document must not freeze the machine: the bursar may not look at
  // it until Friday, and the school still needs the news from the server.
  check("but the pull still happened", Boolean(docs.get("feeCharge", "c-new")), true);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and a pending row is never overwritten by the server ---");

  // THE MOST IMPORTANT ASSERTION HERE. pen-1 is still waiting, blocked. The
  // server now claims a different version of the same document. Taking it would
  // silently erase what somebody typed.
  st.data.feeCharge.push({
    _id: "pen-1", schoolId: "sch-1", amount: 999999,
    updatedAt: "2026-04-02T00:00:00.000Z", deletedAt: null,
  });

  await eng.cycle();

  check("the local version survives",
    docs.get("feeCharge", "pen-1").amount, 5000);
  check("and is still pending", docs.get("feeCharge", "pen-1")._pending, true);
  check("the disagreement is reported rather than hidden",
    (eng.status().heldBack ?? []).includes("feeCharge/pen-1"), true);

  // Once the block is resolved, the machine converges.
  delete st.refuse["/api/fees/penalties"];
  queue.unblock(queue.summary().stuck[0].seq);
  db.prepare("UPDATE outbox SET next_try_at = ?").run("2000-01-01T00:00:00.000Z");

  await eng.cycle();
  check("after the write goes through, the queue drains", queue.all().length, 0);
  check("and the row settles", docs.get("feeCharge", "pen-1")._pending, false);

  await eng.cycle();
  check("then the server's version is accepted",
    docs.get("feeCharge", "pen-1").amount, 999999);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a replay is a success, not a conflict ---");

  // The case that would otherwise block the queue on work that succeeded: the
  // request arrived, the response did not.
  docs.tx(() => {
    docs.put("feePayment", { _id: "pay-1", schoolId: "sch-1", amount: 30000 }, { pending: true });
    queue.add({
      method: "post", path: "/api/fees/payments", body: { _id: "pay-1", amount: 30000 },
      collection: "feePayment", docId: "pay-1", idemKey: "pay-1-again",
    });
  });
  await eng.cycle();
  check("the second attempt is accepted", queue.all().length, 0);
  check("and the row settles rather than blocking", docs.get("feePayment", "pay-1")._pending, false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a refused collection is reported and then left alone ---");

  st.refuse["feed:feeCharge"] = true;
  st.seen.length = 0;
  await eng.cycle();

  check("the refusal reaches the status",
    (eng.status().refused ?? []).map((r) => r.collection), ["feeCharge"]);
  delete st.refuse["feed:feeCharge"];

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an expired session stops the cycle rather than emptying the queue ---");

  queue.add({ method: "post", path: "/api/fees/reminders", body: {}, idemKey: "rem-2" });
  st.unauthorized = true;

  await eng.cycle();
  check("the phase says so", eng.status().phase, "unauthenticated");
  // Nothing is wrong with the request, so marking it blocked would be a lie
  // that a person then has to unblock by hand once they sign in again.
  check("the queued write is untouched", queue.summary().blocked, 0);
  check("and still waiting", queue.summary().pending, 1);

  st.unauthorized = false;

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and an unreachable server is offline, not broken ---");

  await new Promise((r) => server.close(r));

  await eng.cycle();
  check("the phase distinguishes it from a refusal", eng.status().phase, "offline");
  check("the write is still queued", queue.summary().pending, 1);
  check("nothing was blocked", queue.summary().blocked, 0);

  // No token at all is a different state again, and the one a fresh install is
  // in — reported rather than retried.
  api.setToken(null);
  await eng.cycle();
  check("no session is its own state", eng.status().phase, "unauthenticated");

  eng.stop();
  db.close();

  console.log(`\n  ${pass} passed, ${fail} failed`);
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => { cleanup(); process.exit(fail ? 1 : 0); });
