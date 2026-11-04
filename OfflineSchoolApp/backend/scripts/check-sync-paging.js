// backend/scripts/check-sync-paging.js
"use strict";

/**
 * Neither pull may answer with an unbounded payload, and paging may neither
 * lose nor duplicate a row.
 *
 *   GET /sync/pull     — the phone's original pull. It used to answer with every
 *                        changed row of six collections in ONE body; a first sync
 *                        of a big school was one download that a phone link could
 *                        not carry. Now each collection is cut at `limit` and the
 *                        `timestamp` cursor stays behind the cut, so an OLD
 *                        client — one that knows nothing of `hasMore` and just
 *                        stores `timestamp` — gets the rest on its next syncs.
 *   GET /sync/changes  — the keyset feed, paged to exhaustion: every row exactly
 *                        once within a pass.
 *
 * Real routes over an in-memory MongoDB.
 *
 *   node scripts/check-sync-paging.js
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

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "sync-paging" });

  require(path.join(SRC, "db/models"));
  const User          = mongoose.model("User");
  const Student       = mongoose.model("Student");
  const Class         = mongoose.model("Class");
  const SyncTombstone = mongoose.model("SyncTombstone");

  const A = "5c0e2e0000000000000000a1";
  await User.create({ _id: "adm-a", name: "Admin A", email: "adm-a@example.test", password: "check-only-password", role: "school_admin", schoolId: A, isActive: true });
  await Class.create({ _id: "cls-a", schoolId: A, name: "Form 1" });

  // 4 500 pupils, stamped across the past few hours, with a group of sixty
  // sharing one millisecond placed where the 2 000 cut falls.
  const N = 4500;
  const base = Date.now() - 6 * 3600_000;
  const docs = [];
  for (let i = 0; i < N; i++) {
    const at = (i >= 1980 && i < 2040) ? new Date(base + 1980 * 1000) : new Date(base + i * 1000);
    docs.push({
      _id: `p-${String(i).padStart(5, "0")}`, userId: `u-${i}`, schoolId: A, classId: "cls-a",
      studentName: `Pupil ${i}`, enrollmentNo: `E-${i}`, isActive: true, status: "approved",
      createdAt: at, updatedAt: at,
    });
  }
  await Student.collection.insertMany(docs, { ordered: false });
  const allIds = new Set(docs.map((d) => d._id));

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

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. /sync/pull: an old client, storing `timestamp` and nothing else ---");
  {
    const seen = new Set();
    let lastSync = null, biggest = 0, pulls = 0, statusOk = true;
    // An old build stores `timestamp` and pulls again at its next sync. It never
    // reads hasMore; the loop stops when a pull brings nothing new.
    for (let i = 0; i < 12; i++) {
      const r = await get(`/pull?schoolId=${A}${lastSync ? `&lastSync=${encodeURIComponent(lastSync)}` : ""}`);
      pulls++;
      if (r.status !== 200) { statusOk = false; break; }
      const rows = r.body.data.students;
      biggest = Math.max(biggest, rows.length);
      const before = seen.size;
      for (const s of rows) seen.add(String(s._id));
      lastSync = r.body.timestamp;
      if (seen.size === before) break;
    }
    check("every pull answers 200", statusOk);
    check(`no single answer carries more than 2000 pupils (largest: ${biggest})`, biggest <= 2000);
    const missing = [...allIds].filter((id) => !seen.has(id));
    check(`all ${N} pupils arrive over successive pulls (${pulls} pulls, ${missing.length} missing)`, missing.length === 0,
      missing.slice(0, 5).join(", "));
  }

  console.log("--- 2. /sync/pull: a small limit, followed with hasMore ---");
  {
    const seen = new Set();
    let lastSync = null, biggest = 0, pages = 0, sawMore = false;
    for (let i = 0; i < 100; i++) {
      const r = await get(`/pull?schoolId=${A}&limit=500${lastSync ? `&lastSync=${encodeURIComponent(lastSync)}` : ""}`);
      pages++;
      const rows = r.body?.data?.students ?? [];
      biggest = Math.max(biggest, rows.length);
      for (const s of rows) seen.add(String(s._id));
      lastSync = r.body?.timestamp;
      if (r.body?.hasMore) sawMore = true;
      if (!r.body?.hasMore) break;
    }
    check("hasMore is reported while a collection was cut", sawMore);
    check(`limit=500 is honoured (largest: ${biggest})`, biggest <= 500);
    check(`and the pages cover every pupil (${pages} pages, ${seen.size}/${N})`, [...allIds].every((id) => seen.has(id)));
    const capped = await get(`/pull?schoolId=${A}&limit=999999`);
    check("a limit above the ceiling is capped at 2000", (capped.body?.data?.students ?? []).length <= 2000);
  }

  console.log("--- 3. /sync/pull: hard deletes are paged too ---");
  {
    const t0 = new Date(Date.now() - 3600_000);
    const stones = [];
    for (let i = 0; i < 30; i++) {
      stones.push({ _id: `ts-${i}`, schoolId: A, entity: "student", docId: `gone-${String(i).padStart(2, "0")}`, deletedAt: new Date(t0.getTime() + i * 1000), createdAt: t0, updatedAt: t0 });
    }
    await SyncTombstone.collection.insertMany(stones);
    const seen = new Set();
    let lastSync = new Date(t0.getTime() - 1000).toISOString(), biggest = 0;
    for (let i = 0; i < 50; i++) {
      const r = await get(`/pull?schoolId=${A}&limit=10&lastSync=${encodeURIComponent(lastSync)}`);
      const gone = (r.body?.data?.students ?? []).filter((s) => String(s._id).startsWith("gone-"));
      biggest = Math.max(biggest, gone.length);
      for (const s of gone) seen.add(String(s._id));
      lastSync = r.body?.timestamp;
      if (!r.body?.hasMore) break;
    }
    check(`every hard delete arrives (${seen.size}/30)`, seen.size === 30);
    check(`never more than the limit at once (largest: ${biggest})`, biggest <= 10);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4. /sync/changes: paged to exhaustion, each row exactly once ---");
  {
    const counts = new Map();
    let cursors = {}, pages = 0, biggest = 0, err = null;
    for (; pages < 100; ) {
      const qs = `?collections=student&limit=500` + (Object.keys(cursors).length ? `&cursors=${encodeURIComponent(JSON.stringify(cursors))}` : "");
      const r = await get(`/changes${qs}`);
      pages++;
      if (r.status !== 200) { err = `${r.status}`; break; }
      const slice = r.body.collections.student;
      biggest = Math.max(biggest, slice.documents.length);
      for (const d of slice.documents) counts.set(String(d._id), (counts.get(String(d._id)) ?? 0) + 1);
      cursors = { student: slice.cursor };
      if (!slice.hasMore) break;
    }
    check("every page answers 200", !err, err);
    check(`no page carries more than 500 (largest: ${biggest})`, biggest <= 500);
    const missing = [...allIds].filter((id) => !counts.has(id));
    const twice   = [...counts.entries()].filter(([, n]) => n > 1);
    check(`every pupil delivered (${pages} pages, ${missing.length} missing)`, missing.length === 0);
    check(`none delivered twice within the pass (${twice.length} duplicated)`, twice.length === 0, twice.slice(0, 3).join(" "));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
