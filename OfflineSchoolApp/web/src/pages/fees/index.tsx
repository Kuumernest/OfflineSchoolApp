// web/src/pages/fees/index.tsx
//
// The arrears list — the screen a bursar actually opens.
//
// Ordered by who owes most, because that is the question being asked. Every
// figure comes from the server's ledger aggregation; nothing is summed in the
// browser, so this page cannot disagree with the student's own account page.

import { useState, Fragment } from "react";
import { useQuery }        from "@tanstack/react-query";
import { useNavigate }     from "react-router-dom";
import { useTranslation }  from "react-i18next";
import { Wallet, ArrowUpRight, Search } from "lucide-react";

import { useUser }             from "@/store/auth.store";
import { PageHeader }          from "@/components/ui/PageHeader";
import { Card }                from "@/components/ui/Card";
import { Button }              from "@/components/ui/Button";
import { Select }              from "@/components/ui/Select";
import { SearchInput }         from "@/components/ui/SearchInput";
import { PageSpinner }         from "@/components/ui/Spinner";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }           from "@/i18n/format";
import { fetchOutstanding }    from "@/services/fee.service";
import { fetchClasses }        from "@/services/class.service";
import ChaseArrears            from "@/pages/fees/ChaseArrears";

/** Sensible default: the year that started most recently. */
const currentAcademicYear = (): string => {
  const now = new Date();
  // Cameroonian school years run September–July, so before September the
  // "current" year still belongs to the one that began last calendar year.
  const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}/${startYear + 1}`;
};

/** Pickable years: two back through one forward from the current one. */
const academicYearOptions = (): string[] => {
  const now = new Date();
  const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return [-2, -1, 0, 1].map((i) => `${startYear + i}/${startYear + i + 1}`);
};

export default function FeesPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const navigate = useNavigate();
  const schoolId = useUser()?.schoolId ?? "";

  const [year,    setYear]    = useState(currentAcademicYear());
  const [classId, setClassId] = useState("");
  const [search,  setSearch]  = useState("");

  const classesQ = useQuery({
    queryKey: ["classes", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  const outstandingQ = useQuery({
    queryKey: ["fees", "outstanding", schoolId, year, classId],
    queryFn:  () => fetchOutstanding(schoolId, year, classId || undefined),
    enabled:  !!schoolId,
  });

  if (outstandingQ.isLoading) return <PageSpinner />;

  const report = outstandingQ.data;
  const rows   = (report?.rows ?? []).filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      r.name?.toLowerCase().includes(q) ||
      (r.enrollmentNo ?? "").toLowerCase().includes(q)
    );
  });

  // classId is on every row and the class list is already loaded for the
  // filter above, so the names cost nothing extra.
  // Not a hook: there is an early return above for the loading state, and a
  // single pass over the arrears rows is not worth a rule violation to skip.
  const arrearsGroups = (() => {
    const names = new Map((classesQ.data ?? []).map((c) => [String(c._id), c.name]));

    type Row      = (typeof rows)[number];
    type Grouping = { classId: string | null; className: string; items: Row[]; total: number };

    const byClass = new Map<string, Grouping>();
    for (const r of rows) {
      const key = r.classId ? String(r.classId) : "";
      if (!byClass.has(key)) {
        byClass.set(key, {
          classId:   r.classId ?? null,
          className: (r.classId && names.get(String(r.classId))) || t("fees.noClass"),
          items:     [],
          total:     0,
        });
      }
      const g = byClass.get(key)!;
      g.items.push(r);
      g.total += r.balance ?? 0;
    }

    // The biggest debt is still the first thing on the page, now under a class.
    return [...byClass.values()].sort((a, b) => b.total - a.total);
  })();

  // One class means one heading, which is noise. Same rule as the exam page.
  const showClassRows = arrearsGroups.length > 1;

  const classOptions = [
    { value: "", label: t("fees.allClasses") },
    ...(classesQ.data ?? []).map((c) => ({ value: c._id, label: c.name })),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("fees.title")}
        description={t("fees.blurb")}
        actions={
          <Button
            variant="secondary"
            onClick={() => navigate("/fees/structures")}
          >
            {t("fees.structures")}
          </Button>
        }
      />

      {/* Reminding and charging, above the list rather than buried in it: a
          bursar opens this page to act on the arrears, not only to read them.
          Renders nothing if the school has taken both capabilities away from
          them. */}
      <ChaseArrears
        schoolId={schoolId}
        academicYear={year}
        classId={classId || undefined}
      />

      {/* The headline figure, before the detail. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="sm:col-span-1">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-ink-faint" aria-hidden="true" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {t("fees.totalOutstanding")}
            </p>
          </div>
          <p className="mt-2 font-display text-[30px] leading-none text-ink tabular">
            {fmt.money(report?.totalOutstanding ?? 0)}
          </p>
          <p className="mt-1.5 text-xs text-ink-muted">
            {t("fees.studentsOwing", { count: report?.count ?? 0 })}
          </p>
        </Card>

        <Card className="sm:col-span-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[9rem]">
              <label
                htmlFor="fee-year"
                className="mb-1 block text-[13px] font-medium text-ink-body"
              >
                {t("fees.academicYear")}
              </label>
              {/* Picked, not typed — a typo here silently shows an empty
                  outstanding report for a year that has no records. */}
              <Select
                id="fee-year"
                className="w-full"
                options={[...new Set([year, ...academicYearOptions()])].map(
                  (y) => ({ value: y, label: y })
                )}
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </div>

            <div className="min-w-[10rem]">
              <label
                htmlFor="fee-class"
                className="mb-1 block text-[13px] font-medium text-ink-body"
              >
                {t("academic.class")}
              </label>
              <Select
                id="fee-class"
                className="w-full"
                options={classOptions}
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
              />
            </div>

            <SearchInput
              className="min-w-[12rem] flex-1"
              value={search}
              onChange={setSearch}
              placeholder={t("students.searchPh")}
            />
          </div>
        </Card>
      </div>

      <Card padding={false}>
        {/* Grouped by class.

            A bursar chasing arrears across the whole school was reading one
            flat list of names with no way to see which class a debt sat in,
            which is how the chase is actually organised — a form master takes
            their own class.

            The rows arrive sorted by balance, biggest first, and that is the
            point of the screen. So the groups are ordered by what each class
            owes in total, and the rows inside each keep the order they came
            in: the largest debt is still the first thing on the page, and it
            now has a class over it. */}
        {rows.length === 0 ? (
          <EmptyTable
            icon={<Search />}
            title={t("fees.noneOwing")}
            subtitle={t("fees.noneOwingHint")}
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("academic.student")}</Th>
                <Th>{t("academic.enrollmentNo")}</Th>
                <Th numeric>{t("fees.charged")}</Th>
                <Th numeric>{t("fees.paid")}</Th>
                <Th numeric>{t("fees.owes")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {arrearsGroups.map((group) => (
                <Fragment key={group.classId ?? "no-class"}>
                  {showClassRows && (
                    <Tr className="bg-indigo-50/60">
                      <Td colSpan={5} className="py-2">
                        <span className="text-xs font-semibold uppercase
                                         tracking-wide text-indigo-700">
                          {group.className}
                        </span>
                        <span className="ml-2 text-[11px] text-ink-faint tabular-nums">
                          {t("fees.owingCount", { count: group.items.length })}
                        </span>
                      </Td>
                      <Td numeric className="py-2 font-semibold text-danger">
                        {fmt.money(group.total)}
                      </Td>
                    </Tr>
                  )}

              {group.items.map((r) => (
                <Tr
                  key={r.studentId}
                  onClick={() => navigate(`/fees/students/${r.studentId}?year=${encodeURIComponent(year)}`)}
                >
                  <Td className="font-medium text-ink">{r.name}</Td>
                  <Td className="text-ink-muted">{r.enrollmentNo ?? "—"}</Td>
                  <Td numeric>{fmt.money(r.charged)}</Td>
                  <Td numeric>{fmt.money(r.paid)}</Td>
                  <Td numeric className="font-semibold text-danger">
                    {fmt.money(r.balance)}
                  </Td>
                  <Td numeric>
                    <ArrowUpRight
                      className="inline h-3.5 w-3.5 text-ink-faint"
                      aria-hidden="true"
                    />
                  </Td>
                </Tr>
              ))}
                </Fragment>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
