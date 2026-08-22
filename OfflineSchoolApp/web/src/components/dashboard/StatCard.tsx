// web/src/components/dashboard/StatCard.tsx
import { useNavigate }             from "react-router-dom";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn }                      from "@/utils/cn";

interface StatCardProps {
  title:          string;
  value:          string | number;
  subtitle?:      string;
  /** Tailwind text-colour class. Use it only to flag a value needing action. */
  subtitleColor?: string;
  icon:           LucideIcon;
  /** @deprecated Kept for call-site compatibility; the icon is neutral now. */
  iconColor?:     string;
  /** @deprecated Kept for call-site compatibility; the icon is neutral now. */
  iconBg?:        string;
  href?:          string;
  loading?:       boolean;
}

/**
 * One metric.
 *
 * What makes a tile look expensive is not decoration — it is that every
 * element does a different job at a different weight: a recessed icon well, a
 * small-caps label, the figure in the display serif, a subtitle that stays out
 * of the way. Four ranks inside one small box, and nothing competing.
 *
 * `iconColor` and `iconBg` are still accepted so the exam and report pages keep
 * compiling, but they are ignored: six tiles in six unrelated hues implied a
 * colour code that meant nothing. Colour appears here only via `subtitleColor`,
 * and only when something needs attention.
 */
export default function StatCard({
  title,
  value,
  subtitle,
  subtitleColor,
  icon: Icon,
  href,
  loading = false,
}: StatCardProps) {
  const navigate    = useNavigate();
  const interactive = Boolean(href);

  const go = () => { if (href) navigate(href); };

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? go : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
            }
          : undefined
      }
      className={cn(
        "group relative overflow-hidden rounded-card border border-line p-4 shadow-card",
        // A gradient of barely two percent. You do not read it as a gradient —
        // you read a surface lit from above instead of a flat fill.
        "bg-gradient-to-b from-surface to-[#fcfcfe]",
        "transition duration-150 ease-[var(--ease-out-quiet)]",
        interactive &&
          "cursor-pointer hover:-translate-y-px hover:border-line-strong hover:shadow-lift"
      )}
    >
      {/*
        A hairline of accent along the top edge, drawn only on hover. The tile
        acknowledges the cursor without moving any colour underneath the
        content, which is what keeps a grid of six from flickering as you
        sweep across it.
      */}
      {interactive && (
        <span
          className="absolute inset-x-0 top-0 h-px origin-left scale-x-0 bg-primary-600 opacity-0 transition duration-200 ease-[var(--ease-out-quiet)] group-hover:scale-x-100 group-hover:opacity-100"
          aria-hidden="true"
        />
      )}

      <div className="flex items-start justify-between gap-2">
        {/* A recessed well, not a coloured chip: the icon labels the tile, it
            is not the subject of it. */}
        <span className="flex h-8 w-8 items-center justify-center rounded-control bg-canvas text-ink-muted ring-1 ring-inset ring-line transition-colors group-hover:text-ink-body">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>

        {interactive && (
          <ArrowUpRight
            className="h-3.5 w-3.5 shrink-0 -translate-x-0.5 translate-y-0.5 text-ink-faint opacity-0 transition duration-200 ease-[var(--ease-out-quiet)] group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>

      <p className="mt-3 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {title}
      </p>

      {loading ? (
        <div className="mt-1.5 h-8 w-16 animate-pulse rounded-control bg-canvas" />
      ) : (
        <p className="mt-1 font-display text-[32px] leading-none text-ink tabular">
          {value}
        </p>
      )}

      {subtitle && (
        <p className={cn("mt-1.5 truncate text-xs", subtitleColor ?? "text-ink-faint")}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
