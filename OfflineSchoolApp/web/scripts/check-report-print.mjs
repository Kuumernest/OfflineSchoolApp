// web/scripts/check-report-print.mjs
//
// The report-card print path, asserted from the source.
//
// The failure this pins: a single card opened a preview torn between the click
// and the response, so `window.open` ran after an await. Browsers treat that as
// an unsolicited popup, return null, and say nothing in the console — while the
// page counted the blocked window as a success and told the reader "sent to
// print". The second card was the one that usually failed.
//
// The rules that follow from it:
//
//   1. A single card's window is opened synchronously, before the first await.
//   2. A class is never opened as one window per pupil; it is fetched and shown
//      in the in-app preview, where Print is an explicit action.
//   3. A card is counted as opened only after its HTML was written.
//   4. Nothing says "sent to print"; the browser never tells us it printed.
//   5. Both languages carry every new message.
//
//   node scripts/check-report-print.mjs
//
// Static, like check-api-paths and check-platform-layout: this project has no
// DOM test runner, and these are the ordering rules a later edit must not undo.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => `       ${l}`).join("\n"));
};
const check = (label, value, detail) => value ? ok(label) : bad(label, detail);

const page    = read("src/pages/reports/cards.tsx");
const printer = read("src/print/document.ts");
const en      = JSON.parse(read("src/i18n/locales/en.json"));
const fr      = JSON.parse(read("src/i18n/locales/fr.json"));

const from = page.indexOf("const handleGenerate = async");
const to   = page.indexOf("const previewCard", from);
const generate = from >= 0 && to > from ? page.slice(from, to) : "";
const loopAt = generate.indexOf("for (let i = 0;");
const loop   = loopAt >= 0 ? generate.slice(loopAt) : "";
const firstAwait = generate.indexOf("await");
const openAt     = generate.indexOf("openPreviewWindow(");

