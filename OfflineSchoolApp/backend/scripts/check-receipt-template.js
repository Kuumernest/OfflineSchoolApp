// backend/scripts/check-receipt-template.js
"use strict";

/**
 * One receipt template, official and provisional (shared/receiptHtml.js).
 *
 * The owner's decision: a receipt may be printed before the payment has
 * synced, clearly marked provisional. What this holds:
 *
 *   - the official receipt carries NO provisional marking, in either language;
 *   - the provisional one carries the heading, the explanation and the
 *     watermark as WORDS (black-and-white printers), and labels its number
 *     provisional;
 *   - both are the same layout: the same sequence of sheet sections, with the
 *     provisional additions the only difference;
 *   - a provisional receipt for a payment reversed before it synced says VOID;
 *   - a phone payment (no receipt number) is identified by its provisional
 *     reference, and the server's official receipt names that reference;
 *   - a desktop number the server refused is named on the official receipt;
 *   - the server's catalogue and the template's agree on every word.
 *
 *   node scripts/check-receipt-template.js
 */

const path = require("path");
const SHARED = path.join(__dirname, "..", "..", "shared");

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
};

const tpl = require(path.join(SHARED, "receiptHtml"));
const {
  provisionalReference, replacedProvisionalReference,
  replacedProvisionalReceipt, rejectedDeviceReceipt,
} = require(path.join(SHARED, "receipts"));
const backendReceipt = require("../src/print/receipt");
const { labelsFor } = require("../src/print/labels");

const school  = { name: "Lycée Bilingue", motto: "Work", address: "Box 1", phone: "677", email: "s@x" };
const student = { name: "Ada Nkeng", enrollmentNo: "E-1", className: "Form 2" };
const totals  = { charged: 100000, waived: 0, paid: 60000, balance: 40000 };
const payment = {
  _id: "9f1c2b3a-1111-4222-8333-444455556666",
  receiptNo: "RCT-2026-2027-CB6F-0007", academicYear: "2026-2027",
  amount: 60000, method: "mobile_money", reference: "MOMO-77",
};

const render = (lang, provisional, p = payment, extra = {}) => tpl.buildReceiptHtml({
  data: { school, student, payment: p, totals, ...extra },
  labels: tpl.receiptLabelsFor(lang), lang, printedOn: "1 October 2026", provisional,
});

/** The sheet's skeleton: every class attribute in order, provisional ones removed.
 *  Individual facts are left out: the provisional one has more of them (its
 *  reference, who recorded it) inside the same box. */
const skeleton = (html) =>
  [...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1]).filter((c) => !c.startsWith("prov-") && !c.startsWith("fact__"));

const MARKS = (L) => [L.provisionalBanner, L.provisionalWatermark, L.provisionalExplain, L.provisionalReceiptNo];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");

for (const lang of ["en", "fr"]) {
  const L = tpl.receiptLabelsFor(lang);
  const official    = render(lang, false);
  const provisional = render(lang, true);

  console.log(`\n── ${lang} ──`);
  ok("official: no provisional marking at all",
    MARKS(L).every((m) => !official.includes(esc(m))) && !official.includes("prov-"));
  ok("provisional: the heading, in words",  provisional.includes(esc(L.provisionalBanner)));
  ok("provisional: the explanation that the official receipt follows the sync",
    provisional.includes(esc(L.provisionalExplain)));
  ok("provisional: a text watermark (not colour alone)",
    /class="prov-mark"[^>]*>[^<]*\S/.test(provisional) && provisional.includes(`>${esc(L.provisionalWatermark)}<`));
  ok("provisional: the number is labelled provisional",
    provisional.includes(esc(L.provisionalReceiptNo)) && provisional.includes(payment.receiptNo));
  ok("provisional: the title says provisional", provisional.includes(esc(L.provisionalTitle)));
  ok("provisional: the page <title> says provisional",
    new RegExp(`<title>${L.provisionalWatermark}`).test(provisional));
  ok("both carry the amount and the balance", [official, provisional].every((h) =>
    h.includes(tpl.fmtMoney(60000, lang)) && h.includes(tpl.fmtMoney(40000, lang))));
  ok("same layout: the sheet's sections are identical apart from the marking",
    JSON.stringify(skeleton(official)) === JSON.stringify(skeleton(provisional)),
    `${skeleton(official).join(",")}\n       ${skeleton(provisional).join(",")}`);
  ok("the date fact has a label", !/<div class="fact__label"><\/div>/.test(official));

  const voided = render(lang, true, { ...payment, reversedById: "r1" });
  ok("provisional for a payment reversed before sync says VOID",
    voided.includes(esc(L.voidBanner)) && voided.includes(`>${esc(L.voidWatermark)}<`));
  ok("…and an official one is not stamped void by this template",
    !render(lang, false, { ...payment, reversedById: "r1" }).includes(esc(L.voidBanner)));

  const reversal = render(lang, true, { ...payment, amount: -60000, reversesId: "p0" });
  ok("a provisional credit note is titled as a reversal",
    reversal.includes(esc(L.provisionalReversal)) && !reversal.includes(esc(L.voidBanner)));

  const phone = render(lang, true, { ...payment, receiptNo: null }, { recordedBy: "Mme Bursar" });
  ok("phone payment: identified by the provisional reference",
    phone.includes(esc(L.provisionalReference)) && phone.includes("P-9F1C2B3A"));
  ok("phone payment: recorded by", phone.includes(esc(L.recordedBy)) && phone.includes("Mme Bursar"));
}

