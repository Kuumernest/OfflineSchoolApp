// web/src/pages/portal/HomeScreen.tsx
//
// Home: one card per child, from one request (GET /portal/home). A parent can
// have several children at the school, and this is the screen that shows them
// side by side. Each figure is read as the screen it leads to reads it, so
// the card never disagrees with the page behind it.

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  GraduationCap, CalendarCheck, Wallet, CalendarClock, Megaphone,
  TrendingUp, TrendingDown, Minus, ChevronRight, Users,
} from "lucide-react";

import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import { fetchHome, type PortalHomeChild } from "@/services/portal.service";
import { PortalCard, Skeleton, EmptyState, ChildAvatar } from "./ui";
import { ordinal, on20 } from "./format";

export type PortalScreen = "home" | "results" | "attendance" | "fees" | "messages";

export function HomeScreen({ onOpen }: { onOpen: (childId: string, screen: PortalScreen) => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const homeQ = useQuery({ queryKey: ["portal", "home"], queryFn: fetchHome, retry: false, staleTime: 60_000 });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">{t("portal.home.title")}</h1>
        <p className="mt-0.5 text-sm text-ink-muted">{t("portal.home.subtitle")}</p>
      </div>

      {homeQ.isLoading && <HomeSkeleton />}

      {homeQ.data && homeQ.data.children.length === 0 && (
        <PortalCard><EmptyState icon={<Users className="h-6 w-6" />} title={t("portal.home.empty")} hint={t("portal.home.emptyHint")} /></PortalCard>
      )}

      {homeQ.data?.children.map((child, i) => (
        <ChildCard key={child._id} child={child} index={i} onOpen={onOpen} />
      ))}

      {homeQ.data?.latestNews && (
        <PortalCard className="p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-600" aria-hidden="true">
              <Megaphone className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">{t("portal.home.latestNews")}</p>
              <p className="mt-0.5 font-medium text-ink">{homeQ.data.latestNews.title}</p>
              {homeQ.data.latestNews.body && (
                <p className="mt-1 line-clamp-2 text-sm text-ink-body">{homeQ.data.latestNews.body}</p>
              )}
              <p className="mt-1 text-xs text-ink-faint">{fmt.date(homeQ.data.latestNews.createdAt)}</p>
            </div>
          </div>
          <button type="button" onClick={() => onOpen("", "messages")}
            className="mt-3 flex min-h-11 w-full items-center justify-center gap-1 rounded-control text-sm font-medium text-primary-700 hover:bg-primary-50">
            {t("portal.home.seeAll")} <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </PortalCard>
      )}
    </div>
  );
}

