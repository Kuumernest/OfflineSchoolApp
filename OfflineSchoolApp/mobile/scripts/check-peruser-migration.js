// mobile/scripts/check-peruser-migration.js
"use strict";

/**
 * Per-user local data on a shared phone — the migration (docs/40 §8).
 *
 * The REAL modules (db/database.js, db/deviceDb.js, services/perUserData,
 * syncBackfill, mutationQueue, the real zustand auth store with its real
 * online/offline sign-in) over real SQLite FILES on disk (node:sqlite), one
 * temp directory per phone (scripts/peruser-harness.js). The network sync of a
 * new store is the one thing stood in for here (a hook that writes the rows a
 * pull would); check-peruser-e2e.js runs it for real against the backend.
 *
 * The legacy file is built the way an existing install has it: four accounts
 * signed in over time (credentials in `users`), queued outbox rows of three
 * of them, one queued before owners were recorded, dirty rows with and
 * without author evidence, and clean mirror rows.
 *
 *   1  switch off: nothing created, nothing gated, the shared file unchanged
 *   2  switch on: placement exactly as decided (D1, D2, outbox, credentials),
 *      the review list, and a row-for-row accounting proof across every file
 *   3  review actions: assign, send-as-me (confirmed), save a copy; admin only
 *   4  a crash after EVERY journal step and row move, then a re-run: the same
 *      final state as an uninterrupted run, no duplicates
 *   5  an offline upgrade changes nothing visible; the shared file is still read
 *   6  offline sign-in keeps working for every account that had it
 *   7  five stores; LRU eviction only of a store with no unsent work; a sixth
 *      sign-in is refused, with nothing evicted, when all five hold work
 *   8  D3: refused while anything is unplaced or before 30 days; allowed after
 *   9  the legacy backfill gate: an unflipped account sends only its own rows
 *  10  switch turned off again: back to the shared file only once clean
 *
 *   node scripts/check-peruser-migration.js
 */

const fs   = require("fs");
const path = require("path");
const { bootDevice, tmpDir, quietly } = require("./peruser-harness");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

const SCHOOL = "5c0e2e000000000000000001";
const PW = "pass-1234";
const ACCOUNTS = {
  "tea-a": { name: "Ama",   email: "ama@s.test",   role: "teacher" },
  "tea-b": { name: "Kofi",  email: "kofi@s.test",  role: "teacher" },
  "adm-c": { name: "Head",  email: "head@s.test",  role: "school_admin" },
  "stu-d": { name: "Esi",   enrollmentNo: "ENR-D", role: "student" },
};
for (let i = 1; i <= 7; i++) ACCOUNTS[`u${i}`] = { name: `User ${i}`, email: `u${i}@s.test`, role: "teacher" };
const userOf = (id) => ({ _id: id, id, schoolId: SCHOOL, ...ACCOUNTS[id] });

/** The server's /auth/login, as far as the phone's sign-in needs it. */
const server = { perUserLocalData: false, logins: 0 };
global.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || "{}");
  const id = Object.keys(ACCOUNTS).find((k) =>
    (body.email && ACCOUNTS[k].email === body.email) || (body.enrollmentNo && ACCOUNTS[k].enrollmentNo === body.enrollmentNo));
  const ok = String(url).endsWith("/auth/login") && id && body.password === PW;
  server.logins++;
  return {
    ok, status: ok ? 200 : 401,
    json: async () => ok
      ? { success: true, token: `tok-${id}`, refreshToken: `ref-${id}`, user: userOf(id), localData: { perUserLocalData: server.perUserLocalData } }
      : { success: false, message: "Invalid email or password" },
  };
};
const noNetworkApi = new Proxy({}, { get: () => async () => { throw Object.assign(new Error("no network in this check"), { code: "ERR_NETWORK" }); } });

