// web/src/components/applications/DetailRow.tsx

import React from "react";

interface DetailRowProps {
  icon:   React.ReactNode;
  label:  string;
  value:  string | null | undefined;
}

export const DetailRow: React.FC<DetailRowProps> = ({
  icon,
  label,
  value,
}) => (
  <div className="flex items-start gap-3 mb-4 last:mb-0">
    <span className="flex-shrink-0 mt-0.5">{icon}</span>
    <div className="flex-1 min-w-0">
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
        {label}
      </p>
      <p className="text-sm font-semibold text-gray-900 mt-0.5 break-words">
        {value || "Not provided"}
      </p>
    </div>
  </div>
);