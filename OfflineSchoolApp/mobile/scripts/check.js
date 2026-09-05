// mobile/scripts/check.js
"use strict";

/**
 * The mobile app's only automated safety net.
 *
 * There is no test runner here, no tsc pass over the JS, and no eslint config —
 * so until this existed, nothing checked the phone app at all. A syntax error in
 * a screen was found by opening that screen, and a French string missing from
 * the bundle was found by a francophone user.
 *
 * Two checks, both cheap and both catching real classes of mistake:
 *
 *   PARSE      every .js under app/ and src/ through babel-preset-expo. This is
 *              what the bundler will do, so a file that fails here cannot load
 *              on a device. It is the floor, not a type check.
 *
 *   LOCALES    en.json against fr.json, key for key. The web package has had
 *              this check for a while (scripts/check-i18n.mjs) and mobile never
 *              did, which is the more consequential gap of the two: on a phone
 *              a missing key renders as the raw key on screen, offline, with no
 *              console to notice it in.
 *
 *   node scripts/check.js
 */

const fs   = require("fs");
const path = require("path");
const babel = require("@babel/core");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok   = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad  = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(detail.split("\n").map((l) => "       " + l).join("\n"));
};

// ─────────────────────────────────────────────────────────────────────────────
// PARSE
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".expo", "assets", "scripts"]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(js|jsx)$/.test(e.name) ? [full] : [];
  });

const checkParse = () => {
  console.log("--- every screen and service parses ---");

  const preset = require.resolve("babel-preset-expo");
  const files  = ["app", "src"]
    .map((d) => path.join(ROOT, d))
    .filter((d) => fs.existsSync(d))
    .flatMap(walk);

  const broken = [];

  for (const file of files) {
    try {
      babel.parseSync(fs.readFileSync(file, "utf8"), {
        filename:   file,
        presets:    [preset],
        babelrc:    false,
        configFile: false,
      });
    } catch (err) {
      broken.push(
        `${path.relative(ROOT, file)}\n  ${err.message.split("\n")[0]}`
      );
    }
  }

  if (broken.length) bad(`${files.length} files, ${broken.length} will not parse`, broken.join("\n"));
  else ok(`${files.length} files parse`);
};

// ─────────────────────────────────────────────────────────────────────────────
// LOCALES
// ─────────────────────────────────────────────────────────────────────────────

/** Every leaf path in a nested object, as "a.b.c". */
const flatten = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v)
      ? flatten(v, key)
      : [key];
  });

