// mobile/scripts/check-offline-period.js
"use strict";
/**
 * The 30-day offline period, as the phone shows it.
 *
 * Owner decision: devices may work offline up to 30 days. From day 21 since
 * the last successful sync the bottom strip says "Connect to the internet
 * soon…", from day 30 "Connect now: …". Nothing is blocked.
 *
 *   - config/offlinePeriod.js holds 21 and 30, and nothing else does;
 *   - offlineAge(): the pure rule, at the day boundaries, with an unknown /
 *     epoch / future time showing nothing;
 *   - useSyncStatus reads the last-sync time from SyncManager (read only) and
 *     re-reads it when a sync run ends; SyncStatusBar renders both levels,
 *     non-blocking, in both languages.
 *
 *   node scripts/check-offline-period.js
 */
const fs    = require("fs");
const path  = require("path");
const babel = require("@babel/core");
const { I18n } = require("i18n-js");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// Load the real module through the app's Babel preset.
const loadEsm = (rel) => {
  const file = path.join(ROOT, rel);
  const { code } = babel.transformFileSync(file, {
    presets: [require.resolve("babel-preset-expo")],
    babelrc: false, configFile: false,
  });
  const m = { exports: {} };
  new Function("module", "exports", "require", code)(m, m.exports, require);
  return m.exports;
};

const P = loadEsm("src/config/offlinePeriod.js");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const ago = (days, extraMs = 0) => new Date(NOW - days * DAY - extraMs).toISOString();

console.log("--- the numbers, in one place ---");
check("notice from day 21, warning from day 30", [P.OFFLINE_NOTICE_DAYS, P.OFFLINE_LIMIT_DAYS], [21, 30]);

console.log("--- the rule ---");
check("synced an hour ago: nothing", P.offlineAge(new Date(NOW - 3600e3).toISOString(), NOW), { level: "none", days: 0 });
check("20 days 23 hours: still nothing", P.offlineAge(ago(20, 23 * 3600e3), NOW).level, "none");
check("exactly 21 days: the notice", P.offlineAge(ago(21), NOW), { level: "notice", days: 21 });
check("29 days: still the notice", P.offlineAge(ago(29, 3600e3), NOW), { level: "notice", days: 29 });
check("exactly 30 days: the warning", P.offlineAge(ago(30), NOW), { level: "warning", days: 30 });
check("45 days: the warning, counted", P.offlineAge(ago(45), NOW), { level: "warning", days: 45 });
check("never synced (null): nothing", P.offlineAge(null, NOW), { level: "none", days: null });
check("the 1970 placeholder cursor: nothing",
  P.offlineAge("1970-01-01T00:00:00.000Z", NOW), { level: "none", days: null });
check("garbage: nothing", P.offlineAge("not a date", NOW).level, "none");
check("a sync time in the future (clock behind the server): nothing",
  P.offlineAge(new Date(NOW + 5 * DAY).toISOString(), NOW), { level: "none", days: 0 });
check("accepts a Date too", P.offlineAge(new Date(NOW - 22 * DAY), new Date(NOW)).level, "notice");

console.log("--- one place for the numbers ---");
const offenders = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(js|jsx|ts|tsx)$/.test(e.name) && !full.endsWith(path.join("config", "offlinePeriod.js"))) {
      const src = fs.readFileSync(full, "utf8");
      if (/OFFLINE_(NOTICE|LIMIT)_DAYS\s*=/.test(src)) offenders.push(path.relative(ROOT, full));
    }
  }
};
walk(path.join(ROOT, "src")); walk(path.join(ROOT, "app"));
check("no second definition of the thresholds", offenders, []);

console.log("--- the wiring ---");
const hook = read("src/hooks/useSyncStatus.js");
check("useSyncStatus reads the last successful sync from SyncManager",
  /SyncManager\.getLastSync\(\)/.test(hook), true);
check("  and only reads it (no setLastSync/resetLastSync)", /SyncManager\.(set|reset)LastSync/.test(hook), false);
check("  re-reads it when a sync run ends", /SyncProgress\.subscribe/.test(hook) && /!s\.active\) refresh\(\)/.test(hook), true);
check("  and returns offlineAge from the shared rule",
  /from "\.\.\/config\/offlinePeriod"/.test(hook) && /offlineAge: offlineAge\(lastSyncedAt\)/.test(hook), true);

const bar = read("src/components/SyncStatusBar.js");
check("SyncStatusBar shows the notice and the warning",
  /"sync\.staleWarning"/.test(bar) && /"sync\.staleNotice"/.test(bar), true);
check("  with the limit from the config, not a literal 30",
  /limit: OFFLINE_LIMIT_DAYS/.test(bar) && /from "\.\.\/config\/offlinePeriod"/.test(bar), true);
const branch = bar.slice(bar.indexOf('offlineAge.level !== "none"'), bar.indexOf("} else if (isOfflineSession)"));
check("  and does not block: the stale state is not tappable and pushes nowhere",
  [branch.length > 0, /tappable = true/.test(branch), /router\./.test(branch)], [true, false, false]);
check("  sign-in and blocked changes still outrank it",
  bar.indexOf("if (needsSignIn)") < bar.indexOf('offlineAge.level !== "none"') &&
  bar.indexOf("} else if (hasBlocked)") < bar.indexOf('offlineAge.level !== "none"'), true);
check("  the sentence may wrap to two lines", /numberOfLines=\{lines\}/.test(bar) && /lines = 2/.test(branch), true);

console.log("--- the words ---");
const en = JSON.parse(read("src/i18n/locales/en.json"));
const fr = JSON.parse(read("src/i18n/locales/fr.json"));
const i18n = new I18n({ en, fr });
i18n.enableFallback = false;
const T = (lng, key, opts) => { i18n.locale = lng; return i18n.t(key, opts); };
check("en notice", T("en", "sync.staleNotice", { count: 23, limit: 30 }),
  "Connect to the internet soon — this device last synced 23 days ago; changes older than 30 days may not be accepted safely");
check("en warning", T("en", "sync.staleWarning", { count: 31, limit: 30 }),
  "Connect now: this device last synced 31 days ago; changes older than 30 days may not be accepted safely");
check("fr notice and warning are French and carry both numbers",
  ["sync.staleNotice", "sync.staleWarning"].map((k) => {
    const s = T("fr", k, { count: 31, limit: 30 });
    return /31/.test(s) && /30/.test(s) && /synchronisation/.test(s) && !/missing/.test(s);
  }), [true, true]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
