// backend/scripts/check-retry-after-refusal.js
"use strict";

/**
 * A change the server refused can be sent again and be looked at again.
 *
 * The idempotency middleware stores a 4xx answer against its key and replays
 * it for 14 days. The desktop and phone outboxes reused one key per change,
 * so after a refusal — a permission later granted, data later fixed — Try
 * again got the stored refusal back and the change never landed. Now a retry
 * of a REFUSED entry goes out under a new key (desktop outbox.unblock, mobile
 * MutationQueue.retry); one that failed for want of an answer keeps its key.
 *
 * The real middleware (middleware/idempotency.js) on an in-memory MongoDB, and
 * the desktop's real outbox, client and engine.
 *
 *   node scripts/check-retry-after-refusal.js
 */

const { stopQuietly } = require("./stopQuietly");
const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const express  = require("express");
const mongoose = require("mongoose");

const DESKTOP = path.join(__dirname, "..", "..", "desktop", "src", "main");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  const IdempotencyKey = require("../src/db/models/IdempotencyKey");
  await IdempotencyKey.createIndexes();
  const idempotency = require("../middleware/idempotency");

  // A route that refuses until the office grants the permission.
  let granted = false, ran = 0, created = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { _id: "bursar-1" }; next(); });
  app.use("/api", idempotency);
  app.get("/api/sync/changes", (_req, res) => res.json({ success: true, collections: {}, refused: [] }));
  app.post("/api/admin/classes", (req, res) => {
    ran++;
    if (!granted) return res.status(403).json({ success: false, message: "classes.manage is required" });
    created++;
    return res.status(201).json({ success: true, class: { _id: req.body.id, name: req.body.name } });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const store      = require(path.join(DESKTOP, "db", "store"));
  const { outbox } = require(path.join(DESKTOP, "db", "outbox"));
  const { client } = require(path.join(DESKTOP, "sync", "client"));
  const { engine } = require(path.join(DESKTOP, "sync", "engine"));
  const dir   = fs.mkdtempSync(path.join(os.tmpdir(), "rekey-"));
  const db    = store.open(path.join(dir, "d.db"));
  const queue = outbox(db);
  const api   = client({ meta: store.meta(db) });
  api.setServerUrl(base); api.setToken("t");
  const eng = engine({ docs: store.documents(db), queue, state: store.state(db), client: api, feedCollections: [] });

  console.log("--- the desktop: refused, then granted ---");
  queue.add({ method: "POST", path: "/api/admin/classes", body: { id: "c9", name: "Form 9" }, collection: "class", docId: "c9", userId: "bursar-1" });
  await eng.cycle();
  const blocked = queue.summary().stuck[0];
  const firstKey = queue.get(blocked.seq).idem_key;
  check("refused 403: the entry blocks; the handler ran once", [blocked.last_status, ran], [403, 1]);

  granted = true;
  // What Try again USED to do: the same key. The stored refusal comes back
  // and the handler is not even asked.
  let replay = null;
  try { await api.replay({ method: "POST", path: "/api/admin/classes", body: { id: "c9", name: "Form 9" }, idem_key: firstKey }); }
  catch (err) { replay = err.status; }
  check("  under the old key, after the permission was granted: the stored 403 replayed, handler not run",
    [replay, ran, created], [403, 1, 0]);

  queue.unblock(blocked.seq);
  const secondKey = queue.get(blocked.seq).idem_key;
  await eng.cycle();
  check("Try again now (unblock): a NEW key, and the change lands — created once",
    [secondKey !== firstKey, created, queue.summary().blocked, queue.summary().pending], [true, 1, 0, 0]);
  await eng.cycle();
  check("  and syncing again does not create it twice", created, 1);

  console.log("--- an entry that failed for want of an answer keeps its key ---");
  queue.add({ method: "POST", path: "/api/admin/classes", body: { id: "c10", name: "Form 10" }, collection: "class", docId: "c10", userId: "bursar-1" });
  const row2 = queue.all().find((r) => r.method === "POST" && JSON.parse(r.body).id === "c10");
  db.prepare("UPDATE outbox SET status='blocked', last_status=NULL, last_error='timeout' WHERE seq=?").run(row2.seq);
  queue.unblock(row2.seq);
  check("blocked with no status (no answer): unblock keeps the key — the server may have applied it",
    queue.get(row2.seq).idem_key, row2.idem_key);

  db.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