function ChildCard({ child, index, onOpen }: {
  child: PortalHomeChild; index: number; onOpen: (childId: string, screen: PortalScreen) => void;
}) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const latest = child.latest;
  const delta = latest?.average != null && latest.previousAverage != null
    ? Math.round((latest.average - latest.previousAverage) * 100) / 100 : null;

  return (
    <PortalCard as="article" aria-labelledby={`child-${child._id}`} className="overflow-hidden">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <ChildAvatar name={child.name} index={index} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 id={`child-${child._id}`} className="truncate text-base font-semibold text-ink">{child.name ?? child.enrollmentNo}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            {child.className && <span className="rounded-full bg-primary-50 px-2 py-0.5 font-medium text-primary-700">{child.className}</span>}
            {child.enrollmentNo && <span>{child.enrollmentNo}</span>}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-px bg-line">
        {/* Latest result */}
        <Tile icon={<GraduationCap className="h-4 w-4" />} label={t("portal.home.latestResult")} onClick={() => onOpen(child._id, "results")}>
          {latest?.average != null ? (
            <>
              <p className="text-2xl font-semibold tabular-nums text-ink">
                {on20(latest.average, i18n.resolvedLanguage)}<span className="text-sm font-medium text-ink-faint">/20</span>
              </p>
              {latest.position != null && latest.outOf != null && (
                <p className="text-sm text-ink-body">{t("portal.home.rank", { position: ordinal(latest.position, i18n.resolvedLanguage), outOf: latest.outOf })}</p>
              )}
              {latest.examName && <p className="text-xs text-ink-faint">{latest.examName}</p>}
              {delta != null && latest.previousExamName && <Change delta={delta} exam={latest.previousExamName} />}
            </>
          ) : <p className="text-sm text-ink-muted">{t("portal.home.noResults")}</p>}
        </Tile>

        {/* Attendance this month */}
        <Tile icon={<CalendarCheck className="h-4 w-4" />} label={t("portal.home.attendanceMonth")} onClick={() => onOpen(child._id, "attendance")}>
          {child.attendance.rate != null ? (
            <>
              <p className={cn("text-2xl font-semibold tabular-nums", child.attendance.rate >= 90 ? "text-ink" : "text-warning")}>
                {child.attendance.rate}%
              </p>
              <p className="text-sm text-ink-body">{t("portal.home.daysPresent", { present: child.attendance.present, marked: child.attendance.marked })}</p>
            </>
          ) : <p className="text-sm text-ink-muted">{t("portal.home.noRegister")}</p>}
        </Tile>

        {/* Fees */}
        <Tile icon={<Wallet className="h-4 w-4" />} label={t("portal.home.balance")} onClick={() => onOpen(child._id, "fees")}>
          {child.fees == null ? <Skeleton className="h-7 w-24" /> : child.fees.balance > 0 ? (
            <>
              <p className={cn("text-xl font-semibold tabular-nums", child.fees.isOverdue ? "text-danger" : "text-ink")}>{fmt.money(child.fees.balance)}</p>
              {child.fees.isOverdue ? (
                <span className="mt-1 inline-flex items-center rounded-full border border-danger-line bg-danger-soft px-2 py-0.5 text-xs font-semibold text-danger">
                  {t("portal.home.overdue")}
                </span>
              ) : child.fees.dueDate ? (
                <p className="text-sm text-ink-body">{t("portal.home.dueOn", { date: fmt.date(child.fees.dueDate) })}</p>
              ) : null}
            </>
          ) : (
            <p className="inline-flex items-center rounded-full border border-success-line bg-success-soft px-2 py-0.5 text-sm font-semibold text-success">
              {t("portal.home.paidUp")}
            </p>
          )}
        </Tile>

        {/* Next exam */}
        <Tile icon={<CalendarClock className="h-4 w-4" />} label={t("portal.home.nextExam")}>
          {child.nextExam ? (
            <>
              <p className="font-semibold text-ink">{child.nextExam.name}</p>
              <p className="text-sm text-ink-body">{t("portal.home.startsOn", { date: fmt.date(child.nextExam.startDate) })}</p>
            </>
          ) : <p className="text-sm text-ink-muted">{t("portal.home.noExam")}</p>}
        </Tile>
      </div>
    </PortalCard>
  );
}

/** One figure on a child's card; tappable when it leads somewhere. */
function Tile({ icon, label, children, onClick }: {
  icon: React.ReactNode; label: string; children: React.ReactNode; onClick?: () => void;
}) {
  const body = (
    <>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <span className="text-primary-600" aria-hidden="true">{icon}</span>{label}
      </p>
      {children}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick}
      className="min-h-[7.5rem] bg-surface p-4 text-left transition-colors hover:bg-surface-muted focus-visible:relative focus-visible:z-10">
      {body}
    </button>
  ) : <div className="min-h-[7.5rem] bg-surface p-4">{body}</div>;
}

function Change({ delta, exam }: { delta: number; exam: string }) {
  const { t, i18n } = useTranslation();
  const abs = on20(Math.abs(delta), i18n.resolvedLanguage);
  if (delta > 0) return (
    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-success">
      <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />{t("portal.home.up", { delta: abs, exam })}
    </p>
  );
  if (delta < 0) return (
    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-danger">
      <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />{t("portal.home.down", { delta: abs, exam })}
    </p>
  );
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-ink-muted">
      <Minus className="h-3.5 w-3.5" aria-hidden="true" />{t("portal.home.same", { exam })}
    </p>
  );
}

function HomeSkeleton() {
  return (
    <>
      {[0, 1].map((k) => (
        <PortalCard key={k} className="overflow-hidden">
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="flex-1 space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-20" /></div>
          </div>
          <div className="grid grid-cols-2 gap-px bg-line">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="space-y-2 bg-surface p-4"><Skeleton className="h-3 w-20" /><Skeleton className="h-7 w-16" /><Skeleton className="h-3 w-24" /></div>
            ))}
          </div>
        </PortalCard>
      ))}
    </>
  );
}
