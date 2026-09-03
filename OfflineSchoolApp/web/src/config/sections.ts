// web/src/config/sections.ts
/**
 * Which part of the school a route belongs to, and what colour that part is.
 *
 * ── Why colour is worth a config file ─────────────────────────────────────
 *
 * The console has nineteen top-level destinations and every one of them was
 * the same indigo-on-white as every other. Nothing was wrong with any single
 * screen; what was missing was the ability to tell at a glance which screen you
 * were on. Colour is the cheapest wayfinding there is — a person who has opened
 * Fees twice should recognise it from the corner of their eye before reading a
 * word of it.
 *
 * ── The rule this file exists to keep ─────────────────────────────────────
 *
 * A section hue marks WHERE you are. It never marks what something means.
 * Green here is Attendance, not "good"; amber is Fees, not "warning". Status
 * has its own four colours and they are the only ones allowed to carry
 * meaning. Mixing the two is exactly how a colourful interface stops being
 * readable, so the two vocabularies never appear on the same element: sections
 * tint headers, nav icons and stat tiles; status tints badges and banners.
 *
 * ── How a page gets its colour ────────────────────────────────────────────
 *
 * By its path, resolved here, rather than by every page passing a prop. Forty
 * one pages render PageHeader and none of them should have to know what colour
 * it is — and a page added tomorrow inherits the right one for free.
 */

export type SectionKey =
  | "overview"
  | "students"
  | "teachers"
  | "academic"
  | "attendance"
  | "finance"
  | "exams"
  | "reports"
  | "comms"
  | "settings";

export interface Section {
  key: SectionKey;
  /** i18n key for the group label shown above the nav block. */
  labelKey: string;
  /** English fallback, so a missing translation is never a blank rail. */
  label: string;
  /**
   * Tailwind classes rather than raw variables: the class scanner only emits
   * what it can see in source, so a colour composed at runtime from a token
   * name would resolve to nothing. Written out, they are real.
   */
  text: string;
  bg: string;
  border: string;
  /** Solid fill for the one element per page that carries the hue. */
  solid: string;
  /** The accent rule down the side of a page header. */
  rule: string;
  /**
   * The same hue for the navigation rail, which is near-black.
   *
   * A separate value rather than reusing `text`: the section colours are
   * chosen to pass AA on WHITE, which makes every one of them too dark to see
   * on the rail. A light tint is the same colour doing the same job against
   * the opposite background.
   */
  navIcon: string;
}

export const SECTIONS: Record<SectionKey, Section> = {
  overview: {
    key: "overview", labelKey: "navGroup.overview", label: "Overview",
    text: "text-primary-700", bg: "bg-primary-50", border: "border-primary-200",
    solid: "bg-primary-600", rule: "bg-primary-500",
    navIcon: "text-primary-300",
  },
  students: {
    key: "students", labelKey: "navGroup.people", label: "People",
    text: "text-sec-students", bg: "bg-sec-students-soft", border: "border-sec-students-line",
    solid: "bg-sec-students", rule: "bg-sec-students",
    navIcon: "text-teal-300",
  },
  teachers: {
    key: "teachers", labelKey: "navGroup.people", label: "People",
    text: "text-sec-teachers", bg: "bg-sec-teachers-soft", border: "border-sec-teachers-line",
    solid: "bg-sec-teachers", rule: "bg-sec-teachers",
    navIcon: "text-sky-300",
  },
  academic: {
    key: "academic", labelKey: "navGroup.academics", label: "Academics",
    text: "text-sec-academic", bg: "bg-sec-academic-soft", border: "border-sec-academic-line",
    solid: "bg-sec-academic", rule: "bg-sec-academic",
    navIcon: "text-violet-300",
  },
  attendance: {
    key: "attendance", labelKey: "navGroup.academics", label: "Academics",
    text: "text-sec-attendance", bg: "bg-sec-attendance-soft", border: "border-sec-attendance-line",
    solid: "bg-sec-attendance", rule: "bg-sec-attendance",
    navIcon: "text-emerald-300",
  },
  exams: {
    key: "exams", labelKey: "navGroup.academics", label: "Academics",
    text: "text-sec-exams", bg: "bg-sec-exams-soft", border: "border-sec-exams-line",
    solid: "bg-sec-exams", rule: "bg-sec-exams",
    navIcon: "text-indigo-300",
  },
  finance: {
    key: "finance", labelKey: "navGroup.money", label: "Money",
    text: "text-sec-finance", bg: "bg-sec-finance-soft", border: "border-sec-finance-line",
    solid: "bg-sec-finance", rule: "bg-sec-finance",
    navIcon: "text-amber-300",
  },
  reports: {
    key: "reports", labelKey: "navGroup.documents", label: "Documents",
    text: "text-sec-reports", bg: "bg-sec-reports-soft", border: "border-sec-reports-line",
    solid: "bg-sec-reports", rule: "bg-sec-reports",
    navIcon: "text-rose-300",
  },
  comms: {
    key: "comms", labelKey: "navGroup.communication", label: "Communication",
    text: "text-sec-comms", bg: "bg-sec-comms-soft", border: "border-sec-comms-line",
    solid: "bg-sec-comms", rule: "bg-sec-comms",
    navIcon: "text-fuchsia-300",
  },
  settings: {
    key: "settings", labelKey: "navGroup.administration", label: "Administration",
    text: "text-sec-settings", bg: "bg-sec-settings-soft", border: "border-sec-settings-line",
    solid: "bg-sec-settings", rule: "bg-sec-settings",
    navIcon: "text-slate-300",
  },
};

/**
 * Path prefix → section, longest prefix first.
 *
 * Order matters and the sort below enforces it rather than trusting this list
 * to stay written in the right order: /exams/results must resolve before
 * /exams, and /messages/audit before /messages.
 */
const ROUTE_SECTIONS: Array<[string, SectionKey]> = [
  ["/dashboard",      "overview"],
  ["/watchlist",      "overview"],
  ["/approvals",      "overview"],

  ["/students",       "students"],
  ["/teachers",       "teachers"],

  ["/classes",        "academic"],
  ["/subjects",       "academic"],
  ["/timetable",      "academic"],
  ["/periods",        "academic"],
  ["/attendance",     "attendance"],
  ["/exams",          "exams"],
  ["/promotion",      "exams"],

  ["/fees",           "finance"],
  ["/finance",        "finance"],

  ["/documents",      "reports"],
  ["/exports",        "reports"],
  ["/reports",        "reports"],

  ["/announcements",  "comms"],
  ["/messages",       "comms"],

  ["/portal-codes",   "settings"],
  ["/settings",       "settings"],
].sort((a, b) => b[0].length - a[0].length) as Array<[string, SectionKey]>;

/** The section a path belongs to. Overview is the fallback, never a blank. */
export function sectionForPath(pathname: string): Section {
  const hit = ROUTE_SECTIONS.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  return SECTIONS[hit ? hit[1] : "overview"];
}

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
