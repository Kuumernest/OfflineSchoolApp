// desktop/scripts/check-initial-sync.js
"use strict";

/**
 * Does a desktop that has never finished a pull know it, and say so?
 *
 * "Signed in, sees none of the data the web shows" had four ways to happen and
 * none of them was visible: a super_admin's pull asked for no school and got
 * nothing; cursors carried over from another server or school skipped every
 * older row; a server fault was reported as "idle"; and a first sync longer
 * than one cycle's page ceiling waited a full minute between batches.
 *
 * Runs the real store, client and engine against a fake feed.
 *
 *   node scripts/check-initial-sync.js
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

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-initial-sync-"));
const file = path.join(dir, "school.db");

// ── A feed: one collection, one row per page ────────────────────────────────
// School A has more rows than the engine takes pages in one cycle (40), so its
// first sync needs a second cycle.
const fakeFeed = () => {
  const st = { asked: [], fault: false };
  const rows = {
    A: Array.from({ length: 42 }, (_, i) => ({
      _id: `a${String(i).padStart(2, "0")}`, schoolId: "A", name: `A${String(i).padStart(2, "0")}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    })),
    B: [{ _id: "b1", schoolId: "B", name: "Esi",  updatedAt: "2026-01-01T00:00:00.000Z" }],
  };
  const enc = (d) => Buffer.from(JSON.stringify({ at: d.updatedAt, id: d._id })).toString("base64url");
  const dec = (c) => JSON.parse(Buffer.from(c, "base64url").toString());

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname !== "/api/sync/changes") return send(404, {});
    // The token names the school, as on the real server; a super_admin's
    // token names none and the query must.
    const token  = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const school = token === "root" ? url.searchParams.get("schoolId") : token;
    st.asked.push({ token, schoolId: url.searchParams.get("schoolId") });
    if (st.fault) return send(500, { message: "database unavailable" });

    const cursors = JSON.parse(url.searchParams.get("cursors") || "{}");
    const all = rows[school] ?? [];
    const from = cursors.student ? dec(cursors.student) : null;
    const after = from ? all.filter((d) => d.updatedAt > from.at || (d.updatedAt === from.at && d._id > from.id)) : all;
    const page = after.slice(0, 1);
    send(200, {
      success: true,
      collections: { student: { documents: page, hasMore: after.length > 1, cursor: page.length ? enc(page[0]) : (cursors.student ?? null) } },
      refused: [],
    });
  });
  return { st, server };
};

const main = async () => {
  const { st, server } = fakeFeed();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const db    = store.open(file);
  const docs  = store.documents(db);
  const state = store.state(db);
  const meta  = store.meta(db);
  const queue = outbox(db);
  const api   = client({ meta });
  api.setServerUrl(base);

  // What main.js passes, driven by a session the test controls.
  let session = null;
  const eng = engine({
    docs, queue, state, client: api, feedCollections: ["student"],
    currentUser: () => session?.userId ?? null,
    schoolId:    () => (session?.role === "super_admin" ? session.schoolId : null),
    scope:       () => (session?.schoolId ? `${api.serverUrl()}|${session.schoolId}` : null),
    marks:       meta,
  });
  const names = () => docs.find("student").map((d) => d.name).sort();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a super_admin on the platform pages has nothing to wait for ---");
  session = { userId: "root", role: "super_admin", schoolId: "" };
  api.setToken("root");
  check("no school, no pending first sync", eng.status().initialSync, "done");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a super_admin inside a school pulls THAT school ---");
  session = { ...session, schoolId: "A" };
  check("before the pull, the first sync is pending", eng.status().initialSync, "pending");

  await eng.cycle();
  check("the feed was asked for school A", st.asked.at(-1).schoolId, "A");
  check("forty pages this cycle, more to come", eng.status().morePending, true);
  check("still pending while pages remain", eng.status().initialSync, "pending");

  await eng.cycle();
  check("all 42 of A's pupils arrived", names().length, 42);
  check("the first sync is done", eng.status().initialSync, "done");
  check("nothing left", eng.status().morePending, false);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a school admin's school comes from the token, not the query ---");
  session = { userId: "u-b", role: "school_admin", schoolId: "B" };
  api.setToken("B");
  check("a new school is a new first sync", eng.status().initialSync, "pending");

  await eng.cycle();
  check("no schoolId was sent", st.asked.at(-1).schoolId, null);
  // A's cursor (past both of A's rows) would have skipped b1 if it had been
  // carried over; the change of scope drops it.
  check("B's pupil arrived despite A's cursor", names().includes("Esi"), true);
  check("done for B", eng.status().initialSync, "done");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a server fault during a first sync is an error, not idle ---");
  session = { userId: "root", role: "super_admin", schoolId: "C" };
  api.setToken("root");
  st.fault = true;
  await eng.cycle();
  check("the phase is error", eng.status().phase, "error");
  check("the message is kept for the window", eng.status().lastError, "database unavailable");
  check("and the first sync is still pending", eng.status().initialSync, "pending");
  st.fault = false;

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- going back to a school already synced does not start over ---");
  session = { userId: "u-b", role: "school_admin", schoolId: "B" };
  api.setToken("B");
  check("B is still done", eng.status().initialSync, "done");

  eng.stop();
  db.close();
  await new Promise((r) => server.close(r));
  console.log(`\n  ${pass} passed, ${fail} failed`);
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    process.exit(fail ? 1 : 0);
  });