const waitIdle = async (phone) => {
  for (let i = 0; i < 400 && phone.useAuthStore.getState().localDataPhase !== "idle"; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A launch of the app over `dir`, with the pull of a new store stood in for. */
const launch = async (dir, { crashAt = null, onReach = null } = {}) => {
  const phone = await bootDevice({ dir, api: noNetworkApi });
  const LD = phone.load("src/services/perUserData.service");
  const { getDatabase } = phone.load("src/db/database");
  let n = 0;
  LD.__setTestHooks({
    skipQuiesce: true,
    now: () => new Date(Date.now() + (phone.clockDays ?? 0) * 86_400_000),
    afterStep: async (name) => {
      n++;
      onReach?.(name);
      if (crashAt !== null && n >= crashAt) {
        // The process dies here: every connection closes with whatever was
        // uncommitted rolled back, and nothing after this point is written.
        phone.crashed = true;
        phone.kill();
        throw Object.assign(new Error(`crash after ${name}`), { __testCrash: true });
      }
    },
    // What the first full sync of a new store does that matters here: the
    // account's own copy of the server's rows arrives. Nothing from the
    // shared mirror.
    prime: async () => {
      const db = await getDatabase();
      const me = phone.useAuthStore.getState().user?.id;
      await db.runAsync(
        "INSERT OR REPLACE INTO students (id, name, schoolId) VALUES (?, ?, ?)",
        [`pulled-for-${me}`, `pulled for ${me}`, SCHOOL]
      );
      return phone.primeOutcome ?? "completed";
    },
  });
  phone.LD = LD;
  phone.db = getDatabase;
  phone.reached = () => n;
  return phone;
};

const login = async (phone, id, { password = PW } = {}) => {
  const ok = await phone.useAuthStore.getState().login(
    ACCOUNTS[id].enrollmentNo ? { enrollmentNo: ACCOUNTS[id].enrollmentNo, password } : { email: ACCOUNTS[id].email, password }
  );
  await waitIdle(phone);
  return ok;
};
const logout = (phone) => phone.useAuthStore.getState().logout();

// ═════════════════════════════════════════════════════════════════════════════
// THE LEGACY INSTALL
// ═════════════════════════════════════════════════════════════════════════════

const buildLegacy = quietly(async (dir) => {
  server.perUserLocalData = false;
  const phone = await launch(dir);
  const { getDatabase } = phone.load("src/db/database");
  const db = await getDatabase();
  await phone.load("src/db/quizSchema").ensureQuizTables(db, { log: { log() {}, warn() {} } });
  const { SyncManager } = phone.load("src/services/syncManager");
  for (const step of ["migrateLocalDatabase", "migrateUsersTable", "migrateClassesTable", "migrateSubjectsTable",
                      "migrateAssignmentsTable", "migrateAnnouncementsTable", "migrateQuizTables"]) {
    await SyncManager[step]?.().catch?.(() => {});
  }
  const { MutationQueue } = phone.load("src/services/mutationQueue.service");
  await MutationQueue.getStats();

  // Four people have signed in on this phone before (offline credentials).
  for (const id of ["tea-a", "tea-b", "adm-c", "stu-d"]) { await login(phone, id); await logout(phone); }

  // Clean mirror rows somebody pulled.
  for (const s of ["s1", "s2", "s3"]) {
    await db.runAsync("INSERT INTO students (id, name, schoolId) VALUES (?, ?, ?)", [s, `Pupil ${s}`, SCHOOL]);
  }
  await db.runAsync("INSERT INTO classes (id, name, schoolId, _synced) VALUES ('cls-clean', 'Form 1', ?, 1)", [SCHOOL]);

  // Dirty rows made by an older build: nobody signed in → no owner stamp.
  const ann = (id, author, title) => db.runAsync(
    `INSERT INTO announcements (id, title, body, author_id, school_id, _synced, _operation, created_at, updated_at)
     VALUES (?, ?, 'b', ?, ?, 0, 'create', '2026-10-01', '2026-10-01')`, [id, title, author, SCHOOL]);
  await ann("ann-a", "tea-a", "Trip to the museum");        // author A, known → A
  await ann("ann-x", "someone-else", "Sports day");         // author unknown → held
  await db.runAsync(
    `INSERT INTO quizzes (id, title, class_id, subject_id, created_by, _synced, schoolId)
     VALUES ('quiz-b', 'Fractions', 'cls-clean', 'sub-m', 'tea-b', 0, ?)`, [SCHOOL]);   // author B
  await db.runAsync("INSERT INTO quiz_questions (id, quiz_id, question_id, display_order) VALUES ('qq-b1', 'quiz-b', 'qst-1', 0)");
  await db.runAsync("INSERT INTO classes (id, name, schoolId, _synced) VALUES ('cls-x', 'Form 6', ?, 0)", [SCHOOL]); // no evidence → held
  await db.runAsync(
    "INSERT INTO subjects (id, name, class_id, classId, schoolId, _synced) VALUES ('sub-1', 'Physics', 'cls-clean', 'cls-clean', ?, 0)", [SCHOOL]);

  // Rows made since the owner stamp shipped: A was signed in → stamped A.
  phone.setSession(userOf("tea-a"));
  await db.runAsync("INSERT INTO classes (id, name, schoolId, _synced) VALUES ('cls-a', 'Form 2A', ?, 0)", [SCHOOL]);

  // Queued requests: A ×2 (one refused), B ×1, C ×1 covering sub-1, one
  // queued before owners were recorded, and an old one already sent.
  const q = (entityKey, ownerId, payload = {}) => MutationQueue.enqueue({ entityKey, method: "POST", endpoint: "/x", payload, ownerId });
  const a1 = await q("homework:h1", "tea-a", { title: "Read ch. 3" });
  const a2 = await q("homework:h2", "tea-a", { title: "Essay" });
  await db.runAsync("UPDATE mutation_outbox SET status = 'failed', retry_count = 8, error = 'refused', last_status = 422 WHERE id = ?", [a2]);
  await db.runAsync("UPDATE mutation_outbox SET idem_key = 'idem-a1-retry' WHERE id = ?", [a1]);
  await q("homework:h3", "tea-b", { title: "Map work" });
  await q("subject:sub-1", "adm-c", { __local: { table: "subjects", ids: ["sub-1"] } });
  await db.runAsync(
    `INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, silent, owner_id)
     VALUES ('legacy-null', 'attendance:old', 'POST', '/attendance', '{"n":1}', 'pending', 0, '2026-01-01', 0, NULL)`);
  const old = await q("homework:h0", "tea-a", { title: "done" });
  await db.runAsync("UPDATE mutation_outbox SET status = 'synced' WHERE id = ?", [old]);
  phone.useAuthStore.setState({ user: null, token: null });
  phone.kill();
});

/** Every unsent row of the legacy file, by content: what must not be lost. */
const legacyLedger = (phone, LD) => {
  const L = phone.inspect("schoolapp.db");
  const out = [];
  for (const r of L.all("SELECT * FROM mutation_outbox WHERE status != 'synced'")) out.push(`outbox|${r.id}|${LD.outboxHash(r)}`);
  const sel = [
    ["announcements", "id", "_synced = 0 AND _operation IS NOT NULL"],
    ["quizzes", "id", "(_synced = 0 OR _synced IS NULL) AND (deleted_at IS NULL OR deleted_at = '')"],
    ["classes", "id", "(_synced = 0 OR _synced IS NULL) AND (deleted_at IS NULL OR deleted_at = '')"],
    ["subjects", "id", "(_synced = 0 OR _synced IS NULL) AND (deleted_at IS NULL OR deleted_at = '')"],
  ];
  for (const [t, idc, w] of sel) for (const r of L.all(`SELECT * FROM ${t} WHERE ${w}`)) out.push(`dirty|${t}|${r[idc]}|${LD.dirtyHash(r)}`);
  L.close();
  return out.sort();
};

/** Where each ledger entry is now, across every file. */
const locate = (phone, LD, ledger) => {
  const files = fs.readdirSync(phone.dir).filter((f) => /^schoolapp\.u_.*\.db$/.test(f));
  const dev = phone.inspect("device.db");
  const review = dev.all("SELECT * FROM review_items");
  const found = {};
  for (const entry of ledger) {
    const [kind, a, b, c] = entry.split("|");
    const places = [];
    for (const f of files) {
      const S = phone.inspect(f);
      if (kind === "outbox") {
        const r = S.one("SELECT * FROM mutation_outbox WHERE id = ?", [a]);
        if (r && LD.outboxHash(r) === b) places.push(f);
      } else {
        const r = S.one(`SELECT * FROM ${a} WHERE id = ?`, [b]);
        if (r && LD.dirtyHash(r) === c) places.push(f);
      }
      S.close();
    }
    const rid = kind === "outbox" ? `outbox:mutation_outbox:${a}` : `dirty:${a}:${b}`;
    const it = review.find((x) => x.id === rid);
    if (it && it.hash === (kind === "outbox" ? b : c) && it.status !== "placed") places.push("review");
    found[entry] = places;
  }
  dev.close();
  return found;
};

const copyDir = (from) => { const to = tmpDir("copy"); for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f)); return to; };

