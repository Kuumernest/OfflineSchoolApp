// web/src/pages/portal/ResultsScreen.tsx
//
// Results for the selected child, one term at a time: each published result
// with its average /20, class position and remark, every subject with its
// mark /20, coefficient and remark, and the report card the school issued.
// Above them, how the average has moved across every published result.
//
// Figures are shown as the server sends them; nothing is recomputed here.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FileDown, GraduationCap, TrendingUp } from "lucide-react";

import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import { printHtml } from "@/print/document";
import { fetchResults, fetchReportCard, type PortalResult } from "@/services/portal.service";
import { PortalCard, Skeleton, EmptyState } from "./ui";
import { ordinal, on20, mark } from "./format";
import { TrendChart } from "./TrendChart";

export function ResultsScreen({ studentId }: { studentId: string | null }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["portal", "results", studentId], queryFn: () => fetchResults(studentId),
    enabled: Boolean(studentId), retry: false,
  });

  // Terms newest first, each with its results newest first (the order sent).
  const terms = useMemo(() => {
    const out: { key: string; term: string | null; year: string | null; rows: PortalResult[] }[] = [];
    for (const r of q.data ?? []) {
      const key = `${r.academicYear}|${r.term}`;
      let g = out.find((x) => x.key === key);
      if (!g) { g = { key, term: r.term, year: r.academicYear, rows: [] }; out.push(g); }
      g.rows.push(r);
    }
    return out;
  }, [q.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const current = terms.find((g) => g.key === picked) ?? terms[0];

  const trend = useMemo(() => [...(q.data ?? [])].reverse()
    .filter((r) => r.average != null)
    .map((r) => ({ key: r._id, label: r.examName ?? `T${r.term}`, value: r.average as number })), [q.data]);

  if (q.isLoading || !studentId) return <ResultsSkeleton />;
  if (!q.data?.length) {
    return (
      <PortalCard>
        <EmptyState icon={<GraduationCap className="h-6 w-6" />} title={t("portal.resultsScreen.empty")} hint={t("portal.resultsScreen.emptyHint")} />
      </PortalCard>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">{t("portal.resultsScreen.title")}</h1>

      {trend.length >= 2 && (
        <PortalCard className="p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <TrendingUp className="h-4 w-4 text-primary-600" aria-hidden="true" />{t("portal.resultsScreen.trend")}
          </h2>
          <TrendChart points={trend} />
        </PortalCard>
      )}

      {terms.length > 1 && (
        <div role="tablist" aria-label={t("portal.resultsScreen.chooseTerm")} className="-mx-1 flex gap-2 overflow-x-auto px-1">
          {terms.map((g) => (
            <button key={g.key} type="button" role="tab" aria-selected={g.key === current?.key} onClick={() => setPicked(g.key)}
              className={cn("min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors",
                g.key === current?.key ? "border-primary-600 bg-primary-600 text-white" : "border-line-strong bg-surface text-ink-body hover:bg-surface-muted")}>
              {t("portal.resultsScreen.term", { term: g.term, year: g.year })}
            </button>
          ))}
        </div>
      )}

      {current?.rows.map((r) => <ResultCard key={r._id} result={r} studentId={studentId} />)}
    </div>
  );
}

function ResultCard({ result: r, studentId }: { result: PortalResult; studentId: string }) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const [card, setCard] = useState<"idle" | "loading" | "notIssued" | "failed">("idle");

  const openCard = async () => {
    setCard("loading");
    try {
      const { html } = await fetchReportCard(r._id, studentId);
      await printHtml(html);
      setCard("idle");
    } catch (err) {
      // Only the server's "not issued" means not issued; a dropped connection
      // on slow data is worth another try.
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      setCard(code === "NOT_ISSUED" ? "notIssued" : "failed");
    }
  };

  return (
    <PortalCard as="article" className="overflow-hidden" aria-labelledby={`res-${r._id}`}>
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-4 py-4">
        <div className="min-w-0">
          <h2 id={`res-${r._id}`} className="font-semibold text-ink">{r.examName ?? t("portal.resultsScreen.term", { term: r.term, year: r.academicYear })}</h2>
          <p className="text-xs text-ink-muted">
            {t("portal.resultsScreen.term", { term: r.term, year: r.academicYear })}
            {r.issuedAt ? ` · ${t("portal.resultsScreen.published", { date: fmt.date(r.issuedAt) })}` : ""}
          </p>
        </div>
        <div className="w-full sm:w-auto sm:text-right">
          <p className="text-2xl font-semibold tabular-nums text-ink">{on20(r.average, i18n.resolvedLanguage)}<span className="text-sm font-medium text-ink-faint">/20</span></p>
          {r.classPosition != null && r.totalInClass != null && (
            <p className="text-sm text-ink-body">{t("portal.resultsScreen.rank", { position: ordinal(r.classPosition, i18n.resolvedLanguage), outOf: r.totalInClass })}</p>
          )}
        </div>
        {r.overallRemark && (
          <p className="w-full text-sm">
            <span className="rounded-full bg-primary-50 px-2.5 py-0.5 font-medium text-primary-800">{r.overallRemark}</span>
          </p>
        )}
      </header>

      {/* Phone: one row per subject. Wider: a table with the column names. */}
      <table className="w-full text-left text-sm">
        <thead className="hidden bg-surface-muted text-xs text-ink-muted sm:table-header-group">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">{t("portal.resultsScreen.subject")}</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">{t("portal.resultsScreen.mark")}</th>
            <th scope="col" className="px-2 py-2 text-right font-medium">{t("portal.resultsScreen.coef")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("portal.resultsScreen.remark")}</th>
          </tr>
        </thead>
        <tbody>
          {r.subjects.map((s, i) => (
            <tr key={s.subjectId ?? i} className="border-t border-line first:border-t-0 sm:first:border-t">
              <td className="px-4 py-3 align-top">
                <p className="font-medium text-ink">{s.subjectName}</p>
                <p className="text-xs text-ink-muted sm:hidden">
                  {s.remark ?? ""}{s.coefficient != null ? `${s.remark ? " · " : ""}${t("portal.resultsScreen.coef")} ${s.coefficient}` : ""}
                </p>
              </td>
              <td className="py-3 pl-2 pr-4 text-right align-top sm:pr-2">
                {s.isAbsent ? <span className="text-ink-muted">{t("portal.resultsScreen.absent")}</span> : (
                  <span className={cn("font-semibold tabular-nums", s.isPassing ? "text-ink" : "text-danger")}>
                    {mark(s.normalizedMark, i18n.resolvedLanguage)}
                    {!s.isPassing && <span className="sr-only"> ({t("portal.resultsScreen.belowPass")})</span>}
                  </span>
                )}
              </td>
              <td className="hidden px-2 py-3 text-right align-top tabular-nums text-ink-body sm:table-cell">{s.coefficient ?? "–"}</td>
              <td className="hidden px-4 py-3 align-top text-ink-body sm:table-cell">{s.remark ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="border-t border-line px-4 py-3">
        <button type="button" onClick={openCard} disabled={card === "loading"}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-control border border-line-strong bg-surface text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-60 sm:w-auto sm:px-4">
          <FileDown className="h-4 w-4" aria-hidden="true" />{t("portal.resultsScreen.reportCard")}
        </button>
        <p className="mt-1.5 text-xs text-ink-muted" aria-live="polite">
          {card === "notIssued" ? t("portal.resultsScreen.notIssued")
            : card === "failed" ? t("portal.resultsScreen.openFailed") : t("portal.resultsScreen.reportCardHint")}
        </p>
      </footer>
    </PortalCard>
  );
}

function ResultsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-28" />
      <Skeleton className="h-44 w-full rounded-card" />
      <PortalCard className="space-y-3 p-4">
        <div className="flex justify-between"><Skeleton className="h-5 w-32" /><Skeleton className="h-7 w-20" /></div>
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
      </PortalCard>
    </div>
  );
}
