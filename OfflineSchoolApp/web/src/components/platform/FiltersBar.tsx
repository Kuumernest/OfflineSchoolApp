// web/src/components/platform/FiltersBar.tsx
//
// The filter row every platform page shares: school, academic year, term and
// (where attendance is shown) the window of days. One component so the four
// pages cannot drift in what "term" means — see platformStats.service.js on
// the server for why term applies to results and not to fees.
import { useTranslation } from "react-i18next";
import { FormField, Input, SelectField } from "@/components/ui/FormField";
import type { FilterOptions, PlatformFilters } from "@/services/platform.service";

interface Props {
  value:       PlatformFilters;
  onChange:    (next: PlatformFilters) => void;
  options?:    FilterOptions;
  showSchool?: boolean;
  showTerm?:   boolean;
  showWindow?: boolean;
}

export default function FiltersBar({
  value, onChange, options, showSchool = true, showTerm = true, showWindow = false,
}: Props) {
  const { t } = useTranslation();
  const set = (patch: Partial<PlatformFilters>) => onChange({ ...value, ...patch });

  // One row of fields, however many there are. With five fields in a
  // four-column grid the last date box sat alone on a second row, under a
  // column of nothing.
  const fields = [showSchool, true, showTerm, showWindow, showWindow].filter(Boolean).length;
  const columns =
    fields >= 5 ? "sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5" :
    fields === 4 ? "sm:grid-cols-2 lg:grid-cols-4" :
    fields === 3 ? "sm:grid-cols-3" :
                   "sm:grid-cols-2";

  return (
    <div className={`grid gap-3 ${columns}`}>
      {showSchool && (
        <FormField label={t("platform.filters.school")}>
          <SelectField
            value={value.schoolId ?? ""}
            onChange={(e) => set({ schoolId: e.target.value || null })}
            options={[
              { value: "", label: t("platform.filters.allSchools") },
              ...(options?.schools ?? []).map((s) => ({ value: s._id, label: s.name })),
            ]}
          />
        </FormField>
      )}
      <FormField label={t("platform.filters.year")}>
        <SelectField
          value={value.academicYear ?? ""}
          onChange={(e) => set({ academicYear: e.target.value || null })}
          options={[
            { value: "", label: t("platform.filters.allYears") },
            ...(options?.academicYears ?? []).map((y) => ({ value: y, label: y })),
          ]}
        />
      </FormField>
      {showTerm && (
        <FormField label={t("platform.filters.term")}>
          <SelectField
            value={value.term != null ? String(value.term) : ""}
            onChange={(e) => set({ term: e.target.value ? Number(e.target.value) : null })}
            options={[
              { value: "", label: t("platform.filters.allTerms") },
              ...(options?.terms ?? [1, 2, 3]).map((n) => ({
                value: String(n), label: t("platform.filters.termN", { n }),
              })),
            ]}
          />
        </FormField>
      )}
      {showWindow && (
        <>
          <FormField label={t("platform.filters.from")}>
            <Input type="date" value={value.from ?? ""} onChange={(e) => set({ from: e.target.value || null })} />
          </FormField>
          <FormField label={t("platform.filters.to")}>
            <Input type="date" value={value.to ?? ""} onChange={(e) => set({ to: e.target.value || null })} />
          </FormField>
        </>
      )}
    </div>
  );
}
