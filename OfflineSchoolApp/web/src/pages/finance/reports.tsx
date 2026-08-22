// web/src/pages/finance/reports.tsx
//
// Income against expenditure.
//
// Two kinds of number live on this page and they must not be confused. The
// summary is a FLOW over the chosen period. Arrears are a POSITION as of today
// — a debt raised in October is still owed in March, so it is not clipped to
// the period and is kept in its own panel, captioned, well away from the totals.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { TrendingUp, TrendingDown, Wallet } from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { PageSpinner } from "@/components/ui/Spinner";
import { FormField, Input } from "@/components/ui/FormField";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }   from "@/i18n/format";
import { cn }          from "@/utils/cn";
import { fetchReport } from "@/services/finance.service";

type Preset = "month" | "year" | "all" | "custom";

/** Cameroonian school years run September–July. */
const currentAcademicYear = () => {
  const now   = new Date();
  const start = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}/${start + 1}`;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

const presetRange = (preset: Preset): { from?: string; to?: string } => {
  const now = new Date();
  if (preset === "month") {
    return {
      from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
      to:   iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))),
    };
  }
  if (preset === "year") {
    // The academic year, not the calendar year. Teaching runs September to July,
    // but the window closes on 31 August rather than 31 July: August is the
    // holiday month, salaries and bills are still paid in it, and ending in July
    // would drop that money into no academic year at all. Opened in August —
    // which is exactly when a head reviews the year just finished — a July
    // cut-off also puts TODAY outside the range, so the page reports zeros for a
    // school whose books are not remotely empty.
    const startYear = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    return {
      from: iso(new Date(Date.UTC(startYear, 8, 1))),
      to:   iso(new Date(Date.UTC(startYear + 1, 7, 31))),
    };
  }
  return {};
};

export default function FinanceReportsPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const schoolId = useUser()?.schoolId ?? "";

  const [preset, setPreset] = useState<Preset>("year");
  const [custom, setCustom] = useState({ from: "", to: "" });

  const range = useMemo(
    () => (preset === "custom" ? custom : presetRange(preset)),
    [preset, custom]
  );

  const reportQ = useQuery({
    queryKey: ["finance", "report", schoolId, range.from, range.to],
    queryFn:  () =>
      fetchReport(schoolId, {
        from: range.from || undefined,
        to:   range.to   || undefined,
        academicYear: currentAcademicYear(),
      }),
    enabled: !!schoolId,
  });

  if (reportQ.isLoading) return <PageSpinner />;

  const summary = reportQ.data?.summary;
  const arrears = reportQ.data?.arrears;

  const income      = summary?.income.total ?? 0;
  const expenditure = summary?.expenditure.total ?? 0;
  const net         = summary?.net ?? 0;
  const months      = summary?.months ?? [];

  // One scale for both series, so a tall income bar and a short expenditure bar
  // mean what they look like. Scaling each series to its own maximum would make
  // every month appear balanced.
  const peak = Math.max(
    1,
    ...months.map((m) => Math.max(m.income, m.expenditure))
  );

  const PRESETS: { key: Preset; label: string }[] = [
    { key: "month",  label: t("finrep.thisMonth") },
    { key: "year",   label: t("finrep.thisYear") },
    { key: "all",    label: t("finrep.allTime") },
    { key: "custom", label: t("finrep.custom") },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title={t("finrep.title")} description={t("finrep.blurb")} />

      {/* Period */}
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={cn(
                  "h-8 rounded-control px-3 text-xs font-medium transition-colors",
                  preset === p.key
                    ? "bg-primary-600 text-white"
                    : "border border-line-strong bg-surface text-ink-body hover:bg-surface-muted"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === "custom" && (
            <div className="flex flex-wrap items-end gap-3">
              <FormField label={t("finrep.from")}>
                <Input
                  type="date"
                  value={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                />
              </FormField>
              <FormField label={t("finrep.to")}>
                <Input
                  type="date"
                  value={custom.to}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                />
              </FormField>
            </div>
          )}
        </div>
      </Card>

      {/* Headline */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-success" aria-hidden="true" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {t("finrep.income")}
            </p>
          </div>
          <p className="mt-2 font-display text-[28px] leading-none text-ink tabular">
            {fmt.money(income)}
          </p>
          <p className="mt-2 text-xs text-ink-muted">
            {t("finrep.paymentCount", { count: summary?.income.count ?? 0 })}
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-danger" aria-hidden="true" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {t("finrep.expenditure")}
            </p>
          </div>
          <p className="mt-2 font-display text-[28px] leading-none text-ink tabular">
            {fmt.money(expenditure)}
          </p>
          <p className="mt-2 text-xs text-ink-muted">
            {t("expenses.title")} {fmt.money(summary?.expenditure.expenses ?? 0)}
            {" · "}
            {t("finrep.payrollLine")} {fmt.money(summary?.expenditure.payroll ?? 0)}
          </p>
        </Card>

        <Card>
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-ink-faint" aria-hidden="true" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {net < 0 ? t("finrep.deficit") : t("finrep.surplus")}
            </p>
          </div>
          <p
            className={cn(
              "mt-2 font-display text-[28px] leading-none tabular",
              net < 0 ? "text-danger" : "text-success"
            )}
          >
            {fmt.money(net)}
          </p>
          <p className="mt-2 text-xs text-ink-muted">{t("finrep.net")}</p>
        </Card>
      </div>

      {/* Month by month */}
      <Card padding={false}>
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">{t("finrep.monthly")}</h2>
        </div>
        {months.length === 0 ? (
          <EmptyTable title={t("finrep.noData")} subtitle={t("finrep.noDataHint")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("finrep.month")}</Th>
                <Th>{/* bars */}</Th>
                <Th numeric>{t("finrep.income")}</Th>
                <Th numeric>{t("finrep.expenditure")}</Th>
                <Th numeric>{t("finrep.net")}</Th>
              </Tr>
            </THead>
            <TBody>
              {months.map((m) => (
                <Tr key={m.month}>
                  <Td className="font-medium text-ink">{fmt.monthLabel(m.month)}</Td>
                  <Td className="w-[38%]">
                    {/* Two bars on one scale — the shape of the month at a glance. */}
                    <div className="flex flex-col gap-1">
                      <div className="h-1.5 w-full rounded-full bg-canvas">
                        <div
                          className="h-full rounded-full bg-success transition-[width] duration-300"
                          style={{ width: `${(m.income / peak) * 100}%` }}
                        />
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-canvas">
                        <div
                          className="h-full rounded-full bg-danger transition-[width] duration-300"
                          style={{ width: `${(m.expenditure / peak) * 100}%` }}
                        />
                      </div>
                    </div>
                  </Td>
                  <Td numeric className="text-ink-muted">{fmt.money(m.income)}</Td>
                  <Td numeric className="text-ink-muted">{fmt.money(m.expenditure)}</Td>
                  <Td
                    numeric
                    className={cn(
                      "font-semibold",
                      m.net < 0 ? "text-danger" : "text-ink"
                    )}
                  >
                    {fmt.money(m.net)}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* By category */}
        <Card padding={false}>
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-sm font-semibold text-ink">{t("finrep.byCategory")}</h2>
          </div>
          {(summary?.byCategory.length ?? 0) === 0 ? (
            <EmptyTable title={t("expenses.none")} subtitle={t("expenses.noneHint")} />
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>{t("expenses.category")}</Th>
                  <Th numeric>{t("fees.amount")}</Th>
                </Tr>
              </THead>
              <TBody>
                {summary?.byCategory.map((c) => (
                  <Tr key={c.categoryId}>
                    <Td className="font-medium text-ink">{c.label}</Td>
                    <Td numeric className="text-ink-muted">{fmt.money(c.total)}</Td>
                  </Tr>
                ))}
                {/* Salaries are expenditure but not an expense category, so they
                    are shown as their own line rather than folded into one. */}
                <Tr>
                  <Td className="font-medium text-ink-muted">{t("finrep.payrollLine")}</Td>
                  <Td numeric className="text-ink-muted">
                    {fmt.money(summary?.expenditure.payroll ?? 0)}
                  </Td>
                </Tr>
              </TBody>
            </Table>
          )}
        </Card>

        {/* Arrears — a position, not a flow. */}
        <Card>
          <h2 className="text-sm font-semibold text-ink">{t("finrep.arrears")}</h2>
          <p className="mt-1 text-xs text-ink-muted">{t("finrep.arrearsNote")}</p>

          <p className="mt-4 font-display text-[28px] leading-none text-danger tabular">
            {fmt.money(arrears?.outstanding ?? 0)}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-muted">{t("finrep.billed")}</dt>
            <dd className="text-right font-medium text-ink tabular">
              {fmt.money(arrears?.billed ?? 0)}
            </dd>
            <dt className="text-ink-muted">{t("finrep.collected")}</dt>
            <dd className="text-right font-medium text-ink tabular">
              {fmt.money(arrears?.paid ?? 0)}
            </dd>
            {(arrears?.waived ?? 0) > 0 && (
              <>
                <dt className="text-ink-muted">{t("fees.waived")}</dt>
                <dd className="text-right font-medium text-ink tabular">
                  {fmt.money(arrears?.waived ?? 0)}
                </dd>
              </>
            )}
          </dl>

          {arrears?.collectionRate !== null && arrears?.collectionRate !== undefined && (
            <div className="mt-4">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-muted">{t("finrep.collectionRate")}</span>
                <span className="text-sm font-semibold text-ink tabular">
                  {arrears.collectionRate}%
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full rounded-full bg-canvas">
                <div
                  className="h-full rounded-full bg-primary-600 transition-[width] duration-300"
                  style={{ width: `${Math.min(100, Math.max(0, arrears.collectionRate))}%` }}
                />
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
