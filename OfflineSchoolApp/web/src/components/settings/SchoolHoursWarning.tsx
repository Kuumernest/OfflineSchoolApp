// web/src/components/settings/SchoolHoursWarning.tsx
//
// Shown on Settings and on Periods when the school's hours and its period grid
// disagree (B2). Each is the school's own setting; this only says they differ
// and where to change either.

import { useTranslation } from "react-i18next";
import { Link }           from "react-router-dom";
import { AlertTriangle }  from "lucide-react";
import { hoursConflict }  from "@/services/period.service";
import type { Period }    from "@/types/timetable.types";

export function SchoolHoursWarning({
  schoolStart, schoolEnd, periods, fixLink,
}: {
  schoolStart: string | null | undefined;
  schoolEnd:   string | null | undefined;
  periods:     Pick<Period, "startTime" | "endTime" | "isActive">[];
  /** Where the other half is edited: "/settings" or "/periods". */
  fixLink?:    { to: string; label: string };
}) {
  const { t } = useTranslation();
  const c = hoursConflict(schoolStart, schoolEnd, periods);
  if (!c) return null;
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div>
        <p className="font-semibold">{t("schoolHours.conflictTitle")}</p>
        <p className="mt-0.5">
          {t("schoolHours.conflictBody", {
            open: schoolStart, close: schoolEnd, from: c.gridFrom, to: c.gridTo,
          })}
        </p>
        {fixLink && (
          <Link to={fixLink.to} className="mt-1 inline-block font-semibold underline">
            {fixLink.label}
          </Link>
        )}
      </div>
    </div>
  );
}
