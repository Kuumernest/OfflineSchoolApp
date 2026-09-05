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

  // The module is ESM and this file is CommonJS. supportsStaticESM: false is
  // what tells preset-expo to hand back require/exports instead.
  const srcPath = path.join(ROOT, "src/services/linkQuality.js");
  let LQ;
  try {
    const { code } = babel.transformFileSync(srcPath, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false,
      configFile: false,
    });
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function("module", "exports", "require", code)(mod, mod.exports, require);
    LQ = mod.exports;
  } catch (err) {
    bad("linkQuality loads", err.message);
    return;
  }
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

checkParse();
checkLocales();
checkLinkQuality();

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
