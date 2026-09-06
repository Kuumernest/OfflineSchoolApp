// desktop/scripts/check-crash-seams.js
"use strict";

/**
 * What survives the machine being interrupted mid-write.
 *
 * check-outbox already proves the queue survives a clean shutdown: close the
 * database, open it again, everything queued is still queued. That is the easy
 * half. The hard half is being interrupted BETWEEN two writes that have to
 * agree with each other, because a half-finished pair does not announce itself
 * — the application starts, the data looks plausible, and one record is wrong
 * for ever.
 *
 * Three seams matter here, and each is exercised by making the second half
 * throw at the exact point a crash would land:
 *
 *   1. a local document is written, then the outbox entry that will send it
 *      — interrupted between the two, the school has a record the server will
 *        never hear about, which is worse than losing it: it is on screen
 *   2. a page of pulled documents, then the cursor that says they arrived
 *      — interrupted between the two, either rows are applied and asked for
 *        again (harmless) or the cursor advances past rows never applied
 *        (permanent)
 *   3. an outbox entry settled, then the pending flag cleared on its document
 *      — interrupted between the two, a row stays pending for ever and the
 *        screen shows a spinner nothing will ever finish
 *
 * A throw is a fair stand-in for a crash here: better-sqlite3 rolls a
 * transaction back on an exception exactly as it rolls back on a lost process,
 * and what is being tested is whether the two writes are inside one.
 *
 *   node scripts/check-crash-seams.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const store = require("../src/main/db/store");
const { outbox } = require("../src/main/db/outbox");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-crash-"));
const file = path.join(dir, "school.db");
const cleanup = () => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (err) { console.log(`  (could not remove ${dir}: ${err.code})`); }
};

const main = () => {
  let db    = store.open(file);
  let docs  = store.documents(db);
  let state = store.state(db);
  let q     = outbox(db);
  // docs.tx, not store.transactor(db). Each transactor keeps its own nesting
  // depth, so a second one over the same connection does not know it is
  // already inside a transaction and SQLite refuses the inner BEGIN. The API
  // layer and the sync engine both use docs.tx for exactly this reason.
  let tx    = docs.tx;

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. a document written, the outbox entry interrupted ---");

  // What the API layer does for every write: put the document and queue the
  // request that will send it, inside one transaction.
  const writeAndQueue = (docId, { failQueue = false } = {}) =>
    tx(() => {
      const id = docs.put("student", {
        _id: docId, schoolId: "sch-1", studentName: `Pupil ${docId}`,
      }, { pending: true });

      if (failQueue) throw new Error("power lost between the write and the queue");

      return q.add({
        method: "POST", path: "/api/admin/students", body: { _id: docId },
        collection: "student", docId: id,
      });
    });

  writeAndQueue("st-ok");
  const okDoc = docs.get("student", "st-ok");
  const okQueued = q.all().filter((e) => String(e.doc_id ?? e.docId) === "st-ok");

  if (okDoc && okQueued.length === 1) ok("an ordinary write lands as one document and one queue entry");
  else bad("an ordinary write lands", `doc=${Boolean(okDoc)} queued=${okQueued.length}`);

  let threw = false;
  try { writeAndQueue("st-crash", { failQueue: true }); } catch { threw = true; }

  const ghost   = docs.get("student", "st-crash");
  const orphan  = q.all().filter((e) => String(e.doc_id ?? e.docId) === "st-crash");

  if (threw) ok("the interrupted write reports the failure rather than swallowing it");
  else bad("the interrupted write reports the failure", "no error was raised");

  if (!ghost) {
    ok("and the document is not left behind — the pair rolled back together");
  } else {
    bad("the document is not left behind",
      "a pupil is on this machine's screen with nothing queued to tell the " +
      "server about them. Nobody will ever notice: it looks saved.");
  }
  if (orphan.length === 0) ok("nor is there a queue entry pointing at a document that does not exist");
  else bad("no orphan queue entry", `${orphan.length} entry(ies)`);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. a page of pulled rows, the cursor interrupted ---");

  const applyPage = (rows, cursor, { failCursor = false } = {}) =>
    tx(() => {
      docs.putMany("class", rows, { pending: false });
      if (failCursor) throw new Error("power lost between the page and its cursor");
      state.setCursor("class", cursor);
    });

  applyPage([{ _id: "cls-1", schoolId: "sch-1", name: "Form 1" }], "cursor-1");
  if (docs.get("class", "cls-1") && state.cursorFor("class") === "cursor-1") {
    ok("an ordinary page lands with its cursor");
  } else {
    bad("an ordinary page lands with its cursor",
      `doc=${Boolean(docs.get("class", "cls-1"))} cursor=${state.cursorFor("class")}`);
  }

  try {
    applyPage([{ _id: "cls-2", schoolId: "sch-1", name: "Form 2" }], "cursor-2", { failCursor: true });
  } catch { /* the crash */ }

  const halfApplied = docs.get("class", "cls-2");
  const cursorNow   = state.cursorFor("class");

  if (!halfApplied && cursorNow === "cursor-1") {
    ok("an interrupted page leaves neither the rows nor the advanced cursor");
  } else if (halfApplied && cursorNow === "cursor-1") {
    ok("the rows landed but the cursor did not — they will simply be sent again");
  } else {
    bad("an interrupted page never advances the cursor past unapplied rows",
      `cursor=${cursorNow} rowApplied=${Boolean(halfApplied)}. A cursor ahead of ` +
      "the rows it claims to cover is the one state nothing recovers from: the " +
      "server will never offer those rows again.");
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the queue settled, the pending flag interrupted ---");

  const entry = writeAndQueue("st-settle");

  const settle = ({ failClear = false } = {}) =>
    tx(() => {
      q.markSent(entry.seq);
      if (failClear) throw new Error("power lost between settling and clearing");
      docs.settle("student", "st-settle");
    });

  try { settle({ failClear: true }); } catch { /* the crash */ }

  const stillQueued = q.nextBatch(50)
    .filter((e) => String(e.doc_id ?? e.docId) === "st-settle");
  if (stillQueued.length === 1) {
    ok("an interrupted settle leaves the entry queued — it is retried, and the replay is idempotent");
  } else {
    bad("an interrupted settle leaves the entry queued",
      "the entry was removed while the document stayed pending, so the row shows " +
      "as unsent for ever with nothing left to send it.");
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- and all of it survives the process going away ---");

  db.close();
  db    = store.open(file);
  docs  = store.documents(db);
  state = store.state(db);
  q     = outbox(db);
  tx    = docs.tx;

  const afterRestart = q.all().map((e) => String(e.doc_id ?? e.docId)).sort();
  if (afterRestart.includes("st-ok") && afterRestart.includes("st-settle")) {
    ok(`the queue is intact after reopening (${afterRestart.length} entry(ies))`);
  } else {
    bad("the queue is intact after reopening", JSON.stringify(afterRestart));
  }
  if (!afterRestart.includes("st-crash")) ok("and the interrupted write is still absent");
  else bad("the interrupted write is still absent", "it reappeared after a restart");

  db.close();

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  return fail === 0;
};

let okAll = false;
try { okAll = main(); }
catch (err) { console.error("check failed:", err); }
finally { cleanup(); }
process.exitCode = okAll ? 0 : 1;
