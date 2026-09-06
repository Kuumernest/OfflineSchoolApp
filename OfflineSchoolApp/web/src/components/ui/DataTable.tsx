// web/src/components/ui/DataTable.tsx
import { cn } from "@/utils/cn";

/**
 * Table parts, tuned for scanning rather than reading.
 *
 * Rows are 44px, not 56px: an admin comparing twenty students wants twenty on
 * screen. Density comes from the row height and a hairline divider — never
 * from shrinking the text below 14px, which just makes it hard to read.
 */

// ── Table root ───────────────────────────────────────────
export function Table({
  children,
  className,
}: {
  children:   React.ReactNode;
  className?: string;
}) {
  return (
    // The scroll container is the table's own, so a wide table scrolls inside
    // its card instead of pushing the whole page sideways.
    <div className="overflow-x-auto">
      <table
        className={cn(
          "w-full text-sm border-separate border-spacing-0",
          className
        )}
      >
        {children}
      </table>
    </div>
  );
}

// ── Head ─────────────────────────────────────────────────
export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="bg-gray-50">{children}</thead>;
}

// ── Header cell ──────────────────────────────────────────
export function Th({
  children,
  className,
  numeric = false,
}: {
  children?:  React.ReactNode;
  className?: string;
  /** Right-align, for columns of figures. */
  numeric?:   boolean;
}) {
  return (
    <th
      scope="col"
      className={cn(
        // Darker and a touch wider: a column heading is the label you read
        // to know what a column of numbers means, and it was set in the
        // second-faintest ink the palette has.
        "px-4 h-11 text-xs font-semibold uppercase tracking-[0.05em] text-ink-body",
        // Sentence case, not SCREAMING. Uppercase headers cost legibility and
        // buy nothing once the header row is already tinted and ruled.
        "border-b border-line",
        // sticky so the header survives a long scroll inside the card
        "sticky top-0 z-10 bg-gray-50",
        numeric ? "text-right" : "text-left",
        className
      )}
    >
      {children}
    </th>
  );
}

// ── Body ─────────────────────────────────────────────────
export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>;
}

// ── Row ──────────────────────────────────────────────────
export function Tr({
  children,
  onClick,
  className,
}: {
  children:   React.ReactNode;
  onClick?:   () => void;
  className?: string;
}) {
  const interactive = Boolean(onClick);

  return (
    <tr
      onClick={onClick}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? "button" : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        "group transition-colors",
        interactive && "cursor-pointer hover:bg-primary-50/50",
        !interactive && "hover:bg-surface-muted",
        className
      )}
    >
      {children}
    </tr>
  );
}

// ── Cell ─────────────────────────────────────────────────
export function Td({
  children,
  className,
  numeric = false,
  colSpan,
}: {
  children?:  React.ReactNode;
  className?: string;
  /** Right-align, for columns of figures. */
  numeric?:   boolean;
  /** For a row that spans the table — a group heading inside the body. */
  colSpan?:   number;
}) {
  return (
    <td
      className={cn(
        "px-4 h-12 text-ink-body whitespace-nowrap",
        // Border on the cell rather than divide-y on the body: with
        // border-separate that is what keeps the rule under the sticky header
        // from detaching when the body scrolls.
        "border-b border-line",
        numeric ? "text-right tabular" : "text-left",
        className
      )}
      colSpan={colSpan}
    >
      {children}
    </td>
  );
}

// ── Empty state ───────────────────────────────────────────
export function EmptyTable({
  icon,
  title,
  subtitle,
  action,
}: {
  icon?:     React.ReactNode;
  title:     string;
  subtitle?: string;
  action?:   React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-card bg-canvas text-ink-faint [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <p className="text-base font-semibold text-ink">{title}</p>
      {subtitle && (
        <p className="mt-1 max-w-sm text-sm text-ink-muted">{subtitle}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
