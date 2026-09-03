// web/src/components/ui/PageHeader.tsx
import { useLocation } from "react-router-dom";
import { cn }              from "@/utils/cn";
import { sectionForPath }  from "@/config/sections";

/**
 * The title block every page opens with.
 *
 * Pages used to each invent their own heading — different sizes, different
 * gaps, actions sometimes left and sometimes right — which is most of why
 * moving between screens felt like moving between applications. One component
 * makes that consistent by construction rather than by everyone remembering.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title:        string;
  /** One line on what this screen is for. Omit it rather than pad it. */
  description?: string;
  /** Buttons, right-aligned. At most one of them filled. */
  actions?:     React.ReactNode;
  /** Small status line under the title — counts, last-updated, filters. */
  meta?:        React.ReactNode;
  className?:   string;
}) {
  /*
   * The colour comes from the route, not from a prop.
   *
   * Forty-one pages render this and none of them should have to know what
   * colour they are — and a page added tomorrow gets the right one without
   * anybody remembering. See config/sections.ts for why a section has a hue
   * at all.
   */
  const section = sectionForPath(useLocation().pathname);

  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      <div className="flex min-w-0 gap-3.5">
        {/* The one element on the page that carries the section's colour. A
            rule rather than a block: it marks the title without competing
            with it. */}
        <span
          aria-hidden="true"
          className={cn("mt-1 w-1 shrink-0 self-stretch rounded-full", section.rule)}
        />
        <div className="min-w-0">
          <h1 className="font-display text-[28px] leading-[1.15] text-ink">
            {title}
          </h1>
          {description && (
            <p className="mt-1.5 text-sm text-ink-body">{description}</p>
          )}
          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              {meta}
            </div>
          )}
        </div>
      </div>

      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Section heading for grouping panels within a page — one step quieter than
 * PageHeader, one step louder than CardHeader.
 */
export function SectionHeading({
  title,
  action,
  className,
}: {
  title:      string;
  action?:    React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      {/* Was 11px in the faintest ink the palette has — a label nobody could
          read, on the element whose whole job is to say what a block of the
          page is. */}
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
        {title}
      </h2>
      {action}
    </div>
  );
}
