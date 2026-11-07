// mobile/scripts/check-pull-keeps-pending.js
"use strict";

/**
 * A pull never overwrites a class, teacher or subject the phone has an
 * unsent change for.
 *
 * Found by CI on the offline P0 branch: a teacher was deleted on the phone
 * while a sync's pull was in flight. The pull had left the server before the
 * delete and was written after it, so the server's active copy replaced the
 * deleted row and marked it synced — and the delete was never sent. Any edit
 * made in that window was lost the same way.
 *
 * The rule now (syncClasses / syncTeachers / syncSubjects): the pulled row
 * only updates a row that is clean (_synced = 1). A row with an unsent edit
 * or a pending delete is left as it is; once its change has gone out and the
 * row is clean again, the next pull refreshes it. A server-side deletion
 * likewise waits for a pending local change.
 *
 * Runs the REAL SyncManager and table setup over node:sqlite
 * (offline-harness.js). The race itself, against the real backend, is case
 * 5b of check-teacher-unsent-delete.js.
 *
 *   node scripts/check-pull-keeps-pending.js
 */

const { bootPhone, quietly } = require("./offline-harness");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  const S = "5c0e2e000000000000000009";
  const api = { request: async () => ({ status: 200, data: {} }), get: async () => ({ status: 200, data: {} }) };
  const phone = await quietly(bootPhone)({
    api, user: { _id: "adm-1", id: "adm-1", role: "school_admin", schoolId: S, name: "Head" },
  });
  const { load, one, SyncManager } = phone;
  const db = await load("src/db/database").getDatabase();
  const pull = (fn, rows) => quietly(() => SyncManager[fn](rows))();

  // Each table: a clean row, one with an unsent edit, one with a pending
  // local delete, and one with an unsent edit the server then deletes.
  const cases = [
    {
      table: "classes", fn: "syncClasses",
      row: (id, name) => ({ _id: id, schoolId: S, name, isActive: true }),
    },
    {
      table: "users", fn: "syncTeachers",
      row: (id, name) => ({ _id: id, schoolId: S, name, email: `${id}@school.test`, isActive: true }),
    },
    {
      table: "subjects", fn: "syncSubjects",
      row: (id, name) => ({ _id: id, schoolId: S, name, classId: "cls-x" }),
    },
  ];

  for (const { table, fn, row } of cases) {
    console.log(`--- ${table} ---`);
    const id = (k) => `${table}-${k}`;
    await pull(fn, ["clean", "edited", "deleted", "gone"].map((k) => row(id(k), "server v1")));

    // Local changes the phone has not sent yet.
    await db.runAsync(`UPDATE ${table} SET name = 'local edit', _synced = 0 WHERE id = ?`, [id("edited")]);
    await db.runAsync(`UPDATE ${table} SET deleted_at = '2026-11-04T08:00:00.000Z', _synced = 0 WHERE id = ?`, [id("deleted")]);
    await db.runAsync(`UPDATE ${table} SET name = 'local edit', _synced = 0 WHERE id = ?`, [id("gone")]);

    // A pull that left the server before those changes lands after them.
    await pull(fn, [
      row(id("clean"),   "server v2"),
      row(id("edited"),  "server v2"),
      row(id("deleted"), "server v2"),
      { ...row(id("gone"), "server v2"), deletedAt: "2026-11-04T09:00:00.000Z" },
    ]);
    const get = (k) => one(`SELECT name, _synced, deleted_at FROM ${table} WHERE id = ?`, [id(k)]);

    check("a clean row is refreshed", get("clean"), { name: "server v2", _synced: 1, deleted_at: null });
    check("an unsent edit is kept", get("edited"), { name: "local edit", _synced: 0, deleted_at: null });
    check("a pending local delete is kept",
      get("deleted"), { name: "server v1", _synced: 0, deleted_at: "2026-11-04T08:00:00.000Z" });
    check("a server-side delete waits for the unsent edit",
      get("gone"), { name: "local edit", _synced: 0, deleted_at: null });

    // Once the change has gone out the row is clean, and the next pull
    // refreshes it as before.
    await db.runAsync(`UPDATE ${table} SET _synced = 1 WHERE id = ?`, [id("edited")]);
    await pull(fn, [row(id("edited"), "server v3")]);
    check("after it is sent, the next pull refreshes it",
      get("edited"), { name: "server v3", _synced: 1, deleted_at: null });
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
