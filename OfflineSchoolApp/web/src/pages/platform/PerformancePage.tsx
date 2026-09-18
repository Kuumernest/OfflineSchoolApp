// web/src/pages/platform/PerformancePage.tsx
//
// The same figures for every school, in one sortable table. Nothing is
// computed here — the rows come from /super-admin/performance as they are;
// this page only orders them and lets them be taken away as a file.
import { useMemo, useState }    from "react";
import { useQuery }             from "@tanstack/react-query";
import { useTranslation }       from "react-i18next";
import { Link }                 from "react-router-dom";
import {
  Download, ArrowUpDown, BarChart3, GraduationCap, Users, CalendarCheck, Award, TrendingUp, Percent,
} from "lucide-react";
import { PageHeader }           from "@/components/ui/PageHeader";
import { Card }                 from "@/components/ui/Card";
import { Button }               from "@/components/ui/Button";
import { Badge }                from "@/components/ui/Badge";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import FiltersBar               from "@/components/platform/FiltersBar";
import { MetricTile, MetricGrid, MetricNote } from "@/components/platform/MetricTile";
import { downloadCsv }          from "@/components/platform/csv";
import { useFormat }            from "@/i18n/format";
import {
  fetchPlatformFilters, fetchPlatformPerformance, type PlatformFilters, type SchoolRow,
} from "@/services/platform.service";

type SortKey = "name" | "students" | "teachers" | "attendance" | "results" | "average" | "passRate" | "promotion" | "billed" | "paid" | "collection";

const valueOf = (r: SchoolRow, k: SortKey): number | string => {
  switch (k) {
    case "name":       return r.name.toLowerCase();
    case "students":   return r.students;
    case "teachers":   return r.teachers;
    case "attendance": return r.attendance.rate ?? -1;
    case "results":    return r.academics.results;
    case "average":    return r.academics.average ?? -1;
    case "passRate":   return r.academics.passRate ?? -1;
    case "promotion":  return r.promotion.rate ?? -1;
    case "billed":     return r.fees.billed;
    case "paid":       return r.fees.paid;
    case "collection": return r.fees.collectionRate ?? -1;
  }
};

const pctText = (v: number | null) => (v == null ? "—" : `${v}%`);

