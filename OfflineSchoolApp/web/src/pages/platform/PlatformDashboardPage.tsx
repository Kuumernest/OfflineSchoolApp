// web/src/pages/platform/PlatformDashboardPage.tsx
//
// Every school on the deployment, side by side. The figures are the ones each
// school's own dashboard already shows, grouped by school on the server
// (platformStats.service.js) rather than filtered to one — nothing here is a
// number a school could not see about itself.
import { useState }        from "react";
import { useQuery }        from "@tanstack/react-query";
import { useTranslation }  from "react-i18next";
import { Link }            from "react-router-dom";
import {
  Building2, Users, GraduationCap, CheckSquare, BookOpen, TrendingUp, Wallet,
  AlertCircle, LogIn,
} from "lucide-react";
import { PageHeader }           from "@/components/ui/PageHeader";
import { Card, CardHeader }     from "@/components/ui/Card";
import { Button }               from "@/components/ui/Button";
import { Badge }                from "@/components/ui/Badge";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import StatCard                 from "@/components/dashboard/StatCard";
import FiltersBar               from "@/components/platform/FiltersBar";
import { useEnterSchool }       from "@/components/platform/useEnterSchool";
import { useFormat }            from "@/i18n/format";
import {
  fetchPlatformDashboard, fetchPlatformFilters, type PlatformFilters,
} from "@/services/platform.service";

const pctText = (v: number | null | undefined) => (v == null ? "—" : `${v}%`);

function FigureCard({
  title, hint, headline, headlineLabel, rows,
}: {
  title:         string;
  hint:          string;
  headline:      string;
  headlineLabel: string;
  rows:          [string, string][];
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={hint} />
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-ink">{headline}</span>
        <span className="text-sm text-ink-muted">{headlineLabel}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-t border-line pt-1">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="font-medium tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title={d("schools")} value={totals ? fmt.number(totals.schools) : "—"}
          subtitle={totals ? `${d("activeSchools")}: ${fmt.number(totals.activeSchools)}` : undefined}
          icon={Building2} href="/platform/schools" loading={statsQ.isLoading} />
        <StatCard title={d("students")} value={totals ? fmt.number(totals.students) : "—"}
          subtitle={d("studentsHint")} icon={GraduationCap} loading={statsQ.isLoading} />
        <StatCard title={d("teachers")} value={totals ? fmt.number(totals.teachers) : "—"}
          subtitle={d("teachersHint")} icon={Users} loading={statsQ.isLoading} />
        <StatCard title={d("collectionRate")} value={totals ? pctText(totals.fees.collectionRate) : "—"}
          subtitle={totals ? `${d("paid")}: ${fmt.money(totals.fees.paid)}` : undefined}
          icon={Wallet} loading={statsQ.isLoading} />
      </div>

      {totals && (
        <div className="grid gap-4 lg:grid-cols-2">
          <FigureCard title={d("attendance")} hint={d("attendanceHint")}
            headline={pctText(totals.attendance.rate)} headlineLabel={d("present")}
            rows={[
              [d("marked"),  fmt.number(totals.attendance.marked)],
              [d("present"), fmt.number(totals.attendance.present)],
              [d("late"),    fmt.number(totals.attendance.late)],
              [d("absent"),  fmt.number(totals.attendance.absent)],
              [d("excused"), fmt.number(totals.attendance.excused)],
            ]} />
          <FigureCard title={d("academics")} hint={d("academicsHint")}
            headline={pctText(totals.academics.passRate)} headlineLabel={d("passRate")}
            rows={[
              [d("results"),   fmt.number(totals.academics.results)],
              [d("published"), fmt.number(totals.academics.published)],
              [d("average"),   totals.academics.average == null ? "—" : fmt.decimal(totals.academics.average, 1)],
            ]} />
          <FigureCard title={d("promotion")} hint={d("promotionHint")}
            headline={pctText(totals.promotion.rate)} headlineLabel={d("promotionRate")}
            rows={[
              [d("decided"),     fmt.number(totals.promotion.decided)],
              [d("promoted"),    fmt.number(totals.promotion.promoted)],
              [d("repeated"),    fmt.number(totals.promotion.repeated)],
              [d("conditional"), fmt.number(totals.promotion.conditional)],
              [d("graduated"),   fmt.number(totals.promotion.graduated)],
              [d("pending"),     fmt.number(totals.promotion.pending)],
            ]} />
          <FigureCard title={d("fees")} hint={d("feesHint")}
            headline={pctText(totals.fees.collectionRate)} headlineLabel={d("collectionRate")}
            rows={[
              [d("charged"), fmt.money(totals.fees.charged)],
              [d("waived"),  fmt.money(totals.fees.waived)],
              [d("billed"),  fmt.money(totals.fees.billed)],
              [d("paid"),    fmt.money(totals.fees.paid)],
              [d("balance"), fmt.money(totals.fees.balance)],
            ]} />
        </div>
      )}

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
                  <Td>
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
      <p className="flex items-center gap-1 text-xs text-ink-muted">
        <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />{d("attendanceHint")}
        <BookOpen className="ml-3 h-3.5 w-3.5" aria-hidden="true" />{t("platform.filters.termNote")}
        <TrendingUp className="ml-3 h-3.5 w-3.5" aria-hidden="true" />{d("promotionHint")}
      </p>
    </div>
  );
}
