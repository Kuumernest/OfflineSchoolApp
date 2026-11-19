// web/scripts/check-gate-page.mjs
//
// The gate screen's offline half and its boundaries.
//
//   - the snapshot search finds a pupil by name (accents ignored) or admission
//     number, and lists every sibling who shares a surname (CLAUDE.md: siblings
//     are normal data, never collapsed)
//   - the local verification counts confirmed payments only, reports this
//     device's pending ones beside the result, and calls a day-old copy stale
//   - the snapshot is never written without gate.verify
//   - nothing on the gate screen can record a payment or change an agreement,
//     waiver or fee structure
//
//   node scripts/check-gate-page.mjs

import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";
import url  from "node:url";
import ts   from "typescript";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// gateLogic.ts, transpiled, with the shared engine reached by absolute path.
const engine = url.pathToFileURL(path.join(ROOT, "..", "shared", "compliance.js")).href;
const { outputText } = ts.transpileModule(read("src/pages/gate/gateLogic.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gate-")), "gateLogic.mjs");
fs.writeFileSync(tmp, outputText.replace(/(["'])(\.\.\/)+shared\/compliance\.js\1/g, `"${engine}"`));
const gate = await import(url.pathToFileURL(tmp).href);

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const pupil = (over) => ({
  studentId: "s", token: null, name: "", enrollmentNo: null, classId: null, className: null,
  photoUrl: null, charges: [], payments: [], plan: null, authorizations: [], ...over,
});

const snapshot = {
  generatedAt: new Date().toISOString(),
  academicYear: "2026-2027",
  students: [
    pupil({ studentId: "a", token: "tokA", name: "Élodie Ngo", enrollmentNo: "ADM-001" }),
    pupil({ studentId: "b", token: "tokB", name: "Marc Ngo",   enrollmentNo: "ADM-002" }),
    pupil({ studentId: "c", token: null,   name: "Paul Ngo",   enrollmentNo: "ADM-003" }),
    pupil({ studentId: "d", token: "tokD", name: "Awa Bello",  enrollmentNo: "ADM-104" }),
  ],
};

console.log("--- search over the snapshot ---");
check("accents ignored", gate.searchSnapshot(snapshot, "elodie").map((s) => s.studentId), ["a"]);
check("every sibling sharing a surname is listed", gate.searchSnapshot(snapshot, "ngo").map((s) => s.studentId), ["a", "b", "c"]);
check("words in any order", gate.searchSnapshot(snapshot, "ngo marc").map((s) => s.studentId), ["b"]);
check("admission number", gate.searchSnapshot(snapshot, "adm-104").map((s) => s.studentId), ["d"]);
check("a pupil with no card is still found", gate.searchSnapshot(snapshot, "paul").map((s) => s.token), [null]);
check("one letter searches nothing", gate.searchSnapshot(snapshot, "n").length, 0);
check("by token", gate.findByToken(snapshot, "tokD")?.studentId, "d");
check("an unknown token is nobody", gate.findByToken(snapshot, "nope"), null);

console.log("--- verification on this device ---");
const owes = pupil({
  studentId: "x",
  charges:  [{ amount: 100_000, dueDate: day(-10) }],
  payments: [{ amount: 60_000, receivedAt: day(-12) }],
});
const now = gate.localCompliance(owes, new Date().toISOString());
check("confirmed payments only: non-compliant", now.status, "non_compliant");
check("outstanding due", now.outstandingDue, 40_000);
check("fresh copy is not stale", now.stale, false);

const withPending = gate.localCompliance(owes, new Date().toISOString(),
  [{ amount: 40_000, receivedAt: day(0), state: "pending" }]);
check("a pending payment is never counted as paid", [withPending.status, withPending.totalPaid], ["non_compliant", 60_000]);
check("…but is reported beside the result", [withPending.pending.count, withPending.pending.amount, withPending.pending.statusIfConfirmed], [1, 40_000, "compliant"]);
check("…and says the answer depends on it", withPending.dependsOnPending, true);

const old = gate.localCompliance(owes, new Date(Date.now() - 30 * 3_600_000).toISOString());
check("a copy synced 30h ago is stale", old.stale, true);

const passed = gate.localCompliance({
  ...owes,
  authorizations: [{ _id: "g1", validFrom: day(-1), validUntil: day(5), reason: "Bursar agreed" }],
}, new Date().toISOString());
check("a gate pass in force: authorized", passed.status, "authorized");

console.log("--- boundaries ---");
const page = read("src/pages/gate/GatePage.tsx");
check("the snapshot is stored only under gate.verify",
  /if \(canVerify && snapshotQ\.data\) storeSnapshot\(/.test(page) &&
  /canVerify \? readStoredSnapshot\(/.test(page), true);

const gateSources = fs.readdirSync(path.join(ROOT, "src/pages/gate"))
  .map((f) => read(`src/pages/gate/${f}`)).join("\n") + read("src/services/gate.service.ts");
const forbidden = [
  "recordPayment", "reversePayment", "createPlan", "updatePlan", "cancelPlan",
  "applyStructure", "createStructure", "/fees/payments", "/waiver", "approveRequest",
];
check("no payment, agreement, waiver or structure action on the gate screen",
  forbidden.filter((f) => gateSources.includes(f)), []);

console.log("\n--- the fee card always shows after a scan (bug: a stale session hid it) ---");
// A browser signed in before gate.verify existed kept a permission list
// without it for up to 30 days, and the card left the fee section out with
// no word of why — while the server had sent the full compliance.
const card = read("src/pages/gate/VerificationCard.tsx");
check("the fee section is not gated on the browser's permission list",
  /\{canVerify && s && \(\s*result\.compliance/.test(card), false);
check("…it renders the card, or the reason there is none",
  /result\.compliance\s*\?\s*<FeePanel/.test(card) && /gatePage\.feeUnavailable\./.test(card), true);
check("the server's compliance is shown whatever the browser's list says",
  /const shown = res\.compliance \?\? \(canVerify \? local : null\);/.test(page), true);
check("every result records why fees are missing, when they are",
  (page.match(/feeUnavailable:/g) ?? []).length >= 2, true);
const en = JSON.parse(read("src/i18n/locales/en.json")).gatePage?.feeUnavailable ?? {};
const fr = JSON.parse(read("src/i18n/locales/fr.json")).gatePage?.feeUnavailable ?? {};
const reasons = ["title", "not_permitted", "no_offline_data", "server_missing"];
check("each reason is worded in both languages",
  reasons.filter((k) => !en[k] || !fr[k]), []);
const store = read("src/store/auth.store.ts");
check("a restored session re-reads its permissions (GET /auth/me) at start-up",
  /revalidateUser: async/.test(store) && /"\/auth\/me"/.test(store) &&
  /setTimeout\(\(\) => \{ void get\(\)\.revalidateUser\(\); \}/.test(store), true);
check("…keeping the school a super_admin is inside, not resetting it like setAuth",
  /withActiveSchool\(normaliseAuthUser\(raw\), get\(\)\.activeSchool\)/.test(store), true);
check("the gate page re-reads them on opening",
  /useEffect\(\(\) => \{ void useAuthStore\.getState\(\)\.revalidateUser\(\); \}, \[\]\)/.test(page), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