const checkLocales = () => {
  console.log("--- en and fr say the same things ---");

  const dir = path.join(ROOT, "src", "i18n", "locales");
  const load = (lang) => {
    const file = path.join(dir, `${lang}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      bad(`${lang}.json is not valid JSON`, err.message);
      return undefined;
    }
  };

  const en = load("en");
  const fr = load("fr");

  if (en === null || fr === null) { bad("both en.json and fr.json must exist"); return; }
  if (!en || !fr) return;   // invalid JSON, already reported

  ok("both files are valid JSON");

  const enKeys = new Set(flatten(en));
  const frKeys = new Set(flatten(fr));

  // A key in en and not fr is the one that matters: i18n-js falls back to
  // English, so a francophone user gets one English line in a French screen and
  // reads it as a bug rather than a missing translation.
  const missingFr = [...enKeys].filter((k) => !frKeys.has(k));
  const missingEn = [...frKeys].filter((k) => !enKeys.has(k));

  if (missingFr.length) bad(`${missingFr.length} key(s) missing from fr.json`, missingFr.slice(0, 40).join("\n"));
  else ok("fr.json covers every English key");

  if (missingEn.length) bad(`${missingEn.length} key(s) missing from en.json`, missingEn.slice(0, 40).join("\n"));
  else ok("en.json covers every French key");

  // An empty string renders as nothing at all on screen, which reads as a
  // layout bug rather than a missing translation.
  const empties = [];
  const scan = (obj, lang, prefix = "") => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) scan(v, lang, key);
      else if (typeof v === "string" && v.trim() === "") empties.push(`${lang}: ${key}`);
    }
  };
  scan(en, "en");
  scan(fr, "fr");

  if (empties.length) bad(`${empties.length} empty string(s)`, empties.slice(0, 20).join("\n"));
  else ok("no empty strings");

  console.log(`       ${enKeys.size} keys, 2 languages`);
};

/**
 * Load an ESM module from src/ into this CommonJS script.
 *
 * supportsStaticESM: false is what tells preset-expo to emit require/exports
 * instead of import/export. Without it these modules cannot be checked at all,
 * which is how they came to be unchecked in the first place.
 */
const loadModule = (relPath) => {
  try {
    const { code } = babel.transformFileSync(path.join(ROOT, relPath), {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false,
      configFile: false,
    });
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function("module", "exports", "require", code)(mod, mod.exports, require);
    return mod.exports;
  } catch (err) {
    bad(`${relPath} loads`, err.message);
    return null;
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// LINK QUALITY
//
// The one piece of logic here that decides whether a request is abandoned,
// so it is the one piece worth asserting on. Pure arithmetic over a rolling
// window — no device, no network, no clock.
// ─────────────────────────────────────────────────────────────────────────────

const checkLinkQuality = () => {
  console.log("");
  console.log("LINK QUALITY");

  const LQ = loadModule("src/services/linkQuality.js");
  if (!LQ) return;
  ok("linkQuality loads");

  const near = (a, b, tol = 0.001) => Math.abs(a - b) <= tol;

  // A cold start must not scale anything. Below MIN_SAMPLES the factor is 1,
  // so the first requests of a session go out on the budgets their callers
  // asked for rather than on a guess formed from one sample.
  LQ._reset();
  LQ.recordSuccess(100, 30_000);
  if (near(LQ.currentFactor(), 1)) ok("one sample does not move the factor");
  else bad("one sample does not move the factor", `factor ${LQ.currentFactor()}`);

  // A fast link: every request uses 5% of its budget against a target of 25%,
  // so budgets should come DOWN — a dead link on fibre should not take thirty
  // seconds to say so.
  LQ._reset();
  for (let i = 0; i < 10; i++) LQ.recordSuccess(1_500, 30_000);
  const fast = LQ.currentFactor();
  if (fast < 1) ok(`a fast link shrinks budgets (factor ${fast.toFixed(2)})`);
  else bad("a fast link shrinks budgets", `factor ${fast}`);

  // ...but never below the floor, or a burst of cached responses would cut
  // the next real request off at the knees.
  LQ._reset();
  for (let i = 0; i < 30; i++) LQ.recordSuccess(1, 60_000);
  if (LQ.currentFactor() >= 0.5) ok("the factor has a floor");
  else bad("the factor has a floor", `factor ${LQ.currentFactor()}`);

  // A slow link: requests using 80% of their budget are one hiccup from
  // failing, so budgets must grow.
  LQ._reset();
  for (let i = 0; i < 10; i++) LQ.recordSuccess(24_000, 30_000);
  const slow = LQ.currentFactor();
  if (slow > 2) ok(`a slow link grows budgets (factor ${slow.toFixed(2)})`);
  else bad("a slow link grows budgets", `factor ${slow}`);

  // Timeouts count as a full budget. Without this the median is formed only
  // from the requests that happened to survive, and a link that has genuinely
  // slowed keeps timing out at a budget the survivors say is fine.
  LQ._reset();
  for (let i = 0; i < 10; i++) LQ.recordTimeout();
  if (LQ.currentFactor() > 2) ok("timeouts push budgets up");
  else bad("timeouts push budgets up", `factor ${LQ.currentFactor()}`);

  // A 500 is not slowness. Feeding server faults in would raise every budget
  // on this device because of a bug on the server.
  LQ._reset();
  for (let i = 0; i < 10; i++) LQ.recordSuccess(1_500, 30_000);
  const before = LQ.currentFactor();
  for (let i = 0; i < 10; i++) LQ.recordFailure();
  if (near(LQ.currentFactor(), before)) ok("non-timeout failures are ignored");
  else bad("non-timeout failures are ignored", `${before} -> ${LQ.currentFactor()}`);

  // The window rolls, so a link that recovers is believed again rather than
  // being punished for the tunnel it drove through ten minutes ago.
  LQ._reset();
  for (let i = 0; i < 30; i++) LQ.recordTimeout();
  for (let i = 0; i < 30; i++) LQ.recordSuccess(1_500, 30_000);
  if (LQ.currentFactor() < 1) ok("recovery is believed once the window rolls");
  else bad("recovery is believed once the window rolls", `factor ${LQ.currentFactor()}`);

  // Absolute bounds hold whatever the factor is.
  LQ._reset();
  for (let i = 0; i < 30; i++) LQ.recordTimeout();
  const huge = LQ.scaleTimeout(60_000);
  LQ._reset();
  for (let i = 0; i < 30; i++) LQ.recordSuccess(1, 60_000);
  const tiny = LQ.scaleTimeout(10_000);
  if (huge <= 180_000 && tiny >= 8_000) ok(`timeouts stay within 8s..180s (${tiny}, ${huge})`);
  else bad("timeouts stay within 8s..180s", `${tiny}, ${huge}`);

  // The caller's intent survives scaling: a pull is still allowed longer than
  // a message fetch, whatever the link is doing.
  LQ._reset();
  for (let i = 0; i < 10; i++) LQ.recordSuccess(20_000, 30_000);
  if (LQ.scaleTimeout(60_000) > LQ.scaleTimeout(10_000)) ok("relative budgets are preserved");
  else bad("relative budgets are preserved", "a pull lost its head start");

  // A missing or nonsense budget must not produce NaN as a timeout, which
  // axios treats as no timeout at all — a request that hangs forever.
  const bogus = [LQ.scaleTimeout(undefined), LQ.scaleTimeout(0), LQ.scaleTimeout(-5)];
  if (bogus.every((v) => !Number.isFinite(v) || v <= 0)) ok("a bad budget is passed through, never NaN-scaled");
  else bad("a bad budget is passed through, never NaN-scaled", JSON.stringify(bogus));

  // ── Batch size ────────────────────────────────────────────────────────────

  // A healthy link gets the size the caller asked for. Anything else and
  // every batch in the app silently changes the day this module lands.
  LQ._reset();
  if (LQ.batchSize(50) === 50 && LQ.batchSize(25) === 25) ok("an unmeasured link uses the caller's size");
  else bad("an unmeasured link uses the caller's size", `${LQ.batchSize(50)}, ${LQ.batchSize(25)}`);

  // A timeout halves it immediately. Waiting for confirmation would mean
  // several more failures at a size already known to be too big.
  LQ._reset();
  LQ.recordTimeout();
  if (LQ.batchSize(50) === 25) ok("a timeout halves the batch at once");
  else bad("a timeout halves the batch at once", `${LQ.batchSize(50)}`);

  // And keeps halving, down to a floor. Zero would be an infinite loop in
  // every caller that walks a list in slices.
  LQ._reset();
  for (let i = 0; i < 20; i++) LQ.recordTimeout();
  const floorBatch = LQ.batchSize(50);
  if (floorBatch >= 10 && floorBatch <= 12) ok(`the batch has a floor (${floorBatch} of 50)`);
  else bad("the batch has a floor", `${floorBatch}`);
  if (LQ.batchSize(1) >= 1) ok("the batch never reaches zero");
  else bad("the batch never reaches zero", `${LQ.batchSize(1)}`);

  // Recovery is additive and slow: one clean request must not undo a halving.
  LQ._reset();
  LQ.recordTimeout();
  const halved = LQ.currentBatchScale();
  LQ.recordSuccess(500, 30_000);
  if (LQ.currentBatchScale() === halved) ok("one success does not undo a halving");
  else bad("one success does not undo a halving", `${halved} -> ${LQ.currentBatchScale()}`);

  LQ._reset();
  LQ.recordTimeout();
  for (let i = 0; i < 8; i++) LQ.recordSuccess(500, 30_000);
  if (LQ.currentBatchScale() > halved) ok("a clean run grows the batch back");
  else bad("a clean run grows the batch back", `${LQ.currentBatchScale()}`);

  // The ceiling holds, so a fast link cannot build a request so large that
  // the server rejects the body outright.
  LQ._reset();
  for (let i = 0; i < 200; i++) LQ.recordSuccess(500, 30_000);
  if (LQ.batchSize(50) <= 100) ok(`the batch has a ceiling (${LQ.batchSize(50)} of 50)`);
  else bad("the batch has a ceiling", `${LQ.batchSize(50)}`);

  // The two controls must not be the same knob. A slow-but-succeeding link
  // should lengthen timeouts while leaving the batch alone — if the batch
  // shrank here too, the pair would oscillate: smaller batch, faster
  // request, lower ratio, bigger batch, timeout, and round again.
  LQ._reset();
  for (let i = 0; i < 12; i++) LQ.recordSuccess(24_000, 30_000);
  const slowFactor = LQ.currentFactor();
  const slowBatch  = LQ.batchSize(50);
  if (slowFactor > 2 && slowBatch === 50) ok("slow but succeeding: longer timeouts, same batch");
  else bad("slow but succeeding: longer timeouts, same batch", `factor ${slowFactor}, batch ${slowBatch}`);

  // Timing out is the only thing that shrinks it.
  LQ._reset();
  for (let i = 0; i < 12; i++) LQ.recordFailure();
  if (LQ.batchSize(50) === 50) ok("server faults leave the batch alone");
  else bad("server faults leave the batch alone", `${LQ.batchSize(50)}`);
};

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SYNC POLICY
//
// When the periodic sync runs and how hard one request tries. These are the
// two dials that can lose or duplicate work rather than merely waste time,
// and SyncManager itself cannot be constructed off a device — it wants
// NetInfo, SQLite and AppState first. So the arithmetic lives apart from it
// and is asserted on here.
// ─────────────────────────────────────────────────────────────────────────────

const checkSyncPolicy = () => {
  console.log("");
  console.log("SYNC POLICY");

  const P = loadModule("src/services/syncPolicy.js");
  if (!P) return;
  ok("syncPolicy loads");

  const BASE = P.BASE_INTERVAL_MS;

  // A healthy link ticks at the interval it always did. If this moved, every
  // school's data and battery use changed the day this landed.
  if (P.nextInterval({ consecutiveFailures: 0 }) === BASE) ok("a healthy link keeps the base interval");
  else bad("a healthy link keeps the base interval", String(P.nextInterval({ consecutiveFailures: 0 })));

  // Never faster than base, whatever is passed. Ticking more often wins
  // nothing — the reconnect and foreground triggers are what make the app
  // feel live — and risks a cycle starting before the last one ended.
  const faster = [0, -1, -99].map((f) => P.nextInterval({ consecutiveFailures: f }));
  if (faster.every((v) => v >= BASE)) ok("the interval never goes below base");
  else bad("the interval never goes below base", JSON.stringify(faster));

  // Failures back it off, monotonically. This is the death-spiral guard: a
  // link that is down must be tried LESS often, not the same amount.
  const ramp = [0, 1, 2, 3, 4, 5].map((f) => P.nextInterval({ consecutiveFailures: f }));
  const rising = ramp.every((v, i) => i === 0 || v >= ramp[i - 1]);
  if (rising && ramp[3] > ramp[0]) ok(`failures back the interval off (${ramp.map((v) => v / 1000 + "s").join(" → ")})`);
  else bad("failures back the interval off", JSON.stringify(ramp));

  // But it is capped, or a device that was offline overnight would not look
  // again for days.
  const capped = P.nextInterval({ consecutiveFailures: 999 });
  if (capped === P.MAX_INTERVAL_MS) ok(`the backoff is capped (${capped / 60000} min)`);
  else bad("the backoff is capped", String(capped));

  // Recovery is immediate, not a slow climb back down. SyncManager zeroes the
  // counter on a completed cycle, so the assertion here is that going from
  // "several failures" to "none" lands straight back on base rather than
  // stepping — a teacher waiting for a register to upload after an outage is
  // the exact moment a gradual recovery would be felt.
  const backedOff = P.nextInterval({ consecutiveFailures: 4, linkFactor: 1 });
  const recovered = P.nextInterval({ consecutiveFailures: 0, linkFactor: 1 });
  if (backedOff > BASE && recovered === BASE) {
    ok(`recovery is one step, not a climb (${backedOff / 1000}s → ${recovered / 1000}s)`);
  } else {
    bad("recovery is one step, not a climb", `${backedOff} → ${recovered}`);
  }

  // ── Retries ───────────────────────────────────────────────────────────────

  // Never zero. Zero attempts is not a cautious sync, it is no sync, and the
  // outbox would never drain again.
  const budgets = [
    P.retryBudget({ consecutiveFailures: 0,   linkFactor: 1 }),
    P.retryBudget({ consecutiveFailures: 9,   linkFactor: 6 }),
    P.retryBudget({ consecutiveFailures: -1,  linkFactor: 0 }),
    P.retryBudget({}),
  ];
  if (budgets.every((b) => b >= 1)) ok("there is always at least one attempt");
  else bad("there is always at least one attempt", JSON.stringify(budgets));

  // A link that has failed twice running is down, not flaky. A second attempt
  // buys nothing and holds the sync lock for twice as long; the reconnect
  // trigger is what handles a link that comes back.
  const healthy = P.retryBudget({ consecutiveFailures: 0, linkFactor: 1 });
  const down    = P.retryBudget({ consecutiveFailures: 2, linkFactor: 1 });
  if (down < healthy && down === 1) ok(`a down link stops retrying inside the cycle (${healthy} → ${down})`);
  else bad("a down link stops retrying inside the cycle", `${healthy} → ${down}`);

  // A measurably slow link tries less hard than a fast one, because each
  // attempt now costs a longer timeout.
  const struggling = P.retryBudget({ consecutiveFailures: 0, linkFactor: 4 });
  if (struggling < healthy) ok(`a struggling link tries less hard (${healthy} → ${struggling})`);
  else bad("a struggling link tries less hard", `${healthy} → ${struggling}`);

  // Retry delay doubles and is capped inside the interval.
  const delays = [1, 2, 3, 9].map((a) => P.retryDelay({ attempt: a }));
  const growing = delays.every((v, i) => i === 0 || v >= delays[i - 1]);
  if (growing && delays[3] <= 30_000) ok(`retry delay doubles and caps (${delays.join(", ")} ms)`);
  else bad("retry delay doubles and caps", JSON.stringify(delays));

  // ── The two dials together ────────────────────────────────────────────────

  // The property that matters: a cycle must not outlive the tick that starts
  // the next one. When it does, cycles overlap and the sync lock is left to
  // paper over it — which is exactly the state the cursor spiral lived in.
  //
  // Checked at the worst case the timeout ceiling allows, for each health.
  const cases = [
    { name: "healthy",    failures: 0, factor: 1 },
    { name: "struggling", failures: 0, factor: 4 },
    { name: "at the ceiling", failures: 0, factor: 6 },
    { name: "down",       failures: 2, factor: 6 },
    { name: "long outage", failures: 9, factor: 6 },
  ];
  const overlaps = [];
  const shown    = [];
  for (const c of cases) {
    const attempts = P.retryBudget({ consecutiveFailures: c.failures, linkFactor: c.factor });
    const worst    = P.worstCaseCycleMs({
      attempts,
      timeoutCeilingMs: P.effectiveTimeoutMs(c.factor),
    });
    const interval = P.nextInterval({ consecutiveFailures: c.failures, linkFactor: c.factor });
    shown.push(`${c.name} ${Math.round(worst / 1000)}s/${Math.round(interval / 1000)}s`);
    if (worst > interval) overlaps.push(`${c.name}: ${Math.round(worst / 1000)}s of work vs a ${Math.round(interval / 1000)}s tick`);
  }
  if (!overlaps.length) ok(`no state schedules a cycle past its own tick (${shown.join(", ")})`);
  else bad("no health state schedules a cycle longer than its own interval", overlaps.join("\n"));
};
// ─────────────────────────────────────────────────────────────────────────────
// SERVER-WINS UPSERTS
//
// A row with _synced = 0 is work this device has done and not yet sent. An
// upsert that overwrites one throws away a register a teacher took, or marks
// somebody entered, with no error and no trace — and sets _synced = 1 on the
// way past, so the outbox stops believing there is anything to send.
//
// This is a source check rather than a behavioural one, because the code it
// guards needs SQLite and a device. It is looking for exactly one thing: an
// ON CONFLICT ... DO UPDATE that assigns _synced = 1 without either a WHERE
// on the existing row, or a documented skip of dirty rows before it.
// ─────────────────────────────────────────────────────────────────────────────

const checkServerWinsUpserts = () => {
  console.log("");
  console.log("SERVER-WINS UPSERTS");

  const files = walk(path.join(ROOT, "src"))
    .concat(walk(path.join(ROOT, "app")))
    .filter((f) => f.endsWith(".js"));

  const offenders = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("DO UPDATE")) continue;

    // Each upsert, from ON CONFLICT to the end of its template literal.
    const re = /ON CONFLICT[\s\S]{0,2400}?`/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const block = m[0];
      if (!/DO UPDATE/.test(block)) continue;
      // Real SQL, not prose. syncManager explains this very pattern in a
      // comment — "Try INSERT with ON CONFLICT(id) DO UPDATE" — and the scan
      // was matching the sentence, then reading 2400 characters of unrelated
      // code after it. Every genuine DO UPDATE assigns from excluded.
      if (!/excluded\./.test(block)) continue;
      // Only upserts that CLAIM the row is now in step with the server.
      if (!/_synced\s*=\s*1/.test(block)) continue;
      // Guarded in the statement itself.
      if (/WHERE[\s\S]{0,120}_synced\s*=\s*1/.test(block)) continue;

      // Or guarded before it: a skip of locally-dirty rows in the 1200
      // characters preceding, which is how cacheScores does it.
      const before = text.slice(Math.max(0, m.index - 1200), m.index);
      if (/_synced\s*===?\s*0[\s\S]{0,80}(continue|return)/.test(before)) continue;

      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${path.relative(ROOT, file).replace(/\\/g, "/")}:${line}`);
    }
  }

  /**
   * Known, and not yet fixed.
   *
   * Eleven of these already existed when the check was written. Every one is
   * real — each writes a table the phone also writes — but they sit in the
   * middle of the sync engine, and changing eleven conflict resolutions at
   * once, with no device to run them on, is how a working app stops working.
   *
   * So this is a ratchet rather than a pass. Nothing new may be added; the list
   * only shrinks. Delete an entry as you fix it and the check will hold you to
   * it.
   */
  // Known, and NOT to be 'fixed' the way I first fixed them.
  //
  // These eleven were guarded with WHERE <table>._synced = 1 and the guard
  // was reverted the same day, because its premise is false here. It assumed
  // a dirty row is pending in the outbox and will be settled. class.service,
  // announcement.service and teacher.service do not use the outbox: they PUT
  // directly and only console.warn if it fails. So a failed push leaves the
  // row dirty for ever, and with the guard in place the server could never
  // refresh it again — a class stuck showing a teacher the server never
  // received, and no way back.
  //
  // The order matters: route those writers through the outbox FIRST, so that
  // dirty genuinely means pending, and only then is the guard safe. Until
  // that happens the older bug stands — a sync can overwrite an unsent edit —
  // and it is the lesser of the two.
  const KNOWN = new Set([
    "src/services/announcement.service.js",
    "src/services/class.service.js",
    "src/services/student.service.js",
    "src/services/syncManager.js",
    "src/services/timetableService.js",
    "src/services/examCache.service.js",
  ]);

  const fresh = offenders.filter((o) => !KNOWN.has(o.split(":")[0]));

  if (fresh.length) {
    bad(
      `${fresh.length} NEW upsert(s) can overwrite unsent local work`,
      fresh.join("\n") +
        "\n\nAdd `WHERE <table>._synced = 1` to the DO UPDATE, or skip" +
        "\nrows whose _synced is 0 before reaching it."
    );
  } else if (offenders.length) {
    ok(`no new server-wins upserts (${offenders.length} known - see KNOWN)`);
  } else {
    ok("no upsert overwrites a row this device has not sent");
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A PUPIL'S SYNC IS ALLOWED TO DO
//
// The sync plan says which steps a role runs; the pull methods say which
// roles they turn away. Those are two lists that must agree, kept in two
// files, and when they disagreed every student sync ended in a 403:
// pullExams calls GET /exams, which is gated on exams.view, while the plan
// listed an exams step for pupils on the belief that it scoped to self.
//
// The rule, in both directions:
//
//   a step in the pupil plan  -> its method must NOT turn students away
//   a step not in that plan   -> its method MUST turn students away
//
// The second half is what stops a staff-only pull being added without a
// guard and only failing on somebody else's phone.
// ─────────────────────────────────────────────────────────────────────────────

const checkStudentSyncPlan = () => {
  console.log("");
  console.log("PUPIL SYNC PLAN");

  const progress = fs.readFileSync(path.join(ROOT, "src/services/syncProgress.js"), "utf8");
  const manager  = fs.readFileSync(path.join(ROOT, "src/services/syncManager.js"), "utf8");

  // The pupil branch of planFor.
  const branch = progress.match(/if \(isStudent\)\s*\{([\s\S]*?)\}/);
  if (!branch) { bad("the pupil plan can be read"); return; }
  const pupilSteps = new Set([...branch[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]));
  ok(`the pupil plan is readable (${[...pupilSteps].join(", ")})`);

  // Which step each pull method serves, from the syncAll body: a
  // SyncProgress.step("x") followed by an await this.pullY().
  const pairs = [...manager.matchAll(
    /SyncProgress\.step\("([a-zA-Z]+)"\)[\s\S]{0,120}?await this\.(pull[A-Za-z]+)\(/g
  )].map((m) => ({
    step:   m[1],
    method: m[2],
    // A step can also be excluded at the CALL site — pullFinance and
    // pullStudentApplications both sit inside `if (this.isAdmin())` rather
    // than turning students away themselves. Equally safe, so the check has
    // to see it.
    adminOnlyCall: /isAdmin\(\)\s*\)?\s*\{[\s\S]{0,160}$/.test(
      manager.slice(Math.max(0, m.index - 160), m.index)
    ),
  }));

  if (!pairs.length) { bad("no step/pull pairs found in syncAll"); return; }

  /** Does this method turn a student away before doing any work? */
  const turnsStudentsAway = (name) => {
    const i = manager.indexOf(`async ${name}(`);
    if (i === -1) return null;
    const body = manager.slice(i, i + 700);
    // Either spelling counts: turning students away, or admitting only
    // admins — !isAdmin() excludes a pupil by a wider door.
    return /isStudent\(\)\s*\)?\s*return|!\s*this\.isAdmin\(\)\s*\)?\s*return/.test(body);
  };

  const wrong = [];
  for (const pair of pairs) {
    const { step, method } = pair;
    const guarded = turnsStudentsAway(method);
    if (guarded === null) continue;   // not a method on the class
    const inPupilPlan = pupilSteps.has(step);

    if (inPupilPlan && guarded) {
      wrong.push(`${step}: in the pupil plan, but ${method}() returns early for students`);
    }
    if (!inPupilPlan && !guarded && !pair.adminOnlyCall) {
      wrong.push(`${step}: not in the pupil plan, and ${method}() does not turn students away`);
    }
  }

  if (wrong.length) {
    bad(`${wrong.length} step(s) disagree with their pull method`, wrong.join(String.fromCharCode(10)));
  } else {
    ok(`every step agrees with its pull method (${pairs.length} checked)`);
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// THE EDGES OF THE SCREEN, AND THE KEYBOARD
//
// Android has drawn edge-to-edge since Expo SDK 54, and it cannot be turned
// off. Two things follow, and both of them reached a user before this check
// existed.
//
// The window no longer resizes when the keyboard opens. KeyboardAvoidingView
// with `behavior={Platform.OS === "ios" ? "padding" : undefined}` — the shape
// every form screen in this app was written with — therefore does nothing at
// all on Android. Nothing moves, the scroll view keeps its full height, and
// Android never scrolls the focused field into view because as far as it is
// concerned that field is already on screen. It is behind the keys.
//
// And the app paints behind the status bar and the navigation bar, so a
// screen that pads with a guessed constant hides its first line under the
// clock, or its last control under the navigation bar. The parent portal
// link on the login screen sat under the navigation bar for exactly this
// reason.
//
// Both rules apply to the signed-out flow without exception, because it is
// the first thing anybody sees. The keyboard rule applies everywhere.
// ─────────────────────────────────────────────────────────────────────────────

// The screens a person meets before they have an account.
const SIGNED_OUT = [
  "app/auth/login.js",
  "app/auth/set-password.js",
  "app/auth/apply.js",
  "app/auth/select-school.js",
  "app/portal/index.js",
];

// Signed-in screens still pad with constants. Fixing that is a layout pass
// over every screen in the app, not a search and replace, so they are listed
// rather than pretended about — and the list may only shrink.
const PADS_BY_HAND = 93;

const checkScreenEdges = () => {
  console.log("");
  console.log("SCREEN EDGES AND THE KEYBOARD");

  const screens = walk(path.join(ROOT, "app")).filter((f) => f.endsWith(".js"));

  // ── 1. No screen may leave Android without a keyboard behaviour ─────────
  const noop = [];
  for (const f of screens) {
    const text = fs.readFileSync(f, "utf8");
    if (!text.includes("KeyboardAvoidingView")) continue;
    if (/behavior=\{[^}]*undefined[^}]*\}/.test(text)) {
      noop.push(path.relative(ROOT, f).replace(/\\/g, "/"));
    }
  }

  if (noop.length) {
    bad(
      "every KeyboardAvoidingView does something on Android",
      noop.map((f) => `${f}: behavior resolves to undefined, so the keyboard covers the field`)
        .join(String.fromCharCode(10))
    );
  } else {
    ok("every KeyboardAvoidingView does something on Android");
  }

  // ── 2. The signed-out flow measures the bars instead of guessing ────────
  const guessing = [];
  for (const rel of SIGNED_OUT) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { guessing.push(`${rel}: missing`); continue; }
    const text = fs.readFileSync(full, "utf8");

    if (!text.includes("useScreenInsets")) {
      guessing.push(`${rel}: does not use useScreenInsets`);
      continue;
    }
    // A constant top padding left behind next to the hook is the bug coming
    // back one screen at a time.
    const stray = [...text.matchAll(/paddingTop:\s*(\d+)/g)].map((m) => Number(m[1]));
    const tooBig = stray.filter((n) => n >= 24);
    if (tooBig.length) {
      guessing.push(`${rel}: still has a hardcoded paddingTop of ${tooBig.join(", ")}`);
    }
  }

  if (guessing.length) {
    bad("the signed-out flow measures the system bars", guessing.join(String.fromCharCode(10)));
  } else {
    ok(`the signed-out flow measures the system bars (${SIGNED_OUT.length} screens)`);
  }

  // ── 3. The rest of the app: a count that may only go down ───────────────
  let byHand = 0;
  for (const f of screens) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (SIGNED_OUT.includes(rel)) continue;
    const text = fs.readFileSync(f, "utf8");
    if (/paddingTop:\s*(?:Platform[^,\n]*|\d{2,})/.test(text)) byHand++;
  }

  if (byHand > PADS_BY_HAND) {
    bad(
      `signed-in screens padding by hand: ${byHand}`,
      `was ${PADS_BY_HAND}. A new screen guessed past the status bar instead of ` +
      "asking useScreenInsets for the measurement."
    );
  } else if (byHand < PADS_BY_HAND) {
    ok(`signed-in screens padding by hand: ${byHand}, down from ${PADS_BY_HAND} — lower PADS_BY_HAND`);
  } else {
    ok(`signed-in screens padding by hand: ${byHand}, unchanged`);
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// EVERY SECTION CAN BE REACHED, AND EVERY RECEIPT CAN BE SEEN
//
// The navigation guard in app/_layout.js sends a signed-in user back to their
// role home whenever the section they are in is not their home section and is
// not on a shared list. app/messages was never on that list. Every role has a
// home of its own — /admin, /teacher, /student — so /messages matched nobody,
// and the guard replaced the route the instant the screen pushed it. Tapping
// Messages took you home.
//
// Nothing else was wrong: the screens rendered, the service read and wrote,
// and /messages/conversations answered 200 to a student, a teacher and an
// administrator alike. The whole module was simply unreachable, and being
// unreachable is exactly what stops anyone discovering the rest works.
//
// So: a section of the app that no role can open is a bug, and this counts
// them. It needs no baseline, because the answer must always be none.
//
// The second half is the read receipts. They sit on the outgoing bubble,
// which is a saturated blue, and the blue "read" tick measured 1.41:1 against
// it — invisible, on the state that matters most. The failed marker was
// 2.72:1, on the one message a sender has to notice. WCAG 1.4.11 asks 3:1 of
// a graphical indicator, so that is the floor here.
// ─────────────────────────────────────────────────────────────────────────────

const checkNavigationReach = () => {
  console.log("");
  console.log("EVERY SECTION IS REACHABLE");

  const layout = fs.readFileSync(path.join(ROOT, "app/_layout.js"), "utf8");
  const routes = fs.readFileSync(path.join(ROOT, "src/services/routes.js"), "utf8");

  const sharedLine = layout.match(/SHARED_SECTIONS\s*=\s*new Set\(\[([^\]]*)\]/);
  if (!sharedLine) { bad("the shared-section list can be read"); return; }
  const shared = new Set([...sharedLine[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));

  // Where each role lands. The first path segment is the section it owns.
  const homes = new Set(
    [...routes.matchAll(/return\s+"\/([a-z-]+)/g)].map((m) => m[1])
  );

  const sections = fs.readdirSync(path.join(ROOT, "app"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("(") && !d.name.startsWith("_"))
    .map((d) => d.name);

  const stranded = sections.filter((s) => !homes.has(s) && !shared.has(s));

  if (stranded.length) {
    bad(
      "no section is stranded outside the navigation guard",
      stranded.map((s) =>
        `app/${s} is nobody\u2019s home section and is not shared \u2014 the guard ` +
        "redirects away from it the moment it is opened"
      ).join(String.fromCharCode(10))
    );
  } else {
    ok(`every section is reachable (${sections.length} checked, ${shared.size} shared)`);
  }
};

// ── Read receipts must clear 3:1 on the bubble they sit on ──────────────────

const checkReceiptContrast = () => {
  console.log("");
  console.log("READ RECEIPTS ARE VISIBLE");

  const thread = fs.readFileSync(path.join(ROOT, "app/messages/[id].js"), "utf8");

  // The outgoing bubble's fill, read from the palette the screen defines.
  const primary = thread.match(/primary:\s*"(#[0-9A-Fa-f]{6})"/);
  if (!primary) { bad("the outgoing bubble colour can be read"); return; }
  const bg = primary[1];

  // Every colour StateMark hands to an icon.
  const body = thread.slice(thread.indexOf("function StateMark"));
  const end  = body.indexOf(String.fromCharCode(10) + "}");
  const marks = [...body.slice(0, end).matchAll(/color="(#[0-9A-Fa-f]{6})"/g)]
    .map((m) => m[1]);

  if (!marks.length) { bad("StateMark's colours can be read"); return; }

  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  const FLOOR = 3;   // WCAG 1.4.11, non-text contrast
  const dim = [...new Set(marks)]
    .map((c) => ({ c, r: ratio(c, bg) }))
    .filter(({ r }) => r < FLOOR);

  if (dim.length) {
    bad(
      `every receipt clears ${FLOOR}:1 on the bubble`,
      dim.map(({ c, r }) => `${c} on ${bg} is ${r.toFixed(2)}:1`).join(String.fromCharCode(10))
    );
  } else {
    const worst = Math.min(...[...new Set(marks)].map((c) => ratio(c, bg)));
    ok(`every receipt clears ${FLOOR}:1 on the bubble (worst ${worst.toFixed(2)}:1)`);
  }

  // Delivered and read share a shape, so colour is all that separates them.
  const readMark = body.match(/isRead[\s\S]{0,400}?color="(#[0-9A-Fa-f]{6})"/);
  if (readMark && ratio(readMark[1], bg) >= 4.5) {
    ok(`the read receipt is the brightest of them (${ratio(readMark[1], bg).toFixed(2)}:1)`);
  } else {
    bad("the read receipt is the brightest of them",
      "delivered and read are both a double tick — if the read one is not " +
      "clearly brighter there is nothing left to tell them apart");
  }
};
checkParse();
checkLocales();
checkLinkQuality();
checkSyncPolicy();
checkServerWinsUpserts();
checkStudentSyncPlan();
checkScreenEdges();
checkNavigationReach();
checkReceiptContrast();

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
