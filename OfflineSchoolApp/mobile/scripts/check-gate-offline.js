// mobile/scripts/check-gate-offline.js
"use strict";

/**
 * The gate's offline verification, without a phone: the pure helpers in
 * src/components/gate/gateRules.js, fed through the real shared/compliance.js
 * the way gateSnapshot.service.js feeds it, and the i18n keys the gate screen
 * and card use, in both languages.
 *
 *   1. snapshot payments are confirmed; this phone's unsynced ones pending;
 *      an outbox refusal (conflict, or failed with a 4xx) rejected; a failed
 *      row without a refusal (5xx, no answer) still pending; synced local
 *      rows never counted twice; other years' local rows left out;
 *   2. pending money is never paid: a pupil short 25,000 with 50,000 pending
 *      stays non-compliant, and dependsOnPending says it would flip;
 *   3. data older than 24 h is stale; ages pick the right unit;
 *   4. amounts print as whole FCFA with separators;
 *   5. every gate.* key the screen and card use exists in en and fr.
 *
 * The screens themselves are not rendered here — no device or emulator ran
 * them. Needs Node ≥ 22.12 (require() of an ES module).
 *
 *   node scripts/check-gate-offline.js
 */

const path   = require("path");
const fs     = require("fs");
const assert = require("assert/strict");

const MOBILE = path.join(__dirname, "..");
const rules  = require(path.join(MOBILE, "src", "components", "gate", "gateRules.js"));
const { compliance } = require(path.join(MOBILE, "..", "shared", "compliance.js"));

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

const asOf = new Date("2026-11-19T09:00:00Z");
const charges = [
  { amount: 100_000, dueDate: "2026-10-01" },
  { amount: 100_000, dueDate: "2027-01-15" },
];

check("payments: confirmed / pending / rejected / not double-counted", () => {
  const outbox = new Map([
    ["p2", { status: "conflict", last_status: 412 }],
    ["p3", { status: "failed", last_status: 503 }],   // ran out of retries, never refused
    ["p4", { status: "failed", last_status: 422 }],   // refused
  ]);
  const local = [
    { id: "p1", amount: 10_000, received_at: "2026-11-18", _synced: 0, academic_year: "2026-2027" },
    { id: "p2", amount: 5_000,  received_at: "2026-11-18", _synced: 0, academic_year: "2026/2027" },
    { id: "p3", amount: 7_000,  received_at: "2026-11-18", _synced: 0 },
    { id: "p4", amount: 3_000,  received_at: "2026-11-18", _synced: 0 },
    { id: "p5", amount: 9_999,  received_at: "2026-11-01", _synced: 1 },                 // in the snapshot already
    { id: "p6", amount: 1_000,  received_at: "2025-11-01", _synced: 0, academic_year: "2025-2026" },
  ];
  const out = rules.buildPayments([{ amount: 75_000, receivedAt: "2026-10-02" }], local, outbox, "2026-2027");
  assert.deepEqual(out.map((p) => [p.amount, p.state]), [
    [75_000, "confirmed"], [10_000, "pending"], [5_000, "rejected"], [7_000, "pending"], [3_000, "rejected"],
  ]);
});

