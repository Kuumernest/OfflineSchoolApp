// web/scripts/check-outbox-ownership.mjs
//
// The desktop sync panel offers Discard, Try again and Save a copy only on the
// signed-in account's own queued changes.
//
//   1. The rule (src/lib/offline/outboxOwnership.ts), run for real: "mine" is
//      actionable; "other" and "none" are read-only with their reason; a main
//      process older than `owner` keeps the old panel; the main process's
//      refusals (a thrown Error, or Save a copy's { ok: false, error }) map to
//      a sentence.
//   2. The panel (SyncIndicator.tsx) puts all three buttons behind canActOn,
//      shows the reason otherwise, and turns a refusal into a toast instead of
//      an unhandled rejection.
//   3. The sentences exist in en and fr.
//
// The main process enforces the same rule: desktop/scripts/check-outbox-ownership.js.
//
//   node scripts/check-outbox-ownership.mjs

import fs   from "node:fs";
import path from "node:path";
import url  from "node:url";
import ts   from "typescript";
import i18next from "i18next";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// ── 1. The rule ─────────────────────────────────────────────────────────────
console.log("--- whose entry it is decides what is offered ---");
const { outputText } = ts.transpileModule(read("src/lib/offline/outboxOwnership.ts"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { canActOn, readOnlyReasonKey, refusalKey } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const entry = (owner) => ({ seq: 1, method: "POST", path: "/api/fees/payments", last_status: 403, last_error: "x", ...(owner ? { owner } : {}) });
check("own entry: actionable", canActOn(entry("mine")), true);
check("another account's: read-only", canActOn(entry("other")), false);
check("ownerless: read-only", canActOn(entry("none")), false);
check("a main process without `owner`: as before", canActOn(entry()), true);
check("the reasons", [readOnlyReasonKey(entry("other")), readOnlyReasonKey(entry("none")), readOnlyReasonKey(entry("mine"))],
  ["sync.readOnlyOtherAccount", "sync.readOnlyOwnerless", null]);

console.log("--- the main process's refusals, in words ---");
const ipc = (msg) => new Error(`Error invoking remote method 'outbox:discard': OutboxRefusal: ${msg}`);
check("another account's (thrown over IPC)",
  refusalKey(ipc("OUTBOX_OTHER_ACCOUNT: This change was recorded by another account")), "sync.readOnlyOtherAccount");
check("ownerless (thrown over IPC)", refusalKey(ipc("OUTBOX_OWNERLESS: …")), "sync.readOnlyOwnerless");
check("signed out", refusalKey(ipc("NOT_SIGNED_IN: …")), "sync.refusedSignedOut");
check("Save a copy's answer", refusalKey({ ok: false, error: "OUTBOX_OTHER_ACCOUNT", message: "…" }), "sync.readOnlyOtherAccount");
check("anything else is not a refusal", [refusalKey(new Error("disk full")), refusalKey({ ok: false, cancelled: true }), refusalKey(null)],
  [null, null, null]);

// ── 2. The panel ────────────────────────────────────────────────────────────
console.log("--- the panel ---");
const panel = read("src/components/offline/SyncIndicator.tsx");
const gateAt  = panel.indexOf("{canActOn(item) && (\n");
const buttons = ["bridge.outbox.saveCopy(", "bridge.outbox.unblock(", "bridge.outbox.discard("].map((s) => panel.indexOf(s));
const gateEnd = panel.indexOf("</li>", gateAt);
check("the rule is imported from lib/offline", /from "@\/lib\/offline\/outboxOwnership"/.test(panel), true);
check("all three actions sit inside the canActOn(item) block",
  gateAt > 0 && buttons.every((b) => b > gateAt && b < gateEnd), true);
check("each action appears once (no ungated copy)",
  ["bridge.outbox.saveCopy(", "bridge.outbox.unblock(", "bridge.outbox.discard("]
    .map((s) => panel.split(s).length - 1), [1, 1, 1]);
check("a read-only entry shows its reason",
  /\{!canActOn\(item\) && \([\s\S]{0,300}readOnlyReasonKey\(item\)/.test(panel), true);
check("a refused Try again or Discard is caught and said",
  [/unblock\(item\.seq\)\); \}\s*catch \(err\) \{ refused\(/.test(panel), /discard\(item\.seq\)\); \}\s*catch \(err\) \{ refused\(/.test(panel)],
  [true, true]);
check("a refused Save a copy is said", /else if \(refusalKey\(saved\)\)/.test(panel), true);
check("the bridge type carries the owner",
  /owner\?: "mine" \| "other" \| "none"/.test(read("src/lib/offline/bridge.ts")), true);

// ── 3. The sentences ────────────────────────────────────────────────────────
console.log("--- what the person reads ---");
await i18next.init({
  lng: "en", fallbackLng: false,
  resources: {
    en: { translation: JSON.parse(read("src/i18n/locales/en.json")) },
    fr: { translation: JSON.parse(read("src/i18n/locales/fr.json")) },
  },
});
for (const key of ["sync.readOnlyOtherAccount", "sync.readOnlyOwnerless", "sync.refusedSignedOut"]) {
  const en = i18next.t(key, { lng: "en" });
  const fr = i18next.t(key, { lng: "fr" });
  check(`${key}: written in both, and differently`, [en !== key, fr !== key, en !== fr], [true, true, true]);
}
check("en: another account's says who may act",
  /another account/.test(i18next.t("sync.readOnlyOtherAccount", { lng: "en" })), true);
check("fr: another account's says who may act",
  /autre compte/.test(i18next.t("sync.readOnlyOtherAccount", { lng: "fr" })), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
