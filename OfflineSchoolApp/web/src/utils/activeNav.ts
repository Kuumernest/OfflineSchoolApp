// web/src/utils/activeNav.ts
//
// Which sidebar entry is the page you are on.
//
// NavLink decides on its own, per link, by prefix: a link is active when the
// URL starts with its path. The rail has entries that are prefixes of other
// entries — /students and /students/admissions, /exams and /exams/results,
// /reports and /reports/cards, /fees and /fees/structures, /messages and
// /messages/audit — so on any of the nested pages two rows lit up at once. The
// fix for /dashboard and /platform was to match them exactly, which cannot be
// done for the rest: /students/123 has to keep Students lit.
//
// So the rail decides once, for every entry together: the active entry is the
// longest path among the ones shown that the URL is, or sits beneath. Exactly
// one row, or none when the page is not in the rail.
//
// Kept free of imports so scripts/check-active-nav.mjs can run it as it is.

/** Is `pathname` this path, or a page beneath it — on a segment boundary? */
export const isWithin = (pathname: string, path: string): boolean => {
  if (!path) return false;
  const base = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (base === "/") return pathname === "/";
  return pathname === base || pathname.startsWith(`${base}/`);
};

/** The one nav path to highlight for this URL, or null. */
export const activeNavPath = (
  pathname: string,
  paths: ReadonlyArray<string | undefined>,
): string | null => {
  let best: string | null = null;
  for (const p of paths) {
    if (p && isWithin(pathname, p) && (best === null || p.length > best.length)) best = p;
  }
  return best;
};
