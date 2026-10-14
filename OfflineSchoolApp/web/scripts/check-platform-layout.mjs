// web/scripts/check-platform-layout.mjs
//
// Layout invariants for the Super Admin (platform) screens, asserted from the
// source. This project has no DOM test runner; the rendered check is done by
// hand with the Electron capture rig, and these are the rules that rig kept
// finding broken, written down so a later edit cannot quietly undo them:
//
//   1. A data table scrolls inside its own container, which can never widen
//      its parent (min-w-0 max-w-full overflow-x-auto).
//   2. A cell either wraps (Td wrap) or stays on one line; a nowrap cell must
//      not hold a flex-wrap row of buttons, which turns one row into three.
//   3. No platform page reaches for width: max-content, fixed pixel widths on
//      a container, or page-level overflow-x: hidden to paper over a spill.
//   4. Pagination and every modal footer may wrap their controls.
//   5. The tile grid and filter bar collapse: grid-cols-1 or -2 at the base.
//
// Run: npm run check:layout
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname }             from "node:path";
import { fileURLToPath }             from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
};

const PLATFORM_DIR = "src/pages/platform";
const platformPages = readdirSync(join(ROOT, PLATFORM_DIR))
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => [`${PLATFORM_DIR}/${f}`, read(`${PLATFORM_DIR}/${f}`)]);
const shared = {
  DataTable:  read("src/components/ui/DataTable.tsx"),
  Pagination: read("src/components/ui/Pagination.tsx"),
  Modal:      read("src/components/ui/Modal.tsx"),
  Card:       read("src/components/ui/Card.tsx"),
  FiltersBar: read("src/components/platform/FiltersBar.tsx"),
  MetricTile: read("src/components/platform/MetricTile.tsx"),
  Layout:     read("src/components/layout/DashboardLayout.tsx"),
};

console.log("--- the shared table ---");
check("the table scroll container cannot widen its parent",
  /className="min-w-0 max-w-full overflow-x-auto"/.test(shared.DataTable));
check("Td offers a wrap option and stays nowrap otherwise",
  /wrap\s*\?\s*"[^"]*whitespace-normal[^"]*"\s*:\s*"[^"]*whitespace-nowrap[^"]*"/.test(shared.DataTable));
check("Th does not force nowrap on headings (French headings wrap instead of widening)",
  !/<th[\s\S]*?whitespace-nowrap[\s\S]*?scope="col"/.test(shared.DataTable));

check("a card can shrink below its content when it is a grid or flex item",
  /"min-w-0 rounded-card border border-line shadow-card"/.test(shared.Card));
check("the card header wraps its action under a long title and names the full title on hover",
  /flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2/.test(shared.Card) && /title=\{title\}>\{title\}<\/h3>/.test(shared.Card));

console.log("--- pagination, modals, filters, tiles ---");
check("pagination wraps its two halves", /flex flex-wrap items-center justify-between/.test(shared.Pagination));
check("the modal is bounded by the viewport",
  /w-\[calc\(100%-2rem\)\]/.test(shared.Modal) && /max-h-\[calc\(100vh-4rem\)\] overflow-y-auto/.test(shared.Modal));
check("the filter bar starts single-column and grows by breakpoint",
  /grid gap-3 \$\{columns\}/.test(shared.FiltersBar) && /sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5/.test(shared.FiltersBar));
check("the tile grid starts single-column on a phone and every tile is min-w-0",
  /grid grid-cols-1 gap-3 min-\[420px\]:grid-cols-2 sm:grid-cols-3/.test(shared.MetricTile) && /"block min-w-0 rounded-card/.test(shared.MetricTile));
check("the tile figure never breaks inside a number above phone width",
  /break-normal max-sm:\[overflow-wrap:anywhere\]/.test(shared.MetricTile));
check("the content column is min-w-0 and the main area scrolls vertically only",
  /flex min-w-0 flex-1 flex-col overflow-hidden/.test(shared.Layout) && /<main className="flex-1 overflow-y-auto">/.test(shared.Layout));

console.log("--- every platform page ---");
for (const [file, src] of platformPages) {
  const short = file.replace(`${PLATFORM_DIR}/`, "");
  check(`${short}: no max-content, w-max or min-w-max widths`,
    !/(max-content|\bw-max\b|min-w-max)/.test(src));
  check(`${short}: no page-level overflow-x-hidden`,
    !/overflow-x-hidden/.test(src));
  // A min-w is a floor a control can grow from, not a width; only a bare w-[Npx]
  // pins a container to a size the viewport may not have.
  check(`${short}: no fixed pixel width on a container (w-[Npx])`,
    !/(?<![\w-])w-\[\d+px\]/.test(src), (src.match(/(?<![\w-])w-\[\d+px\]/g) || []).join(" "));
  // A flex-wrap row of buttons inside a table cell makes the row several
  // lines tall the moment the table is squeezed; actions stay on one line.
  const cellActionWrap = /<Td[^>]*>\s*<div className="flex flex-wrap/.test(src);
  check(`${short}: no flex-wrap button row inside a table cell`, !cellActionWrap);
  // A header with an action beside it is CardHeader's action slot, not a row
  // hand-rolled around it; and a Table brings its own scroll container.
  check(`${short}: no hand-rolled card header row (use CardHeader action)`,
    !/justify-between gap-x-4 gap-y-2 px-5 pt-4/.test(src));
  check(`${short}: no scroll container wrapped around a Table`,
    !/overflow-x-auto[^\n]*>\s*\n\s*<Table>/.test(src));
  // Every modal footer may wrap — French labels are longer.
  const footers = src.match(/className="[^"]*justify-end gap-2[^"]*"/g) || [];
  const rigid = footers.filter((f) => !/flex-wrap/.test(f));
  check(`${short}: every modal footer wraps (${footers.length} footer${footers.length === 1 ? "" : "s"})`,
    rigid.length === 0, rigid.join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
