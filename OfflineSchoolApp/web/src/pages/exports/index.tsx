// web/src/pages/exports/index.tsx
//
// Download the books as spreadsheets.
//
// The list of exports comes from the server, not from a constant here, so a
// teacher sees only the roster and never a Payroll tile that answers 403 when
// they click it. Offering a control that cannot work is worse than not
// offering it.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Download, FileSpreadsheet } from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { FormField, Input, SelectField } from "@/components/ui/FormField";
import { useToast }    from "@/components/ui/Toast";
import { cn }          from "@/utils/cn";
import { getErrorMessage } from "@/lib/axios";

import { fetchClasses } from "@/services/class.service";
import {
  listExports, downloadExport,
  type ExportKind, type ExportParams,
} from "@/services/export.service";

/** Which filters each export actually understands. */
const FILTERS: Record<ExportKind, Array<keyof ExportParams>> = {
  students:    ["classId"],
  arrears:     ["academicYear"],
  payments:    ["academicYear", "from", "to"],
  expenses:    ["from", "to"],
  payroll:     ["periodMonth"],
  enrollments: ["academicYear"],
};

/** Cameroonian school years run September–July. */
const currentAcademicYear = () => {
  const now = new Date();
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

export default function ExportsPage() {
  const { t, i18n } = useTranslation();
  const { toast }   = useToast();
  const schoolId    = useUser()?.schoolId ?? "";

  const [selected, setSelected] = useState<ExportKind | null>(null);
  const [params, setParams]     = useState<ExportParams>({});
  const [busy, setBusy]         = useState(false);

  const kindsQ = useQuery({
    queryKey: ["exports", "kinds"],
    queryFn:  listExports,
  });

  const classesQ = useQuery({
    queryKey: ["classes", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  if (kindsQ.isLoading) return <PageSpinner />;

  const kinds   = kindsQ.data ?? [];
  const classes = classesQ.data ?? [];
  const active  = selected && FILTERS[selected] ? FILTERS[selected] : [];

  const run = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const rows = await downloadExport(
        selected, schoolId, i18n.resolvedLanguage ?? "en", params
      );
      // Said explicitly, because a downloaded file that turns out to be empty
      // is discovered only after opening it.
      toast(
        rows > 0
          ? { kind: "success", title: t("exp.downloaded", { count: rows }) }
          : { kind: "warning", title: t("exp.empty") }
      );
    } catch (err) {
      toast({ kind: "error", title: t("exp.failed"), message: getErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("exp.title")}
        description={t("exp.blurb")}
        actions={
          <Button
            icon={<Download className="h-4 w-4" />}
            loading={busy}
            disabled={!selected}
            onClick={run}
          >
            {t("exp.download")}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => {
              setSelected(kind);
              // Filters are cleared on switch: an academic year left over from
              // Arrears would silently narrow an Expenses export.
              setParams(
                FILTERS[kind]?.includes("academicYear")
                  ? { academicYear: currentAcademicYear() }
                  : {}
              );
            }}
            className={cn(
              "rounded-card border p-4 text-left transition-colors",
              selected === kind
                ? "border-primary-600 bg-primary-50/60"
                : "border-line bg-surface hover:bg-surface-muted"
            )}
          >
            <div className="flex items-center gap-2">
              <FileSpreadsheet
                className={cn(
                  "h-4 w-4",
                  selected === kind ? "text-primary-600" : "text-ink-faint"
                )}
                aria-hidden="true"
              />
              <p className="text-sm font-semibold text-ink">{t(`exp.${kind}`)}</p>
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">{t(`exp.${kind}Hint`)}</p>
          </button>
        ))}
      </div>

      {active.length > 0 && (
        <Card>
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            {t("exp.filters")}
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {active.includes("classId") && (
              <FormField label={t("academic.class")}>
                <SelectField
                  value={params.classId ?? ""}
                  placeholder={t("exp.allClasses")}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, classId: e.target.value || undefined }))
                  }
                  options={classes.map((c) => ({ value: c._id, label: c.name }))}
                />
              </FormField>
            )}

            {active.includes("academicYear") && (
              <FormField label={t("fees.academicYear")}>
                <Input
                  placeholder={t("exp.allYears")}
                  value={params.academicYear ?? ""}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, academicYear: e.target.value || undefined }))
                  }
                />
              </FormField>
            )}

            {active.includes("from") && (
              <FormField label={t("finrep.from")}>
                <Input
                  type="date"
                  value={params.from ?? ""}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, from: e.target.value || undefined }))
                  }
                />
              </FormField>
            )}

            {active.includes("to") && (
              <FormField label={t("finrep.to")}>
                <Input
                  type="date"
                  value={params.to ?? ""}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, to: e.target.value || undefined }))
                  }
                />
              </FormField>
            )}

            {active.includes("periodMonth") && (
              <FormField label={t("payroll.month")}>
                <Input
                  type="month"
                  placeholder={t("exp.allMonths")}
                  value={params.periodMonth ?? ""}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, periodMonth: e.target.value || undefined }))
                  }
                />
              </FormField>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
