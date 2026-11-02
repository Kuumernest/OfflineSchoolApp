// web/scripts/check-connectivity.mjs
//
// When the console believes it is offline, and when it stops believing it.
//
// The browser console is online-only, so being offline has to be said — once,
// persistently, across the top (components/offline/OfflineBanner.tsx). The
// rules for "offline" live in src/lib/offline/connectivity.ts, which imports
// nothing so it can be run here as it is:
//
//   the device's offline/online events      set / clear it
//   a request that got NO response          sets it — a link that is up with no
//                                           internet behind it, which
//                                           navigator.onLine calls online
//   any response from the server            clears it, whatever the status
//   a timeout or a cancelled request        changes nothing
//
//   node scripts/check-connectivity.mjs

import fs   from "node:fs";
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

const load = async (rel) => {
  const { outputText } = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};

const { createConnectivity, isNoNetworkError, noResponseMessageKey } = await load("src/lib/offline/connectivity.ts");

const ONLINE = { offline: false, reason: null };

console.log("--- the device's own events ---");
{
  const c = createConnectivity(true);
  let notified = 0;
  c.subscribe(() => { notified++; });
  check("starts online when the device says so", c.get(), ONLINE);
  c.deviceOffline();
  check("the offline event sets it", c.get(), { offline: true, reason: "device" });
  check("and tells subscribers", notified, 1);
  const same = c.get();
  c.deviceOffline();
  check("a repeat changes nothing and notifies nobody", [c.get() === same, notified], [true, 1]);
  c.deviceOnline();
  check("the online event clears it", c.get(), ONLINE);
  check("starts offline when navigator.onLine is false", createConnectivity(false).get(), { offline: true, reason: "device" });
}

console.log("--- connected, but no internet ---");
{
  const c = createConnectivity(true);
  c.unreachable();
  check("a request with no response sets it", c.get(), { offline: true, reason: "request" });
  c.reached();
  check("the next response clears it", c.get(), ONLINE);
  c.unreachable();
  c.deviceOnline();
  check("so does an online event", c.get(), ONLINE);
}

console.log("--- the stronger reason is kept ---");
{
  const c = createConnectivity(true);
  c.deviceOffline();
  c.unreachable();
  check("a failed request while the device is offline keeps 'device'", c.get(), { offline: true, reason: "device" });
  c.reached();
  check("a server answer clears it even so (navigator.onLine can be wrong)", c.get(), ONLINE);
}

console.log("--- unsubscribe ---");
{
  const c = createConnectivity(true);
  let n = 0;
  const off = c.subscribe(() => { n++; });
  off();
  c.deviceOffline();
  check("an unsubscribed listener hears nothing", n, 0);
}

console.log("--- which failures count as 'no network' ---");
check("ERR_NETWORK with no response", isNoNetworkError({ code: "ERR_NETWORK" }), true);
check("not a timeout", isNoNetworkError({ code: "ECONNABORTED" }), false);
check("not a cancelled request", isNoNetworkError({ code: "ERR_CANCELED" }), false);
check("not a response of any status", isNoNetworkError({ code: "ERR_NETWORK", response: { status: 502 } }), false);
check("not a 500", isNoNetworkError({ code: "ERR_BAD_RESPONSE", response: { status: 500 } }), false);
check("not nothing", isNoNetworkError(null), false);

console.log("--- the wiring ---");
const axiosSrc = read("src/lib/axios.ts");
check("axios reports every response as reached",
  /connectivity\.reached\(\)/.test(axiosSrc), true);
check("axios reports a no-response failure as unreachable",
  /isNoNetworkError\(err\)\)\s*connectivity\.unreachable\(\)/.test(axiosSrc), true);
check("a desktop's local answers are not taken as network evidence",
  /servedLocally\)\s*connectivity\.reached\(\)/.test(axiosSrc), true);
