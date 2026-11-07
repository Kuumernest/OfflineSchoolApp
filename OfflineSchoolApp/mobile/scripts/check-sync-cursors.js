// mobile/scripts/check-sync-cursors.js
"use strict";

/**
 * The sync position belongs to an account, not to the phone (db/syncCursors.js).
 *
 * With per-user local data switched OFF (the shared schoolapp.db), the cursor
 * was one SecureStore value for the phone: a second account signing in pulled
 * "since the first account's last sync" and never received the older rows of
 * its own scope. Now, on the REAL SyncManager over a real SQLite file:
 *
 *   1. the old phone-wide cursor is not handed to anyone: dropped once, so the
 *      next pull of every account is a full one (safe; a borrowed one is not);
 *   2. two accounts on one phone each keep their own position, and switching
 *      back finds it again; the same account in another school (a super_admin)
 *      starts afresh;
 *   3. resetting one account's position leaves the other's alone;
 *   4. nobody signed in: nothing is read or written;
 *   5. a stored value that is not a date reads as the beginning;
 *   6. with the switch ON, a per-user file keeps its cursor in its own
 *      local_meta under the same key as before (docs/40 unchanged).
 *
 *   node scripts/check-sync-cursors.js
 */

const { bootDevice, tmpDir, quietly } = require("./peruser-harness");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const S1 = "5c0e2e0000000000000000d1", S2 = "5c0e2e0000000000000000d2";
  const dir = tmpDir("sync-cursors");
  const phone = await bootDevice({ dir, api: { get: async () => ({ data: {} }), request: async () => ({ data: {} }) } });
  const { SyncManager } = phone.load("src/services/syncManager");
  const as = (id, role, schoolId) => phone.setSession({ _id: id, id, role, schoolId, name: id });
  const q = (fn) => quietly(fn)();

  // An older build left a phone-wide cursor behind.
  await phone.secure.setItemAsync("sync_last_timestamp", "2026-10-01T00:00:00.000Z");
  await phone.secure.setItemAsync("quiz_last_sync", "2026-10-01T00:00:00.000Z");

  console.log("--- 1. the old phone-wide cursor ---");
  as("teacher-a", "teacher", S1);
  check("is not handed to the account signed in now: a full pull", await q(() => SyncManager.getLastSync()), EPOCH);
  check("  nor the quiz cursor", await q(() => SyncManager.getLastQuizSync()), EPOCH);
  check("  and it is gone from SecureStore", [await phone.secure.getItemAsync("sync_last_timestamp"), await phone.secure.getItemAsync("quiz_last_sync")], [null, null]);

  console.log("--- 2. two accounts, one phone, switch off ---");
  await q(() => SyncManager.setLastSync("2026-11-01T10:00:00.000Z"));
  as("bursar-b", "bursar", S1);
  check("a second account starts from the beginning, not the first's position", await q(() => SyncManager.getLastSync()), EPOCH);
  await q(() => SyncManager.setLastSync("2026-11-02T10:00:00.000Z"));
  as("teacher-a", "teacher", S1);
  check("the first account finds its own position again", await q(() => SyncManager.getLastSync()), "2026-11-01T10:00:00.000Z");
  as("bursar-b", "bursar", S1);
  check("and the second its own", await q(() => SyncManager.getLastSync()), "2026-11-02T10:00:00.000Z");
  as("teacher-a", "teacher", S2);
  check("the same account in another school starts afresh", await q(() => SyncManager.getLastSync()), EPOCH);
  const d = phone.inspect("schoolapp.db");
  const scopes = d.all("SELECT DISTINCT scope FROM sync_cursors ORDER BY scope").map((r) => r.scope.split("|").slice(1).join("|"));
  d.close();
  check("kept in the shared file, one scope per (server, school, account)", scopes, [`${S1}|bursar-b`, `${S1}|teacher-a`]);

  console.log("--- 3. a reset is one account's ---");
  as("bursar-b", "bursar", S1);
  await q(() => SyncManager.resetLastSync());
  check("the reset account starts again", await q(() => SyncManager.getLastSync()), EPOCH);
  as("teacher-a", "teacher", S1);
  check("the other is untouched", await q(() => SyncManager.getLastSync()), "2026-11-01T10:00:00.000Z");

  console.log("--- 4. nobody signed in ---");
  phone.useAuthStore.setState({ user: null, token: null });
  await q(() => SyncManager.setLastSync("2026-11-03T00:00:00.000Z"));
  check("nothing is written", (() => { const x = phone.inspect("schoolapp.db"); try { return x.one("SELECT COUNT(*) n FROM sync_cursors WHERE v = ?", ["2026-11-03T00:00:00.000Z"]).n; } finally { x.close(); } })(), 0);
  check("and the beginning is read", await q(() => SyncManager.getLastSync()), EPOCH);

  console.log("--- 5. a corrupt value ---");
  as("teacher-a", "teacher", S1);
  await q(() => SyncManager.setLastQuizSync("not-a-date"));
  check("reads as the beginning (never sent to the server as Invalid Date)", await q(() => SyncManager.getLastQuizSync()), EPOCH);

  console.log("--- 6. switch on: a per-user file keeps its own ---");
  const database = phone.load("src/db/database");
  await q(() => database.setActiveDatabase("schoolapp.u_teacher-a.db"));
  await q(() => SyncManager.setLastSync("2026-11-04T08:00:00.000Z"));
  const u = phone.inspect("schoolapp.u_teacher-a.db");
  check("in the file's local_meta, under the key it always had", u.one("SELECT v FROM local_meta WHERE k = 'sync_last_timestamp'")?.v, "2026-11-04T08:00:00.000Z");
  u.close();
  await q(() => SyncManager.resetLastSync());
  check("and a reset clears it there", await q(() => SyncManager.getLastSync()), EPOCH);

  phone.kill();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
