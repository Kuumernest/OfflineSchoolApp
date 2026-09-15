// web/src/components/platform/csv.ts
//
// A table, as a file. The platform reports exist to be handed to somebody who
// is not in the app, and a CSV is the one format every spreadsheet opens.

const cell = (v: string | number | null | undefined): string => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | null | undefined)[][],
): void {
  const lines = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  // A BOM so Excel reads the accents in a French heading correctly.
  const blob = new Blob(["﻿" + lines], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