/** The state that must be identical however many times a run was killed. */
const snapshot = (phone, LD) => {
  const out = {};
  for (const f of fs.readdirSync(phone.dir).filter((x) => x.endsWith(".db")).sort()) {
    const S = phone.inspect(f);
    const has = (t) => !!S.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t]);
    if (f === "device.db") {
      out[f] = {
        review: S.all("SELECT id, status, hash FROM review_items ORDER BY id"),
        placements: S.all("SELECT kind, tbl, row_id, hash, dest FROM placements ORDER BY kind, tbl, row_id"),
        attribution: S.all("SELECT tbl, row_id, owner_id, evidence FROM attribution ORDER BY tbl, row_id"),
        stores: S.all("SELECT user_id, file, primed_at IS NOT NULL AS primed, switched_at IS NOT NULL AS switched FROM stores ORDER BY user_id"),
        credentials: S.all("SELECT user_id FROM credentials ORDER BY user_id").map((r) => r.user_id),
      };
    } else {
      out[f] = {
        outbox: has("mutation_outbox") ? S.all("SELECT * FROM mutation_outbox ORDER BY id").map((r) => [r.id, LD.outboxHash(r), r.owner_id, r.status]) : [],
        outboxDupes: has("mutation_outbox") ? S.one("SELECT COUNT(*) - COUNT(DISTINCT id) AS n FROM mutation_outbox").n : 0,
        archive: has("mutation_outbox_migrated") ? S.all("SELECT id FROM mutation_outbox_migrated ORDER BY id").map((r) => r.id) : [],
        dirty: ["announcements", "quizzes", "classes", "subjects"].filter(has).flatMap((t) =>
          S.all(`SELECT * FROM ${t} WHERE _synced = 0 OR _synced IS NULL`).map((r) => `${t}:${r.id}:${LD.dirtyHash(r)}:${r._owner_id ?? ""}`)).sort(),
        children: has("quiz_questions") ? S.all("SELECT id, quiz_id FROM quiz_questions ORDER BY id") : [],
        students: has("students") ? S.all("SELECT id FROM students ORDER BY id").map((r) => r.id) : [],
      };
    }
    S.close();
  }
  return out;
};

// ═════════════════════════════════════════════════════════════════════════════

