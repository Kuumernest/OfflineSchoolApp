// web/src/components/platform/MetricTile.tsx
//
// One figure, in a tinted tile: a coloured icon well, a label beside it, the
// figure underneath and, when there is one, a line of context. The platform
// pages show the same dozen figures for every school, so they share one tile
// rather than each page composing its own.
//
// Two rules keep a grid of these from overflowing, which is the reason the
// component exists:
//
//   1. The tile never clips. A figure such as "FCFA 10,065,000" is set at a
//      size chosen from its length, and is allowed to wrap onto a second line
//      when the column is narrower still. The old tiles drew the figure at a
//      fixed 32px inside overflow-hidden, so a long amount was simply cut.
//   2. The label and the hint truncate with a title attribute, so a long
//      French label costs one line, not a taller row.
//
// The hue says what family a figure belongs to — people, attendance, results,
// money — and is the same hue the section rail and page headers use for that
// family (config/sections.ts), so the tiles agree with the rest of the shell.
import { Link }               from "react-router-dom";
import { Info, type LucideIcon } from "lucide-react";
import { cn }                 from "@/utils/cn";

export type TileTone =
  | "schools" | "students" | "teachers" | "attendance"
  | "academic" | "exams" | "finance" | "reports" | "neutral";

// Whole class strings, never composed: Tailwind only emits what it can read.
const TONES: Record<TileTone, { surface: string; well: string }> = {
  schools:    { surface: "border-primary-200 from-surface to-primary-50",
                well:    "bg-primary-100 text-primary-700" },
  students:   { surface: "border-sec-students-line from-surface to-sec-students-soft",
                well:    "bg-sec-students-soft text-sec-students" },
  teachers:   { surface: "border-sec-teachers-line from-surface to-sec-teachers-soft",
                well:    "bg-sec-teachers-soft text-sec-teachers" },
  attendance: { surface: "border-sec-attendance-line from-surface to-sec-attendance-soft",
                well:    "bg-sec-attendance-soft text-sec-attendance" },
  academic:   { surface: "border-sec-academic-line from-surface to-sec-academic-soft",
                well:    "bg-sec-academic-soft text-sec-academic" },
  exams:      { surface: "border-sec-exams-line from-surface to-sec-exams-soft",
                well:    "bg-sec-exams-soft text-sec-exams" },
  finance:    { surface: "border-sec-finance-line from-surface to-sec-finance-soft",
                well:    "bg-sec-finance-soft text-sec-finance" },
  reports:    { surface: "border-sec-reports-line from-surface to-sec-reports-soft",
                well:    "bg-sec-reports-soft text-sec-reports" },
  neutral:    { surface: "border-line from-surface to-[#fcfcfe]",
                well:    "bg-canvas text-ink-muted ring-1 ring-inset ring-line" },
};

// The size follows the length: "70" can be large, "FCFA 10,065,000" cannot be
// the same size in the same box. Chosen from the text, so it is the same on
// every render and the grid does not jump.
const sizeFor = (value: string) =>
  value.length <= 6  ? "text-[28px]" :
  value.length <= 10 ? "text-[24px]" :
  value.length <= 14 ? "text-[20px]" :
                       "text-[18px]";

interface MetricTileProps {
  label:    string;
  /** Already formatted — the tile does not know what it is showing. */
  value:    string;
  /** One short line under the figure: a breakdown, a count, a comparison. */
  hint?:    string;
  icon:     LucideIcon;
  tone?:    TileTone;
  href?:    string;
  loading?: boolean;
  className?: string;
}

export function MetricTile({
  label, value, hint, icon: Icon, tone = "neutral", href, loading = false, className,
}: MetricTileProps) {
  const t = TONES[tone];
  // Intl puts a no-break space between a currency code and its digits, which
  // makes "FCFA 17,308,000" one unbreakable word. As an ordinary space the
  // amount can drop its currency to the line above when the column is narrow
  // and keep every digit together; the number itself is never split.
  const text = value.replace(/[\u00A0\u202F]/g, " ");
  const body = (
    <div className="flex min-w-0 items-start gap-3.5">
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
          t.well,
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink-muted" title={label}>{label}</p>
        {loading ? (
          <div className="mt-2 h-7 w-20 animate-pulse rounded-control bg-line/70" aria-hidden="true" />
        ) : (
          <p
            className={cn(
              // break-normal: an amount wraps at the space after its currency,
              // never inside its digits. Only on a phone, where two tiles
              // share 360px, may a figure break anywhere rather than spill.
              "mt-0.5 break-normal max-sm:[overflow-wrap:anywhere] font-semibold leading-tight tracking-tight text-ink tabular",
              sizeFor(text),
            )}
          >
            {text}
          </p>
        )}
        {hint ? (
          <p className="mt-1 truncate text-xs text-ink-faint" title={hint}>{hint}</p>
        ) : null}
      </div>
    </div>
  );

  const shell = cn(
    "block min-w-0 rounded-card border bg-gradient-to-br p-4 shadow-card",
    "transition duration-150 ease-[var(--ease-out-quiet)]",
    t.surface,
    href && "hover:-translate-y-px hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
    className,
  );

  return href
    ? <Link to={href} className={shell} aria-label={`${label}: ${text}`}>{body}</Link>
    : <div className={shell}>{body}</div>;
}

/**
 * The grid the tiles sit in. One across on a phone narrower than 420px (two
 * across left each figure 90px, and an amount broke inside its digits), two
 * from there, three from a tablet up,
 * four once the content column passes about a thousand pixels, six on a wide
 * monitor. Four across at 1024px beside the sidebar left each tile 85px for
 * its figure, and FCFA amounts broke across three lines; three across is the
 * narrowest that keeps a ten-digit amount on one.
 */
export function MetricGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6", className)}>
      {children}
    </div>
  );
}

/**
 * The line of small print under a grid: how a figure was counted, what a
 * filter does and does not apply to. A paragraph that wraps, in a quiet
 * tinted bar — the previous footer was three sentences in one flex row that
 * ran past the right edge of the page.
 */
export function MetricNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn(
      "flex items-start gap-2.5 rounded-card border border-info-line bg-info-soft/60 px-4 py-3 text-xs leading-relaxed text-ink-muted",
      className,
    )}>
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
