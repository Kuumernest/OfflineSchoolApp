// web/src/pages/platform/ReportsPage.tsx
//
// Three tables somebody outside the app will want: who is enrolled where, how
// the results and promotions went, and what the money looks like — each with
// a totals row and a download. The figures are the dashboard's; this page is
// about handing them over.
import { useState }             from "react";
import { useQuery }             from "@tanstack/react-query";
import { useTranslation }       from "react-i18next";
import { Download, FileSpreadsheet } from "lucide-react";
import { PageHeader }           from "@/components/ui/PageHeader";
import { Card, CardHeader }     from "@/components/ui/Card";
import { Button }               from "@/components/ui/Button";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import FiltersBar               from "@/components/platform/FiltersBar";
import { MetricNote }           from "@/components/platform/MetricTile";
import { downloadCsv }          from "@/components/platform/csv";
import { useFormat }            from "@/i18n/format";
import {
  fetchPlatformFilters, fetchPlatformPerformance, type PlatformFilters, type SchoolRow, type PlatformTotals,
} from "@/services/platform.service";

const pctText = (v: number | null) => (v == null ? "—" : `${v}%`);

type Cell = string | number | null;
interface ReportSpec {
  key:     string;
  title:   string;
  columns: string[];
  row:     (r: SchoolRow) => Cell[];
  totals:  (tt: PlatformTotals) => Cell[];
  render:  (cells: Cell[]) => string[];
}

export default function ReportsPage() {
  const { t } = useTranslation();
  const fmt   = useFormat();
  const d = (k: string) => t(`platform.dashboard.${k}`);
  const r = (k: string) => t(`platform.reports.${k}`);

  const [filters, setFilters] = useState<PlatformFilters>({});
  const optionsQ = useQuery({ queryKey: ["platform", "filters"], queryFn: fetchPlatformFilters });
  const dataQ    = useQuery({
    queryKey: ["platform", "performance", filters],
    queryFn:  () => fetchPlatformPerformance(filters),
  });

  const rows   = dataQ.data?.schools ?? [];
  const totals = dataQ.data?.totals;
  const num  = (v: Cell) => (typeof v === "number" ? fmt.number(v) : v == null ? "—" : String(v));
  const cash = (v: Cell) => (typeof v === "number" ? fmt.money(v) : v == null ? "—" : String(v));
  const pct  = (v: Cell) => (typeof v === "number" ? pctText(v) : v == null ? "—" : String(v));

  const specs: ReportSpec[] = [
    {
      key: "enrolment", title: r("enrolment"),
      columns: [t("platform.performance.school"), d("students"), d("teachers"), d("marked"), d("present"), d("late"), d("absent"), d("attendance")],
      row:    (s) => [s.name, s.students, s.teachers, s.attendance.marked, s.attendance.present, s.attendance.late, s.attendance.absent, s.attendance.rate],
      totals: (tt) => [r("totalsRow"), tt.students, tt.teachers, tt.attendance.marked, tt.attendance.present, tt.attendance.late, tt.attendance.absent, tt.attendance.rate],
      render: (c) => [String(c[0]), num(c[1]), num(c[2]), num(c[3]), num(c[4]), num(c[5]), num(c[6]), pct(c[7])],
    },
    {
      key: "academics", title: r("academics"),
      columns: [t("platform.performance.school"), d("results"), d("published"), d("average"), d("passRate"), d("decided"), d("promoted"), d("repeated"), d("graduated"), d("promotionRate")],
      row:    (s) => [s.name, s.academics.results, s.academics.published, s.academics.average, s.academics.passRate, s.promotion.decided, s.promotion.promoted, s.promotion.repeated, s.promotion.graduated, s.promotion.rate],
      totals: (tt) => [r("totalsRow"), tt.academics.results, tt.academics.published, tt.academics.average, tt.academics.passRate, tt.promotion.decided, tt.promotion.promoted, tt.promotion.repeated, tt.promotion.graduated, tt.promotion.rate],
      render: (c) => [String(c[0]), num(c[1]), num(c[2]), typeof c[3] === "number" ? fmt.decimal(c[3], 1) : "—", pct(c[4]), num(c[5]), num(c[6]), num(c[7]), num(c[8]), pct(c[9])],
    },
    {
      key: "finance", title: r("finance"),
      columns: [t("platform.performance.school"), d("charged"), d("waived"), d("billed"), d("paid"), d("balance"), d("collectionRate")],
      row:    (s) => [s.name, s.fees.charged, s.fees.waived, s.fees.billed, s.fees.paid, s.fees.balance, s.fees.collectionRate],
      totals: (tt) => [r("totalsRow"), tt.fees.charged, tt.fees.waived, tt.fees.billed, tt.fees.paid, tt.fees.balance, tt.fees.collectionRate],
      render: (c) => [String(c[0]), cash(c[1]), cash(c[2]), cash(c[3]), cash(c[4]), cash(c[5]), pct(c[6])],
    },
  ];

  const scope = filters.schoolId
    ? (optionsQ.data?.schools.find((s) => s._id === filters.schoolId)?.name ?? filters.schoolId)
    : t("platform.filters.allSchools");

  return (
    <div className="space-y-6">
      <PageHeader title={r("title")} description={r("subtitle")} />

      <Card>
        <FiltersBar value={filters} onChange={setFilters} options={optionsQ.data} showWindow />
        <p className="mt-2 text-xs text-ink-muted">
          {r("generatedFor").replace("{{scope}}", scope)}
          {filters.academicYear ? ` · ${filters.academicYear}` : ""}
          {filters.term ? ` · ${t("platform.filters.termN", { n: filters.term })}` : ""}
        </p>
      </Card>

      <MetricNote>{d("attendanceHint")} {t("platform.filters.termNote")} {d("feesHint")}</MetricNote>

      {specs.map((spec) => (
        <Card key={spec.key} padding={false}>
          <CardHeader
            title={spec.title}
            className="px-5 pt-4"
            action={
              <Button size="sm" variant="secondary" icon={<Download className="h-4 w-4" />} disabled={!rows.length}
                onClick={() => downloadCsv(
                  `platform-${spec.key}`,
                  spec.columns,
                  [...rows.map(spec.row), ...(totals ? [spec.totals(totals)] : [])],
                )}>
                {r("download")}
              </Button>
            }
          />
          {!dataQ.isLoading && rows.length === 0 ? (
            <EmptyTable icon={<FileSpreadsheet className="h-8 w-8" />} title={d("noData")} />
          ) : (
            <Table>
                <THead>
                  {spec.columns.map((c, i) => <Th key={c} numeric={i > 0}>{c}</Th>)}
                </THead>
                <TBody>
                  {rows.map((s) => (
                    <Tr key={s.schoolId}>
                      {spec.render(spec.row(s)).map((v, i) => (
                        <Td key={i} numeric={i > 0} wrap={i === 0} className={i === 0 ? "min-w-[12rem] max-w-sm" : undefined}>{v}</Td>
                      ))}
                    </Tr>
                  ))}
                  {totals && rows.length > 1 && (
                    <Tr className="font-semibold">
                      {spec.render(spec.totals(totals)).map((v, i) => <Td key={i} numeric={i > 0}>{v}</Td>)}
                    </Tr>
                  )}
                </TBody>
              </Table>
          )}
        </Card>
      ))}
    </div>
  );
}
