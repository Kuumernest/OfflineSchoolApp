// web/src/components/ui/Card.tsx
import { cn }             from "@/utils/cn";
import type { LucideIcon } from "lucide-react";
import { DASH_TINT, type DashAccent } from "@/config/dashboardTint";

interface CardProps {
  className?: string;
  children:   React.ReactNode;
  /** Set false to manage padding yourself — tables and lists usually do. */
  padding?:   boolean;
}

/**
 * The one container in the app.
 *
 * A hairline border does the separating, not a shadow. `shadow-card` is barely
 * there on purpose: in a dense console a page of drop-shadowed panels reads as
 * clutter, and once every card floats, nothing does.
 */
export function Card({
  className,
  children,
  padding = true,
}: CardProps) {
  return (
    <div
      className={cn(
        // White, one hairline border, a faint neutral shadow.
        // min-w-0: as a grid or flex item a card must be allowed to shrink below
        // its content. Without it a table inside the card sets the column's
        // minimum width, and on a phone the whole page grows to fit the table.
        "min-w-0 rounded-card border border-line shadow-card",
        "bg-surface",
        padding && "p-5",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * Card title row.
 *
 * The title is `text-sm font-semibold`, not `text-base`. Panel titles are
 * labels for the content under them, not headings competing with the page
 * title — the size difference is what makes the hierarchy legible.
 */
export function CardHeader({
  title,
  subtitle,
  action,
  icon: Icon,
  accent = "blue",
  className,
}: {
  title:      string;
  subtitle?:  string;
  action?:    React.ReactNode;
  /** A small solid icon square in front of the title, in `accent`'s colour. */
  icon?:      LucideIcon;
  /** The square's colour (config/dashboardTint.ts); blue by default. */
  accent?:    DashAccent;
  className?: string;
}) {
  return (
    // flex-wrap: an action beside a long title (longer still in French) drops
    // under it on a narrow card instead of squeezing the title to nothing.
    <div className={cn("mb-4 flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {/* A 2px accent stub against the title. One small deliberate mark per
            panel is what separates a designed header from a bold paragraph —
            and it costs nothing in space. */}
        {Icon ? (
          <span
            className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT[accent].box)}
            aria-hidden="true"
          >
            <Icon className="h-4 w-4" />
          </span>
        ) : (
          <span
            className={cn(
              "mt-[3px] h-4 w-[3px] shrink-0 rounded-full",
              accent === "blue" ? "bg-primary-600" : DASH_TINT[accent].box,
            )}
            aria-hidden="true"
          />
        )}
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink" title={title}>{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Full-bleed divider inside a padded card — pulls back through the padding so
 * the rule spans the card edge to edge instead of floating inside it.
 */
export function CardDivider({ className }: { className?: string }) {
  return <div className={cn("-mx-5 my-4 border-t border-line", className)} />;
}
