// desktop/scripts/check-tombstones.js
"use strict";

/**
 * Hard deletes reach the mirror: the feed's syncTombstone collection.
 *
 * Subjects, teacher assignments and pupils are hard-deleted on the server; no
 * row comes back with a deletedAt, so the mirror kept them for good. The feed
 * now sends their tombstones, and the engine (store.applyTombstones) removes
 * the named row — never creating one, and holding a row with a local write
 * still waiting, as merge() does, so nothing typed is lost and the cursor
 * does not pass it.
 *
 * A real store, the real client and engine, and a small server that speaks
 * GET /api/sync/changes.
 *
 *   node scripts/check-tombstones.js
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
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

// The server's collections, each a list of documents with updatedAt.
const st = { rows: { subject: [], student: [], syncTombstone: [] }, pageSize: 50 };
let clock = Date.parse("2026-10-01T00:00:00.000Z");
const stamp = () => new Date(clock += 1000).toISOString();
const put = (collection, doc) => {
  st.rows[collection] = st.rows[collection].filter((d) => d._id !== doc._id);
  st.rows[collection].push({ ...doc, updatedAt: stamp() });
};
const hardDelete = (entity, id) => {
  st.rows[entity] = st.rows[entity].filter((d) => d._id !== id);
  put("syncTombstone", { _id: `t-${entity}-${id}`, entity, docId: id, schoolId: "s1" });
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/api/sync/changes") { res.writeHead(404); return res.end("{}"); }
  const cursors = JSON.parse(url.searchParams.get("cursors") || "{}");
  const wanted = (url.searchParams.get("collections") || Object.keys(st.rows).join(",")).split(",");
  const collections = {};
  for (const name of wanted) {
    const after = cursors[name] ? JSON.parse(Buffer.from(cursors[name], "base64url").toString()) : null;
    const all = [...(st.rows[name] || [])].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a._id < b._id ? -1 : 1));
    const rest = all.filter((d) => !after || d.updatedAt > after.at || (d.updatedAt === after.at && d._id > after.id));
    const page = rest.slice(0, st.pageSize);
    collections[name] = {
      documents: page, hasMore: rest.length > page.length,
      cursor: page.length ? Buffer.from(JSON.stringify({ at: page[page.length - 1].updatedAt, id: page[page.length - 1]._id })).toString("base64url") : (cursors[name] ?? null),
    };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: true, collections, refused: [] }));
});

(async () => {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "tombstones-"));
  const db   = store.open(path.join(dir, "t.db"));
  const docs = store.documents(db);
  const meta = store.meta(db);
  const api  = client({ meta });
  api.setServerUrl(`http://127.0.0.1:${server.address().port}`);
  api.setToken("test-token");
  const eng = engine({ docs, queue: outbox(db), state: store.state(db), client: api,
    feedCollections: ["subject", "student", "syncTombstone"] });
  const ids = (c) => docs.find(c, {}).map((d) => d._id).sort();

  // ── the school as the mirror first sees it ───────────────────────────────
  put("subject", { _id: "s1", schoolId: "s1", name: "Music" });
  put("subject", { _id: "s2", schoolId: "s1", name: "Maths" });
  put("student", { _id: "p1", schoolId: "s1", studentName: "Ada" });
  put("student", { _id: "p2", schoolId: "s1", studentName: "Ben" });
  await eng.cycle();
  check("first sync: the mirror holds the school", [ids("subject"), ids("student")], [["s1", "s2"], ["p1", "p2"]]);
  check("  and keeps no tombstone rows of its own", docs.find("syncTombstone", {}).length, 0);

  console.log("--- a hard delete reaches the mirror ---");
  hardDelete("subject", "s1");
  hardDelete("subject", "never-held");
  await eng.cycle();
  check("the subject deleted on the server is removed from the mirror; the other stays",
    ids("subject"), ["s2"]);
  check("  a tombstone for a record the mirror never held creates nothing",
    docs.get("subject", "never-held"), null);
  await eng.cycle();
  check("  syncing again changes nothing", ids("subject"), ["s2"]);

  console.log("--- a row with a local write still waiting ---");
  // The office edited Ben on this desktop, not yet sent; meanwhile the
  // server deleted him, and later Maths.
  docs.put("student", { _id: "p2", schoolId: "s1", studentName: "Ben (edited)" }, { pending: true });
  hardDelete("student", "p2");
  hardDelete("subject", "s2");
  await eng.cycle();
  check("the edited row is held, not removed — what was typed is not lost",
    docs.get("student", "p2")?.studentName, "Ben (edited)");
  check("  the engine reports it as held back, by collection and id",
    (eng.status().heldBack || []).includes("student/p2"), true);
  // Once the write is resolved (here: settled), the deletion is applied.
  docs.settle("student", "p2");
  await eng.cycle();
  check("  once the local write is resolved, the deletion is applied — the cursor had not passed it",
    [docs.get("student", "p2"), ids("subject")], [null, []]);

  console.log("--- many deletions, a page at a time ---");
  st.pageSize = 1;
  for (let i = 0; i < 5; i++) put("subject", { _id: `x${i}`, schoolId: "s1", name: `Sub ${i}` });
  await eng.cycle();
  for (let i = 0; i < 5; i++) hardDelete("subject", `x${i}`);
  await eng.cycle();
  check("five deletions over five pages: every one applied in one sync", ids("subject"), []);

  db.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
