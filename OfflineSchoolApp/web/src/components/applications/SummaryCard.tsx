// web/src/components/applications/SummaryCard.tsx

import React from "react";

interface SummaryCardProps {
  bg:        string;
  icon:      React.ReactNode;
  iconColor: string;
  value:     number;
  label:     string;
}

export const SummaryCard: React.FC<SummaryCardProps> = ({
  bg,
  icon,
  value,
  label,
}) => (
  <div
    className="flex flex-1 flex-col items-center justify-center
               rounded-2xl py-4 px-2 gap-1 min-w-[96px]"
    style={{ backgroundColor: bg }}
  >
    {icon}
    <span className="text-xl font-bold text-gray-900">{value}</span>
    <span className="text-[11px] font-semibold text-gray-500 text-center leading-tight">
      {label}
    </span>
  </div>
);