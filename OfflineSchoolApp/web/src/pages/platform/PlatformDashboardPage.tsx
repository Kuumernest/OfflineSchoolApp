// web/src/pages/platform/PlatformDashboardPage.tsx
//
// Every school on the deployment, side by side. The figures are the ones each
// school's own dashboard already shows, grouped by school on the server
// (platformStats.service.js) rather than filtered to one — nothing here is a
// number a school could not see about itself.
//
// Twelve tiles, then the table. The tiles used to be four stat cards over four
// panels of two- and three-column lists, and a money figure in a third of a
// half-width panel had nowhere to go but out of it. One grid of equal tiles,
// each sized to its own figure, is what stopped that.
import { useState }        from "react";
import { useQuery }        from "@tanstack/react-query";
import { useTranslation }  from "react-i18next";
import { Link }            from "react-router-dom";
import {
  Building2, Users, GraduationCap, CalendarCheck, ClipboardList, BarChart3, Award,
  TrendingUp, Banknote, Wallet, CircleDollarSign, Percent, AlertCircle, LogIn,
} from "lucide-react";
import { PageHeader }           from "@/components/ui/PageHeader";
import { Card, CardHeader }     from "@/components/ui/Card";
import { Button }               from "@/components/ui/Button";
import { Badge }                from "@/components/ui/Badge";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import { MetricTile, MetricGrid, MetricNote } from "@/components/platform/MetricTile";
import FiltersBar               from "@/components/platform/FiltersBar";
import { useEnterSchool }       from "@/components/platform/useEnterSchool";
import { useFormat }            from "@/i18n/format";
import {
  fetchPlatformDashboard, fetchPlatformFilters, type PlatformFilters,
} from "@/services/platform.service";

const pctText = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

