// web/src/components/ui/PageHeader.tsx
import { cn } from "@/utils/cn";

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
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="font-display text-[26px] leading-[1.15] text-ink">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        )}
        {meta && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
            {meta}
          </div>
        )}
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
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-faint">
        {title}
      </h2>
      {action}
    </div>
  );
}
