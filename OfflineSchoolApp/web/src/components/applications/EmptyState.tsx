// web/src/components/applications/EmptyState.tsx

import React from "react";

import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { DASH_TINT } from "@/config/dashboardTint";

export const EmptyState: React.FC = () => {
  const { t } = useTranslation();

  return (
  <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
    <span className={cn("flex h-20 w-20 items-center justify-center rounded-card", DASH_TINT.green.box)}>
      <svg
        className="w-12 h-12"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </span>
    <h3 className="text-base font-semibold text-gray-700 mt-4">
      {t("applications.allCaughtUp")}
    </h3>
    <p className="text-sm text-gray-400 mt-1 leading-relaxed max-w-xs">
      {t("applications.noPendingBody")}
    </p>
  </div>
);
};
