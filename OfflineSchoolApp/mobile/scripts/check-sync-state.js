// mobile/scripts/check-sync-state.js
"use strict";

/**
 * Marks that have not reached the server, and whether anything will send them.
 *
 * countUnsyncedScores has existed since exam_scores was written and is called
 * by nothing. A teacher had no way to know that marks were still on the phone —
 * not from the marks sheet, not from the exam list, not from anywhere.
 *
 * A count alone would not have been enough either. "3 marks not uploaded" is
 * two opposite situations wearing the same sentence: three queued on a bad line
 * that will go by themselves, and three the server refused that never will. A
 * teacher who sees the first every morning stops reading it, and the morning it
 * means the second looks identical.
 *
 * So the states are separated, and there is a third that offline applications
 * grow whether or not anybody designs it: a dirty row with nothing in the
 * outbox carrying it. Nothing retries those and nothing counts them. One source
 * was fixed — a refused save used to leave its local write behind — but "the
 * one we found" is not "cannot happen", so they are counted and named.
 *
 * The classifier is pure, so every state below is exercised here rather than
 * only on a handset.
 *
 *   node scripts/check-sync-state.js
 */

const fs   = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};

// ESM module, CommonJS runner — read and evaluate rather than import.
const load = () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "syncState.js"), "utf8"
  );
  const cjs = src
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+default[\s\S]*$/m, "")
    .concat("\nmodule.exports = { classifyDirtyRows, syncStateLabel };\n");
  const m = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", cjs)(m, m.exports);
  return m.exports;
};

const { classifyDirtyRows, syncStateLabel } = load();

const TABLE = "exam_scores";
const entry = (status, ids) => ({
  status,
  payload: { __local: { table: TABLE, ids } },
});

const state = (dirtyIds, outboxRows = []) =>
  classifyDirtyRows({ dirtyIds, outboxRows, table: TABLE });

// ── Nothing outstanding ─────────────────────────────────────────────────────
console.log("\n--- a sheet that is fully saved ---");
{
  const s = state([]);
  if (s.total === 0) ok("no dirty rows is a total of nought");
  else bad("no dirty rows is nought", JSON.stringify(s));

  const label = syncStateLabel(s);
  if (label.kind === "synced") ok("and reads as synchronised, not as an empty warning");
  else bad("it reads as synchronised", JSON.stringify(label));
}

// ── Queued ──────────────────────────────────────────────────────────────────
console.log("\n--- marks entered with no signal ---");
{
  const s = state(["sc-1"], [entry("pending", ["sc-1"])]);
  if (s.pending.length === 1 && s.failed.length === 0 && s.orphaned.length === 0) {
    ok("one offline mark is one pending, and nothing else");
  } else {
    bad("one offline mark is one pending", JSON.stringify(s));
  }

  const label = syncStateLabel(s);
  if (label.kind === "pending" && label.count === 1) ok("and is described as waiting, not failed");
  else bad("it is described as waiting", JSON.stringify(label));
}

{
  // A whole class saved at once is one request carrying forty rows.
  const ids = Array.from({ length: 40 }, (_, i) => `sc-${i}`);
  const s = state(ids, [entry("pending", ids)]);
  if (s.pending.length === 40 && s.total === 40) ok("a class of forty counts as forty, from one queue entry");
  else bad("forty marks count as forty", JSON.stringify({ p: s.pending.length, t: s.total }));
}

{
  // Two subjects entered in the same sitting: two entries, two sets of rows.
  const s = state(["sc-1", "sc-2", "sc-3"], [
    entry("pending",  ["sc-1", "sc-2"]),
    entry("retrying", ["sc-3"]),
  ]);
  if (s.pending.length === 3) ok("retrying counts as waiting — it has not stopped");
  else bad("retrying counts as waiting", JSON.stringify(s));
}

