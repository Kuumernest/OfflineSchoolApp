// web/src/config/sections.ts
/**
 * How the rail is grouped, and which accent a card's icon box takes.
 *
 * ── Colour ────────────────────────────────────────────────────────────────
 *
 * The console is neutral: white cards, slate text, one brand blue for what is
 * interactive. Colour appears in two places only:
 *
 *   1. The icon box of a normal stat / module card, tinted by what the card
 *      counts (CARD_ACCENT). The card itself stays white. The mapping is the
 *      same as the mobile app's (mobile/src/theme/colors.js, TILE), so a pupil
 *      count is a blue box on both.
 *   2. Status (SEMANTIC): warning, error, info, success — a light tint, never
 *      a solid fill, and only when the value means something.
 *
 * Class strings are written out in full, never composed at runtime: Tailwind
 * only emits classes it can read in source.
 */

/** What a card is about. `neutral` is a figure that belongs to no kind. */
export type TileTone =
  | "students" | "teachers" | "classes"  | "subjects" | "timetable"
  | "attendance" | "exams"  | "homework" | "reports"  | "finance"
  | "comms"    | "settings" | "neutral";

export type Accent = "blue" | "indigo" | "violet" | "slate" | "teal";

/** Icon box classes per accent: a pale box, the accent on the glyph. */
export const ACCENT_BOX: Record<Accent, string> = {
  blue:   "bg-accent-blue-soft text-accent-blue",
  indigo: "bg-accent-indigo-soft text-accent-indigo",
  violet: "bg-accent-violet-soft text-accent-violet",
  slate:  "bg-accent-slate-soft text-accent-slate",
  teal:   "bg-accent-teal-soft text-accent-teal",
};

/** Which accent each kind takes — the same as mobile. */
export const CARD_ACCENT: Record<TileTone, Accent> = {
  students:   "blue",
  teachers:   "indigo",
  classes:    "violet",
  subjects:   "slate",
  timetable:  "teal",
  attendance: "teal",
  exams:      "blue",
  homework:   "indigo",
  reports:    "violet",
  finance:    "teal",
  comms:      "blue",
  settings:   "slate",
  neutral:    "slate",
};

/** Icon box classes for a kind. */
export const iconBox = (tone: TileTone): string => ACCENT_BOX[CARD_ACCENT[tone]];

/** The shell every normal card shares: white, a hairline, a faint shadow. */
export const CARD_SHELL = "rounded-card border border-line bg-surface shadow-card";

export type Semantic = "warning" | "error" | "info" | "success";

/**
 * A card whose value means something. `card` is the tinted shell (words on it
 * take its -text colour), `box` the icon box on that tint.
 */
export const SEMANTIC: Record<Semantic, { card: string; box: string; text: string }> = {
  warning: { card: "rounded-card border border-warning-line bg-warning-soft", box: "bg-warning-box text-warning", text: "text-warning-text" },
  error:   { card: "rounded-card border border-danger-line bg-danger-soft",   box: "bg-danger-box text-danger",   text: "text-danger-text" },
  info:    { card: "rounded-card border border-info-line bg-info-soft",       box: "bg-info-box text-info",       text: "text-info-text" },
  success: { card: "rounded-card border border-success-line bg-success-soft", box: "bg-success-box text-success", text: "text-success-text" },
};

/**
 * The order the rail draws its groups in, and which sections fall under each.
 *
 * The rail lists nineteen destinations. It always did — this does not move any
 * of them, because moving where a thing lives is how you make somebody who had
 * finally learned an interface start guessing again. What it does is put a
 * labelled break every few rows, so the eye lands on "Money" and reads three
 * entries instead of scanning nineteen.
 */
export const NAV_GROUPS: Array<{
  labelKey: string;
  label: string;
  /** Matched against a top-level nav item's own path or its first child's. */
  paths: string[];
}> = [
  { labelKey: "navGroup.platform", label: "Platform",
    paths: ["/platform"] },
  { labelKey: "navGroup.overview", label: "Overview",
    paths: ["/dashboard", "/watchlist", "/approvals"] },
  { labelKey: "navGroup.people", label: "People",
    paths: ["/students", "/teachers"] },
  { labelKey: "navGroup.academics", label: "Academics",
    paths: ["/classes", "/attendance", "/exams", "/promotion"] },
  { labelKey: "navGroup.money", label: "Money",
    paths: ["/fees", "/finance"] },
  { labelKey: "navGroup.documents", label: "Documents",
    paths: ["/documents", "/exports", "/reports"] },
  { labelKey: "navGroup.communication", label: "Communication",
    paths: ["/announcements", "/messages"] },
  { labelKey: "navGroup.administration", label: "Administration",
    paths: ["/portal-codes", "/settings"] },
];

/** The group a top-level nav entry belongs to, by its path or first child's. */
export function groupIndexFor(path: string | undefined): number {
  if (!path) return NAV_GROUPS.length - 1;
  const i = NAV_GROUPS.findIndex((g) =>
    g.paths.some((p) => path === p || path.startsWith(`${p}/`))
  );
  return i === -1 ? NAV_GROUPS.length - 1 : i;
}
