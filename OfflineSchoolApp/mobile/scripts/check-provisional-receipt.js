// mobile/scripts/check-provisional-receipt.js
"use strict";

/**
 * A receipt the bursar can hand over before the phone has synced.
 *
 * The phone could not print a receipt at all. The owner's decision:
 * provisional receipts may be printed before sync, clearly marked provisional.
 *
 * Loads the REAL services through Babel (fee.service, student.service,
 * school.service, document.service, receipt.service) over a real SQLite
 * (node:sqlite), records a payment the way the screen does, and asserts:
 *
 *   - the template on the phone is a byte-for-byte copy of OfflineSchoolApp/
 *     shared (Metro cannot reach that folder; a copy that drifts is a second
 *     template);
 *   - a payment still queued prints PROVISIONAL, in words, with the amount, the
 *     child's balance as known on the phone, the class, the provisional
 *     reference and who recorded it — in English and French;
 *   - one guardian, two children: each receipt carries that child's balance;
 *   - once the payment is confirmed the official receipt is the SERVER's
 *     (backend print/receipt.js, called here as the fake server), unmarked,
 *     naming the provisional reference it replaces.
 *
 *   node scripts/check-provisional-receipt.js
 */

const path = require("path");
const fs   = require("fs");
const nodeCrypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { adapt, makeLoader, quietly, MOBILE } = require("./offline-harness");

const ROOT    = path.join(MOBILE, "..");
const SHARED  = path.join(ROOT, "shared");
const BACKEND = path.join(ROOT, "backend");

