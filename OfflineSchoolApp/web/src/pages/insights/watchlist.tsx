// web/src/pages/insights/watchlist.tsx
//
// The watch list — students whose recorded data says something is going wrong.
//
// Every row is built server-side from records the school already keeps:
// attendance, published results, homework submissions, the fee ledger. The
// page's whole job is to show the REASONS, not just a score — "absent 6 of 20
// days, failed the last exam" is something a head teacher can act on or argue
// with; a bare number is neither.

import { useState }       from "react";
import { useQuery }       from "@tanstack/react-query";
import { useNavigate }    from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ShieldAlert, Eye, Search } from "lucide-react";

import { useUser }      from "@/store/auth.store";
import { PageHeader }   from "@/components/ui/PageHeader";
import { Card }         from "@/components/ui/Card";
import { Select }       from "@/components/ui/Select";
import { SearchInput }  from "@/components/ui/SearchInput";
import { PageSpinner }  from "@/components/ui/Spinner";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }    from "@/i18n/format";
import { cn }           from "@/utils/cn";
import { fetchClasses } from "@/services/class.service";
import {
  fetchWatchlist,
  type WatchSignal,
  type WatchStudent,
  type WatchTier,
} from "@/services/insights.service";

const TIER_STYLE: Record<WatchTier, { badge: string; dot: string }> = {
  high:   { badge: "bg-red-50 text-red-700",       dot: "bg-red-500" },
  medium: { badge: "bg-amber-50 text-amber-700",   dot: "bg-amber-500" },
  low:    { badge: "bg-slate-100 text-slate-600",  dot: "bg-slate-400" },
};

export default function WatchlistPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const navigate = useNavigate();
  const schoolId = useUser()?.schoolId ?? "";

  const [days,    setDays]    = useState(30);
  const [tier,    setTier]    = useState<"" | WatchTier>("");
  const [classId, setClassId] = useState("");
  const [search,  setSearch]  = useState("");

  const classesQ = useQuery({
    queryKey: ["classes", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  const watchQ = useQuery({
    queryKey: ["watchlist", schoolId, days],
    queryFn:  () => fetchWatchlist(schoolId, days),
    enabled:  !!schoolId,
    // The list is an aggregation over four collections; no need to rerun it
    // on every focus change while someone works through the rows.
    staleTime: 60_000,
  });

  if (watchQ.isLoading) return <PageSpinner />;

  const list = watchQ.data;

  /** One signal, in the reader's language, with the numbers filled in. */
  const signalText = (s: WatchSignal): string => {
    if (s.code === "fees_outstanding") {
      return t("watch.sig.fees_outstanding", {
        balance: fmt.money(Number(s.data.balance ?? 0)),
      });
    }
    return t(`watch.sig.${s.code}`, { ...s.data } as Record<string, unknown>);
  };

  const rows = (list?.students ?? []).filter((r: WatchStudent) => {
    if (tier && r.tier !== tier) return false;
    if (classId && r.classId !== classId) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (r.name ?? "").toLowerCase().includes(q) ||
      (r.enrollmentNo ?? "").toLowerCase().includes(q)
    );
  });

  const classOptions = [
    { value: "", label: t("watch.allClasses") },
    ...(classesQ.data ?? []).map((c) => ({ value: c._id, label: c.name })),
  ];

  const tierCards: Array<{ key: WatchTier; count: number; hint: string }> = [
    { key: "high",   count: list?.counts.high   ?? 0, hint: t("watch.highHint") },
    { key: "medium", count: list?.counts.medium ?? 0, hint: t("watch.mediumHint") },
    { key: "low",    count: list?.counts.low    ?? 0, hint: t("watch.lowHint") },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("watch.title")}
        description={t("watch.blurb", { days: list?.windowDays ?? days })}
      />

      {/* The three tiers, each a filter as well as a figure. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {tierCards.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setTier(tier === c.key ? "" : c.key)}
            className="text-left"
          >
            <Card
              className={cn(
                "h-full transition-shadow",
                tier === c.key && "ring-2 ring-indigo-400"
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", TIER_STYLE[c.key].dot)} />
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  {t(`watch.tier.${c.key}`)}
                </p>
              </div>
              <p className="mt-2 font-display text-[30px] leading-none text-ink tabular">
                {c.count}
              </p>
              <p className="mt-1.5 text-xs text-ink-muted">{c.hint}</p>
            </Card>
          </button>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[9rem]">
            <label
              htmlFor="watch-days"
              className="mb-1 block text-[13px] font-medium text-ink-body"
            >
              {t("watch.window")}
            </label>
            <Select
              id="watch-days"
              className="w-full"
              options={[30, 60, 90].map((d) => ({
                value: String(d), label: t("watch.lastDays", { days: d }),
              }))}
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </div>

          <div className="min-w-[10rem]">
            <label
              htmlFor="watch-class"
              className="mb-1 block text-[13px] font-medium text-ink-body"
            >
              {t("academic.class")}
            </label>
            <Select
              id="watch-class"
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

      <Card padding={false}>
        {rows.length === 0 ? (
          <EmptyTable
            icon={list?.students.length ? <Search /> : <Eye />}
            title={list?.students.length ? t("watch.noMatch") : t("watch.empty")}
            subtitle={list?.students.length ? undefined : t("watch.emptyHint")}
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("academic.student")}</Th>
                <Th>{t("academic.class")}</Th>
                <Th>{t("watch.signals")}</Th>
                <Th numeric>{t("watch.level")}</Th>
              </Tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <Tr key={r.studentId} onClick={() => navigate(`/students/${r.studentId}`)}>
                  <Td className="font-medium text-ink">
                    {r.name ?? "—"}
                    {r.enrollmentNo ? (
                      <span className="ml-2 text-xs font-normal text-ink-faint">
                        {r.enrollmentNo}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="text-ink-muted">{r.className ?? "—"}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {r.signals.map((s, i) => (
                        <span
                          key={`${s.code}-${i}`}
                          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700"
                        >
                          {s.points >= 2 && (
                            <AlertTriangle
                              className="h-3 w-3 text-amber-600"
                              aria-hidden="true"
                            />
                          )}
                          {signalText(s)}
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td numeric>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        TIER_STYLE[r.tier].badge
                      )}
                    >
                      {r.tier === "high" && (
                        <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                      )}
                      {t(`watch.tier.${r.tier}`)}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <p className="text-xs text-ink-faint">{t("watch.footnote")}</p>
    </div>
  );
}
