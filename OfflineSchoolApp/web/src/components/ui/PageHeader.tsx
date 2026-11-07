// web/src/components/ui/PageHeader.tsx
import { useLocation } from "react-router-dom";
import { cn }              from "@/utils/cn";
import { flowStepForPath } from "@/config/resultsFlow";
import { ResultsFlow }     from "./ResultsFlow";
import { pageIdentity }    from "@/config/pageIdentity";
import { DASH_TINT, type DashAccent } from "@/config/dashboardTint";
import type { LucideIcon } from "lucide-react";

/**
 * The title block every page opens with.
 *
 * Pages used to each invent their own heading — different sizes, different
 * gaps, actions sometimes left and sometimes right — which is most of why
 * moving between screens felt like moving between applications. One component
 * makes that consistent by construction rather than by everyone remembering.
 *
 * It opens with a solid icon square in the colour of what the page is about,
 * looked up from the route (config/pageIdentity.ts); a page can pass `icon`
 * and `accent` to say otherwise.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  icon,
  accent,
  className,
}: {
  title:        string;
  /** One line on what this screen is for. Omit it rather than pad it. */
  description?: string;
  /** Buttons, right-aligned. At most one of them filled. */
  actions?:     React.ReactNode;
  /** Small status line under the title — counts, last-updated, filters. */
  meta?:        React.ReactNode;
  /** The header square's icon; by default the route's (config/pageIdentity.ts). */
  icon?:        LucideIcon;
  /** The header square's colour; by default the route's. */
  accent?:      DashAccent;
  className?:   string;
}) {
  const { pathname } = useLocation();
  const identity = pageIdentity(pathname);
  const Icon     = icon ?? identity.icon;
  const tint     = DASH_TINT[accent ?? identity.accent];
  /*
   * Exam → results → report card is five actions across four screens, and
   * every screen used to be silent about the order. Shown here so a page in
   * that flow says where it sits without the page being edited, and a page
   * outside it shows nothing at all. See config/resultsFlow.ts.
   */
  const flowStep = flowStepForPath(pathname);

  return (
    <div className={cn("flex flex-col", className)}>
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
      )}
    >
      <div className="flex min-w-0 gap-3.5">
        {/* The page's icon square, in the colour of what the page is about. */}
        <span
          aria-hidden="true"
          className={cn("mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-control", tint.box)}
        >
          <Icon className="h-5 w-5" />
        </span>
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

    {flowStep !== null && <ResultsFlow current={flowStep} />}
    </div>
  );
}

/**
 * The page's icon square on its own, for a page that writes its own <h1>
 * rather than using PageHeader: put it beside the heading in a flex row.
 */
export function PageIcon({
  icon,
  accent,
  className,
}: {
  icon?:      LucideIcon;
  accent?:    DashAccent;
  className?: string;
}) {
  const { pathname } = useLocation();
  const identity = pageIdentity(pathname);
  const Icon     = icon ?? identity.icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-control",
        DASH_TINT[accent ?? identity.accent].box,
        className,
      )}
    >
      <Icon className="h-5 w-5" />
    </span>
  );
}

/**
 * Section heading for grouping panels within a page — one step quieter than
 * PageHeader, one step louder than CardHeader.
 */
export function SectionHeading({
  title,
  action,
  icon: Icon,
  accent = "blue",
  className,
}: {
  title:      string;
  action?:    React.ReactNode;
  /** A small solid icon square before the title. */
  icon?:      LucideIcon;
  accent?:    DashAccent;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      {/* Was 11px in the faintest ink the palette has — a label nobody could
          read, on the element whose whole job is to say what a block of the
          page is. */}
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
        {Icon && (
          <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-control", DASH_TINT[accent].box)} aria-hidden="true">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        {title}
      </h2>
      {action}
    </div>
  );
}
