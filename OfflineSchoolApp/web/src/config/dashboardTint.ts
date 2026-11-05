// web/src/config/dashboardTint.ts
/**
 * The app's tinted cards. Every stat card, summary tile, quick action and
 * icon square takes its kind's colour: a soft wash, a 3px top edge, a solid
 * icon square with a white icon, and the figure in a deeper shade of the same
 * hue. The same kind is the same colour on every screen — and in the phone
 * app (mobile/src/theme/colors.js, TILE) — and no icon square is grey or pale.
 * Red is for a figure that is bad news (failed, overdue), not a kind.
 *
 * Tokens live in index.css (accent-*, accent-*-solid, accent-*-deep), with
 * their measured contrast. Class strings are written out in full: Tailwind
 * only emits what it can read in source.
 */
import type { Semantic, TileTone } from "@/config/sections";

export type DashAccent = "blue" | "violet" | "indigo" | "slate" | "amber" | "green" | "teal" | "sky" | "red";

/** Which colour each kind takes on a dashboard. */
export const DASH_ACCENT: Record<TileTone, DashAccent> = {
  students:   "blue",
  teachers:   "violet",
  classes:    "indigo",
  subjects:   "slate",
  exams:      "amber",
  attendance: "green",
  timetable:  "teal",
  comms:      "sky",
  homework:   "indigo",
  reports:    "slate",
  finance:    "teal",
  settings:   "slate",
  neutral:    "slate",
};

export interface DashTint {
  /** The card: border, wash and the 3px top edge. */
  card:      string;
  /** The icon square: a solid fill and a white glyph. */
  box:       string;
  /** The figure, in the deeper shade. */
  number:    string;
  /** The card with an amber border: a warning count above zero. */
  warnCard:  string;
  /** The card with a red border: a fault (a timetable conflict) above zero. */
  errorCard: string;
  /** Just the 3px top edge, for a panel about one kind. */
  edge:      string;
  /** A glyph on white, in the kind's colour. */
  glyph:     string;
}

export const DASH_TINT: Record<DashAccent, DashTint> = {
  blue: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-blue bg-accent-blue-soft shadow-card",
    box:       "bg-accent-blue-solid text-white",
    number:    "text-accent-blue-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-blue-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-blue-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-blue",
    glyph:     "text-accent-blue-solid",
  },
  violet: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-violet bg-accent-violet-soft shadow-card",
    box:       "bg-accent-violet-solid text-white",
    number:    "text-accent-violet-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-violet-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-violet-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-violet",
    glyph:     "text-accent-violet-solid",
  },
  indigo: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-indigo bg-accent-indigo-soft shadow-card",
    box:       "bg-accent-indigo-solid text-white",
    number:    "text-accent-indigo-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-indigo-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-indigo-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-indigo",
    glyph:     "text-accent-indigo-solid",
  },
  slate: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-slate bg-accent-slate-soft shadow-card",
    box:       "bg-accent-slate-solid text-white",
    number:    "text-accent-slate-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-slate-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-slate-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-slate",
    glyph:     "text-accent-slate-solid",
  },
  amber: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-amber bg-accent-amber-soft shadow-card",
    box:       "bg-accent-amber-solid text-white",
    number:    "text-accent-amber-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-amber-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-amber-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-amber",
    glyph:     "text-accent-amber-solid",
  },
  green: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-green bg-accent-green-soft shadow-card",
    box:       "bg-accent-green-solid text-white",
    number:    "text-accent-green-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-green-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-green-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-green",
    glyph:     "text-accent-green-solid",
  },
  teal: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-teal bg-accent-teal-soft shadow-card",
    box:       "bg-accent-teal-solid text-white",
    number:    "text-accent-teal-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-teal-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-teal-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-teal",
    glyph:     "text-accent-teal-solid",
  },
  sky: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-sky bg-accent-sky-soft shadow-card",
    box:       "bg-accent-sky-solid text-white",
    number:    "text-accent-sky-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-sky-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-sky-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-sky",
    glyph:     "text-accent-sky-solid",
  },
  red: {
    card:      "rounded-card border border-line border-t-[3px] border-t-accent-red bg-accent-red-soft shadow-card",
    box:       "bg-accent-red-solid text-white",
    number:    "text-accent-red-deep",
    warnCard:  "rounded-card border border-accent-amber-solid border-t-[3px] bg-accent-red-soft shadow-card",
    errorCard: "rounded-card border border-danger border-t-[3px] bg-accent-red-soft shadow-card",
    edge:      "border-t-[3px] border-t-accent-red",
    glyph:     "text-accent-red-solid",
  },
};

/** The tinted look for a kind. */
export const dashTint = (tone: TileTone): DashTint => DASH_TINT[DASH_ACCENT[tone]];

/** A count's figure: dark navy, amber above zero for a warning, red for a fault. */
export const ALERT_NUMBER = {
  ok:      "text-ink",
  warning: "text-warning-text",
  error:   "text-danger-text",
} as const;

/**
 * How an overview (setup health) tile looks for its current value:
 *  - "kind": a plain count — the kind's tinted card, solid icon square. Notices
 *    are one of these (sky), whatever their `semantic` says elsewhere;
 *  - "alert": a metric that is a problem only above zero. It keeps the same
 *    tinted card and solid icon square at every value; `level` says whether
 *    the figure and border are calm ("ok": a navy figure), amber ("warning")
 *    or red ("error": a timetable conflict).
 * Styling only — what counts as a fault for the panel's header is decided by
 * the metric's own `alert` (SystemHealthGrid), unchanged.
 */
export type HealthLook =
  | { kind: "kind" }
  | { kind: "alert"; level: keyof typeof ALERT_NUMBER };

export const healthLook = (
  metric: { key: string; alertOnNonZero?: boolean; semantic?: Semantic },
  value: number,
): HealthLook => {
  if (metric.alertOnNonZero) {
    if (value <= 0) return { kind: "alert", level: "ok" };
    return { kind: "alert", level: metric.key === "timetableConflicts" ? "error" : "warning" };
  }
  return { kind: "kind" };
};