const watch = read("src/lib/offline/connectivityWatch.ts");
check("the window's offline and online events are listened to",
  [/addEventListener\("offline"/.test(watch), /addEventListener\("online"/.test(watch)], [true, true]);
const main = read("src/main.tsx");
check("the watch is started at bootstrap", /startConnectivityWatch\(\)/.test(main), true);
check("queries and mutations run whatever navigator.onLine says (networkMode always)",
  (main.match(/networkMode:\s*"always"/g) ?? []).length, 2);
check("the banner is mounted in the dashboard layout",
  /<OfflineBanner\s*\/>/.test(read("src/components/layout/DashboardLayout.tsx")), true);
check("and on the sign-in page",
  /<OfflineBanner\b/.test(read("src/pages/LoginPage.tsx")), true);
check("the banner stays out of the desktop",
  /isDesktop\(\)/.test(read("src/components/offline/OfflineBanner.tsx")), true);

// ── Needs internet: the desktop says something different ────────────────────
console.log("--- the no-connection message, desktop vs browser ---");
check("browser, no network: the offline message",
  noResponseMessageKey({ desktop: false, timedOut: false }), "errors.offline");
check("desktop, no network: this action needs the internet, the rest works",
  noResponseMessageKey({ desktop: true, timedOut: false }), "errors.needsInternet");
check("a timeout is a slow link in both",
  [noResponseMessageKey({ desktop: false, timedOut: true }), noResponseMessageKey({ desktop: true, timedOut: true })],
  ["errors.timeout", "errors.timeout"]);
const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
for (const k of ["offline", "needsInternet", "timeout"]) {
  check(`errors.${k} exists in both languages`, [typeof en.errors[k], typeof fr.errors[k]], ["string", "string"]);
}
check("the desktop and browser sentences differ", en.errors.needsInternet !== en.errors.offline, true);
check("getErrorMessage chooses by where it runs",
  /noResponseMessageKey\(\{\s*desktop:\s*isDesktop\(\)/.test(axiosSrc), true);

console.log("--- the online-only screens say so on an offline desktop ---");
const hookSrc = read("src/hooks/useNeedsInternet.ts");
check("blocked only on the desktop, only while offline",
  /const blocked = offline && isDesktop\(\);/.test(hookSrc), true);
const SCREENS = [
  ["src/pages/settings/SettingsPage.tsx", "settings: profile/password, admins, permissions",
    /<NeedsInternet><ProfileSection \/>[\s\S]*<NeedsInternet><AdminsSection[\s\S]*<NeedsInternet><PermissionsSection/],
  ["src/pages/exams/[id]/index.tsx", "exam results: calculate / recalculate", /processResults\.isPending \|\| net\.blocked/],
  ["src/pages/exams/term-results/index.tsx", "term results: compute + publish + unpublish",
    /needsClass \|\| net\.blocked[\s\S]*!results\.length \|\| net\.blocked[\s\S]*isPublished\) \|\| net\.blocked/],
  ["src/pages/exams/annual-results/index.tsx", "annual results: compute + publish + unpublish",
    /needsClass \|\| net\.blocked[\s\S]*!results\.length \|\| net\.blocked[\s\S]*isPublished\) \|\| net\.blocked/],
  ["src/pages/reports/cards.tsx", "report cards: print / reissue / print preview",
    /generating \|\| net\.blocked[\s\S]*reissuing \|\| generating \|\| net\.blocked[\s\S]*printFlight\.busy \|\| net\.blocked/],
  ["src/pages/exports/index.tsx", "exports: download", /!selected \|\| net\.blocked/],
  ["src/pages/finance/payroll.tsx", "payroll: confirm, reverse, generate",
    /disabled=\{net\.blocked\}[\s\S]*disabled=\{net\.blocked\}[\s\S]*disabled=\{net\.blocked\}/],
  ["src/pages/messages/index.tsx", "messages: new conversation (button and the open dialog), attachment upload",
    /disabled=\{net\.blocked\}[\s\S]*disabled=\{attaching \|\| sendMutation\.isPending \|\| net\.blocked\}[\s\S]*function NewConversationModal[\s\S]*<NeedsInternet className[\s\S]*disabled=\{opening !== null \|\| net\.blocked\}/],
];
for (const [file, label, re] of SCREENS) {
  const src = read(file);
  check(`${label}: gated`, re.test(src), true);
  check(`${label}: the notice is shown`, /<NeedsInternet\b/.test(src), true);
}

console.log("--- messages: an existing conversation is written to offline on the desktop ---");
{
  const src = read("src/pages/messages/index.tsx");
  const page = src.slice(0, src.indexOf("function NewConversationModal"));
  // The desktop queues a send in an existing thread (desktop/src/main/api/
  // handlers/messages.js), so the composer must not be switched off — only
  // starting a conversation and uploading a file are.
  check("the composer is not inside a NeedsInternet", /<NeedsInternet>/.test(page), false);
  check("the send button is not gated on the connection",
    /onClick=\{handleSend\}\s*disabled=\{\s*\(!draft\.trim\(\) && pending\.length === 0\) \|\|\s*sendMutation\.isPending\s*\}/.test(page), true);
  check("offline, the composer says what will happen", /net\.blocked && \([\s\S]*messages\.offlineQueued/.test(page), true);
  check("each send carries a clientId (the desktop's replay key)",
    /clientId: attemptIds\.current\.forAttempt\(/.test(page) && /attemptIds\.current\.sent\(\)/.test(page), true);
  const { clientIds } = await load("src/pages/messages/clientId.ts");
  const ids = clientIds();
  const a = ids.forAttempt({ body: "ok" });
  check("a retry of the same message keeps its id", ids.forAttempt({ body: "ok" }), a);
  const b = ids.forAttempt({ body: "ok!" });
  check("an edited message is a new id", b !== a, true);
  ids.sent();
  check("once sent, the same text again is a new message", ids.forAttempt({ body: "ok!" }) !== b, true);
  check("an unsent message is marked and cannot be deleted",
    [/m\._pending && \(/.test(page), /!m\.isDeleted && m\.seq != null && \(/.test(page)], [true, true]);

  const { threadOrder, newestSeq } = await load("src/pages/messages/order.ts");
  const thread = [
    { _id: "u2", seq: null, createdAt: "2026-11-01T10:02:00Z" },
    { _id: "m2", seq: 2,    createdAt: "2026-11-01T09:00:00Z" },
    { _id: "u1", seq: null, createdAt: "2026-11-01T10:01:00Z" },
    { _id: "m1", seq: 1,    createdAt: "2026-11-01T09:30:00Z" },
  ];
  check("by seq, unsent last in the order written",
    [...thread].sort(threadOrder).map((m) => m._id), ["m1", "m2", "u1", "u2"]);
  check("the read marker never claims an unsent message", newestSeq(thread), 2);
  check("nothing ordered yet: no read marker", newestSeq([{ seq: null }]), null);
  for (const [lang, d] of [["en", en], ["fr", fr]]) {
    check(`${lang}: messages.pendingSend and offlineQueued exist`,
      [typeof d.messages.pendingSend, typeof d.messages.offlineQueued], ["string", "string"]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
