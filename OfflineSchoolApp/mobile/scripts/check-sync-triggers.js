// mobile/scripts/check-sync-triggers.js
"use strict";

/**
 * Does a change made on the phone leave it soon, and does a sync stop
 * re-downloading lists that have not changed?
 *
 *   1. db/localWrites.js reports data-changing statements, once each, and not
 *      the outbox's own bookkeeping.
 *   2. SyncManager pushes once after a burst of writes settles, never during a
 *      full sync (it runs once that sync ends), never re-triggered by its own
 *      writes, and never spends the rate-limit window.
 *   3. Each whole-list pull is skipped while fresh, retried after a failure,
 *      and always run when a person asked for the sync.
 *
 * SyncManager imports half of Expo, so its new methods are lifted out of the
 * source and run against stubs. That tests the code as written, not a copy.
 *
 *   node scripts/check-sync-triggers.js
 */

const fs   = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// ── 1. localWrites ───────────────────────────────────────────────────────────
const loadLocalWrites = () => {
  const cjs = read("db/localWrites.js")
    .replace(/^export\s+const\s+/gm, "const ")
    .replace(/^export\s+default[\s\S]*$/m, "")
    .concat("\nmodule.exports = { onLocalWrite, noteStatement, instrument, isReportableWrite };\n");
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", cjs)(m, m.exports);
  return m.exports;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const LW = loadLocalWrites();

  console.log("--- which statements count as a local change ---");
  check("an UPDATE that dirties a row", LW.isReportableWrite("UPDATE students SET name = ?, _synced = 0 WHERE id = ?"), true);
  check("an INSERT OR REPLACE", LW.isReportableWrite("  INSERT OR REPLACE INTO classes (id) VALUES (?)"), true);
  check("a DELETE", LW.isReportableWrite("DELETE FROM homework WHERE id = ?"), true);
  check("a SELECT is not", LW.isReportableWrite("SELECT * FROM students"), false);
  check("DDL is not", LW.isReportableWrite("CREATE TABLE IF NOT EXISTS x (id TEXT)"), false);
  check("the outbox's own writes are not", LW.isReportableWrite("UPDATE mutation_outbox SET status = 'synced' WHERE id = ?"), false);
  check("nor the id map's", LW.isReportableWrite("INSERT OR REPLACE INTO sync_id_map (local_id) VALUES (?)"), false);

  console.log("--- an instrumented handle reports each successful write once ---");
  let heard = 0;
  const off = LW.onLocalWrite(() => { heard++; });
  const db = LW.instrument({
    runAsync:  async (sql) => { if (/boom/.test(sql)) throw new Error("boom"); return { changes: 1 }; },
    execAsync: async () => undefined,
    getAllAsync: async () => [],
  });
  await db.runAsync("UPDATE students SET _synced = 0 WHERE id = ?", ["s1"]);
  await db.runAsync("SELECT 1");
  await db.execAsync("INSERT INTO a VALUES (1)");
  try { await db.runAsync("UPDATE boom SET x = 1"); } catch { /* expected */ }
  check("two writes heard, the read and the failure not", heard, 2);
  check("instrumenting twice does not double-report", LW.instrument(db) === db, true);
  await db.runAsync("DELETE FROM a");
  check("still once per statement", heard, 3);
  off();

  // ── 2 and 3. SyncManager's new methods, lifted out of the source ──────────
  const sm = read("services/syncManager.js");
  const method = (name) => {
    const re = new RegExp(`\\n  (async )?${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`);
    const m = sm.match(re);
    if (!m) throw new Error(`method ${name} not found in syncManager.js`);
    return m[0];
  };
  const names = ["_onLocalWrite", "_schedulePush", "pushNow", "_listDue", "_listPulled"];

  const makeManager = () => {
    const env = {
      online: true, authed: true, lock: false, lockTaken: 0, released: [],
      backfills: 0, drains: 0,
    };
    const stubRequire = (p) => {
      if (p === "../store/auth.store") {
        return {
          acquireSyncLock: () => { if (env.lock) return false; env.lock = true; env.lockTaken++; return true; },
          releaseSyncLock: (consumed = true) => { env.lock = false; env.released.push(consumed); },
        };
      }
      throw new Error(`unexpected require ${p}`);
    };
    // eslint-disable-next-line no-new-func
    const Klass = new Function("require", "NetInfo", "isAuthenticated", "getCurrentAuth", `
      return class {
        constructor() {
          this._destroyed = false; this.isSyncing = false; this._pushing = false;
          this._pushAfterSync = false; this._pushTimer = null; this._syncAfterPush = null;
          this.PUSH_DEBOUNCE_MS = 50; this.LIST_REFRESH_MS = 1000;
          this._listPulledAt = new Map(); this._fullRun = false;
        }
        ${names.map(method).join("\n")}
      };
    `)(
      stubRequire,
      { fetch: async () => ({ isConnected: env.online }) },
      () => env.authed,
      () => ({ user: {} }),
    );
    const mgr = new Klass();
    mgr.backfillOutbox = async () => {
      env.backfills++;
      // The backfill writes too (it dirties nothing, but marks rows) — that
      // must not arm another push.
      mgr._onLocalWrite();
      await sleep(5);
    };
    mgr.drainOutbox = async () => { env.drains++; return { synced: 1 }; };
    env.syncs = [];
    mgr.syncAll = async (opts) => { env.syncs.push(opts); };
    return { mgr, env };
  };

  console.log("--- a burst of writes is one push, after it settles ---");
  {
    const { mgr, env } = makeManager();
    for (let i = 0; i < 10; i++) { mgr._onLocalWrite(); await sleep(10); }
    check("nothing sent while the writes keep coming", env.drains, 0);
    await sleep(120);
    check("one push once they stop", [env.backfills, env.drains], [1, 1]);
    check("the push's own writes did not arm another", mgr._pushTimer, null);
    check("the rate-limit window was handed back", env.released, [false]);
  }

  console.log("--- a write during a full sync waits for it, then pushes ---");
  {
    const { mgr, env } = makeManager();
    mgr.isSyncing = true;
    mgr._onLocalWrite();
    await sleep(120);
    check("no push while the sync runs", env.drains, 0);
    check("but one is owed", mgr._pushAfterSync, true);
  }

  console.log("--- the lock held elsewhere defers rather than drops ---");
  {
    const { mgr, env } = makeManager();
    env.lock = true;
    await mgr.pushNow();
    check("nothing sent", env.drains, 0);
    check("owed to whoever holds the lock", mgr._pushAfterSync, true);
  }

  console.log("--- a full sync asked for during a push runs when the push ends ---");
  {
    const { mgr, env } = makeManager();
    const pushing = mgr.pushNow();
    await sleep(1);
    // What syncAll does when it meets the lock held by a push.
    check("the push holds the lock", mgr._pushing, true);
    mgr._syncAfterPush = { force: true, full: false };
    await pushing;
    check("the owed sync ran, as asked", env.syncs, [{ force: true, full: false }]);
    check("and is not owed twice", mgr._syncAfterPush, null);
  }
  check("syncAll records the owed sync when a push holds the lock",
    /if \(this\._pushing\) \{\s*this\._syncAfterPush = \{/.test(read("services/syncManager.js")), true);

  console.log("--- offline or signed out, a push does nothing ---");
  {
    const { mgr, env } = makeManager();
    env.online = false;
    await mgr.pushNow();
    env.online = true; env.authed = false;
    await mgr.pushNow();
    check("no lock taken, nothing sent", [env.lockTaken, env.drains], [0, 0]);
  }

  console.log("--- whole lists: once per window, unless a person asked ---");
  {
    const { mgr } = makeManager();
    check("never pulled: due", mgr._listDue("timetable"), true);
    mgr._listPulled("timetable");
    check("just pulled: not due", mgr._listDue("timetable"), false);
    check("another list is its own", mgr._listDue("gate"), true);
    mgr._fullRun = true;
    check("a sync somebody asked for: due regardless", mgr._listDue("timetable"), true);
    mgr._fullRun = false;
    mgr._listPulledAt.set("timetable", Date.now() - 2000);
    check("after the window: due again", mgr._listDue("timetable"), true);
  }

  console.log("--- every throttled pull is marked under its own key ---");
  const guarded = [...sm.matchAll(/this\._listDue\("(\w+)"\)/g)].map((m) => m[1]);
  const marked  = [...sm.matchAll(/this\._listPulled\("(\w+)"\)/g)].map((m) => m[1]);
  check("guarded lists", [...new Set(guarded)].sort(), ["assignments", "exams", "fees", "finance", "gate", "timetable"]);
  check("each guarded list is marked when it succeeds", [...new Set(guarded)].sort(), [...new Set(marked)].sort());

  console.log("--- the syncs a person starts fetch every list ---");
  const manual = [
    ["src/services/adminStats.service.js", read("services/adminStats.service.js")],
    ["app/sync/pending.js", fs.readFileSync(path.join(__dirname, "..", "app/sync/pending.js"), "utf8")],
  ];
  for (const [file, src] of manual) {
    check(`${file} passes full: true`, /syncAll\(\{\s*force:\s*true,\s*full:\s*true\s*\}\)/.test(src), true);
  }

  console.log("--- the handle every service shares is the instrumented one ---");
  check("database.js instruments the singleton", /_db\s*=\s*instrument\(db\)/.test(read("db/database.js")), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
};

main()
  .catch((err) => { console.error("\nHarness error:", err); fail++; })
  .finally(() => process.exit(fail ? 1 : 0));
