// web/src/config/sections.ts
/**
 * How the rail is grouped, and which colour a card takes.
 *
 * ── Colour ────────────────────────────────────────────────────────────────
 *
 * The console is a calm blue SaaS frame: white panels, slate text, one brand
 * blue for what is interactive. Colour appears in two places:
 *
 *   1. Every stat card, summary tile and icon square takes its kind's colour
 *      (config/dashboardTint.ts): a soft wash, a 3px top edge, a solid icon
 *      square with a white icon. The mapping is the same as the mobile app's
 *      (mobile/src/theme/colors.js, TILE), so a pupil count is blue on both.
 *   2. Status (SEMANTIC): warning, error, info, success — for banners and
 *      messages whose value means something.
 *
 * Class strings are written out in full, never composed at runtime: Tailwind
 * only emits classes it can read in source.
 */
import { DASH_ACCENT, DASH_TINT, type DashAccent } from "@/config/dashboardTint";

/** What a card is about. `neutral` is a figure that belongs to no kind. */
export type TileTone =
  | "students" | "teachers" | "classes"  | "subjects" | "timetable"
  | "attendance" | "exams"  | "homework" | "reports"  | "finance"
  | "comms"    | "settings" | "neutral";

export type Accent = DashAccent;

/** Which colour each kind takes — the same as mobile. */
export const CARD_ACCENT: Record<TileTone, Accent> = DASH_ACCENT;

/** The icon square for a kind: solid, with a white icon. */
export const iconBox = (tone: TileTone): string => DASH_TINT[DASH_ACCENT[tone]].box;

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