console.log("--- the single-card window ---");
check("the page never calls window.open itself", !/window\.open\s*\(/.test(page));
check("the preview window is opened synchronously, before the first await",
  openAt >= 0 && firstAwait >= 0 && openAt < firstAwait,
  `open at ${openAt}, first await at ${firstAwait}`);
check("a blocked window is reported and counted as a failure",
  /if\s*\(\s*singleInTab\s*&&\s*!previewWindow\s*\)[\s\S]{0,220}success:\s*0[\s\S]{0,120}error:\s*1/.test(generate));
check("the window is populated only after the card request",
  /await cardRequest\(sid\)[\s\S]*?showInPreviewWindow\(previewWindow, html\)/.test(generate));

console.log("--- the desktop single card ---");
check("the desktop bridge is the one source of the answer",
  /import \{\s*isDesktop\s*\}\s+from "@\/lib\/offline\/bridge"/.test(page)
    && /const singleInTab = single && !isDesktop\(\)/.test(generate));
check("a desktop single card skips window.open and uses the in-app preview",
  /const previewWindow = singleInTab \? openPreviewWindow\(\) : null/.test(generate)
    && /if \(singleInTab\) \{\s*if \(!previewWindow[\s\S]{0,500}\} else \{[\s\S]{0,400}collected\.push/.test(generate));
check("no single-card branch bypasses the desktop decision",
  !/if \(single\)/.test(generate) && /if \(singleInTab\) \{/.test(generate));

console.log("--- stale generations ---");
check("a generation token is captured before the requests",
  /import \{[^}]*useRef[^}]*\} from "react"/.test(page)
    && /const generationRef = useRef\(0\)/.test(page)
    && /const generation = \+\+generationRef\.current/.test(generate)
    && /const isCurrent\s*=\s*\(\) => generationRef\.current === generation/.test(generate));
check("selection changes invalidate the active generation",
  (page.match(/invalidateGeneration\(\)/g) || []).length >= 7
    && /setGenerating\(false\)/.test(page.slice(page.indexOf("const invalidateGeneration"),
      page.indexOf("const closePreview"))));
check("a stale reply is checked before progress, cards and result state",
  /if \(stale\(\)\) return;[\s\S]{0,160}setProgress/.test(generate)
    && /await cardRequest\(sid\);[\s\S]{0,80}if \(stale\(\)\) return;/.test(generate)
    && /if \(stale\(\)\) return;[\s\S]{0,80}setGenerating\(false\)/.test(generate)
    && /if \(stale\(\)\) return;[\s\S]{0,1200}setPreviewCards\(collected\)/.test(generate));

console.log("--- the class preview ---");
check("no window is opened inside the per-student loop",
  loopAt >= 0 && !/openPreviewWindow\s*\(/.test(loop));
check("batch HTML is collected for the in-app preview",
  /collected\.push\(\{\s*id:\s*sid,\s*name,\s*html\s*\}\)/.test(generate));
check("the in-app preview renders the selected card in an iframe",
  /<iframe[\s\S]{0,220}srcDoc=\{previewCard\.html\}/.test(page));
check("Print is an explicit action in the preview, through the shared helper",
  /const handlePrintPreview[\s\S]{0,420}await printHtml\(previewCard\.html\)/.test(page));

console.log("--- what is counted and said ---");
check("no card is counted before its HTML was written",
  !/success\+\+/.test(page) && /if\s*\(\s*!showInPreviewWindow\(previewWindow, html\)\)[\s\S]{0,180}break;[\s\S]{0,260}opened\+\+/.test(generate));
check("the page no longer says 'sent to print'", !/sentToPrint/.test(page));
check("opening a preview is not described as completed printing",
  !/sentToPrint|Successfully printed|Printing completed/i.test(page)
    && /printRequested/.test(page));

console.log("--- the print helpers ---");
check("the iframe helper resolves only after print() is invoked",
  /export const printHtml = \(html: string\): Promise<boolean>/.test(printer)
    && /win\.print\(\);[\s\S]{0,80}finish\(true\)/.test(printer)
    && /catch \{[\s\S]{0,80}finish\(false\)/.test(printer)
    && /30_000/.test(printer));
check("the preview helper refuses a closed window",
  /export const showInPreviewWindow =[\s\S]{0,260}if \(!win \|\| win\.closed\) return false;/.test(printer));
check("printing is requested without claiming it completed",
  /win\.print\(\)/.test(printer) && /browser does not tell us/.test(printer));
// The preview used to add a `load` listener before document.open(), which the
// open erases, and fall back on a fixed 4-second timer — so a slow logo or
// photo printed as a blank box. It now waits for the images themselves.
check("the preview waits for its images, not a fixed timer",
  /imagesSettled\(win\.document\)\.then\(requestPrint\)/.test(printer)
    && !/addEventListener\("load", requestPrint/.test(printer)
    && !/\b4000\b/.test(printer));
check("and the print frame waits for them too",
  /imagesSettled\(frame\.contentDocument/.test(printer));

console.log("--- the modal lifecycle ---");
check("closing the preview clears the retained card",
  /const closePreview = \(\) => \{[\s\S]{0,320}setPreviewCards\(\[\]\)[\s\S]{0,80}setPreviewId\(""\)/.test(page)
    && /onClose=\{closePreview\}/.test(page)
    && /onClick=\{closePreview\}/.test(page));
check("the preview note is neutral for browser and desktop",
  /t\("reportCards\.previewNote"\)/.test(page)
    && !/opensNewTab/.test(page)
    && Boolean(en.reportCards?.previewNote)
    && Boolean(fr.reportCards?.previewNote));
check("a late print result cannot land in a newer preview session",
  /const run = \+\+printRunRef\.current/.test(page)
    && /if \(printRunRef\.current !== run\) return;/.test(page)
    && /const closePreview = \(\) => \{[\s\S]{0,160}printRunRef\.current \+= 1/.test(page));

/*
 * The helper is plain TypeScript with no DOM at import time, so the cases the
 * source cannot express — closed, unwritable, missing document — can be run
 * here with a fake window.
 */
const { showInPreviewWindow } = await import("../src/print/document.ts");

const fakeWindow = ({ closed = false, document = true, writeThrows = false } = {}) => {
  const calls = { opened: 0, written: "", ended: 0, focused: 0, printed: 0 };
  let load = null;
  // One image still loading — the school's logo, say.
  const logo = {
    complete: false,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
  const win = {
    closed,
    document: document ? {
      images: [logo],
      open:  () => { calls.opened++; },
      write: (html) => {
        if (writeThrows) throw new Error("write failed");
        calls.written += html;
      },
      close: () => { calls.ended++; },
    } : null,
    addEventListener: (type, fn) => { if (type === "load") load = fn; },
    focus: () => { calls.focused++; },
    print: () => { calls.printed++; },
  };
  return { win, calls, fireLoad: () => load?.(), logo };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("--- the preview helper at runtime ---");
{
  const { win, calls, logo } = fakeWindow();
  check("writes the fetched card into an open window",
    showInPreviewWindow(win, "<p>card</p>") === true && calls.written === "<p>card</p>");
  await tick();
  check("does not ask for print while an image is still loading", calls.printed === 0);
  logo.complete = true; logo.listeners.load?.();
  await tick();
  check("asks for print once it has arrived", calls.printed === 1);
}
{
  const { win, calls, logo } = fakeWindow();
  showInPreviewWindow(win, "<p>card</p>");
  logo.listeners.error?.();
  await tick();
  check("a photo that fails to load does not hold the dialog back", calls.printed === 1);
}
{
  const { win } = fakeWindow({ closed: true });
  check("a closed preview window is not counted as shown",
    showInPreviewWindow(win, "<p>card</p>") === false);
}
{
  const { win } = fakeWindow({ document: false });
  check("a window with no document is not counted as shown",
    showInPreviewWindow(win, "<p>card</p>") === false);
}
{
  const { win } = fakeWindow({ writeThrows: true });
  check("a write failure is not counted as shown",
    showInPreviewWindow(win, "<p>card</p>") === false);
}

console.log("--- both languages ---");
const keys = [
  "previewOpened", "previewClosed", "previewUnavailable", "popupBlocked",
  "emptyResponse", "cardFailed", "batchReady", "batchReady_other",
  "batchNone", "previewTitle", "previewSelect", "previewHint",
  "printRequested", "printNotStarted", "previewNote",
];
for (const key of keys) {
  check(`en.${key} and fr.${key} are present`,
    Boolean(en.reportCards?.[key]) && Boolean(fr.reportCards?.[key]),
    `en=${JSON.stringify(en.reportCards?.[key])} fr=${JSON.stringify(fr.reportCards?.[key])}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
