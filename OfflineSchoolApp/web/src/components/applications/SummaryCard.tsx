// web/src/components/applications/SummaryCard.tsx

import React from "react";
import { cn } from "@/utils/cn";
import { DASH_TINT, type DashAccent } from "@/config/dashboardTint";

interface SummaryCardProps {
  /** The card's colour (config/dashboardTint.ts). */
  accent:    DashAccent;
  /** A count that is bad news: amber (warning) or red (error) border and figure. */
  status?:   "warning" | "error" | null;
  /** The icon, drawn in currentColor: it sits white on the solid square. */
  icon:      React.ReactNode;
  value:     number;
  label:     string;
}

export const SummaryCard: React.FC<SummaryCardProps> = ({
  accent,
  status,
  icon,
  value,
  label,
}) => {
  const tint = DASH_TINT[accent];
  const card =
    status === "warning" ? tint.warnCard :
    status === "error"   ? tint.errorCard :
    tint.card;
  const figure =
    status === "warning" ? "text-warning-text" :
    status === "error"   ? "text-danger-text" :
    tint.number;
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center py-4 px-2 gap-1 min-w-[96px]",
        card
      )}
    >
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-control", tint.box)}>
        {icon}
      </span>
      <span className={cn("text-xl font-bold", figure)}>{value}</span>
      <span className="text-[11px] font-semibold text-ink-muted text-center leading-tight">
        {label}
      </span>
    </div>
  );
};
