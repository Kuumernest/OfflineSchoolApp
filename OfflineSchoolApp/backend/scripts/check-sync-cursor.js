// backend/scripts/check-sync-cursor.js
"use strict";

/**
 * Can a change fall permanently between two cursor positions?
 *
 * That is the question a sync feed lives or dies by, and it is the one that
 * ordinary testing never reaches: every individual request answers correctly,
 * the client believes it is up to date, and one row is simply never mentioned
 * again by anybody.
 *
 * The two clients read different feeds, so both are examined:
 *
 *   mobile   GET /sync/pull      six collections, a plain high-water mark
 *   desktop  GET /sync/changes   thirty-six, a keyset cursor of (updatedAt, _id)
 *
 * The interesting cases are the ones where updatedAt stops being a usable
 * position: rows sharing a millisecond, a page boundary landing in the middle
 * of such a group, and a write that lands while the pull is in flight. Each is
 * set up deliberately here rather than hoped for.
 *
 * The acceptance test is not "the request succeeded". It is: page to
 * exhaustion, then assert every seeded row was seen, exactly once for the
 * keyset feed and at least once for the high-water one — the mobile feed
 * re-sends by design, and re-sending is safe where skipping is not.
 *
 *   node scripts/check-sync-cursor.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User    = mongoose.model("User");
  const Student = mongoose.model("Student");
  const Class   = mongoose.model("Class");

  const A = "school-a";
  const B = "school-b";

  const mk = (id, role, schoolId, name) => User.create({
    _id: id, name, email: `${id}@example.test`, password: "check-only-password",
    role, schoolId, isActive: true,
  });
  await mk("adm-a", "school_admin", A, "Admin A");
  await mk("adm-b", "school_admin", B, "Admin B");
  await Class.create({ _id: "cls-a", schoolId: A, name: "Form 1" });
  await Class.create({ _id: "cls-b", schoolId: B, name: "Form 1 B" });

  /**
   * Rows whose updatedAt is set by hand, because the whole point is to make
   * timestamps collide. Mongoose stamps updatedAt itself, so it is overwritten
   * afterwards with a direct collection write.
   */
  const seedStudents = async (schoolId, classId, prefix, count, stampISO) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const _id = `${prefix}-${String(i).padStart(3, "0")}`;
      ids.push(_id);
      await Student.create({
        _id, userId: `u-${_id}`, schoolId, classId,
        studentName: `Pupil ${prefix} ${i}`, enrollmentNo: _id, isActive: true,
        status: "approved",
      });
    }
    if (stampISO) {
      await mongoose.connection.db.collection("students").updateMany(
        { _id: { $in: ids } },
        { $set: { updatedAt: new Date(stampISO) } }
      );
    }
    return ids;
  };

  const app = express();
  app.use(express.json());
  const auth = require(path.join(ROOT, "middleware/auth"));
  app.use("/api/sync", auth.authenticate, require(path.join(SRC, "routes/sync.routes")));
  const server = app.listen(0);
  const port   = server.address().port;

  const tok = (id, role, schoolId) =>
    jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const TOK = { a: tok("adm-a", "school_admin", A), b: tok("adm-b", "school_admin", B) };

  const get = async (who, p) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sync${p}`, {
      headers: { Authorization: `Bearer ${TOK[who]}` },
    });
    let body = {}; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // THE DESKTOP FEED — a keyset cursor, paged to exhaustion
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- /sync/changes: forty rows sharing one millisecond ---");

  // One timestamp for all forty, so updatedAt alone cannot order them and a
  // page boundary must fall inside the group.
  const COLLIDE = "2026-05-01T08:00:00.000Z";
  const seeded  = await seedStudents(A, "cls-a", "collide", 40, COLLIDE);

  const pageThrough = async (limit) => {
    const seen = [];
    let cursors = {};
    for (let page = 0; page < 200; page++) {
      const qs = `?collections=student&limit=${limit}` +
                 (Object.keys(cursors).length
                   ? `&cursors=${encodeURIComponent(JSON.stringify(cursors))}`
                   : "");
      const r = await get("a", `/changes${qs}`);
      if (r.status !== 200) return { seen, error: `${r.status} ${JSON.stringify(r.body).slice(0, 160)}` };

      const entry = r.body?.collections?.student;
      if (!entry) return { seen, error: "no student collection in the reply" };

      const docs = entry.documents ?? [];
      seen.push(...docs.map((d) => String(d._id)));
      if (!entry.hasMore || docs.length === 0) return { seen, pages: page + 1 };
      cursors = { student: entry.cursor ?? entry.nextCursor };
      if (!cursors.student) return { seen, error: "hasMore was true but no cursor came back" };
    }
    return { seen, error: "did not finish inside two hundred pages" };
  };

  const run = await pageThrough(7);   // 40 rows / 7 = boundaries inside the group

  if (!run.error) ok(`the feed pages to exhaustion (${run.pages} page(s), limit 7)`);
  else bad("the feed pages to exhaustion", run.error);

  const uniq = new Set(run.seen);
  const missed = seeded.filter((id) => !uniq.has(id));
  if (missed.length === 0) {
    ok("every one of the forty identical-timestamp rows was delivered");
  } else {
    bad("every identical-timestamp row is delivered",
      `${missed.length} row(s) fell between two cursor positions and would never ` +
      `be offered again: ${missed.slice(0, 6).join(", ")}`);
  }

  const dupes = run.seen.length - uniq.size;
  if (dupes === 0) ok("and none of them twice — the (updatedAt, _id) pair is a total order");
  else bad("no row is delivered twice", `${dupes} duplicate delivery(ies)`);

  // ── Paging must be stable whatever the page size ──────────────────────────
  console.log("\n--- the same rows at three different page sizes ---");

  for (const limit of [1, 13, 500]) {
    const r = await pageThrough(limit);
    const s = new Set(r.seen);
    const lost = seeded.filter((id) => !s.has(id));
    if (!r.error && lost.length === 0) ok(`limit ${String(limit).padStart(3)} delivers all forty`);
    else bad(`limit ${limit} delivers all forty`, r.error || `${lost.length} missing`);
  }

  // ── Replaying the same cursor ─────────────────────────────────────────────
  console.log("\n--- a cursor used twice, and a cursor from the far past ---");

  const first = await get("a", "/changes?collections=student&limit=5");
  const c1    = first.body?.collections?.student?.cursor
             ?? first.body?.collections?.student?.nextCursor;

  const again1 = await get("a", `/changes?collections=student&limit=5&cursors=${encodeURIComponent(JSON.stringify({ student: c1 }))}`);
  const again2 = await get("a", `/changes?collections=student&limit=5&cursors=${encodeURIComponent(JSON.stringify({ student: c1 }))}`);

  const ids1 = (again1.body?.collections?.student?.documents ?? []).map((d) => d._id);
  const ids2 = (again2.body?.collections?.student?.documents ?? []).map((d) => d._id);

  if (JSON.stringify(ids1) === JSON.stringify(ids2)) {
    ok("the same cursor twice returns the same page — replay is safe");
  } else {
    bad("the same cursor is idempotent", `${JSON.stringify(ids1)} then ${JSON.stringify(ids2)}`);
  }

  // ── Cursors that are wrong in every way a client can get them wrong ───────
  console.log("\n--- malformed, stale and foreign cursors ---");

  for (const [label, raw] of [
    ["garbage",              "not-a-cursor"],
    ["half a cursor",        JSON.stringify({ student: { at: COLLIDE } })],
    ["an id with no time",   JSON.stringify({ student: { id: "collide-000" } })],
    ["a future timestamp",   JSON.stringify({ student: { at: "2099-01-01T00:00:00.000Z", id: "z" } })],
    ["null",                 JSON.stringify({ student: null })],
  ]) {
    const r = await get("a", `/changes?collections=student&limit=5&cursors=${encodeURIComponent(raw)}`);
    if (r.status === 200) ok(`a ${label} cursor is answered, not crashed on (${r.status})`);
    else bad(`a ${label} cursor is answered`, `${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
  }

  // A half cursor must be treated as no cursor — the broken design the header
  // note warns about is a timestamp with no id.
  const half = await get("a", `/changes?collections=student&limit=500&cursors=${encodeURIComponent(JSON.stringify({ student: { at: COLLIDE } }))}`);
  const halfDocs = half.body?.collections?.student?.documents ?? [];
  if (halfDocs.length >= 40) {
    ok("a cursor missing its id half is discarded rather than half-applied");
  } else {
    bad("a half cursor is discarded",
      `${halfDocs.length} row(s) came back; a partially-applied cursor silently ` +
      "skips everything sharing its timestamp.");
  }

  // ── Another school's cursor ───────────────────────────────────────────────
  await seedStudents(B, "cls-b", "other", 3, COLLIDE);

  const foreign = await get("b", `/changes?collections=student&limit=500&cursors=${encodeURIComponent(JSON.stringify({ student: { at: "2000-01-01T00:00:00.000Z", id: "collide-000" } }))}`);
  const foreignDocs = foreign.body?.collections?.student?.documents ?? [];
  const leaked = foreignDocs.filter((d) => String(d._id).startsWith("collide"));

  if (leaked.length === 0) ok("a cursor naming another school's row leaks nothing of that school");
  else bad("a foreign cursor leaks nothing", `${leaked.length} row(s) of school A reached school B`);

  // ── A write that lands while the pull is in flight ────────────────────────
  console.log("\n--- a row written after the cursor was issued ---");

  const before = await get("a", "/changes?collections=student&limit=500");
  const cAll   = before.body?.collections?.student?.cursor
              ?? before.body?.collections?.student?.nextCursor;

  await seedStudents(A, "cls-a", "late", 1, null);   // stamped now, after the cursor

  const after = await get("a", `/changes?collections=student&limit=500&cursors=${encodeURIComponent(JSON.stringify({ student: cAll }))}`);
  const afterIds = (after.body?.collections?.student?.documents ?? []).map((d) => String(d._id));

  if (afterIds.includes("late-000")) ok("a row written after the cursor is offered on the next pull");
  else bad("a row written after the cursor is offered next time", JSON.stringify(afterIds).slice(0, 160));

  // ═══════════════════════════════════════════════════════════════════════════
  // THE MOBILE FEED — a plain high-water mark
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- /sync/pull: the high-water mark ---");

  const pull = async (lastSync) =>
    get("a", `/pull?schoolId=${A}${lastSync ? `&lastSync=${encodeURIComponent(lastSync)}` : ""}`);

  const p1 = await pull(null);
  if (p1.status === 200) ok(`an initial pull answers (${p1.status})`);
  else bad("an initial pull answers", `${p1.status} ${JSON.stringify(p1.body).slice(0, 160)}`);

  // The pull returns { success, data: {...}, timestamp } and `timestamp` is
  // the cursor — pulledAt, stamped before the queries run.
  const cursorField = p1.body?.timestamp;
  if (cursorField) ok("and hands back a cursor for next time");
  else bad("it hands back a cursor", Object.keys(p1.body ?? {}).join(", "));

  // The property the header comment claims: the cursor is stamped BEFORE the
  // queries, so a row written during the pull is re-sent rather than skipped.
  const seenFirst = new Set(
    ((p1.body?.students ?? p1.body?.data?.students ?? [])).map((s) => String(s._id ?? s.id))
  );
  await seedStudents(A, "cls-a", "during", 1, cursorField);   // exactly ON the cursor

  const p2 = await pull(cursorField);
  const seenSecond = new Set(
    ((p2.body?.students ?? p2.body?.data?.students ?? [])).map((s) => String(s._id ?? s.id))
  );

  if (seenFirst.has("during-000") || seenSecond.has("during-000")) {
    ok("a row stamped exactly on the cursor is delivered by one pull or the other");
  } else {
    bad("a row stamped exactly on the cursor is delivered",
      "it was in neither pull. A row whose updatedAt equals the cursor to the " +
      "millisecond is excluded by $gt next time, so if the query missed it once " +
      "it is never offered again — the failure this whole suite exists to find.");
  }

  // A garbage cursor must mean "everything", not "nothing".
  const pBad = await pull("not-a-date");
  const badRows = (pBad.body?.students ?? pBad.body?.data?.students ?? []).length;
  if (pBad.status === 200 && badRows > 0) {
    ok("an unparseable cursor falls back to a full pull rather than an empty one");
  } else {
    bad("an unparseable cursor means everything, not nothing",
      `${pBad.status} with ${badRows} row(s) — a client with a corrupt cursor would ` +
      "sit there believing it is up to date.");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // A DEVICE THAT HAS BEEN OFF FOR A MONTH
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The cursor is a position, not a subscription, so nothing expires and there
  // is no window to miss. What actually goes wrong at this scale is size: a
  // month of changes asked for in one request is a payload a bad line cannot
  // carry, and a timeout mid-download means starting again from the same
  // cursor for ever.
  console.log("\n--- reconnecting after a month away ---");

  const BULK = 2000;
  const bulk = [];
  for (let i = 0; i < BULK; i++) {
    bulk.push({
      _id: `month-${String(i).padStart(4, "0")}`, userId: `u-month-${i}`,
      schoolId: A, classId: "cls-a", studentName: `Pupil ${i}`,
      enrollmentNo: `M-${i}`, isActive: true, status: "approved",
    });
  }
  await Student.insertMany(bulk, { ordered: false });

  const t0 = Date.now();
  const catchUp = await pageThrough(500);
  const ms = Date.now() - t0;

  const caught = new Set(catchUp.seen);
  const absent = bulk.filter((b) => !caught.has(b._id));

  if (!catchUp.error && absent.length === 0) {
    ok(`a month of changes is delivered in full (${catchUp.seen.length} rows, ${catchUp.pages} pages, ${ms} ms)`);
  } else {
    bad("a month of changes is delivered in full",
      catchUp.error || `${absent.length} row(s) never arrived`);
  }

  // The page ceiling is what keeps a single response carryable. If limit is
  // ignored, a device coming back after a month asks for everything at once.
  const { MAX_LIMIT, DEFAULT_LIMIT } = require(path.join(SRC, "controllers/syncFeed.controller"));

  const oneBig  = await get("a", "/changes?collections=student&limit=99999");
  const bigDocs = oneBig.body?.collections?.student?.documents?.length ?? 0;
  const total   = 2042;   // the month's rows plus everything seeded before them

  if (bigDocs <= (MAX_LIMIT ?? 2000) && bigDocs < total) {
    ok(`a request for everything is capped at ${bigDocs} rows (ceiling ${MAX_LIMIT ?? 2000}, default ${DEFAULT_LIMIT ?? 500})`);
  } else {
    bad("a request for everything is capped",
      `${bigDocs} rows in one response against a ceiling of ${MAX_LIMIT}. On a ` +
      "school's connection an uncapped response is a download that times out " +
      "and restarts from the same cursor for ever.");
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