check("payments: a snapshot row with an id is not also pending", () => {
  const out = rules.buildPayments([{ _id: "p1", amount: 10_000 }], [{ id: "p1", amount: 10_000, _synced: 0 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].state, "confirmed");
});

check("payments: a synced local row the snapshot lacks is confirmed; one it holds is not doubled", () => {
  const out = rules.buildPayments(
    [{ _id: "p1", amount: 10_000 }],
    [{ id: "p1", amount: 10_000, _synced: 1 }, { id: "p2", amount: 20_000, _synced: 1 }],
  );
  assert.deepEqual(out.map((p) => [p.amount, p.state]), [[10_000, "confirmed"], [20_000, "confirmed"]]);
});

check("payments: from a snapshot without ids, synced local rows are left out (cannot tell)", () => {
  const out = rules.buildPayments([{ amount: 10_000 }], [{ id: "p1", amount: 10_000, _synced: 1 }]);
  assert.deepEqual(out.map((p) => p.state), ["confirmed"]);
});

check("outboxRefused: old outbox without last_status trusts the queue", () => {
  assert.equal(rules.outboxRefused({ status: "failed" }), true);
  assert.equal(rules.outboxRefused({ status: "failed", last_status: null }), false);
  assert.equal(rules.outboxRefused({ status: "failed", last_status: 429 }), false);
  assert.equal(rules.outboxRefused({ status: "pending" }), false);
  assert.equal(rules.outboxRefused(null), false);
});

check("pending money is never paid, and the card can say it would flip", () => {
  const payments = rules.buildPayments(
    [{ amount: 75_000, receivedAt: "2026-10-02" }],
    [{ id: "x", amount: 50_000, received_at: "2026-11-18", _synced: 0 }],
  );
  const r = compliance({ charges, payments, asOf, dataAsOf: "2026-11-19T06:00:00Z" });
  assert.equal(r.status, "non_compliant");
  assert.equal(r.totalPaid, 75_000);
  assert.equal(r.outstandingDue, 25_000);
  assert.equal(r.pending.count, 1);
  assert.equal(r.pending.amount, 50_000);
  assert.equal(r.dependsOnPending, true);
  assert.equal(r.stale, false);
  // JSON round trip — what the outbox stores and the server receives.
  assert.equal(JSON.parse(JSON.stringify(r)).status, "non_compliant");
});

check("stale after 24 h; ages", () => {
  assert.equal(rules.isStale("2026-11-18T08:00:00Z", asOf), true);
  assert.equal(rules.isStale("2026-11-18T10:00:00Z", asOf), false);
  assert.equal(rules.isStale(null, asOf), true);
  assert.equal(compliance({ charges, asOf, dataAsOf: "2026-11-17T00:00:00Z" }).stale, true);
  assert.deepEqual(rules.ageOf("2026-11-19T08:59:40Z", asOf), { unit: "now", count: 0 });
  assert.deepEqual(rules.ageOf("2026-11-19T08:15:00Z", asOf), { unit: "minutes", count: 45 });
  assert.deepEqual(rules.ageOf("2026-11-19T06:00:00Z", asOf), { unit: "hours", count: 3 });
  assert.deepEqual(rules.ageOf("2026-11-15T09:00:00Z", asOf), { unit: "days", count: 4 });
});

check("FCFA formatting", () => {
  assert.equal(rules.formatFcfa(125000, "en"), "125,000 FCFA");
  assert.equal(rules.formatFcfa(1234567, "fr"), "1 234 567 FCFA");
  assert.equal(rules.formatFcfa(0), "0 FCFA");
  assert.equal(rules.formatFcfa(-5000.4), "-5,000 FCFA");
});

check("four statuses, each with its own icon and tone", () => {
  const looks = ["compliant", "due", "non_compliant", "authorized"].map(rules.lookOf);
  assert.equal(new Set(looks.map((l) => l.icon)).size, 4);
  assert.equal(new Set(looks.map((l) => l.tone)).size, 4);
});

check("every gate.* key used exists in en and fr", () => {
  const files = [
    path.join(MOBILE, "app", "admin", "gate", "index.js"),
    path.join(MOBILE, "src", "components", "GateVerificationCard.js"),
    path.join(MOBILE, "src", "components", "gate", "GateStatusPill.js"),
    path.join(MOBILE, "src", "components", "gate", "gateRules.js"),
  ];
  const keys = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/["`](gate\.[A-Za-z_.]+)(\$\{[^}]+\})?["`]/g)) {
      if (m[2]) {
        // A templated key: every value it can take.
        const base = m[1].replace(/\.$/, "");
        const fam = base.endsWith("age") ? ["now", "minutes", "hours", "days"]
          : ["compliant", "due", "non_compliant", "authorized"];
        for (const v of fam) keys.add(`${base}.${v}`);
      } else {
        keys.add(m[1]);
      }
    }
  }
  for (const lang of ["en", "fr"]) {
    const j = JSON.parse(fs.readFileSync(path.join(MOBILE, "src", "i18n", "locales", `${lang}.json`), "utf8"));
    for (const k of keys) {
      const v = k.split(".").reduce((o, p) => (o == null ? o : o[p]), j);
      assert.ok(v != null, `${lang}: missing ${k}`);
    }
  }
});

console.log(`\n${passed} checks passed.`);
