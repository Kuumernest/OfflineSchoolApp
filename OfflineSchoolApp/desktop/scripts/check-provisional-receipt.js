// desktop/scripts/check-provisional-receipt.js
"use strict";

/**
 * GET /api/fees/receipt/:id on the desktop, with no server.
 *
 * Before this the route had no local handler, so printing the receipt for a
 * payment taken offline went to an unreachable server and the parent left with
 * nothing. The owner's decision: provisional receipts may be printed before
 * sync, clearly marked provisional.
 *
 * Runs the REAL dispatcher (src/main/api) over the REAL store and outbox on a
 * temporary node:sqlite file:
 *
 *   - a payment recorded offline prints a receipt marked PROVISIONAL, with the
 *     amount, the child's balance as this machine knows it, the device receipt
 *     number labelled provisional, the class, and who recorded it;
 *   - once the server has accepted the payment (its outbox entry is gone) the
 *     handler declines, and the request goes to the server for the official
 *     receipt;
 *   - a payment reversed before it synced prints VOID;
 *   - the reversal of an already-confirmed payment does not make the original's
 *     receipt provisional;
 *   - one guardian, two children: each receipt carries that child's balance
 *     only (fees are per child — CLAUDE.md);
 *   - no fees.view, or another school's payment: declined to the server.
 *
 *   node scripts/check-provisional-receipt.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const store = require("../src/main/db/store");
const { outbox } = require("../src/main/db/outbox");
const api = require("../src/main/api");
const { receiptLabelsFor, fmtMoney } = require("../../shared/receiptHtml");

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}` +
    (ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const has = (html, text) => typeof html === "string" && html.includes(
  String(text).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;"));

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-receipt-"));
const file = path.join(dir, "school.db");

const main = () => {
  const db    = store.open(file);
  const docs  = store.documents(db);
  const meta  = store.meta(db);
  const queue = outbox(db);
  const session = {
    userId: "bursar-1", role: "bursar", schoolId: "S1",
    permissions: ["fees.view", "fees.manage"],
  };
  const ctx = { docs, meta, queue, session };

  const YEAR = "2026-2027";
  docs.put("school", { _id: "S1", name: "Lycée Bilingue de Test", motto: "Work", phone: "677000000" });
  docs.put("school", { _id: "S2", name: "Other School" });
  docs.put("class",  { _id: "c1", schoolId: "S1", name: "Form 2" });
  docs.put("user",   { _id: "bursar-1", schoolId: "S1", firstName: "Grace", lastName: "Ebai" });
  // One guardian, two children — the siblings share every contact detail.
  for (const [id, first] of [["kid-a", "Ada"], ["kid-b", "Ben"]]) {
    docs.put("student", {
      _id: id, schoolId: "S1", firstName: first, lastName: "Nkeng", classId: "c1",
      enrollmentNo: `E-${first}`, guardianName: "Mrs Nkeng", guardianPhone: "699000000",
      status: "approved", isActive: true, deletedAt: null,
    });
  }
  docs.put("student", { _id: "kid-x", schoolId: "S2", firstName: "Other", lastName: "Pupil", deletedAt: null });
  docs.put("feeCharge", { _id: "ch-a", schoolId: "S1", studentId: "kid-a", academicYear: YEAR, amount: 100000, waivedAmount: 0, voidedAt: null, deletedAt: null });
  docs.put("feeCharge", { _id: "ch-b", schoolId: "S1", studentId: "kid-b", academicYear: YEAR, amount: 80000,  waivedAmount: 0, voidedAt: null, deletedAt: null });

  const call = (method, p, { body = {}, query = {} } = {}) =>
    api.handle({ method, path: p, query, body }, ctx);
  const receipt = (id, lang = "en") =>
    call("GET", `/api/fees/receipt/${id}`, { query: { schoolId: "S1", lang } });

  // ── a payment recorded offline ──────────────────────────────────────────
  console.log("--- recorded offline, not yet confirmed ---");
  const paid = call("POST", "/api/fees/payments", { body: {
    schoolId: "S1", studentId: "kid-a", academicYear: YEAR,
    amount: 60000, method: "mobile_money", reference: "MOMO-77",
  } });
  const payment = paid.data.data;
  check("the payment is queued with a device receipt number",
    [paid.queued, /^RCT-2026-2027-[0-9A-F]{4}-0001$/.test(payment.receiptNo)], [true, true]);

  const en = receipt(payment._id, "en");
  const L  = receiptLabelsFor("en");
  check("the receipt is answered locally, as HTML", [en?.status, typeof en?.data], [200, "string"]);
  const html = en.data;
  check("marked: PROVISIONAL RECEIPT — not yet confirmed by the school's server",
    has(html, L.provisionalBanner), true);
  check("explains that the official receipt follows the sync", has(html, L.provisionalExplain), true);
  check("a text watermark", has(html, `>${L.provisionalWatermark}<`), true);
  check("the device number, labelled provisional",
    [has(html, L.provisionalReceiptNo), has(html, payment.receiptNo)], [true, true]);
  check("the amount", has(html, fmtMoney(60000, "en")), true);
  check("this child's balance as known locally (100 000 − 60 000)",
    has(html, fmtMoney(40000, "en")), true);
  check("the school, the pupil and the class",
    [has(html, "Lycée Bilingue de Test"), has(html, "Ada"), has(html, "Form 2")], [true, true, true]);
  check("the method in words, and the reference",
    [has(html, "Mobile money"), has(html, "MOMO-77")], [true, true]);
  check("who recorded it", [has(html, L.recordedBy), has(html, "Grace Ebai")], [true, true]);

  const fr = receipt(payment._id, "fr").data;
  const F  = receiptLabelsFor("fr");
  check("in French: REÇU PROVISOIRE",
    [has(fr, F.provisionalBanner), has(fr, F.provisionalExplain), has(fr, F.provisionalReceiptNo)],
    [true, true, true]);

  // ── siblings: per child ─────────────────────────────────────────────────
  console.log("--- one guardian, two children ---");
  const ben = call("POST", "/api/fees/payments", { body: {
    schoolId: "S1", studentId: "kid-b", academicYear: YEAR, amount: 30000, method: "cash",
  } }).data.data;
  const benHtml = receipt(ben._id).data;
  check("the sibling's receipt carries the sibling's balance (80 000 − 30 000)",
    [has(benHtml, fmtMoney(50000, "en")), has(benHtml, "Ben")], [true, true]);
  check("…and not the other child's", has(benHtml, fmtMoney(40000, "en")), false);
  check("both children's receipts are numbered apart",
    ben.receiptNo !== payment.receiptNo, true);

  // ── refusals stay with the server ───────────────────────────────────────
  console.log("--- declined to the server ---");
  ctx.session = { ...session, permissions: ["students.view"] };
  check("no fees.view: declined", receipt(payment._id), null);
  ctx.session = session;
  check("another school's id in the query: declined",
    call("GET", `/api/fees/receipt/${payment._id}`, { query: { schoolId: "S2" } }), null);
  check("an unknown payment: declined", receipt("nope"), null);

  // ── reversed before it synced ───────────────────────────────────────────
  console.log("--- reversed before sync ---");
  const rev = call("POST", `/api/fees/payments/${ben._id}/reverse`, {
    body: { schoolId: "S1", reason: "wrong child" },
  });
  check("the reversal is queued", rev?.queued, true);
  const voided = receipt(ben._id).data;
  check("the original's provisional receipt says VOID",
    [has(voided, L.voidBanner), has(voided, `>${L.voidWatermark}<`)], [true, true]);
  const credit = receipt(rev.data.data._id).data;
  check("the reversal prints as a provisional credit note",
    [has(credit, L.provisionalReversal), has(credit, L.provisionalBanner)], [true, true]);

  // ── confirmed by the server ─────────────────────────────────────────────
  console.log("--- once the server has accepted it ---");
  for (const entry of queue.all()) {
    if (entry.doc_id === payment._id) {
      queue.markSent(entry.seq);
      docs.settle("feePayment", payment._id);
    }
  }
  check("confirmed: the handler declines, so the server's official receipt is printed",
    receipt(payment._id), null);

  // A confirmed payment reversed offline: the original row is stamped and
  // pending again, but its create is not in the queue — it is confirmed.
  const rev2 = call("POST", `/api/fees/payments/${payment._id}/reverse`, {
    body: { schoolId: "S1", reason: "duplicate" },
  });
  check("reversing a confirmed payment is queued", rev2?.queued, true);
  check("the original is pending again (stamped)", docs.get("feePayment", payment._id)._pending, true);
  check("…but its receipt is still the server's", receipt(payment._id), null);
  check("the new reversal row is provisional",
    has(receipt(rev2.data.data._id)?.data, L.provisionalBanner), true);

  // ── classified ──────────────────────────────────────────────────────────
  console.log("--- coverage ---");
  const { isPartial } = require("../src/main/api/coverage");
  check("coverage lists the route as partial (provisional only)",
    isPartial("GET /fees/receipt/:id"), true);
  check("the route is registered",
    api.routes().includes("read GET /api/fees/receipt/:paymentId"), true);

  db.close?.();
};

try {
  main();
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