export default function PlatformDashboardPage() {
  const { t } = useTranslation();
  const fmt   = useFormat();
  const [filters, setFilters] = useState<PlatformFilters>({});

  const optionsQ = useQuery({ queryKey: ["platform", "filters"], queryFn: fetchPlatformFilters });
  const statsQ   = useQuery({
    queryKey: ["platform", "dashboard", filters],
    queryFn:  () => fetchPlatformDashboard(filters),
  });
  const { enter, enteringId } = useEnterSchool();

  const totals  = statsQ.data?.totals;
  const rows    = statsQ.data?.schools ?? [];
  const d       = (k: string) => t(`platform.dashboard.${k}`);
  const loading = statsQ.isLoading;

  // "Label: figure · Label: figure" — the breakdown a tile carries under its
  // headline. Built here so every hint reads the same way.
  const pair  = (k: string, v: string) => `${d(k)}: ${v}`;
  const join  = (...parts: string[]) => parts.join(" · ");
  const n     = (v: number | null | undefined) => (v == null ? "—" : fmt.number(v));
  const money = (v: number | null | undefined) => (v == null ? "—" : fmt.money(v));

  return (
    <div className="space-y-6">
      <PageHeader
        title={d("title")}
        description={d("subtitle")}
        actions={
          <Link to="/platform/schools">
            <Button variant="secondary" icon={<Building2 className="h-4 w-4" />}>
              {t("platform.schools.title")}
            </Button>
          </Link>
        }
      />

      <Card>
        <FiltersBar value={filters} onChange={setFilters} options={optionsQ.data} showWindow />
      </Card>

      {statsQ.isError && (
        <div role="alert" className="flex items-start gap-2 rounded-card border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{d("loadFailed")}</span>
        </div>
      )}

      <MetricGrid>
        <MetricTile tone="schools" icon={Building2} loading={loading} href="/platform/schools"
          label={d("schools")} value={n(totals?.schools)}
          hint={totals ? pair("activeSchools", n(totals.activeSchools)) : undefined} />
        <MetricTile tone="students" icon={GraduationCap} loading={loading}
          label={d("students")} value={n(totals?.students)} hint={d("studentsHint")} />
        <MetricTile tone="teachers" icon={Users} loading={loading}
          label={d("teachers")} value={n(totals?.teachers)} hint={d("teachersHint")} />
        <MetricTile tone="attendance" icon={CalendarCheck} loading={loading}
          label={d("attendance")} value={pctText(totals?.attendance.rate)}
          hint={totals ? join(
            pair("present", n(totals.attendance.present)),
            pair("late",    n(totals.attendance.late)),
            pair("absent",  n(totals.attendance.absent)),
            pair("excused", n(totals.attendance.excused)),
          ) : undefined} />
        <MetricTile tone="academic" icon={ClipboardList} loading={loading}
          label={d("results")} value={n(totals?.academics.results)}
          hint={totals ? pair("published", n(totals.academics.published)) : undefined} />
        <MetricTile tone="academic" icon={BarChart3} loading={loading}
          label={d("average")}
          value={totals?.academics.average == null ? "—" : fmt.decimal(totals.academics.average, 1)}
          hint={d("academicsHint")} />
        <MetricTile tone="reports" icon={Award} loading={loading}
          label={d("passRate")} value={pctText(totals?.academics.passRate)} />
        <MetricTile tone="exams" icon={TrendingUp} loading={loading}
          label={d("promotionRate")} value={pctText(totals?.promotion.rate)}
          hint={totals ? join(
            pair("decided",  n(totals.promotion.decided)),
            pair("promoted", n(totals.promotion.promoted)),
            pair("repeated", n(totals.promotion.repeated)),
            pair("pending",  n(totals.promotion.pending)),
          ) : undefined} />
        <MetricTile tone="finance" icon={Banknote} loading={loading}
          label={d("billed")} value={money(totals?.fees.billed)}
          hint={totals ? join(
            pair("charged", money(totals.fees.charged)),
            pair("waived",  money(totals.fees.waived)),
          ) : undefined} />
        <MetricTile tone="attendance" icon={Wallet} loading={loading}
          label={d("paid")} value={money(totals?.fees.paid)} />
        <MetricTile tone="reports" icon={CircleDollarSign} loading={loading}
          label={d("balance")} value={money(totals?.fees.balance)} />
        <MetricTile tone="schools" icon={Percent} loading={loading}
          label={d("collectionRate")} value={pctText(totals?.fees.collectionRate)} />
      </MetricGrid>

      <MetricNote>
        {d("attendanceHint")} {t("platform.filters.termNote")} {d("promotionHint")} {d("feesHint")}
      </MetricNote>

      <Card padding={false}>
        <div className="px-5 pt-4">
          <CardHeader title={d("bySchool")} />
        </div>
        {!statsQ.isLoading && rows.length === 0 ? (
          <EmptyTable icon={<Building2 className="h-8 w-8" />} title={d("noData")} />
        ) : (
          <Table>
            <THead>
              <Th>{t("platform.performance.school")}</Th>
              <Th numeric>{d("students")}</Th>
              <Th numeric>{d("teachers")}</Th>
              <Th numeric>{d("attendance")}</Th>
              <Th numeric>{d("passRate")}</Th>
              <Th numeric>{d("promotionRate")}</Th>
              <Th numeric>{d("collectionRate")}</Th>
              <Th>{t("common.actions")}</Th>
            </THead>
            <TBody>
              {rows.map((r) => (
                <Tr key={r.schoolId}>
                  <Td className="min-w-[12rem] max-w-sm whitespace-normal">
                    <Link to={`/platform/schools/${r.schoolId}`} className="font-medium text-ink hover:underline">
                      {r.name}
                    </Link>
                    {r.code ? <span className="ml-1 text-ink-muted">({r.code})</span> : null}
                    {!r.isActive ? <Badge variant="danger" className="ml-2">{t("platform.schools.statusInactive")}</Badge> : null}
                  </Td>
                  <Td numeric>{fmt.number(r.students)}</Td>
                  <Td numeric>{fmt.number(r.teachers)}</Td>
                  <Td numeric>{pctText(r.attendance.rate)}</Td>
                  <Td numeric>{pctText(r.academics.passRate)}</Td>
                  <Td numeric>{pctText(r.promotion.rate)}</Td>
                  <Td numeric>{pctText(r.fees.collectionRate)}</Td>
                  <Td>
                    <Button size="sm" variant="ghost" icon={<LogIn className="h-4 w-4" />}
                      loading={enteringId === r.schoolId} onClick={() => enter(r.schoolId)}>
                      {t("platform.context.enter")}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
