// desktop/scripts/check-outbox-ownership.js
"use strict";

/**
 * Discard, Try again and Save a copy act on the signed-in account's own queued
 * changes only.
 *
 * The owner's decision: on a shared computer, another account's queued change
 * and a change with no recorded owner are READ-ONLY in the sync panel. Not just
 * hidden — refused by the main process, so no renderer can step around it.
 * What this holds, against a real store in a temp directory:
 *
 *   - another account's blocked entry: discard, unblock and copy are refused
 *     with a clear error, and the entry and its local row are byte-identical
 *     afterwards;
 *   - an ownerless entry: the same — never dropped;
 *   - signed out: nothing is anybody's to act on;
 *   - the account's own entry: all three still work, and discard still takes
 *     the local rows with it;
 *   - the summary tells the window whose each stuck entry is, without the id;
 *   - main.js routes all three IPC handlers through the guard.
 *
 *   node scripts/check-outbox-ownership.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const store = require("../src/main/db/store");
const { outbox, ownOutboxActions } = require("../src/main/db/outbox");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${label}`); }
  else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "school-outbox-owner-"));
const db    = store.open(path.join(dir, "school.db"));
const docs  = store.documents(db);
const queue = outbox(db);

let signedIn = "usr-a";
const actions = ownOutboxActions({ queue, docs, currentUser: () => signedIn });

/** Queue a payment for `userId`, with its local row, and block it on a refusal. */
const blockedPayment = (id, userId) => {
  docs.put("feePayment", { _id: id, amount: 5000, studentId: "st-1" }, { pending: true });
  const { seq } = queue.add({
    method: "POST", path: "/api/fees/payments",
    body: { _id: id, amount: 5000, studentId: "st-1" },
    collection: "feePayment", docId: id,
    extraDocs: [{ collection: "feePayment", docId: `${id}-extra` }],
    userId,
  });
  docs.put("feePayment", { _id: `${id}-extra`, note: "stamp" }, { pending: true });
  queue.markFailed(seq, { status: 403, message: "fees.write required" });
  return seq;
};

/** Everything stored about one entry: its row as SQLite holds it, and its local rows. */
const snapshot = (seq, id) => JSON.stringify({
  row:   db.prepare("SELECT * FROM outbox WHERE seq = ?").get(seq),
  doc:   db.prepare("SELECT * FROM docs WHERE collection = 'feePayment' AND id = ?").get(id),
  extra: db.prepare("SELECT * FROM docs WHERE collection = 'feePayment' AND id = ?").get(`${id}-extra`),
});

const refusal = (fn) => {
  try { fn(); return null; } catch (err) { return err.code ?? err.message; }
};

const mine      = blockedPayment("pay-mine", "usr-a");
const theirs    = blockedPayment("pay-theirs", "usr-b");
const ownerless = blockedPayment("pay-old", null);

console.log("--- the summary says whose each stuck entry is ---");
const stuck = queue.summary({ userId: "usr-a" }).stuck;
check("own, another account's, nobody's",
  stuck.map((s) => [s.seq, s.owner]), [[mine, "mine"], [theirs, "other"], [ownerless, "none"]]);
check("the account id itself is not in the summary", stuck.some((s) => "user_id" in s), false);
check("signed out, nothing is mine",
  queue.summary().stuck.map((s) => s.owner), ["other", "other", "none"]);

for (const [what, seq, id, code] of [
  ["another account's entry", theirs,    "pay-theirs", "OUTBOX_OTHER_ACCOUNT"],
  ["an ownerless entry",      ownerless, "pay-old",    "OUTBOX_OWNERLESS"],
]) {
  console.log(`\n--- ${what}: read-only ---`);
  const before = snapshot(seq, id);
  check("discard is refused",  refusal(() => actions.discard(seq)), code);
  check("try again is refused", refusal(() => actions.unblock(seq)), code);
  check("save a copy is refused", refusal(() => actions.entryForCopy(seq)), code);
  check("the entry and its local rows are byte-identical", snapshot(seq, id), before);
  check("the refusal explains itself",
    /^OUTBOX_[A-Z_]+: .{40,}/.test((() => { try { actions.discard(seq); } catch (e) { return e.message; } })()), true);
}

console.log("\n--- signed out: nothing may be acted on ---");
signedIn = null;
{
  const before = snapshot(mine, "pay-mine");
  check("discard of a row that was mine is refused", refusal(() => actions.discard(mine)), "NOT_SIGNED_IN");
  check("try again is refused", refusal(() => actions.unblock(mine)), "NOT_SIGNED_IN");
  check("ownerless is refused as ownerless", refusal(() => actions.discard(ownerless)), "OUTBOX_OWNERLESS");
  check("unchanged", snapshot(mine, "pay-mine"), before);
}
signedIn = "usr-a";

console.log("\n--- the account's own entry: everything still works ---");
check("save a copy: the whole entry", actions.entryForCopy(mine)?.doc_id, "pay-mine");
const keyBefore = queue.get(mine).idem_key;
actions.unblock(mine);
check("try again: pending again, under a new key after a refusal",
  [queue.get(mine).status, queue.get(mine).idem_key !== keyBefore], ["pending", true]);
queue.markFailed(mine, { status: 403, message: "still refused" });
actions.discard(mine);
check("discard: the entry is gone", queue.get(mine), null);
check("…and its local rows with it",
  [docs.get("feePayment", "pay-mine"), docs.get("feePayment", "pay-mine-extra")], [null, null]);
check("an entry already gone: nothing to do, no error", refusal(() => actions.discard(mine)), null);
check("the other two are still there",
  [Boolean(queue.get(theirs)), Boolean(queue.get(ownerless))], [true, true]);

console.log("\n--- usr-b signs in: their own entry is theirs to act on ---");
signedIn = "usr-b";
check("discard works for its owner", refusal(() => actions.discard(theirs)), null);
check("…gone", queue.get(theirs), null);
check("the ownerless one is still read-only", refusal(() => actions.discard(ownerless)), "OUTBOX_OWNERLESS");
check("…and still queued", Boolean(queue.get(ownerless)), true);

console.log("\n--- main.js routes every action through the guard ---");
const main = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
const handler = (name) => {
  const at = main.indexOf(`ipcMain.handle("${name}"`);
  if (at < 0) return "";
  const next = main.indexOf("ipcMain.handle(", at + 10);
  return main.slice(at, next < 0 ? undefined : next);
};
check("outbox:unblock uses the guard",  /ownActions\.unblock\(/.test(handler("outbox:unblock")), true);
check("outbox:discard uses the guard",  /ownActions\.discard\(/.test(handler("outbox:discard")), true);
check("outbox:saveCopy uses the guard", /ownActions\.entryForCopy\(/.test(handler("outbox:saveCopy")), true);
check("no handler reaches the queue's unguarded unblock, discard or get",
  ["outbox:unblock", "outbox:discard", "outbox:saveCopy"]
    .some((n) => /queue\.(unblock|discard|get)\(/.test(handler(n))), false);
check("the guard reads the session's account", /ownOutboxActions\(\{[^}]*currentUser:\s*\(\)\s*=>\s*session\?\.userId/.test(main), true);

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