// ── Sent ────────────────────────────────────────────────────────────────────
console.log("\n--- and then the signal comes back ---");
{
  // The row is no longer dirty; the settled entry may linger.
  const s = state([], [entry("synced", ["sc-1"])]);
  if (s.total === 0 && syncStateLabel(s).kind === "synced") {
    ok("a mark that went through leaves nothing outstanding");
  } else {
    bad("a sent mark leaves nothing", JSON.stringify(s));
  }
}
{
  // Half a batch settled: the queue entry is gone for those, still there for
  // the rest. This is what a partial upload actually looks like.
  const s = state(["sc-3"], [entry("pending", ["sc-3"])]);
  if (s.pending.length === 1 && s.total === 1) ok("and the ones still going are still counted");
  else bad("the rest are still counted", JSON.stringify(s));
}

// ── Refused ─────────────────────────────────────────────────────────────────
console.log("\n--- the server said no ---");
{
  const s = state(["sc-1"], [entry("failed", ["sc-1"])]);
  if (s.failed.length === 1 && s.pending.length === 0) {
    ok("a refused mark is failed, and is not reported as waiting");
  } else {
    bad("a refused mark is failed", JSON.stringify(s));
  }

  const label = syncStateLabel(s);
  if (label.kind === "failed" && label.count === 1) ok("and says so — the two are never one number");
  else bad("it says failed", JSON.stringify(label));
}
{
  const s = state(["sc-1"], [entry("conflict", ["sc-1"])]);
  if (s.failed.length === 1) ok("a conflict is failed too: it stopped, and a person has to look");
  else bad("a conflict is failed", JSON.stringify(s));
}
{
  // Mixed, which is the realistic state of a staffroom phone.
  const s = state(["sc-1", "sc-2", "sc-3"], [
    entry("pending", ["sc-1", "sc-2"]),
    entry("failed",  ["sc-3"]),
  ]);
  if (s.pending.length === 2 && s.failed.length === 1) {
    ok("two waiting and one failed are reported as two and one");
  } else {
    bad("mixed states are reported separately", JSON.stringify(s));
  }
  if (syncStateLabel(s).kind === "failed") {
    ok("and the line a teacher sees leads with the failure");
  } else {
    bad("the label leads with the failure", JSON.stringify(syncStateLabel(s)));
  }
}
{
  // Retried into a new entry while the old failure is still on the queue.
  const s = state(["sc-1"], [
    entry("failed",  ["sc-1"]),
    entry("pending", ["sc-1"]),
  ]);
  if (s.failed.length === 1 && s.pending.length === 0) {
    ok("a row that is both counts as failed — the safer of the two to be wrong about");
  } else {
    bad("both means failed", JSON.stringify(s));
  }
}

// ── Retried successfully ────────────────────────────────────────────────────
console.log("\n--- and the retry works ---");
{
  const s = state([], [entry("failed", ["sc-1"]), entry("synced", ["sc-1"])]);
  if (s.total === 0) ok("once the row is clean the old failure stops being counted");
  else bad("a settled row stops counting", JSON.stringify(s));
}
{
  const before = state(["sc-1", "sc-2"], [entry("failed", ["sc-1", "sc-2"])]);
  const after  = state(["sc-2"],         [entry("failed", ["sc-2"])]);
  if (before.failed.length === 2 && after.failed.length === 1) {
    ok("two failures becoming one is counted as one");
  } else {
    bad("the failed count comes down", `${before.failed.length} then ${after.failed.length}`);
  }
}

// ── The state nothing is carrying ───────────────────────────────────────────
console.log("\n--- dirty, and nothing is going to send it ---");
{
  const s = state(["sc-1"], []);
  if (s.orphaned.length === 1) ok("a dirty row with no queue entry is orphaned, not pending");
  else bad("an unqueued dirty row is orphaned", JSON.stringify(s));

  const label = syncStateLabel(s);
  if (label.kind === "failed") {
    ok("and is shown as failed — nothing is waiting for it, so saying 'waiting' would be a lie");
  } else {
    bad("an orphan is shown as failed", JSON.stringify(label));
  }
}
{
  // The shape the published-result refusal used to leave behind.
  const s = state(["sc-1", "sc-2"], [entry("pending", ["sc-1"])]);
  if (s.pending.length === 1 && s.orphaned.length === 1) {
    ok("one queued and one abandoned are told apart");
  } else {
    bad("queued and abandoned are told apart", JSON.stringify(s));
  }
}

