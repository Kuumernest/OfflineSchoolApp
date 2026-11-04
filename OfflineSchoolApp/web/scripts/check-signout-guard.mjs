// web/scripts/check-signout-guard.mjs
//
// Signing out of the desktop never looks like losing work, and a refused
// session never looks like a calm queue.
//
//   1. Every sign-out button goes through hooks/useSignOut, which — on the
//      desktop, when this account has unsent changes — asks first: "You have N
//      changes not yet sent. They'll be sent next time you sign in on this
//      computer." A button that called the store's logout() directly would
//      skip the question; this refuses any such call outside the short list of
//      places that are not sign-out buttons.
//   2. The count is this account's rows (the main process's `mine`), read from
//      the real src/lib/offline/unsent.ts against a stubbed bridge.
//   3. A 401 the sync engine got (status.sessionRejected) is shown: the
//      SignInAgainBanner is mounted, and the indicator does not fall through
//      to "N waiting".
//
//   node scripts/check-signout-guard.mjs

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

// ── 1. No sign-out button around the guard ──────────────────────────────────
console.log("--- every sign-out goes through useSignOut ---");

/** Calls of the store's logout() that are not a person pressing "Sign out", and why. */
const ALLOWED = {
  "src/store/auth.store.ts":                   "the store itself, and a refused refresh",
  "src/lib/axios.ts":                          "a refused refresh in the 401 path",
  "src/hooks/useSignOut.ts":                   "the guard",
  "src/components/offline/SignInAgainBanner.tsx": "its own text says the changes are kept",
  "src/services/auth.service.ts":              "a service function no button calls",
};

const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
    else if (/\.(ts|tsx)$/.test(name)) files.push(rel);
  }
})("src");

const offenders = files.filter((f) => !(f in ALLOWED)).filter((f) => {
  const src = read(f);
  return /\blogout\s*\(\s*\)/.test(src) || /onClick=\{\s*logout\s*\}/.test(src) || /s\.logout\b/.test(src);
});
check("no component calls the store's logout() directly", offenders, []);

for (const [file, label] of [
  ["src/components/layout/TopBar.tsx", "the user menu"],
  ["src/components/auth/StaffOnly.tsx", "the staff-only gate"],
  ["src/pages/auth/ChangePasswordPage.tsx", "the change-password escape hatch"],
]) {
  check(`${label} signs out through useSignOut`, /useSignOut\(\)/.test(read(file)), true);
}
check("the user menu navigates only once signed out",
  /if \(!\(await signOut\(\)\)\) return;/.test(read("src/components/layout/TopBar.tsx")), true);

const hook = read("src/hooks/useSignOut.ts");
check("the guard asks only when there is something unsent",
  [/readUnsentForSession\(\)/.test(hook), /if \(count > 0\)/.test(hook), /signOutGuard\.message/.test(hook)],
  [true, true, true]);
check("and stays signed in on Cancel", /if \(!ok\) return false;/.test(hook), true);

// ── 2. The count ────────────────────────────────────────────────────────────
console.log("--- the count is this account's ---");

const unsentSrc = read("src/lib/offline/unsent.ts").replace(
  /import \{ desktop, type OutboxSummary \} from "\.\/bridge";/,
  "const desktop = () => globalThis.__bridge ?? null;",
);
check("unsent.ts reads the bridge through desktop() (the stub replaced it)",
  /globalThis\.__bridge/.test(unsentSrc), true);
const { outputText } = ts.transpileModule(unsentSrc, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { unsentForSession, readUnsentForSession } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);

const bridgeWith = (summary) => ({ outbox: { summary: async () => {
  if (summary instanceof Error) throw summary;
  return summary;
} } });

globalThis.__bridge = null;
check("a browser has no outbox: no question", await readUnsentForSession(), 0);
// Three of this person's rows, among five another account left behind.
globalThis.__bridge = bridgeWith({ pending: 7, blocked: 1, mine: 3, stuck: [], head: null });
check("this account's rows, not the whole queue", await readUnsentForSession(), 3);
globalThis.__bridge = bridgeWith({ pending: 7, blocked: 1, mine: 0, stuck: [], head: null });
check("another account's rows alone do not ask", await readUnsentForSession(), 0);
globalThis.__bridge = bridgeWith({ pending: 2, blocked: 1, stuck: [], head: null });
check("an older main process without `mine`: the whole queue", await readUnsentForSession(), 3);
globalThis.__bridge = bridgeWith(new Error("ipc down"));
check("a queue that cannot be read never blocks signing out", await readUnsentForSession(), 0);
check("no summary yet is nothing unsent", unsentForSession(null), 0);
globalThis.__bridge = undefined;

// ── The sentences, in both languages ────────────────────────────────────────
console.log("--- what the person reads ---");
await i18next.init({
  lng: "en", fallbackLng: false,
  resources: {
    en: { translation: JSON.parse(read("src/i18n/locales/en.json")) },
    fr: { translation: JSON.parse(read("src/i18n/locales/fr.json")) },
  },
});
check("en: the sign-out question",
  i18next.t("signOutGuard.message", { count: 3, lng: "en" }),
  "You have 3 change(s) not yet sent. They'll be sent next time you sign in on this computer.");
check("fr: the sign-out question has the count",
  i18next.t("signOutGuard.message", { count: 3, lng: "fr" }).startsWith("Vous avez 3 "), true);
check("en: the sign-in-again prompt",
  i18next.t("sync.signInAgainTitle", { count: 4, lng: "en" }), "Sign in again to send 4 unsent change(s)");
check("fr: the sign-in-again prompt has the count",
  i18next.t("sync.signInAgainTitle", { count: 4, lng: "fr" }).includes("4"), true);

// ── 3. A refused session is shown ───────────────────────────────────────────
console.log("--- a refused desktop session is said, with an action ---");
check("the banner is mounted in the dashboard layout",
  /<SignInAgainBanner\s*\/>/.test(read("src/components/layout/DashboardLayout.tsx")), true);
const banner = read("src/components/offline/SignInAgainBanner.tsx");
check("it acts on a 401 the engine got, not on 'no token yet'",
  /phase === "unauthenticated" && status\.sessionRejected === true/.test(banner), true);
check("it first tries to renew quietly, rate-limited",
  [/refreshSession\(\)/.test(banner), /RENEW_EVERY_MS/.test(banner)], [true, true]);
check("its action goes to sign-in", /navigate\("\/login"/.test(banner), true);
const indicator = read("src/components/offline/SyncIndicator.tsx");
check("the indicator shows it rather than 'N waiting'",
  /signedOut \? t\("sync\.signInAgainShort"\)/.test(indicator), true);
check("the bridge types carry the engine's verdict and the account's count",
  [/sessionRejected\?: boolean/.test(read("src/lib/offline/bridge.ts")), /mine\?:\s+number/.test(read("src/lib/offline/bridge.ts"))],
  [true, true]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
