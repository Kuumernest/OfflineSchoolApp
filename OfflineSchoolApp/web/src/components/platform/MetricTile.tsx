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
// The tile is a white card; only its icon box is tinted, by the kind of
// figure (config/sections.ts) — students blue, money teal, and so on. With
// `tinted` (the platform dashboard only) it takes the dashboards' look from
// config/dashboardTint.ts instead: a wash, a top edge, a solid icon square and
// a deeper figure, the schools count indigo.
import { Link }               from "react-router-dom";
import { Info, type LucideIcon } from "lucide-react";
import { cn }                 from "@/utils/cn";
import { CARD_SHELL, iconBox, type TileTone as KindTone } from "@/config/sections";
import { DASH_ACCENT, DASH_TINT, type DashTint } from "@/config/dashboardTint";

/** A kind, or `schools` for the platform's own count of schools. */
export type TileTone = KindTone | "schools";

// The platform's school count belongs to no kind inside a school, so it takes
// the neutral slate box.
const boxFor = (tone: TileTone) => iconBox(tone === "schools" ? "neutral" : tone);

// On a tinted dashboard nothing is grey: the schools count is indigo.
const tintFor = (tone: TileTone): DashTint =>
  DASH_TINT[tone === "schools" ? "indigo" : DASH_ACCENT[tone]];

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
  /** The dashboards' tinted look (config/dashboardTint.ts). Off by default. */
  tinted?:  boolean;
}

export function MetricTile({
  label, value, hint, icon: Icon, tone = "neutral", href, loading = false, className, tinted = false,
}: MetricTileProps) {
  const tint = tinted ? tintFor(tone) : null;
  // Intl puts a no-break space between a currency code and its digits, which
  // makes "FCFA 17,308,000" one unbreakable word. As an ordinary space the
  // amount can drop its currency to the line above when the column is narrow
  // and keep every digit together; the number itself is never split.
  const text = value.replace(/[\u00A0\u202F]/g, " ");
  const body = (
    <div className="flex min-w-0 items-start gap-3.5">
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-control",
          tint ? tint.box : boxFor(tone),
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink-muted" title={label}>{label}</p>
        {loading ? (
          <div className="mt-2 h-7 w-20 animate-pulse rounded-control bg-canvas" aria-hidden="true" />
        ) : (
          <p
            className={cn(
              // break-normal: an amount wraps at the space after its currency,
              // never inside its digits. Only on a phone, where two tiles
              // share 360px, may a figure break anywhere rather than spill.
              "mt-0.5 break-normal max-sm:[overflow-wrap:anywhere] font-bold leading-tight tracking-tight tabular",
              tint ? tint.number : "text-ink",
              sizeFor(text),
            )}
          >
            {text}
          </p>
        )}
        {hint ? (
          <p className={cn("mt-1 truncate text-xs", tint ? "text-ink-muted" : "text-ink-faint")} title={hint}>{hint}</p>
        ) : null}
      </div>
    </div>
  );

  const shell = cn(
    "block min-w-0 p-5",
    tint ? tint.card : CARD_SHELL,
    "transition duration-150 ease-[var(--ease-out-quiet)]",
    href && (tint ? "hover:shadow-lift" : "hover:border-line-strong hover:shadow-lift"),
    href && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2",
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
      "flex items-start gap-2.5 rounded-card border border-info-line bg-info-soft/60 px-4 py-3 text-xs leading-relaxed text-info-text",
      className,
    )}>
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-info-text" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