// ── Entries that are not ours ───────────────────────────────────────────────
console.log("\n--- other tables in the same queue ---");
{
  const s = classifyDirtyRows({
    dirtyIds:   ["sc-1"],
    outboxRows: [{ status: "pending", payload: { __local: { table: "attendance", ids: ["sc-1"] } } }],
    table:      TABLE,
  });
  if (s.orphaned.length === 1 && s.pending.length === 0) {
    ok("an attendance entry does not claim a score with the same id");
  } else {
    bad("entries are matched by table as well as id", JSON.stringify(s));
  }
}
{
  const s = state(["sc-1"], [{ status: "pending", payload: {} }]);
  if (s.orphaned.length === 1) ok("an entry with no __local claims nothing");
  else bad("an entry with no __local claims nothing", JSON.stringify(s));
}

// ── Restart ─────────────────────────────────────────────────────────────────
//
// Both tables are SQLite and survive the process; the classifier is a pure
// function of them, so the count after a restart is the count of whatever is
// on disk. What has to be true is that it is derived and never cached.
console.log("\n--- after the app is closed and opened ---");
{
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "examCache.service.js"), "utf8"
  );
  const fn = src.slice(src.indexOf("export const scoreSyncState"));
  const body = fn.slice(0, fn.indexOf("\n};"));

  if (/SELECT id FROM exam_scores WHERE _synced = 0/.test(body)) {
    ok("the count is read from the table every time, so a restart cannot stale it");
  } else {
    bad("the count is read from the table", "scoreSyncState does not query exam_scores");
  }
  if (!/let\s+cache|const\s+cache|memo/i.test(body)) {
    ok("and nothing is held in memory between calls");
  } else {
    bad("nothing is cached", "scoreSyncState keeps state across calls");
  }
}

// ── And somebody actually looks at it ──────────────────────────────────
//
// A correct counter nothing renders is the state this started in.
// countUnsyncedScores has been exported and uncalled since it was written, so
// these assertions are about reachability, not arithmetic.
console.log("\n--- and it reaches a teacher ---");
{
  const cache = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "examCache.service.js"), "utf8");
  if (/export const scoreSyncState/.test(cache)) {
    ok("the cache can report the state, not just a total");
  } else {
    bad("the cache reports the state", "only countUnsyncedScores exists, which is one number for two situations");
  }

  const service = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "exam.service.js"), "utf8");
  if (/scoreSyncState/.test(service)) {
    ok("and the exam service exposes it to the screens");
  } else {
    bad("the service exposes it", "scoreSyncState is not reachable from a screen");
  }

  const marks = fs.readFileSync(
    path.join(__dirname, "..", "app", "admin", "exams", "marks.js"), "utf8");

  if (/scoreSyncState()/.test(marks)) {
    ok("the marks sheet asks for it");
  } else {
    bad("the marks sheet asks for it",
      "the count exists and no screen calls it, which is where this began.");
  }

  if (/marksFailed/.test(marks) && /marksPending/.test(marks)) {
    ok("and shows waiting and failed as different things");
  } else {
    bad("waiting and failed are shown differently",
      "one combined \"not uploaded\" line is the ambiguity this exists to remove.");
  }

  if (/refreshScoreSync()/.test(marks) && /finally/.test(marks)) {
    ok("and refreshes it after every save, however the save ended");
  } else {
    bad("the count refreshes after a save", "a stale indicator is worse than none");
  }
}

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
