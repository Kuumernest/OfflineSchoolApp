// web/scripts/check-offline-period.mjs
//
// The 30-day offline period, as the desktop window shows it.
//
// Owner decision: devices may work offline up to 30 days. From day 21 since
// the engine's last successful pull the window says "Connect to the internet
// soon…", from day 30 "Connect now: …". Nothing is blocked.
//
//   - src/config/offlinePeriod.ts holds 21 and 30, and nothing else does;
//   - offlineAge(): the pure rule, at the day boundaries; unknown shows nothing;
//   - the bridge type carries lastSyncedAt, the desktop engine publishes it,
//     and InitialSyncBanner (already mounted on every page) renders both
//     levels, non-blocking, in both languages.
//
//   node scripts/check-offline-period.mjs

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

const load = async (rel) => {
  const { outputText } = ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
};

const P = await load("src/config/offlinePeriod.ts");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const ago = (days, extraMs = 0) => new Date(NOW - days * DAY - extraMs).toISOString();

console.log("--- the numbers ---");
check("notice from day 21, warning from day 30", [P.OFFLINE_NOTICE_DAYS, P.OFFLINE_LIMIT_DAYS], [21, 30]);

console.log("--- the rule ---");
check("synced an hour ago: nothing", P.offlineAge(new Date(NOW - 3600e3).toISOString(), NOW), { level: "none", days: 0 });
check("20 days 23 hours: still nothing", P.offlineAge(ago(20, 23 * 3600e3), NOW).level, "none");
check("exactly 21 days: the notice", P.offlineAge(ago(21), NOW), { level: "notice", days: 21 });
check("29 days: still the notice", P.offlineAge(ago(29, 3600e3), NOW), { level: "notice", days: 29 });
check("exactly 30 days: the warning", P.offlineAge(ago(30), NOW), { level: "warning", days: 30 });
check("never synced: nothing", P.offlineAge(null, NOW), { level: "none", days: null });
check("undefined (an older main process): nothing", P.offlineAge(undefined, NOW).level, "none");
check("the 1970 placeholder: nothing", P.offlineAge("1970-01-01T00:00:00.000Z", NOW).level, "none");
check("garbage: nothing", P.offlineAge("nope", NOW).level, "none");
check("in the future (clock behind): nothing", P.offlineAge(new Date(NOW + 3 * DAY).toISOString(), NOW), { level: "none", days: 0 });

console.log("--- the same rule as the phone ---");
const mobile = read("../mobile/src/config/offlinePeriod.js");
check("the phone uses the same 21 and 30",
  [/OFFLINE_NOTICE_DAYS\s*=\s*21\b/.test(mobile), /OFFLINE_LIMIT_DAYS\s*=\s*30\b/.test(mobile)], [true, true]);

console.log("--- one place for the numbers ---");
const offenders = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !full.endsWith(path.join("config", "offlinePeriod.ts")) &&
             /OFFLINE_(NOTICE|LIMIT)_DAYS\s*=/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(ROOT, full));
  }
};
walk(path.join(ROOT, "src"));
check("no second definition of the thresholds", offenders, []);

console.log("--- the wiring ---");
const bridge = read("src/lib/offline/bridge.ts");
check("the bridge's SyncStatus carries lastSyncedAt", /lastSyncedAt\?:\s*string \| null;/.test(bridge), true);
const engine = read("../desktop/src/main/sync/engine.js");
check("the desktop engine publishes lastSyncedAt with every status",
  /lastSyncedAt: lastSyncedAt\(\)/.test(engine) && /status: \(\) => \(\{[^}]*lastSyncedAt: lastSyncedAt\(\)/.test(engine), true);
const banner = read("src/components/offline/InitialSyncBanner.tsx");
check("InitialSyncBanner shows the notice once the first sync is done",
  /status\.initialSync !== "pending"[\s\S]{0,80}<OfflinePeriodNotice lastSyncedAt=\{status\.lastSyncedAt \?\? null\}/.test(banner), true);
check("  using the shared rule and the limit from config",
  /from "@\/config\/offlinePeriod"/.test(banner) && /offlineAge\(lastSyncedAt, now\)/.test(banner) && /limit: OFFLINE_LIMIT_DAYS/.test(banner), true);
check("  both levels", /"offlinePeriod\.warning"/.test(banner) && /"offlinePeriod\.notice"/.test(banner), true);
const notice = banner.slice(banner.indexOf("function OfflinePeriodNotice"), banner.indexOf("export default function"));
check("  and it blocks nothing: no button, no navigation, no overlay",
  [notice.length > 0, /<Button|onClick|navigate|fixed inset/.test(notice)], [true, false]);
check("  re-evaluated over time, not only on a status push", /setInterval\(\(\) => setNow\(Date\.now\(\)\)/.test(notice), true);

console.log("--- the words ---");
const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
await i18next.init({ lng: "en", resources: { en: { translation: en }, fr: { translation: fr } }, returnEmptyString: false });
check("en notice", i18next.t("offlinePeriod.notice", { count: 23, limit: 30 }),
  "Connect to the internet soon — this device last synced 23 days ago; changes older than 30 days may not be accepted safely.");
check("en warning", i18next.t("offlinePeriod.warning", { count: 31, limit: 30 }),
  "Connect now: this device last synced 31 days ago; changes older than 30 days may not be accepted safely.");
await i18next.changeLanguage("fr");
check("fr: French, both numbers",
  ["offlinePeriod.notice", "offlinePeriod.warning"].map((k) => {
    const s = i18next.t(k, { count: 31, limit: 30 });
    return /31/.test(s) && /30/.test(s) && /synchronisation/.test(s);
  }), [true, true]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