(async () => {
  const FIXTURE = tmpDir("fixture");
  await buildLegacy(FIXTURE);

  // ── 1. Switch off ──────────────────────────────────────────────────────────
  console.log("--- 1. switch off: today's behaviour, exactly ---");
  {
    const dir = copyDir(FIXTURE);
    const phone = await launch(dir);
    const before = (() => { const L = phone.inspect("schoolapp.db"); const r = L.all("SELECT * FROM mutation_outbox ORDER BY id"); L.close(); return r; })();
    // Every row of every table except `users` (whose credential row an online
    // sign-in rewrites — as it always has).
    const dumpAll = () => {
      const L = phone.inspect("schoolapp.db");
      const out = {};
      for (const { name } of L.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'users' ORDER BY name")) {
        out[name] = L.all(`SELECT * FROM "${name}" ORDER BY rowid`);
      }
      out.__schema = L.all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
      L.close();
      return JSON.stringify(out);
    };
    const allBefore = dumpAll();
    server.perUserLocalData = false;
    const ok = await quietly(login)(phone, "tea-a");
    check("sign-in works", ok, true);
    check("no device.db is created", phone.exists("device.db"), false);
    check("no per-user file is created", fs.readdirSync(dir).filter((f) => f.startsWith("schoolapp.u_")), []);
    check("the shared file is the active one", phone.load("src/db/database").activeDatabaseName(), "schoolapp.db");
    check("nothing per-user is written to SecureStore either",
      Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "securestore.json"), "utf8"))).filter((k) => k.startsWith("peruser")), []);
    check("the backfill is not gated", await phone.LD.legacyBackfillGate(await phone.db()), null);
    const after = (() => { const L = phone.inspect("schoolapp.db"); const r = L.all("SELECT * FROM mutation_outbox ORDER BY id"); L.close(); return r; })();
    check("the outbox is byte-for-byte unchanged", JSON.stringify(after), JSON.stringify(before));
    check("every other table and the schema are unchanged by sign-in", dumpAll() === allBefore, true);
    const res = await quietly(() => phone.load("src/services/syncBackfill.service").backfillOutbox())();
    const L = phone.inspect("schoolapp.db");
    // Today's behaviour, warts and all: the next account to sync queues the
    // ownerless announcement as its own (docs/40 D10) — the switch is what changes it.
    check("…and, as today, the ownerless announcement is queued under whoever syncs",
      L.one("SELECT owner_id FROM mutation_outbox WHERE entity_key = 'announcement:ann-x'")?.owner_id, "tea-a");
    L.close();
    check("…and nothing per-user was written by the backfill either", phone.exists("device.db"), false);
    void res;
    await quietly(logout)(phone);
    check("logout leaves the shared file active", phone.load("src/db/database").activeDatabaseName(), "schoolapp.db");
    phone.kill();
  }

  // ── 2. Switch on: the migration ────────────────────────────────────────────
  console.log("--- 2. switch on: placement exactly as decided, and nothing lost ---");
  const MIGRATED = copyDir(FIXTURE);
  let reference = null;
  let stepNames = [];
  {
    const phone = await launch(MIGRATED, { onReach: (n) => stepNames.push(n) });
    const ledger = legacyLedger(phone, phone.LD);
    check("the legacy file holds 5 unsent outbox rows and 6 dirty rows", [ledger.filter((x) => x.startsWith("outbox")).length, ledger.filter((x) => x.startsWith("dirty")).length], [5, 6]);
    server.perUserLocalData = true;
    check("A signs in (online, switch on)", await quietly(login)(phone, "tea-a"), true);
    const A = phone.LD.storeFileFor("tea-a");
    check("A's own file is now the active one", phone.load("src/db/database").activeDatabaseName(), A);

    const dev = phone.inspect("device.db");
    check("credentials of every account that had them are in device.db",
      dev.all("SELECT user_id FROM credentials ORDER BY user_id").map((r) => r.user_id), ["adm-c", "stu-d", "tea-a", "tea-b"]);
    check("attribution by the decided evidence order (outbox → author → stamp → hold)",
      dev.all("SELECT tbl, row_id, owner_id, evidence FROM attribution ORDER BY tbl, row_id").map((r) => [r.tbl, r.row_id, r.owner_id, r.evidence]),
      [["announcements", "ann-a", "tea-a", "author:author_id"], ["announcements", "ann-x", null, "none"],
       ["classes", "cls-a", "tea-a", "owner-stamp"], ["classes", "cls-x", null, "none"],
       ["quizzes", "quiz-b", "tea-b", "author:created_by"], ["subjects", "sub-1", "adm-c", "outbox"]]);
    check("the review list holds the two rows with no evidence and the ownerless outbox row",
      dev.all("SELECT id, status, reason FROM review_items ORDER BY id").map((r) => [r.id, r.status, r.reason]),
      [["dirty:announcements:ann-x", "held", "none"], ["dirty:classes:cls-x", "held", "none"], ["outbox:mutation_outbox:legacy-null", "held", "no-owner-recorded"]]);
    dev.close();

    const S = phone.inspect(A);
    check("A's queued requests are in A's file, same ids, same Idempotency-Key, statuses kept",
      S.all("SELECT entity_key, owner_id, status, idem_key FROM mutation_outbox ORDER BY entity_key").map((r) => [r.entity_key, r.owner_id, r.status, r.idem_key]),
      [["homework:h1", "tea-a", "pending", "idem-a1-retry"], ["homework:h2", "tea-a", "failed", null]]);
    check("A's changes (author evidence, owner stamp) are in A's file, still unsent, owned by A",
      S.all("SELECT id, _owner_id FROM announcements WHERE _synced = 0 UNION ALL SELECT id, _owner_id FROM classes WHERE _synced = 0 ORDER BY 1").map((r) => [r.id, r._owner_id]),
      [["ann-a", "tea-a"], ["cls-a", "tea-a"]]);
    check("D1: none of the shared mirror came along — only A's own pull",
      S.all("SELECT id FROM students ORDER BY id").map((r) => r.id), ["pulled-for-tea-a"]);
    check("…and nobody else's changes", S.all("SELECT id FROM quizzes").length + S.all("SELECT id FROM subjects WHERE _synced = 0").length, 0);
    S.close();

    const L = phone.inspect("schoolapp.db");
    check("in the shared file, A's requests left the live outbox only after being archived",
      [L.all("SELECT id FROM mutation_outbox WHERE owner_id = 'tea-a' AND status != 'synced'").length,
       L.all("SELECT migrated_dest FROM mutation_outbox_migrated").map((r) => r.migrated_dest)],
      [0, ["store:tea-a", "store:tea-a"]]);
    check("B's and C's requests stay in the shared file until they sign in (never sent as A)",
      L.all("SELECT owner_id FROM mutation_outbox WHERE status != 'synced' ORDER BY owner_id").map((r) => r.owner_id), [null, "adm-c", "tea-b"]);
    check("the shared mirror itself is untouched", L.all("SELECT id FROM students ORDER BY id").map((r) => r.id), ["s1", "s2", "s3"]);
    L.close();

    let acc = await phone.LD.accountLegacy({ verifyFiles: true });
    check("accounting after A: placed 4, review 3, waiting for their owner 4, unplaced 0",
      acc.totals, { placed: 4, review: 3, "waiting-owner": 4, unplaced: 0 });

    await quietly(logout)(phone);
    check("sign-out returns to the shared file", phone.load("src/db/database").activeDatabaseName(), "schoolapp.db");
    check("B signs in", await quietly(login)(phone, "tea-b"), true);
    const SB = phone.inspect(phone.LD.storeFileFor("tea-b"));
    check("B's quiz and its question link went to B's file, B's request too",
      [SB.all("SELECT id, _owner_id FROM quizzes").map((r) => [r.id, r._owner_id]), SB.all("SELECT id FROM quiz_questions").map((r) => r.id),
       SB.all("SELECT entity_key FROM mutation_outbox").map((r) => r.entity_key)],
      [[["quiz-b", "tea-b"]], ["qq-b1"], ["homework:h3"]]);
    SB.close();
    await quietly(logout)(phone);
    check("C signs in", await quietly(login)(phone, "adm-c"), true);
    acc = await phone.LD.accountLegacy({ verifyFiles: true });
    check("accounting after everyone: placed 8, review 3, waiting 0, unplaced 0",
      acc.totals, { placed: 8, review: 3, "waiting-owner": 0, unplaced: 0 });

    const where = locate(phone, phone.LD, ledger);
    check("row-for-row: every one of the 11 legacy rows is in exactly one place, same content hash",
      Object.values(where).map((p) => p.length), ledger.map(() => 1));
    check("…the right place for each",
      Object.fromEntries(Object.entries(where).map(([k, v]) => [k.split("|").slice(0, 3).join("|"), v[0].replace(/^schoolapp\.u_(.*)\.db$/, "$1")])),
      Object.fromEntries(ledger.map((k) => {
        const key = k.split("|").slice(0, 3).join("|");
        const owner = {
          "dirty|announcements|ann-a": "tea-a", "dirty|classes|cls-a": "tea-a", "dirty|announcements|ann-x": "review",
          "dirty|classes|cls-x": "review", "dirty|quizzes|quiz-b": "tea-b", "dirty|subjects|sub-1": "adm-c",
        }[key];
        if (owner) return [key, owner];
        const L2 = phone.inspect("schoolapp.db");
        const r = L2.one("SELECT owner_id FROM mutation_outbox_migrated WHERE id = ?", [k.split("|")[1]]) ?? L2.one("SELECT owner_id FROM mutation_outbox WHERE id = ?", [k.split("|")[1]]);
        L2.close();
        return [key, r?.owner_id ?? "review"];
      })));
    await quietly(logout)(phone);
    reference = snapshot(phone, phone.LD);
    phone.kill();
  }

  // ── 3. Review actions ──────────────────────────────────────────────────────
  console.log("--- 3. the review list: visible, actionable by an admin, nothing dropped ---");
  {
    const dir = copyDir(MIGRATED);
    const phone = await launch(dir);
    server.perUserLocalData = true;
    await quietly(login)(phone, "tea-a");
    const list = await phone.LD.listReview();
    check("everyone can see the held list", list.map((i) => i.id).length, 3);
    check("a teacher cannot act on it", await phone.LD.assignReviewItem("dirty:classes:cls-x", "adm-c", { by: userOf("tea-a") }), { ok: false, reason: "notAllowed" });
    const copy = JSON.parse(await phone.LD.exportReviewItem("dirty:announcements:ann-x"));
    check("save a copy: the full row", [copy.table, copy.content.title, copy.content.author_id], ["announcements", "Sports day", "someone-else"]);
    await quietly(logout)(phone);
    await quietly(login)(phone, "adm-c");
    const admin = userOf("adm-c");
    check("send as me needs an explicit confirmation", await phone.LD.sendReviewItemAsMe("outbox:mutation_outbox:legacy-null", { by: admin }), { ok: false, reason: "notConfirmed" });
    check("send as me, confirmed", await quietly(phone.LD.sendReviewItemAsMe)("outbox:mutation_outbox:legacy-null", { by: admin, confirmed: true }), { ok: true });
    check("assign a held class to an account", await quietly(phone.LD.assignReviewItem)("dirty:classes:cls-x", "adm-c", { by: admin }), { ok: true });
    check("an unknown account is refused", await phone.LD.assignReviewItem("dirty:announcements:ann-x", "nobody", { by: admin }), { ok: false, reason: "unknownAccount" });
    const C = phone.inspect(phone.LD.storeFileFor("adm-c"));
    check("the ownerless request is now the admin's, same id (same Idempotency-Key on send)",
      C.one("SELECT id, owner_id, status FROM mutation_outbox WHERE id = 'legacy-null'"), { id: "legacy-null", owner_id: "adm-c", status: "pending" });
    check("the held class is in the admin's file as an unsent change", C.one("SELECT id, _synced, _owner_id FROM classes WHERE id = 'cls-x'"), { id: "cls-x", _synced: 0, _owner_id: "adm-c" });
    C.close();
    check("the list shows what was decided, and keeps the rest",
      (await phone.LD.listReview()).map((i) => [i.id, i.status, i.action]).sort(),
      [["dirty:announcements:ann-x", "held", null], ["dirty:classes:cls-x", "placed", "assign"], ["outbox:mutation_outbox:legacy-null", "placed", "send-as-me"]]);
    const acc = await phone.LD.accountLegacy({ verifyFiles: true });
    check("still nothing unplaced", [acc.totals.unplaced, acc.totals.review, acc.totals.placed], [0, 1, 10]);
    await quietly(logout)(phone);
    phone.kill();
  }

  // ── 4. A crash after every step ────────────────────────────────────────────
  console.log("--- 4. killed after every step, re-run: same final state, no duplicates ---");
  {
    const points = stepNames.length;
    check("the uninterrupted run passes through every step", points >= 12, true);
    let identical = 0;
    const differing = [];
    for (let k = 1; k <= points; k++) {
      const dir = copyDir(FIXTURE);
      let phone = await launch(dir, { crashAt: k });
      server.perUserLocalData = true;
      // The same sequence as the uninterrupted run (section 2), killed at step k…
      await quietly(async () => {
        for (const id of ["tea-a", "tea-b", "adm-c"]) {
          if (phone.crashed) break;
          try { await login(phone, id); await logout(phone); } catch { /* dead */ }
        }
      })();
      if (!phone.crashed) { differing.push(`${k}:no-crash`); continue; }
      phone.kill();
      // …and the next launch runs it again from the start.
      phone = await launch(dir);
      for (const id of ["tea-a", "tea-b", "adm-c"]) { await quietly(login)(phone, id); await quietly(logout)(phone); }
      const got = snapshot(phone, phone.LD);
      // Timestamps aside, the state must equal the uninterrupted run's.
      if (JSON.stringify(got) === JSON.stringify(reference)) identical++;
      else differing.push(`${k}:${stepNames[k - 1]}`);
      phone.kill();
    }
    check(`all ${points} crash points converge to the uninterrupted state`, differing, []);
    check("…counted", identical, points);
    check("no outbox file holds a duplicate row", Object.values(reference).every((f) => !f.outboxDupes), true);
  }

  // ── 5. Offline upgrade ─────────────────────────────────────────────────────
  console.log("--- 5. an upgrade that happens offline changes nothing visible ---");
  {
    const dir = copyDir(FIXTURE);
    const phone = await launch(dir);
    await phone.LD.rememberSchoolSwitch(SCHOOL, true);   // learnt at an earlier refresh
    phone.net.connected = false;
    check("A signs in offline", await quietly(login)(phone, "tea-a"), true);
    check("the shared file stays active", phone.load("src/db/database").activeDatabaseName(), "schoolapp.db");
    check("no store is created offline", fs.readdirSync(dir).filter((f) => f.startsWith("schoolapp.u_")), []);
    const db = await phone.db();
    check("A still reads exactly what the phone held", (await db.getAllAsync("SELECT id FROM students ORDER BY id")).map((r) => r.id), ["s1", "s2", "s3"]);
    const L = phone.inspect("schoolapp.db");
    check("the shared outbox is untouched", L.all("SELECT COUNT(*) AS n FROM mutation_outbox WHERE status != 'synced'")[0].n, 5);
    L.close();
    check("no first sync is attempted (no preparing screen)", phone.useAuthStore.getState().localDataPhase, "idle");
    await quietly(logout)(phone);
    phone.net.connected = true;
    server.perUserLocalData = true;
    await quietly(login)(phone, "tea-a");
    check("online again: the switch flips after the first full sync", phone.load("src/db/database").activeDatabaseName(), phone.LD.storeFileFor("tea-a"));
    await quietly(logout)(phone);
    phone.kill();
  }
  {
    const dir = copyDir(FIXTURE);
    const phone = await launch(dir);
    phone.primeOutcome = "failed";
    server.perUserLocalData = true;
    await quietly(login)(phone, "tea-a");
    check("a first sync that does not complete leaves the shared file active", phone.load("src/db/database").activeDatabaseName(), "schoolapp.db");
    check("…and A still reads the shared data", (await (await phone.db()).getAllAsync("SELECT id FROM students ORDER BY id")).map((r) => r.id), ["s1", "s2", "s3"]);
    check("…and A's queued requests are still in the shared outbox, sendable", (() => { const L = phone.inspect("schoolapp.db"); const n = L.one("SELECT COUNT(*) AS n FROM mutation_outbox WHERE owner_id = 'tea-a' AND status != 'synced'").n; L.close(); return n; })(), 2);
    await quietly(logout)(phone);
    phone.kill();
  }

  // ── 6. Offline sign-in ─────────────────────────────────────────────────────
  console.log("--- 6. offline sign-in keeps working for every account that had it ---");
  {
    const dir = copyDir(MIGRATED);
    const phone = await launch(dir);
    phone.net.connected = false;
    for (const id of ["tea-a", "tea-b", "adm-c", "stu-d"]) {
      const before = server.logins;
      check(`${id} signs in offline`, await quietly(login)(phone, id), true);
      check(`${id}: no network was used`, server.logins, before);
      const expectFile = id === "stu-d" ? "schoolapp.db" : phone.LD.storeFileFor(id);
      check(`${id} reads ${id === "stu-d" ? "the shared file (never flipped)" : "their own file"}`, phone.load("src/db/database").activeDatabaseName(), expectFile);
      await quietly(logout)(phone);
    }
    check("a wrong password is still refused offline", await quietly(login)(phone, "tea-a", { password: "nope" }), false);
    // The shared users table gone (D3 later): device.db alone is enough.
    const L = phone.inspect("schoolapp.db"); L.all("SELECT 1"); L.close();
    phone.kill();
    const p2 = await launch(dir);
    const raw = p2.inspect("schoolapp.db");
    raw.all("SELECT 1"); raw.close();
    const { DatabaseSync } = require("node:sqlite");
    const w = new DatabaseSync(path.join(dir, "schoolapp.db")); w.exec("UPDATE users SET passwordHash = NULL, passwordSalt = NULL"); w.close();
    p2.net.connected = false;
    check("with the shared users table emptied, device.db alone signs A in offline", await quietly(login)(p2, "tea-a"), true);
    p2.kill();
  }

  // ── 7. Five stores, eviction, a refused sixth ──────────────────────────────
  console.log("--- 7. at most five stores; evict only what holds no unsent work ---");
  {
    const dir = copyDir(FIXTURE);
    let phone = await launch(dir);
    server.perUserLocalData = true;
    for (const id of ["u1", "u2", "u3", "u4", "u5"]) {
      phone.clockDays = ["u1", "u2", "u3", "u4", "u5"].indexOf(id) * 0.01;
      check(`${id} signs in`, await quietly(login)(phone, id), true);
      if (id !== "u5") {
        const { MutationQueue } = phone.load("src/services/mutationQueue.service");
        await MutationQueue.enqueue({ entityKey: `homework:${id}`, method: "POST", endpoint: "/x", payload: {} });
      }
      await quietly(logout)(phone);
    }
    const live = () => { const d = phone.inspect("device.db"); const r = d.all("SELECT user_id FROM stores WHERE evicted_at IS NULL ORDER BY user_id").map((x) => x.user_id); d.close(); return r; };
    check("five live stores", live(), ["u1", "u2", "u3", "u4", "u5"]);
    phone.clockDays = 1;
    check("a sixth account signs in", await quietly(login)(phone, "u6"), true);
    check("…by evicting u5, the one store with no unsent work (u1 is older but holds work)", live(), ["u1", "u2", "u3", "u4", "u6"]);
    check("u5's file is gone", phone.exists(phone.LD.storeFileFor("u5")), false);
    const { MutationQueue } = phone.load("src/services/mutationQueue.service");
    await MutationQueue.enqueue({ entityKey: "homework:u6", method: "POST", endpoint: "/x", payload: {} });
    await quietly(logout)(phone);
    const filesBefore = fs.readdirSync(dir).sort();
    check("a seventh account is refused while all five hold unsent work", await quietly(login)(phone, "u7"), false);
    check("…with the message, in the reader's language", phone.useAuthStore.getState().errorKey, "svcErr.deviceFullOfAccounts");
    check("…its session is not stored", await phone.secure.getItemAsync("auth_token"), null);
    check("…and nothing was evicted or created", fs.readdirSync(dir).sort(), filesBefore);
    const en = require("../src/i18n/locales/en.json"), fr = require("../src/i18n/locales/fr.json");
    check("the message exists in English and French", [!!en.svcErr.deviceFullOfAccounts, !!fr.svcErr.deviceFullOfAccounts], [true, true]);
    check("an account that already has a store still signs in", await quietly(login)(phone, "u2"), true);
    await quietly(logout)(phone);
    phone.kill();
  }

  // ── 8. D3 ──────────────────────────────────────────────────────────────────
  console.log("--- 8. D3: the shared file is deleted only after 30 days with nothing unplaced ---");
  {
    const dir = copyDir(FIXTURE);
    const phone = await launch(dir);
    server.perUserLocalData = true;
    await quietly(login)(phone, "tea-a");
    let gate = await phone.LD.legacyDeletionGate();
    check("day 0, B and C not yet here: refused (too soon, waiting for owners)", [gate.ok, gate.reasons], [false, ["tooSoon", "waitingOwner"]]);
    phone.clockDays = 31;
    gate = await phone.LD.legacyDeletionGate();
    check("day 31, B and C still not here: still refused", [gate.ok, gate.reasons], [false, ["waitingOwner"]]);
    await quietly(logout)(phone);
    for (const id of ["tea-b", "adm-c"]) { await quietly(login)(phone, id); if (id === "tea-b") await quietly(logout)(phone); }
    phone.clockDays = 10;
    gate = await phone.LD.legacyDeletionGate();
    check("everyone placed but only day 10: refused", [gate.ok, gate.reasons], [false, ["tooSoon"]]);
    phone.clockDays = 31;
    gate = await phone.LD.legacyDeletionGate();
    check("day 31 and everything placed or held for review: allowed", [gate.ok, gate.reasons], [true, []]);
    check("nothing deletes it on its own", phone.exists("schoolapp.db"), true);
    check("a teacher cannot delete it", (await phone.LD.deleteLegacyFile({ by: userOf("tea-a") })).ok, false);
    const held = phone.inspect("device.db"); const heldBefore = held.all("SELECT id, content FROM review_items ORDER BY id"); held.close();
    check("the admin deletes it", (await quietly(phone.LD.deleteLegacyFile)({ by: userOf("adm-c") })).ok, true);
    check("the shared file is gone", phone.exists("schoolapp.db"), false);
    const held2 = phone.inspect("device.db");
    check("the held changes survive it, in full", held2.all("SELECT id, content FROM review_items ORDER BY id"), heldBefore);
    held2.close();
    check("a second delete is refused", (await phone.LD.legacyDeletionGate()).reasons.includes("alreadyDeleted"), true);
    await quietly(logout)(phone);
    phone.kill();
  }

  // ── 9. The legacy backfill gate ────────────────────────────────────────────
  console.log("--- 9. once migration has started, an unflipped account sends only its own rows ---");
  {
    const dir = copyDir(FIXTURE);
    const phone = await launch(dir);
    server.perUserLocalData = true;
    await quietly(login)(phone, "tea-a");                    // starts the migration
    await quietly(logout)(phone);
    phone.net.connected = false;
    await quietly(login)(phone, "tea-b");                    // offline: B stays on the shared file
    check("B is on the shared file", phone.load("src/db/database").activeDatabaseName(), "schoolapp.db");
    phone.setSession({ ...userOf("tea-b"), role: "school_admin" }, "tok-tea-b");   // a role that could send every spec
    await quietly(() => phone.load("src/services/syncBackfill.service").backfillOutbox())();
    const L = phone.inspect("schoolapp.db");
    const queued = L.all("SELECT entity_key, owner_id FROM mutation_outbox WHERE created_at > '2026-11-01' AND status = 'pending' AND owner_id = 'tea-b' ORDER BY entity_key").map((r) => r.entity_key);
    check("B's own quiz is queued under B", queued.includes("quiz:quiz-b"), true);
    check("the held announcement and class are NOT queued under B", ["announcement:ann-x", "class:cls-x"].filter((k) => queued.includes(k)), []);
    check("A's placed rows and C's attributed subject are NOT queued under B", ["announcement:ann-a", "class:cls-a", "subject:sub-1"].filter((k) => queued.includes(k)), []);
    L.close();
    phone.kill();
  }

  // ── 10. Switch off again ───────────────────────────────────────────────────
  console.log("--- 10. switch turned off again: back to the shared file only once clean ---");
  {
    const dir = copyDir(MIGRATED);
    const phone = await launch(dir);
    server.perUserLocalData = false;
    await quietly(login)(phone, "tea-a");
    check("A still has unsent work in their file: stays on it", phone.load("src/db/database").activeDatabaseName(), phone.LD.storeFileFor("tea-a"));
    await quietly(logout)(phone);
    const { DatabaseSync } = require("node:sqlite");
    const w = new DatabaseSync(path.join(dir, phone.LD.storeFileFor("tea-a")));
    w.exec("UPDATE mutation_outbox SET status = 'synced'; UPDATE announcements SET _synced = 1; UPDATE classes SET _synced = 1;");
    w.close();
    await quietly(login)(phone, "tea-a");
    check("once it is all sent: back on the shared file", phone.load("src/db/database").activeDatabaseName(), "schoolapp.db");
    await quietly(logout)(phone);
    phone.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
