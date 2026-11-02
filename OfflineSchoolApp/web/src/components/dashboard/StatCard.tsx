// web/src/components/dashboard/StatCard.tsx
import { useNavigate }             from "react-router-dom";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn }                      from "@/utils/cn";
import { CARD_SHELL, SEMANTIC, iconBox, type Semantic, type TileTone } from "@/config/sections";

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
}: StatCardProps) {
  const navigate    = useNavigate();
  const interactive = Boolean(href);
  const sem         = semantic ? SEMANTIC[semantic] : null;
  const box         = sem ? sem.box : iconBox(tone);

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
        sem ? sem.card : CARD_SHELL,
        "transition duration-150 ease-[var(--ease-out-quiet)]",
        interactive && "cursor-pointer hover:border-line-strong hover:shadow-lift"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-control", box)}>
          <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>

        {interactive && (
          <ArrowUpRight
            className="h-4 w-4 shrink-0 text-ink-faint -translate-x-0.5 translate-y-0.5 opacity-0 transition duration-200 ease-[var(--ease-out-quiet)] group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
          />
        )}
      </div>

      {loading ? (
        <div className="mt-4 h-9 w-16 animate-pulse rounded-control bg-canvas" />
      ) : (
        <p className={cn("mt-4 text-[34px] font-bold leading-none tracking-tight tabular", sem ? sem.text : "text-ink")}>
          {value}
        </p>
      )}

      <p className={cn("mt-2 truncate text-sm font-medium", sem ? sem.text : "text-ink-muted")}>
        {title}
      </p>

      {subtitle && (
        <p className={cn("mt-1 truncate text-xs", subtitleColor ?? (sem ? sem.text : "text-ink-faint"))}>
          {subtitle}
        </p>
      )}
    </div>
  );
}