console.log("\n── numbering ──");
ok("provisional reference from the payment id", provisionalReference(payment._id) === "P-9F1C2B3A");
ok("no reference from a missing id", provisionalReference(null) === null);
ok("official phone receipt with a server number names the provisional reference",
  replacedProvisionalReference({ ...payment, source: "mobile", receiptNo: "RCT-2026-2027-0041" }) === "P-9F1C2B3A");
ok("desktop device number kept by the server: same number, no cross-reference",
  replacedProvisionalReference({ ...payment, source: "web" }) === null &&
  replacedProvisionalReference({ ...payment, source: "desktop" }) === null);
ok("a payment taken on the web never had provisional paper",
  replacedProvisionalReference({ ...payment, source: "web", receiptNo: "RCT-2026-2027-0041" }) === null);

ok("a refused device number is kept for the record",
  rejectedDeviceReceipt(" RCT-2025-2026-CB6F-0042 ", "2026-2027") === "RCT-2025-2026-CB6F-0042");
ok("…a kept one is not (it is the receipt number)",
  rejectedDeviceReceipt("RCT-2026-2027-CB6F-0042", "2026-2027") === null);
ok("…nor anything that is not a device number",
  ["RCT-2025-2026-0042", "RCT-2025-2026-cb6f-0042", "<b>x</b>", null, 42]
    .every((v) => rejectedDeviceReceipt(v, "2026-2027") === null));
ok("the official receipt names the refused number",
  replacedProvisionalReceipt({ receiptNo: "RCT-2026-2027-0041", claimedReceiptNo: "RCT-2025-2026-CB6F-0042" })
    === "RCT-2025-2026-CB6F-0042" &&
  replacedProvisionalReceipt({ receiptNo: "RCT-2026-2027-0041", claimedReceiptNo: null }) === null);

console.log("\n── the server's wrapper ──");
for (const lang of ["en", "fr"]) {
  const L = tpl.receiptLabelsFor(lang);
  const mobileOfficial = backendReceipt.buildReceiptHtml({
    data: { school, student, totals, payment: { ...payment, source: "mobile", receiptNo: "RCT-2026-2027-0041" } },
    labels: labelsFor(lang), lang, printedOn: "x", origin: null,
  });
  ok(`${lang}: official receipt for a phone payment says which provisional paper it replaces`,
    mobileOfficial.includes(esc(L.replacesProvisional.replace("{ref}", "P-9F1C2B3A"))));
  ok(`${lang}: …and is not itself marked provisional`,
    !mobileOfficial.includes(esc(L.provisionalBanner)) && !mobileOfficial.includes("prov-"));
  const webOfficial = backendReceipt.buildReceiptHtml({
    data: { school, student, totals, payment: { ...payment, source: "web", receiptNo: "RCT-2026-2027-0041" } },
    labels: labelsFor(lang), lang, printedOn: "x", origin: null,
  });
  ok(`${lang}: official receipt for a web payment has no cross-reference`,
    !webOfficial.includes(esc(L.replacesProvisional.split("{ref}")[0].slice(0, 30))));

  const desktopRefused = backendReceipt.buildReceiptHtml({
    data: { school, student, totals, payment: { ...payment, source: "desktop",
      receiptNo: "RCT-2026-2027-0041", claimedReceiptNo: "RCT-2025-2026-CB6F-0042" } },
    labels: labelsFor(lang), lang, printedOn: "x", origin: null,
  });
  ok(`${lang}: official receipt for a refused desktop number names that number, once`,
    desktopRefused.includes(esc(L.replacesProvisionalReceipt.replace("{no}", "RCT-2025-2026-CB6F-0042"))) &&
    !desktopRefused.includes(esc(L.replacesProvisional.split("{ref}")[0].slice(0, 30))));
  ok(`${lang}: …a provisional receipt never carries the line`,
    !render(lang, true, payment, { replacesProvisionalReceipt: "RCT-2025-2026-CB6F-0042" })
      .includes("RCT-2025-2026-CB6F-0042"));

  const server = labelsFor(lang);
  const words  = tpl.receiptLabelsFor(lang);
  const differ = Object.keys(words).filter((k) => JSON.stringify(server[k]) !== JSON.stringify(words[k]));
  ok(`${lang}: the server's catalogue and the template's agree on every receipt word`,
    differ.length === 0, differ.join(", "));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
