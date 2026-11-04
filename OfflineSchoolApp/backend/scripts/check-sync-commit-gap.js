// backend/scripts/check-sync-commit-gap.js
"use strict";

/**
 * A write that commits late is still delivered, and a row dated in the future
 * blinds nobody — on both feeds.
 *
 * updatedAt is stamped when the document is BUILT, not when it commits. A slow
 * write therefore appears with an updatedAt older than a cursor already handed
 * out. Simulated here exactly that way: a row is written straight to the
 * collection, AFTER a pull, with an updatedAt earlier than the position that
 * pull handed back. The next pull must still deliver it.
 *
 *   GET /sync/changes  — (updatedAt, _id) keyset; the resting cursor may not be
 *                        later than the pass's floor (now − window).
 *   GET /sync/pull     — the plain timestamp; `timestamp` lags now by the window.
 *
 * Also: a future-dated row does not carry the cursor past rows written today,
 * and is reported; a pass with more rows than a page inside the window still
 * ends (no loop); a cursor the desktop builds for itself (a pair, no floor) is
 * still accepted.
 *
 *   node scripts/check-sync-commit-gap.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  delete process.env.SYNC_SAFETY_WINDOW_MS;   // the shipped default, two minutes

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "sync-commit-gap" });

  require(path.join(SRC, "db/models"));
  const User    = mongoose.model("User");
  const Class   = mongoose.model("Class");

  const A = "5c0e2e0000000000000000b1";
  await User.create({ _id: "adm-a", name: "Admin A", email: "adm-a@example.test", password: "check-only-password", role: "school_admin", schoolId: A, isActive: true });

  // Classes, written raw so updatedAt is exactly what the case needs —
  // which is what a late commit looks like from the outside.
  const raw = mongoose.connection.db.collection("classes");
  const put = (id, at) => raw.insertOne({ _id: id, schoolId: A, name: id, isActive: true, deletedAt: null, createdAt: at, updatedAt: at });

  const app = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware/auth"));
  app.use("/api/sync", auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  const server = app.listen(0);
  const port = server.address().port;
  const TOKEN = jwt.sign({ id: "adm-a", role: "school_admin", schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sync${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  /** One desktop-style pass over `class`: page while hasMore. */
  const passOf = async (cursor, { limit = 500, between = null } = {}) => {
    const ids = [];
    let c = cursor, pages = 0, futureDated = 0;
    for (; pages < 50; ) {
      const qs = `?collections=class&limit=${limit}` + (c ? `&cursors=${encodeURIComponent(JSON.stringify({ class: c }))}` : "");
      const r = await get(`/changes${qs}`);
      pages++;
      const slice = r.body?.collections?.class;
      if (!slice) return { ids, cursor: c, pages, error: `${r.status} ${JSON.stringify(r.body).slice(0, 120)}` };
      ids.push(...slice.documents.map((d) => String(d._id)));
      futureDated += slice.futureDated ?? 0;
      c = slice.cursor ?? c;
      if (between && pages === 1) await between(slice);
      if (!slice.hasMore) break;
    }
    return { ids, cursor: c, pages, futureDated };
  };

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. /sync/changes: a write that commits after the pull ---");
  {
    const t = Date.now();
    await put("c-old", new Date(t - 3600_000));
    await put("c-fresh", new Date(t));                 // the pass's last row
    const p1 = await passOf(null);
    check("the first pass delivers what exists", p1.ids.includes("c-old") && p1.ids.includes("c-fresh"));

    // Stamped five seconds BEFORE the last row the pass delivered, committed
    // only now: older than the position the pass ended on.
    await put("c-slow", new Date(t - 5000));
    const p2 = await passOf(p1.cursor);
    check("the late write is delivered by the next pass", p2.ids.includes("c-slow"), JSON.stringify(p2.ids));
    check("  and a row from well before the window is not re-sent", !p2.ids.includes("c-old"));
  }

  console.log("--- 2. /sync/changes: a late write landing in the middle of a paged pass ---");
  {
    const t = Date.now();
    for (let i = 0; i < 30; i++) await put(`m-${String(i).padStart(2, "0")}`, new Date(t - 30_000 + i * 1000));
    let lateId = null;
    const p1 = await passOf(null, {
      limit: 10,
      // After the first page: a row stamped before that page's last row.
      between: async (slice) => {
        const lastAt = new Date(slice.documents[slice.documents.length - 1].updatedAt).getTime();
        lateId = "m-late";
        await put(lateId, new Date(lastAt - 500));
      },
    });
    check(`the pass ends (${p1.pages} pages, no loop)`, !p1.error && p1.pages < 50, p1.error);
    check("  (the late row was behind the cursor during this pass)", !p1.ids.includes("m-late"));
    const p2 = await passOf(p1.cursor, { limit: 10 });
    check("the next pass delivers it", p2.ids.includes("m-late"));
    check(`  and the next pass ends too (${p2.pages} pages)`, !p2.error && p2.pages < 50);
    const within = p1.ids.filter((id, i) => p1.ids.indexOf(id) !== i);
    check("no row twice within one pass", within.length === 0, within.join(","));
  }

  console.log("--- 3. /sync/changes: a row dated in the future ---");
  {
    await put("f-future", new Date("2099-01-01T00:00:00.000Z"));
    const p1 = await passOf(null);
    check("the future-dated row is delivered", p1.ids.includes("f-future"));
    check(`  and reported (futureDated: ${p1.futureDated})`, p1.futureDated >= 1);
    await put("f-today", new Date());
    const p2 = await passOf(p1.cursor);
    check("a row written today is still delivered after it", p2.ids.includes("f-today"), JSON.stringify(p2.ids));
  }

  console.log("--- 4. /sync/changes: cursors the desktop builds or keeps ---");
  {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    // engine.js rebuilds { at, id } at the last row it stored before a held one.
    const held = await passOf(enc({ at: "2000-01-01T00:00:00.000Z", id: "a" }));
    check("a pair with no floor is accepted (rows after it delivered)", !held.error && held.ids.includes("c-old"));
    const timeOnly = await get(`/changes?collections=class&cursors=${encodeURIComponent(JSON.stringify({ class: enc({ at: new Date().toISOString() }) }))}`);
    check("a timestamp-only position is still refused as a position (read from the start)",
      (timeOnly.body?.collections?.class?.documents ?? []).some((d) => d._id === "c-old"));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 5. /sync/pull: a write that commits after the pull ---");
  {
    const p1 = await get(`/pull?schoolId=${A}`);
    const ts = p1.body?.timestamp;
    check("the pull answers with a cursor", p1.status === 200 && !!ts);
    const lag = Date.now() - new Date(ts).getTime();
    check(`  which lags the clock by the window (${Math.round(lag / 1000)} s)`, lag >= 119_000);
    await put("p-slow", new Date(Date.now() - 5000));
    const p2 = await get(`/pull?schoolId=${A}&lastSync=${encodeURIComponent(ts)}`);
    check("the late write is delivered by the next pull", (p2.body?.data?.classes ?? []).some((c) => c._id === "p-slow"));
    check("future-dated rows are reported", (p2.body?.futureDated ?? 0) >= 1);
    const p3 = await get(`/pull?schoolId=${A}&lastSync=${encodeURIComponent(p2.body.timestamp)}`);
    await put("p-after", new Date());
    const p4 = await get(`/pull?schoolId=${A}&lastSync=${encodeURIComponent(p3.body.timestamp)}`);
    check("and a future-dated row does not hide a row written today", (p4.body?.data?.classes ?? []).some((c) => c._id === "p-after"));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
