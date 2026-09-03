// web/src/components/ui/Card.tsx
import { useLocation } from "react-router-dom";
import { cn }             from "@/utils/cn";
import { sectionForPath } from "@/config/sections";

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
        // shadow-card carries a 1px inset top highlight as well as the drop
        // shadow — see the token in index.css. The two-percent gradient reads
        // as a surface lit from above rather than a flat fill; it is the same
        // treatment the dashboard tiles use, so panels and tiles look cut from
        // one material instead of merely sharing a border colour.
        "rounded-card border border-line shadow-card",
        "bg-gradient-to-b from-surface to-[#fcfcfe]",
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
  className,
}: {
  title:      string;
  subtitle?:  string;
  action?:    React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex items-start justify-between gap-4", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {/* A 2px accent stub against the title. One small deliberate mark per
            panel is what separates a designed header from a bold paragraph —
            and it costs nothing in space. */}
        <span
          className={cn(
            "mt-[3px] h-4 w-[3px] shrink-0 rounded-full",
            // The section's hue rather than the accent, so every panel on a
            // page agrees with the rule beside its title and with the icon in
            // the rail. See config/sections.ts.
            sectionForPath(useLocation().pathname).rule
          )}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{title}</h3>
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
