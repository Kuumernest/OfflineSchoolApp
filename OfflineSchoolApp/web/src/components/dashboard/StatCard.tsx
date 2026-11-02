// web/src/components/dashboard/StatCard.tsx
import { useNavigate }             from "react-router-dom";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn }                      from "@/utils/cn";
import { TILE_TONE, type TileTone } from "@/config/sections";

interface StatCardProps {
  title:          string;
  value:          string | number;
  subtitle?:      string;
  /**
   * Tailwind classes for the subtitle, to flag a value needing action. On a
   * coloured tile a status colour would sit on the fill and fail contrast, so
   * pass a pill instead — e.g. "rounded-control bg-warning-soft px-1.5 text-warning".
   */
  subtitleColor?: string;
  icon:           LucideIcon;
  /**
   * What the figure is about, by section — students, finance, exams… The tile
   * fills with that section's colour (config/sections.ts). Omit for a white,
   * neutral tile.
   */
  tone?:          TileTone;
  /** @deprecated Kept for call-site compatibility; colour comes from `tone`. */
  iconColor?:     string;
  /** @deprecated Kept for call-site compatibility; colour comes from `tone`. */
  iconBg?:        string;
  href?:          string;
  loading?:       boolean;
}

/**
 * One metric, as a solid tile in the colour of what it counts.
 *
 * The rule: colour says what the tile is ABOUT, and it is fixed per section —
 * a pupil count is teal, money is mustard, exams burnt orange, attendance
 * olive — on every dashboard, every page and on the mobile app. Someone who
 * has seen the fees tile twice finds it again by colour before reading it. It
 * never says whether a value is good or bad; that stays with the status
 * colours, and only in the subtitle.
 *
 * Inside the tile: a small icon chip, a big bold figure, a smaller label. Text
 * is the section's `-on` colour at full strength (cream on the dark fills,
 * warm ink on mustard and burnt orange) — never faded with opacity, which is
 * what would drop it under 4.5:1.
 *
 * `iconColor` and `iconBg` are still accepted so older call sites compile, but
 * they are ignored.
 */
export default function StatCard({
  title,
  value,
  subtitle,
  subtitleColor,
  icon: Icon,
  tone = "neutral",
  href,
  loading = false,
}: StatCardProps) {
  const navigate    = useNavigate();
  const interactive = Boolean(href);
  const t           = TILE_TONE[tone];

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
        "group relative overflow-hidden rounded-tile p-5 shadow-tile",
        t.fill,
        "transition duration-150 ease-[var(--ease-out-quiet)]",
        interactive && "cursor-pointer hover:-translate-y-0.5 hover:shadow-tile-lift"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-control", t.well)}>
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>

        {interactive && (
          <ArrowUpRight
            className="h-4 w-4 shrink-0 -translate-x-0.5 translate-y-0.5 opacity-0 transition duration-200 ease-[var(--ease-out-quiet)] group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>

      {loading ? (
        <div className={cn("mt-4 h-9 w-16 animate-pulse rounded-control", t.well)} />
      ) : (
        <p className="mt-4 text-[34px] font-bold leading-none tracking-tight tabular">
          {value}
        </p>
      )}

      <p className="mt-2 truncate text-sm font-medium">
        {title}
      </p>

      {subtitle && (
        <p className={cn("mt-1 truncate text-xs", subtitleColor)}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
