// web/src/config/dashboardTint.ts
/**
 * The school dashboard's tinted cards — this page only.
 *
 * Elsewhere a card is white with an accented icon box (config/sections.ts,
 * shared with mobile). On the dashboard each kind of figure gets its colour
 * more plainly: a soft wash, a 3px top edge, a solid icon square and the
 * figure in a deeper shade of the same hue, so the six headline numbers and
 * the overview tiles can be told apart at a glance. The same kind is the same
 * colour in all three panels.
 *
 * Tokens live in index.css (accent-*, accent-*-solid, accent-*-deep), with
 * their measured contrast. Class strings are written out in full: Tailwind
 * only emits what it can read in source.
 */
import type { Semantic, TileTone } from "@/config/sections";

export type DashAccent = "blue" | "violet" | "indigo" | "slate" | "amber" | "green" | "teal";

/** Which colour each kind takes on the dashboard. */
export const DASH_ACCENT: Record<TileTone, DashAccent> = {
  students:   "blue",
  teachers:   "violet",
  classes:    "indigo",
  subjects:   "slate",
  exams:      "amber",
  attendance: "green",
  timetable:  "teal",
  comms:      "blue",
  homework:   "indigo",
  reports:    "slate",
  finance:    "teal",
  settings:   "slate",
  neutral:    "slate",
};

export interface DashTint {
  /** The card: border, wash and the 3px top edge. */
  card:   string;
  /** The icon square: a solid fill and a white glyph. */
  box:    string;
  /** The figure, in the deeper shade. */
  number: string;
}

export const DASH_TINT: Record<DashAccent, DashTint> = {
  blue:   { card: "rounded-card border border-line border-t-[3px] border-t-accent-blue bg-accent-blue-soft shadow-card",     box: "bg-accent-blue-solid text-white",   number: "text-accent-blue-deep" },
  violet: { card: "rounded-card border border-line border-t-[3px] border-t-accent-violet bg-accent-violet-soft shadow-card", box: "bg-accent-violet-solid text-white", number: "text-accent-violet-deep" },
  indigo: { card: "rounded-card border border-line border-t-[3px] border-t-accent-indigo bg-accent-indigo-soft shadow-card", box: "bg-accent-indigo-solid text-white", number: "text-accent-indigo-deep" },
  slate:  { card: "rounded-card border border-line border-t-[3px] border-t-accent-slate bg-accent-slate-soft shadow-card",   box: "bg-accent-slate-solid text-white",  number: "text-accent-slate-deep" },
  amber:  { card: "rounded-card border border-line border-t-[3px] border-t-accent-amber bg-accent-amber-soft shadow-card",   box: "bg-accent-amber-solid text-white",  number: "text-accent-amber-deep" },
  green:  { card: "rounded-card border border-line border-t-[3px] border-t-accent-green bg-accent-green-soft shadow-card",   box: "bg-accent-green-solid text-white",  number: "text-accent-green-deep" },
  teal:   { card: "rounded-card border border-line border-t-[3px] border-t-accent-teal bg-accent-teal-soft shadow-card",     box: "bg-accent-teal-solid text-white",   number: "text-accent-teal-deep" },
};

/** The tinted look for a kind. */
export const dashTint = (tone: TileTone): DashTint => DASH_TINT[DASH_ACCENT[tone]];

/** The quick-action icon square: the kind's solid colour. */
export const dashBox = (tone: TileTone): string => dashTint(tone).box;

/**
 * How an overview tile looks for its current value:
 *  - "kind": the kind's tinted card (a plain count);
 *  - "neutral": a white card — a warning metric with nothing to report;
 *  - a status: warning (amber) above zero, or error (red) for a timetable
 *    conflict above zero; notices keep their info tint.
 * Styling only — what counts as a fault for the panel's header is decided by
 * the metric's own `alert` (SystemHealthGrid), unchanged.
 */
export type HealthLook = { kind: "kind" } | { kind: "neutral" } | { kind: "status"; status: Semantic };

export const healthLook = (
  metric: { key: string; alertOnNonZero?: boolean; semantic?: Semantic },
  value: number,
): HealthLook => {
  if (metric.alertOnNonZero) {
    if (value <= 0) return { kind: "neutral" };
    return { kind: "status", status: metric.key === "timetableConflicts" ? "error" : "warning" };
  }
  if (metric.semantic) return { kind: "status", status: metric.semantic };
  return { kind: "kind" };
};