export default function PerformancePage() {
  const { t } = useTranslation();
  const fmt   = useFormat();
  const d = (k: string) => t(`platform.dashboard.${k}`);

  const [filters, setFilters] = useState<PlatformFilters>({});
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [desc, setDesc]       = useState(false);

  const optionsQ = useQuery({ queryKey: ["platform", "filters"], queryFn: fetchPlatformFilters });
  const perfQ    = useQuery({
    queryKey: ["platform", "performance", filters],
    queryFn:  () => fetchPlatformPerformance(filters),
  });

  const rows = useMemo(() => {
    const list = [...(perfQ.data?.schools ?? [])];
    list.sort((a, b) => {
      const x = valueOf(a, sortKey), y = valueOf(b, sortKey);
      const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y);
      return desc ? -c : c;
    });
    return list;
  }, [perfQ.data, sortKey, desc]);

  const totals = perfQ.data?.totals;

  const sortBy = (k: SortKey) => {
    if (k === sortKey) setDesc((v) => !v);
    else { setSortKey(k); setDesc(k !== "name"); }
  };

  const columns: { key: SortKey; label: string; numeric?: boolean }[] = [
    { key: "name",       label: t("platform.performance.school") },
    { key: "students",   label: d("students"),       numeric: true },
    { key: "teachers",   label: d("teachers"),       numeric: true },
    { key: "attendance", label: d("attendance"),     numeric: true },
    { key: "results",    label: d("results"),        numeric: true },
    { key: "average",    label: d("average"),        numeric: true },
    { key: "passRate",   label: d("passRate"),       numeric: true },
    { key: "promotion",  label: d("promotionRate"),  numeric: true },
    { key: "billed",     label: d("billed"),         numeric: true },
    { key: "paid",       label: d("paid"),           numeric: true },
    { key: "collection", label: d("collectionRate"), numeric: true },
  ];

  const exportCsv = () => downloadCsv(
    "cross-school-performance",
    columns.map((c) => c.label),
    rows.map((r) => [
      r.name, r.students, r.teachers, r.attendance.rate, r.academics.results, r.academics.average,
      r.academics.passRate, r.promotion.rate, r.fees.billed, r.fees.paid, r.fees.collectionRate,
    ]),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("platform.performance.title")}
        description={t("platform.performance.subtitle")}
        actions={
          <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!rows.length}>
            {t("platform.performance.download")}
          </Button>
        }
      />

      <Card>
        <FiltersBar value={filters} onChange={setFilters} options={optionsQ.data} showSchool={false} showWindow />
      </Card>

      {/* The totals row of the table, as tiles, so the figures every school
          is being compared against are readable without scrolling an
          eleven-column table sideways. */}
      <MetricGrid className="xl:grid-cols-3 2xl:grid-cols-6">
        <MetricTile tone="students" icon={GraduationCap} loading={perfQ.isLoading}
          label={d("students")} value={totals ? fmt.number(totals.students) : "—"}
          hint={t("platform.performance.allSchools")} />
        <MetricTile tone="teachers" icon={Users} loading={perfQ.isLoading}
          label={d("teachers")} value={totals ? fmt.number(totals.teachers) : "—"}
          hint={t("platform.performance.allSchools")} />
        <MetricTile tone="attendance" icon={CalendarCheck} loading={perfQ.isLoading}
          label={d("attendance")} value={totals ? pctText(totals.attendance.rate) : "—"}
          hint={totals ? d("marked") + ": " + fmt.number(totals.attendance.marked) : undefined} />
        <MetricTile tone="reports" icon={Award} loading={perfQ.isLoading}
          label={d("passRate")} value={totals ? pctText(totals.academics.passRate) : "—"}
          hint={totals ? d("results") + ": " + fmt.number(totals.academics.results) : undefined} />
        <MetricTile tone="exams" icon={TrendingUp} loading={perfQ.isLoading}
          label={d("promotionRate")} value={totals ? pctText(totals.promotion.rate) : "—"}
          hint={totals ? d("decided") + ": " + fmt.number(totals.promotion.decided) : undefined} />
        <MetricTile tone="finance" icon={Percent} loading={perfQ.isLoading}
          label={d("collectionRate")} value={totals ? pctText(totals.fees.collectionRate) : "—"}
          hint={totals ? d("paid") + ": " + fmt.money(totals.fees.paid) : undefined} />
      </MetricGrid>

      <Card padding={false}>
        {!perfQ.isLoading && rows.length === 0 ? (
          <EmptyTable icon={<BarChart3 className="h-8 w-8" />} title={t("platform.performance.empty")} />
        ) : (
          <Table>
              <THead>
                {columns.map((c) => (
                  <Th key={c.key} numeric={c.numeric}>
                    <button type="button" onClick={() => sortBy(c.key)}
                      className="inline-flex items-center gap-1 hover:text-ink" aria-label={`${t("platform.performance.sortBy")} ${c.label}`}>
                      {c.label}
                      <ArrowUpDown className={`h-3 w-3 ${sortKey === c.key ? "text-primary-600" : "text-ink-faint"}`} aria-hidden="true" />
                    </button>
                  </Th>
                ))}
              </THead>
              <TBody>
                {rows.map((r) => (
                  <Tr key={r.schoolId}>
                    <Td wrap className="min-w-[12rem] max-w-sm">
                      <Link to={`/platform/schools/${r.schoolId}`} className="font-medium text-ink hover:underline">{r.name}</Link>
                      {!r.isActive ? <Badge variant="danger" className="ml-2">{t("platform.schools.statusInactive")}</Badge> : null}
                    </Td>
                    <Td numeric>{fmt.number(r.students)}</Td>
                    <Td numeric>{fmt.number(r.teachers)}</Td>
                    <Td numeric>{pctText(r.attendance.rate)}</Td>
                    <Td numeric>{fmt.number(r.academics.results)}</Td>
                    <Td numeric>{r.academics.average == null ? "—" : fmt.decimal(r.academics.average, 1)}</Td>
                    <Td numeric>{pctText(r.academics.passRate)}</Td>
                    <Td numeric>{pctText(r.promotion.rate)}</Td>
                    <Td numeric>{fmt.money(r.fees.billed)}</Td>
                    <Td numeric>{fmt.money(r.fees.paid)}</Td>
                    <Td numeric>{pctText(r.fees.collectionRate)}</Td>
                  </Tr>
                ))}
                {perfQ.data && rows.length > 1 && (
                  <Tr className="font-semibold">
                    <Td>{t("platform.performance.allSchools")}</Td>
                    <Td numeric>{fmt.number(perfQ.data.totals.students)}</Td>
                    <Td numeric>{fmt.number(perfQ.data.totals.teachers)}</Td>
                    <Td numeric>{pctText(perfQ.data.totals.attendance.rate)}</Td>
                    <Td numeric>{fmt.number(perfQ.data.totals.academics.results)}</Td>
                    <Td numeric>{perfQ.data.totals.academics.average == null ? "—" : fmt.decimal(perfQ.data.totals.academics.average, 1)}</Td>
                    <Td numeric>{pctText(perfQ.data.totals.academics.passRate)}</Td>
                    <Td numeric>{pctText(perfQ.data.totals.promotion.rate)}</Td>
                    <Td numeric>{fmt.money(perfQ.data.totals.fees.billed)}</Td>
                    <Td numeric>{fmt.money(perfQ.data.totals.fees.paid)}</Td>
                    <Td numeric>{pctText(perfQ.data.totals.fees.collectionRate)}</Td>
                  </Tr>
                )}
              </TBody>
            </Table>
        )}
      </Card>
      <MetricNote>{d("attendanceHint")} {t("platform.filters.termNote")}</MetricNote>
    </div>
  );
}
