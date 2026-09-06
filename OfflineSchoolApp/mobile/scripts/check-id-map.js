// mobile/scripts/check-id-map.js
"use strict";

/**
 * A payment queued against a pupil the server has never heard of.
 *
 * This is the failure mode an outbox with client-invented ids exists to
 * prevent, and the one that does the most damage when it slips: the phone is
 * offline, somebody enrols a pupil, records a payment against them and files a
 * document for them, and every one of those requests refers to an id the phone
 * made up. When the queue drains the pupil goes first, the server may answer
 * with a different id, and everything still waiting has to be rewritten before
 * it is sent.
 *
 * Get it wrong and the payment reaches the server attached to a pupil that does
 * not exist. It is accepted, the screen says saved, and the money belongs to
 * nobody. Nothing errors.
 *
 * The rewrite is in src/services/idMap.js, which takes a lookup instead of a
 * database precisely so this can run here rather than only on a handset.
 *
 *   node scripts/check-id-map.js
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

// The module is ESM and this runner is CommonJS, so it is transpiled the same
// way the rest of check.js reads source: parsed, not imported.
const load = () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "idMap.js"), "utf8"
  );
  const cjs = src
    .replace(/^export\s+async\s+function\s+/gm, "async function ")
    .replace(/^export\s+default[\s\S]*$/m, "")
    .concat("\nmodule.exports = { remapPayload, MIN_ID_LENGTH };\n");

  const module_ = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", cjs)(module_, module_.exports);
  return module_.exports;
};

(async () => {
  const { remapPayload } = load();

  // The map as it stands after the pupil has synced and the server renamed them.
  const LOCAL_STUDENT  = "local-8f3a1c22-9d64-4e77-b0aa-5c1e2f4d6a80";
  const SERVER_STUDENT = "0ac69e73-2729-443d-9f72-a26c396c3c59";

  const map = new Map([[LOCAL_STUDENT, SERVER_STUDENT]]);
  const lookup = async (id) => map.get(String(id)) ?? id;

  // ── The payment queued behind the pupil ───────────────────────────────────
  console.log("\n--- a payment queued while the pupil was still local ---");

  let r = await remapPayload({
    endpoint: "/fees/payments",
    payload: {
      studentId: LOCAL_STUDENT,
      amount:    5000,
      method:    "cash",
      __resolve: ["studentId"],
    },
    lookup,
  });

  if (r.payload.studentId === SERVER_STUDENT) {
    ok("the pupil's id is rewritten to the one the server gave back");
  } else {
    bad("the pupil's id is rewritten",
      `it went out as ${r.payload.studentId}. The server would accept a payment ` +
      "against a pupil it has never heard of, and the money would belong to nobody.");
  }

  if (r.payload.amount === 5000 && r.payload.method === "cash") {
    ok("and nothing else in the payload is touched");
  } else {
    bad("nothing else is touched", JSON.stringify(r.payload));
  }

  // ── The id inside the path ────────────────────────────────────────────────
  console.log("\n--- the same id embedded in the URL ---");

  r = await remapPayload({
    endpoint: `/admin/students/${LOCAL_STUDENT}`,
    payload:  { className: "Form 1" },
    lookup,
  });

  if (r.endpoint === `/admin/students/${SERVER_STUDENT}`) {
    ok("a PUT addressed by id is re-addressed");
  } else {
    bad("a PUT addressed by id is re-addressed", r.endpoint);
  }

  r = await remapPayload({
    endpoint: `/exams/${LOCAL_STUDENT}/scores/bulk`,
    payload:  { examId: LOCAL_STUDENT, __resolve: ["examId"] },
    lookup,
  });

  if (r.endpoint === `/exams/${SERVER_STUDENT}/scores/bulk` &&
      r.payload.examId === SERVER_STUDENT) {
    ok("an id in both the body and the path is rewritten in both");
  } else {
    bad("an id in the body and the path", `${r.endpoint} / ${r.payload.examId}`);
  }

  // ── What must NOT be rewritten ────────────────────────────────────────────
  console.log("\n--- and what must be left alone ---");

  // A route word the map happens to contain would otherwise be substituted.
  // Every one of these is eight characters or more, which the old length-only
  // test accepted as an id.
  const trap = new Map([
    ["students",  "WRONG"], ["payments", "WRONG"],
    ["teachers",  "WRONG"], ["settings", "WRONG"],
    ["approvals", "WRONG"], ["fees",     "WRONG"],
  ]);
  r = await remapPayload({
    endpoint: "/admin/students/payments/settings/teachers/approvals/fees",
    payload:  {},
    lookup:   async (id) => trap.get(String(id)) ?? id,
  });

  if (r.endpoint === "/admin/students/payments/settings/teachers/approvals/fees") {
    ok("route words are not mistaken for ids, even when the map has an entry");
  } else {
    bad("route words are not rewritten",
      `${r.endpoint} — a rewrite here produces a request to an endpoint nobody serves.`);
  }

  // An id with no mapping yet: the parent has not synced, and this must go out
  // unchanged so the queue's ordering, not this function, decides what happens.
  const UNMAPPED = "local-11111111-2222-3333-4444-555555555555";
  r = await remapPayload({
    endpoint: "/fees/payments",
    payload:  { studentId: UNMAPPED, __resolve: ["studentId"] },
    lookup,
  });

  if (r.payload.studentId === UNMAPPED) {
    ok("an id with no mapping passes through unchanged rather than being blanked");
  } else {
    bad("an unmapped id passes through", JSON.stringify(r.payload.studentId));
  }

  // A field not named in __resolve is not touched, however much it looks like
  // an id — a note quoting a reference number is not a foreign key.
  r = await remapPayload({
    endpoint: "/fees/payments",
    payload:  { note: LOCAL_STUDENT, studentId: LOCAL_STUDENT, __resolve: ["studentId"] },
    lookup,
  });

  if (r.payload.note === LOCAL_STUDENT && r.payload.studentId === SERVER_STUDENT) {
    ok("only the fields the caller declared are rewritten");
  } else {
    bad("only declared fields are rewritten", JSON.stringify(r.payload));
  }

  // ── Several dependents, one parent ────────────────────────────────────────
  console.log("\n--- three records queued behind one pupil ---");

  const dependents = [
    { endpoint: "/fees/payments",   payload: { studentId: LOCAL_STUDENT, __resolve: ["studentId"] } },
    { endpoint: "/attendance/students", payload: { studentId: LOCAL_STUDENT, classId: "cls-1", __resolve: ["studentId", "classId"] } },
    { endpoint: `/documents/${LOCAL_STUDENT}`, payload: { kind: "transcript" } },
  ];

  const results = [];
  for (const d of dependents) results.push(await remapPayload({ ...d, lookup }));

  const anyLeft = results.some((x) =>
    JSON.stringify(x.payload).includes(LOCAL_STUDENT) || x.endpoint.includes(LOCAL_STUDENT));

  if (!anyLeft) ok("every dependent is rewritten, in the body and in the path");
  else bad("every dependent is rewritten",
    JSON.stringify(results.map((x) => x.endpoint)));

  // classId had no mapping, so it must survive verbatim.
  if (results[1].payload.classId === "cls-1") {
    ok("and a declared field with no mapping keeps its value");
  } else {
    bad("a declared field with no mapping keeps its value", results[1].payload.classId);
  }

  // ── The queue is what guarantees the parent goes first ────────────────────
  console.log("\n--- the ordering this depends on ---");

  const queue = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "mutationQueue.service.js"), "utf8"
  );

  // Rewriting is useless if the payment can overtake the pupil. The queue has
  // to be ordered and has to stop rather than skip past a failure.
  if (/ORDER BY[\s\S]{0,60}\b(id|created_at|seq)\b\s*ASC/i.test(queue)) {
    ok("the queue drains oldest first, so the pupil is sent before the payment");
  } else {
    bad("the queue drains oldest first",
      "without a stable order the payment can be sent before the pupil exists, " +
      "and no amount of rewriting helps because there is nothing to rewrite to.");
  }

  if (/remapPayload/.test(queue)) {
    ok("and the queue applies the rewrite on the way out, not at enqueue time");
  } else {
    bad("the queue applies the rewrite", "mutationQueue does not call remapPayload");
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
