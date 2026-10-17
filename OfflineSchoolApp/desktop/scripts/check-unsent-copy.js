// desktop/scripts/check-unsent-copy.js
"use strict";

/**
 * A change refused with 410 RECORD_DELETED can be kept before it is discarded.
 *
 * The server refuses a create under the id of a record it has deleted (410
 * RECORD_DELETED). The desktop's outbox blocks on it, and its only answers
 * were Try again — which can never succeed — and Discard, which deletes the
 * queued request and what was typed with no copy. Now the entry can be saved
 * to a file first (src/main/unsentCopy.js, IPC outbox:saveCopy), readable by a
 * person: what was sent, where, when, and the server's refusal.
 *
 * A real store, outbox, client and engine, and a server that answers 410.
 *
 *   node scripts/check-unsent-copy.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");
const store      = require("../src/main/db/store");
const { outbox } = require("../src/main/db/outbox");
const { client } = require("../src/main/sync/client");
const { engine } = require("../src/main/sync/engine");
const { unsentCopy, writeUnsentCopy, suggestedName } = require("../src/main/unsentCopy");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/sync/changes")) return res.end(JSON.stringify({ success: true, collections: {}, refused: [] }));
    if (req.method === "POST" && req.url === "/api/admin/subjects") {
      res.statusCode = 410;
      return res.end(JSON.stringify({ success: false, code: "RECORD_DELETED", message: "This subject was deleted and cannot be recreated under the same id." }));
    }
    res.statusCode = 404; res.end("{}");
  });
});

(async () => {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const dir   = fs.mkdtempSync(path.join(os.tmpdir(), "unsent-"));
  const db    = store.open(path.join(dir, "u.db"));
  const docs  = store.documents(db);
  const queue = outbox(db);
  const api   = client({ meta: store.meta(db) });
  api.setServerUrl(`http://127.0.0.1:${server.address().port}`);
  api.setToken("test-token");
  const eng = engine({ docs, queue, state: store.state(db), client: api, feedCollections: [] });

  // A subject created on this desktop while offline — under an id the server
  // has since seen deleted.
  const body = { id: "s1", name: "Music", classId: "c1", code: "MUS" };
  docs.put("subject", { _id: "s1", name: "Music", classId: "c1" }, { pending: true });
  queue.add({ method: "POST", path: "/api/admin/subjects", body, collection: "subject", docId: "s1", userId: "u1" });
  await eng.cycle();

  const blocked = queue.summary().stuck[0];
  check("the 410 blocks the entry, with the server's own sentence and status",
    [blocked?.last_status, blocked?.last_error], [410, "This subject was deleted and cannot be recreated under the same id."]);

  const row = queue.get(blocked.seq);
  const now = new Date("2026-10-17T12:00:00.000Z");
  const copy = unsentCopy(row, now);
  check("the copy holds what was sent — method, path and the body as typed",
    copy.request, { method: "POST", path: "/api/admin/subjects", body });
  check("  why it was refused, and which record", [copy.refused, copy.record],
    [{ status: 410, message: "This subject was deleted and cannot be recreated under the same id." }, { collection: "subject", id: "s1" }]);
  check("  when it was queued and when it was saved", [Boolean(copy.queuedAt), copy.savedAt], [true, "2026-10-17T12:00:00.000Z"]);

  const file = path.join(dir, suggestedName(row, now));
  writeUnsentCopy(row, file, now);
  const read = JSON.parse(fs.readFileSync(file, "utf8"));
  check("written to the chosen file as readable JSON, under a name that says what it is",
    [path.basename(file), read.request.body.name, read.refused.status], [`unsent-change-2026-10-17-${blocked.seq}.json`, "Music", 410]);

  // The copy taken, the entry is discarded — and the copy outlives it.
  queue.discard(blocked.seq);
  docs.forget("subject", "s1");
  check("after discarding: the queue is clear, the local row gone, the saved copy still there",
    [queue.summary().blocked, docs.get("subject", "s1"), fs.existsSync(file)], [0, null, true]);

  check("a missing entry: nothing to copy", queue.get(99999), null);

  db.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
