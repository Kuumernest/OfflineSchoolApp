// web/src/components/ui/DataTable.tsx
import { cn } from "@/utils/cn";

// ── Table root ───────────────────────────────────────────
export function Table({
  children,
  className,
}: {
  children:   React.ReactNode;
  className?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-sm", className)}>
        {children}
      </table>
    </div>
  );
}

// ── Head ─────────────────────────────────────────────────
export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="bg-gray-50 border-b border-gray-200">
      {children}
    </thead>
  );
}

// ── Header cell ──────────────────────────────────────────
export function Th({
  children,
  className,
}: {
  children?:  React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider",
        className
      )}
    >
      {children}
    </th>
  );
}

// ── Body ─────────────────────────────────────────────────
export function TBody({ children }: { children: React.ReactNode }) {
  return (
    <tbody className="divide-y divide-gray-100">{children}</tbody>
  );
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
  return (
    <tr
      onClick={onClick}
      className={cn(
        "hover:bg-gray-50 transition-colors",
        onClick && "cursor-pointer",
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
}: {
  children?:  React.ReactNode;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "px-4 py-3 text-gray-700 whitespace-nowrap",
        className
      )}
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
    <div className="flex flex-col items-center justify-center py-16">
      {icon && <div className="mb-3">{icon}</div>}
      <p className="text-gray-600 font-medium">{title}</p>
      {subtitle && (
        <p className="text-gray-400 text-sm mt-1">{subtitle}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}