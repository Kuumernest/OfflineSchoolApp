// web/scripts/check-chunk-retry.mjs
//
// A route whose chunk fails to load is fetched again, and if it never loads the
// person gets a sentence and a Reload button — not the browser's error.
//
// The failure this pins: every page in App.tsx was a bare React.lazy import, so
// one failed request for its chunk (a flaky connection, or a deploy that
// renamed the chunks) crashed the route with "Failed to fetch dynamically
// imported module", shown raw by RouteErrorBoundary.
//
// Runs the real helper (src/utils/lazyWithRetry.ts) with a fake import, then
// reads App.tsx, the boundary and both locales.
//
//   node scripts/check-chunk-retry.mjs

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

// The helper, compiled as it is — it imports nothing, on purpose. If it does
// not exist (the old code), every behavioural check below fails.
let helper = {};
try {
  const { outputText } = ts.transpileModule(read("src/utils/lazyWithRetry.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  helper = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
} catch (err) {
  console.log(`  (helper not loaded: ${err.message})`);
}
const { retryImport, isChunkLoadError, CHUNK_RETRY_ATTEMPTS } = helper;

const chunkError = () => new TypeError(
  "Failed to fetch dynamically imported module: https://school.example/assets/ExamsPage-abc123.js");

/** An import that fails `failures` times, then resolves to a page module. */
const flakyImport = (failures) => {
  const state = { calls: 0 };
  const load = async () => {
    state.calls++;
    if (state.calls <= failures) throw chunkError();
    return { default: "Page" };
  };
  return { load, state };
};

const run = async (p) => {
  try { return { ok: true, value: await p }; }
  catch (err) { return { ok: false, message: err?.message ?? String(err) }; }
};

console.log("--- retryImport ---");
check("the helper exists", typeof retryImport, "function");
check("three attempts by default", CHUNK_RETRY_ATTEMPTS, 3);

if (typeof retryImport === "function") {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };

  {
    const { load, state } = flakyImport(0);
    const r = await run(retryImport(load, { sleep }));
    check("an import that works resolves first time", [r.ok, r.value?.default, state.calls], [true, "Page", 1]);
  }
  {
    waits.length = 0;
    const { load, state } = flakyImport(2);
    const r = await run(retryImport(load, { sleep }));
    check("an import that fails twice then loads resolves", [r.ok, r.value?.default], [true, "Page"]);
    check("…on the third attempt", state.calls, 3);
    check("…waiting a little longer before each retry", waits, [400, 800]);
  }
  {
    waits.length = 0;
    const { load, state } = flakyImport(Infinity);
    const r = await run(retryImport(load, { sleep }));
    check("an import that always fails rejects", r.ok, false);
    check("…after exactly the default number of attempts", state.calls, 3);
    check("…with the browser's error, for the boundary to recognise",
      r.message?.startsWith("Failed to fetch dynamically imported module"), true);
    check("…and no wait after the last attempt", waits.length, 2);
  }
  {
    const { load, state } = flakyImport(Infinity);
    await run(retryImport(load, { attempts: 5, baseDelayMs: 1, sleep }));
    check("attempts is configurable", state.calls, 5);
  }
  {
    // The real timer, kept short: the default sleep works.
    const { load, state } = flakyImport(1);
    const r = await run(retryImport(load, { baseDelayMs: 1 }));
    check("the real backoff timer resolves", [r.ok, state.calls], [true, 2]);
  }
}

console.log("--- isChunkLoadError ---");
if (typeof isChunkLoadError === "function") {
  const yes = [
    chunkError(),
    new TypeError("error loading dynamically imported module: /assets/x.js"),  // Firefox
    new TypeError("Importing a module script failed."),                         // Safari
    new Error("Unable to preload CSS for /assets/x.css"),                        // Vite
    Object.assign(new Error("Loading chunk 42 failed."), { name: "ChunkLoadError" }),
  ];
  for (const e of yes) check(`a chunk error: ${e.message}`, isChunkLoadError(e), true);
  check("a page that threw is not one", isChunkLoadError(new TypeError("Cannot read properties of undefined")), false);
  check("nor nothing", isChunkLoadError(null), false);
  check("nor a string", isChunkLoadError("Failed to fetch dynamically imported module"), false);
} else {
  check("isChunkLoadError exists", typeof isChunkLoadError, "function");
}

console.log("--- every route goes through it ---");
const app = read("src/App.tsx");
const bare = (app.match(/\blazy\(\s*\(\)\s*=>\s*import\(/g) ?? []).length;
const wrapped = (app.match(/\blazyPage\(\s*\(\)\s*=>\s*import\(/g) ?? []).length;
check("App.tsx has no bare lazy(() => import(...)) route", bare, 0);
check("the pages are loaded through lazyPage", wrapped > 50, true);
check("lazyPage is lazy over retryImport", /lazy\(\s*\(\)\s*=>\s*retryImport\(/.test(app), true);
check("routes still sit inside RouteErrorBoundary", /<RouteErrorBoundary>\s*<Suspense/.test(app), true);

console.log("--- the screen at the end ---");
const boundary = read("src/components/layout/RouteErrorBoundary.tsx");
check("the boundary recognises a chunk error", /isChunkLoadError\(error\)/.test(boundary), true);
check("and offers a reload", /ChunkErrorFallback[\s\S]*window\.location\.reload\(\)/.test(boundary), true);
check("no automatic reload (no loop to guard)", /^\s*window\.location\.reload\(\);?\s*$/m.test(boundary), false);

const en = JSON.parse(read("src/i18n/locales/en.json")).error ?? {};
const fr = JSON.parse(read("src/i18n/locales/fr.json")).error ?? {};
for (const key of ["chunkTitle", "chunkBody", "chunkReload"]) {
  check(`en has error.${key}`, typeof en[key] === "string" && en[key].length > 0, true);
  check(`fr has error.${key}, translated`, typeof fr[key] === "string" && fr[key].length > 0 && fr[key] !== en[key], true);
  check(`the boundary uses error.${key}`, boundary.includes(`t("error.${key}")`), true);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
