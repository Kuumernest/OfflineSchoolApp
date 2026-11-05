// web/src/components/dashboard/StatCard.tsx
import { useNavigate }             from "react-router-dom";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn }                      from "@/utils/cn";
import { CARD_SHELL, SEMANTIC, iconBox, type Semantic, type TileTone } from "@/config/sections";
import { dashTint }                from "@/config/dashboardTint";

interface StatCardProps {
  title:          string;
  value:          string | number;
  subtitle?:      string;
  /**
   * Tailwind classes for the subtitle, to flag a value needing action — e.g.
   * "rounded-control bg-warning-soft px-1.5 text-warning-text".
   */
  subtitleColor?: string;
  icon:           LucideIcon;
  /**
   * What the figure counts — students, finance, exams… Picks the icon box's
   * accent (config/sections.ts). The card itself is always white.
   */
  tone?:          TileTone;
  /**
   * Set only when the value means something (a backlog, a fault). The card
   * then takes that status's light tint instead of white.
   */
  semantic?:      Semantic;
  /** @deprecated Kept for call-site compatibility; colour comes from `tone`. */
  iconColor?:     string;
  /** @deprecated Kept for call-site compatibility; colour comes from `tone`. */
  iconBg?:        string;
  href?:          string;
  loading?:       boolean;
  /**
   * The school dashboard's look (config/dashboardTint.ts): a soft wash of the
   * kind's colour, a 3px top edge, a solid icon square and the figure in a
   * deeper shade. Off everywhere else. A `semantic` tint still wins.
   */
  tinted?:        boolean;
}

/**
 * One metric on a white card. Colour lives only on the icon box, and says
 * what the card counts; the figure is ink and the label secondary text. A
 * status tint (`semantic`) is for values that mean something, never for
 * decoration.
 */
export default function StatCard({
  title,
  value,
  subtitle,
  subtitleColor,
  icon: Icon,
  tone = "neutral",
  semantic,
  href,
  loading = false,
  tinted = false,
}: StatCardProps) {
  const navigate    = useNavigate();
  const interactive = Boolean(href);
  const sem         = semantic ? SEMANTIC[semantic] : null;
  const tint        = !sem && tinted ? dashTint(tone) : null;
  const box         = sem ? sem.box : tint ? tint.box : iconBox(tone);

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
        "group relative overflow-hidden p-5",
        sem ? sem.card : tint ? tint.card : CARD_SHELL,
        "transition duration-150 ease-[var(--ease-out-quiet)]",
        // A tinted card keeps its coloured top edge on hover.
        interactive && (tint ? "cursor-pointer hover:shadow-lift" : "cursor-pointer hover:border-line-strong hover:shadow-lift")
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-control", box)}>
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>

        {interactive && (
          <ArrowUpRight
            className={cn("h-4 w-4 shrink-0 -translate-x-0.5 translate-y-0.5 opacity-0 transition duration-200 ease-[var(--ease-out-quiet)] group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100", tint ? tint.glyph : "text-ink-faint")}
            aria-hidden="true"
          />
        )}
      </div>

      {loading ? (
        <div className="mt-4 h-9 w-16 animate-pulse rounded-control bg-canvas" />
      ) : (
        <p className={cn("mt-4 text-[34px] font-bold leading-none tracking-tight tabular", sem ? sem.text : tint ? tint.number : "text-ink")}>
          {value}
        </p>
      )}

      <p className={cn("mt-2 truncate text-sm font-medium", sem ? sem.text : "text-ink-muted")}>
        {title}
      </p>

      {/* ink-faint is under AA on a wash, so a tinted card's subtitle is ink-muted. */}
      {subtitle && (
        <p className={cn("mt-1 truncate text-xs", subtitleColor ?? (sem ? sem.text : tint ? "text-ink-muted" : "text-ink-faint"))}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