let pass = 0, fail = 0;
// The services log freely and quietly() silences console; the verdicts go
// straight to stdout so they survive it.
const say = (line) => process.stdout.write(`${line}\n`);
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  say(`  ${ok ? "ok  " : "FAIL"} ${label}` +
    (ok ? "" : `\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const has = (html, text) => typeof html === "string" && html.includes(
  String(text).replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;"));

const run = quietly(async () => {
  // ── the copy is the shared template ─────────────────────────────────────
  say("--- one template ---");
  for (const f of ["printDocument.js", "receiptHtml.js", "receipts.js"]) {
    check(`src/print/shared/${f} is byte-for-byte shared/${f}`,
      fs.readFileSync(path.join(MOBILE, "src/print/shared", f), "utf8") ===
      fs.readFileSync(path.join(SHARED, f), "utf8"), true);
  }

  // ── a phone ─────────────────────────────────────────────────────────────
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);
  const noop = () => {};
  const user = { _id: "bursar-1", role: "school_admin", schoolId: "S1", name: "Grace Ebai" };

  // The fake server: the official receipt is the backend's own renderer.
  const backendReceipt = require(path.join(BACKEND, "src/print/receipt"));
  const { labelsFor }  = require(path.join(BACKEND, "src/print/labels"));
  const server = { payments: new Map(), requests: [] };
  const api = {
    get: async (url, opts = {}) => {
      server.requests.push(url);
      const m = /^\/fees\/receipt\/(.+)$/.exec(url);
      if (m && server.payments.has(m[1])) {
        const lang = opts.params?.lang || "en";
        return { data: backendReceipt.buildReceiptHtml({
          data: {
            school: { name: "Lycée Bilingue de Test" },
            student: { name: "Ada Nkeng", className: "Form 2" },
            payment: server.payments.get(m[1]),
            totals: { charged: 100000, waived: 0, paid: 60000, balance: 40000 },
          },
          labels: labelsFor(lang), lang, printedOn: "1 October 2026", origin: null,
        }) };
      }
      const err = new Error("Network Error"); err.code = "ERR_NETWORK"; throw err;
    },
    post: async () => { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; throw e; },
    put: async () => { throw new Error("offline"); },
    patch: async () => { throw new Error("offline"); },
    delete: async () => { throw new Error("offline"); },
  };

  const pkg = new Map([
    ["expo-sqlite", { openDatabaseAsync: async () => db, openDatabaseSync: () => db }],
    ["expo-secure-store", { getItemAsync: async () => "token", setItemAsync: async () => {}, deleteItemAsync: async () => {} }],
    ["@react-native-community/netinfo", {
      __esModule: true,
      default: { addEventListener: () => noop, fetch: async () => ({ isConnected: false }) },
      addEventListener: () => noop, fetch: async () => ({ isConnected: false }),
    }],
    ["react-native", { AppState: { addEventListener: () => ({ remove: noop }), currentState: "active" }, Platform: { OS: "android" } }],
    ["expo-crypto", { getRandomBytes: (n) => nodeCrypto.randomBytes(n), randomUUID: () => nodeCrypto.randomUUID() }],
    ["react-native-get-random-values", {}],
    ["expo-print",   { printAsync: async () => {}, printToFileAsync: async () => ({ uri: "file:///x.pdf" }) }],
    ["expo-sharing", { isAvailableAsync: async () => false, shareAsync: async () => {} }],
    ["expo-file-system", { File: class { constructor(u) { this.uri = u; } base64() { return "iVBORw0KGgo="; } }, Paths: {}, Directory: class {} }],
  ]);
  const rel = new Map([
    ["src/services/api", { __esModule: true, default: api, API_URL: "http://phone/api", setRetryContext: noop, clearRetryContext: noop, getAuthToken: async () => "token" }],
    ["src/store/auth.store", {
      useAuthStore: { getState: () => ({ user, token: "token" }) },
      acquireSyncLock: () => true, releaseSyncLock: noop,
    }],
    ["src/services/content.service", { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
  ]);
  const load = makeLoader(pkg, rel);

  await load("src/db/database").getDatabase();
  const Fees     = load("src/services/fee.service");
  const Students = load("src/services/student.service");
  const Schools  = load("src/services/school.service");
  const Receipts = load("src/services/receipt.service");
  const { receiptLabelsFor, fmtMoney } = require(path.join(SHARED, "receiptHtml"));

  await Schools.upsertSchoolLocal({ _id: "S1", name: "Lycée Bilingue de Test", motto: "Work", logo: "data:image/png;base64,iVBORw0KGgo=" });
  await Students.getStudentById("warm-up");                 // the table, as the app makes it
  for (const [id, first] of [["kid-a", "Ada"], ["kid-b", "Ben"]]) {
    // Siblings: one guardian, same contact details.
    raw.prepare(`INSERT INTO students (id, schoolId, class_name, firstName, lastName, admissionNo,
                 guardian_name, guardian_phone, _synced) VALUES (?, 'S1', 'Form 2', ?, 'Nkeng', ?, 'Mrs Nkeng', '699000000', 1)`)
      .run(id, first, `E-${first}`);
  }
  await Fees.getStudentAccount("kid-a");                    // the fee tables
  raw.prepare(`INSERT INTO fee_charges (id, school_id, student_id, academic_year, label, amount, _synced)
               VALUES ('ch-a','S1','kid-a','2026-2027','Tuition',100000,1), ('ch-b','S1','kid-b','2026-2027','Tuition',80000,1)`).run();

  // ── queued, not confirmed ───────────────────────────────────────────────
  say("--- recorded on the phone, not yet synced ---");
  const { id } = await Fees.recordPayment({
    schoolId: "S1", studentId: "kid-a", academicYear: "2026-2027",
    amount: 60000, method: "mobile_money", reference: "MOMO-77",
  });
  const ref = Receipts.provisionalReference(id);
  check("a provisional reference from the payment id", /^P-[0-9A-F]{8}$/.test(ref), true);

  const L = receiptLabelsFor("en");
  const r = await Receipts.getReceiptForPrint({ paymentId: id, schoolId: "S1", lang: "en" });
  const html = r.html;
  check("provisional, built on the phone (no request made)",
    [r.provisional, server.requests.length], [true, 0]);
  check("marked: PROVISIONAL RECEIPT — not yet confirmed by the school's server", has(html, L.provisionalBanner), true);
  check("explains the official receipt follows the sync", has(html, L.provisionalExplain), true);
  check("a text watermark", has(html, `>${L.provisionalWatermark}<`), true);
  check("identified by the provisional reference, labelled so",
    [has(html, L.provisionalReference), has(html, ref)], [true, true]);
  check("the amount, and this child's balance as known on the phone (100 000 − 60 000)",
    [has(html, fmtMoney(60000, "en")), has(html, fmtMoney(40000, "en"))], [true, true]);
  check("the school, the pupil, the class, the reference",
    [has(html, "Lycée Bilingue de Test"), has(html, "Ada Nkeng"), has(html, "Form 2"), has(html, "MOMO-77")],
    [true, true, true, true]);
  check("who recorded it", [has(html, L.recordedBy), has(html, "Grace Ebai")], [true, true]);
  check("the cached logo, inline", html.includes('src="data:image/png;base64,'), true);

  const F  = receiptLabelsFor("fr");
  const fr = (await Receipts.getReceiptForPrint({ paymentId: id, schoolId: "S1", lang: "fr" })).html;
  check("in French: REÇU PROVISOIRE",
    [has(fr, F.provisionalBanner), has(fr, F.provisionalExplain), has(fr, F.provisionalReference)],
    [true, true, true]);

  say("--- one guardian, two children ---");
  const ben = await Fees.recordPayment({
    schoolId: "S1", studentId: "kid-b", academicYear: "2026-2027", amount: 30000, method: "cash",
  });
  const benHtml = await Receipts.buildProvisionalReceiptHtml({ paymentId: ben.id, lang: "en" });
  check("the sibling's receipt carries the sibling's balance (80 000 − 30 000)",
    [has(benHtml, fmtMoney(50000, "en")), has(benHtml, "Ben Nkeng")], [true, true]);
  check("…and not the other child's", has(benHtml, fmtMoney(40000, "en")), false);

  // ── confirmed ───────────────────────────────────────────────────────────
  say("--- once the server has confirmed it ---");
  const official = "RCT-2026-2027-0041";
  raw.prepare("UPDATE fee_payments SET _synced = 1, receipt_no = ? WHERE id = ?").run(official, id);
  server.payments.set(id, {
    _id: id, receiptNo: official, academicYear: "2026-2027", amount: 60000,
    method: "mobile_money", reference: "MOMO-77", source: "mobile",
  });
  check("no provisional receipt for a confirmed payment",
    await Receipts.buildProvisionalReceiptHtml({ paymentId: id }), null);
  const o = await Receipts.getReceiptForPrint({ paymentId: id, schoolId: "S1", lang: "en" });
  check("the official receipt is the server's", [o.provisional, server.requests.at(-1)], [false, `/fees/receipt/${id}`]);
  check("…unmarked", [has(o.html, L.provisionalBanner), o.html.includes("prov-")], [false, false]);
  check("…with the official number", has(o.html, official), true);
  check("…naming the provisional reference it replaces",
    has(o.html, L.replacesProvisional.replace("{ref}", ref)), true);

  server.payments.clear();     // the server out of reach again
  const again = await Receipts.getReceiptForPrint({ paymentId: id, schoolId: "S1", lang: "en" });
  check("offline later: the cached official copy reprints, flagged stale",
    [again.provisional, again.stale, has(again.html, official)], [false, true, true]);

  say(`\n  ${pass} passed, ${fail} failed`);
});

run().then(() => process.exit(fail ? 1 : 0))
  .catch((e) => { console.error("check failed:", e); process.exit(1); });
