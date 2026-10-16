// web/src/pages/settings/CalculationRulesSection.tsx
//
// How results are calculated (shared/academicRules.js, docs/39 §21.1).
//
// ── Nothing here is a school's choice any more ────────────────────────────
//
// The project owner decided, once, for every school: the sequence average is
// the coefficient-weighted mean out of 20 with CA blended when the school has
// CA on and a subject with no paper mark left out; term and annual rows carry
// the school's own grade bands; promotion compares the published annual
// average with the class's bar; a published result is never recomputed. This
// screen states that, with the year's result counts, and sends the one thing a
// school does set — its promotion bars — to Promotion → Progression. The
// choices Phase 5 offered here (sequence average, grading authority, promotion
// rule, published results) are gone, and the server refuses them.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Calculator, Info } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { PageSpinner } from "@/components/ui/Spinner";
import { SelectField } from "@/components/ui/FormField";
import { getErrorMessage } from "@/lib/axios";
import { fetchRules } from "@/services/academicRules.service";

const CURRENT_YEAR = new Date().getFullYear();
const ACADEMIC_YEARS = [
  `${CURRENT_YEAR - 1}/${CURRENT_YEAR}`,
  `${CURRENT_YEAR}/${CURRENT_YEAR + 1}`,
  `${CURRENT_YEAR + 1}/${CURRENT_YEAR + 2}`,
];

const STATEMENTS = ["sequence", "absent", "grading", "promotion", "published"] as const;

export default function CalculationRulesSection({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const [year, setYear] = useState(ACADEMIC_YEARS[1]);

  const query = useQuery({
    queryKey: ["academicRules", schoolId, year],
    queryFn:  () => fetchRules(schoolId, year),
    enabled:  Boolean(schoolId),
  });

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Calculator className="mt-0.5 h-5 w-5 text-ink-muted" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-ink">{t("academicRules.title")}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t("academicRules.intro")}</p>
          </div>
        </div>
        <div className="w-44">
          <SelectField
            aria-label={t("academicRules.year")}
            value={year}
            onChange={(e) => setYear(e.target.value)}
            options={ACADEMIC_YEARS.map((y) => ({ value: y, label: y }))}
          />
        </div>
      </div>

      <ul className="mt-4 space-y-2">
        {STATEMENTS.map((key) => (
          <li key={key} className="rounded-xl border border-gray-100 bg-gray-50 p-3 text-sm text-ink-body">
            {t(`academicRules.statement.${key}`)}
          </li>
        ))}
      </ul>

      {query.isLoading ? (
        <PageSpinner />
      ) : query.error || !query.data ? (
        <p className="mt-4 text-sm text-danger">
          {query.error ? getErrorMessage(query.error) : t("academicRules.unavailable")}
        </p>
      ) : (
        <div className="mt-4 space-y-3 text-sm">
          <p className="text-ink-body">
            {query.data.bars.defaultBarSource === "school"
              ? t("academicRules.defaultBarSchool", { bar: query.data.bars.defaultBar })
              : t("academicRules.defaultBarPassMark", { bar: query.data.bars.defaultBar })}
            {" "}
            <Link to="/promotion/progression" className="font-medium text-primary underline">
              {t("academicRules.editBars")}
            </Link>
          </p>
          <div className="flex items-start gap-2 rounded-xl border border-gray-100 p-3 text-ink-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              {t("academicRules.counts", {
                published:   query.data.impact.sequence.published + query.data.impact.term.published + query.data.impact.annual.published,
                unpublished: query.data.impact.sequence.unpublished + query.data.impact.term.unpublished + query.data.impact.annual.unpublished,
              })}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
