// web/src/pages/dashboard/DashboardPage.tsx
import { useQuery }        from "@tanstack/react-query";
import { useNavigate }     from "react-router-dom";
import { useTranslation }  from "react-i18next";
import {
  Users, GraduationCap, School, FileText,
  BookOpen, CheckSquare, AlertCircle, ArrowRight,
} from "lucide-react";

import { useUser }               from "@/store/auth.store";
import { PageSpinner }           from "@/components/ui/Spinner";
import { PageHeader }            from "@/components/ui/PageHeader";
import { useFormat }              from "@/i18n/format";
import StatCard                  from "@/components/dashboard/StatCard";
import RecentExams               from "@/components/dashboard/RecentExams";
import RecentAnnouncements       from "@/components/dashboard/RecentAnnouncements";
import ExamStatusChart           from "@/components/dashboard/ExamStatusChart";
import AttendanceWidget          from "@/components/dashboard/AttendanceWidget";
import SchoolBanner              from "@/components/dashboard/SchoolBanner";
import SystemHealthGrid          from "@/components/dashboard/SystemHealthGrid";
import QuickActions              from "@/components/dashboard/QuickActions";
import AlertsPanel, {
  deriveAlerts,
}                                from "@/components/dashboard/AlertsPanel";

import {
  fetchStudentStats,
  fetchTeacherStats,
  fetchClassStats,
  fetchSubjectStats,
  fetchExamStats,
  fetchAttendanceStats,
  fetchRecentExams,
  fetchRecentAnnouncements,
  fetchSystemHealth,
  fetchSchoolInfo,
} from "@/services/dashboard.service";

import { fetchPendingStudents } from "@/services/student.service";

// ─────────────────────────────────────────────────────────────────────────────
// ERROR BANNER
// ─────────────────────────────────────────────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-card border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING APPLICATIONS
//
// This used to appear three times on one screen — a banner at the top, the
// subtitle of the Students stat, and a large amber quick-access card below it.
// Saying the same thing three times does not make it more urgent, it makes the
// page look padded. One row, once.
// ─────────────────────────────────────────────────────────────────────────────

function PendingApplications({
  count,
  onClick,
}: {
  count:   number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (count === 0) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="
        group flex w-full items-center gap-3 rounded-card
        border border-warning-line bg-warning-soft px-4 py-3
        text-left transition-colors hover:brightness-[0.98]
      "
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-sm text-warning">
        {/*
          Pluralisation goes through i18next rather than `count !== 1 ? "s" : ""`.
          French pluralises differently — 0 takes the singular — so the English
          rule baked into JSX produces wrong French no matter the translation.
        */}
        <span className="font-semibold">
          {t("dashboard.pendingApplications", { count })}
        </span>
        <span className="text-warning/80">
          {" "}{t("dashboard.awaitingReview")}
        </span>
      </p>
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-warning">
        {t("dashboard.review")}
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const user     = useUser();
  const navigate = useNavigate();
  const schoolId = user?.schoolId ?? "";

  // ── All queries run in parallel ───────────────────────────────────────────
  // Core stat queries — dashboard waits for these before rendering
  const studentQ = useQuery({
    queryKey: ["dashboard", "students",    schoolId],
    queryFn:  () => fetchStudentStats(schoolId),
    enabled:  !!schoolId,
  });

  const teacherQ = useQuery({
    queryKey: ["dashboard", "teachers",    schoolId],
    queryFn:  () => fetchTeacherStats(schoolId),
    enabled:  !!schoolId,
  });

  const classQ = useQuery({
    queryKey: ["dashboard", "classes",     schoolId],
    queryFn:  () => fetchClassStats(schoolId),
    enabled:  !!schoolId,
  });

  const subjectQ = useQuery({
    queryKey: ["dashboard", "subjects",    schoolId],
    queryFn:  () => fetchSubjectStats(schoolId),
    enabled:  !!schoolId,
  });

  const examQ = useQuery({
    queryKey: ["dashboard", "exams",       schoolId],
    queryFn:  () => fetchExamStats(schoolId),
    enabled:  !!schoolId,
  });

  const attendanceQ = useQuery({
    queryKey: ["dashboard", "attendance",  schoolId],
    queryFn:  () => fetchAttendanceStats(schoolId),
    enabled:  !!schoolId,
  });

  // Non-blocking queries — render without waiting for these
  const healthQ = useQuery({
    queryKey: ["dashboard", "health",      schoolId],
    queryFn:  () => fetchSystemHealth(schoolId),
    enabled:  !!schoolId,
  });

  const schoolQ = useQuery({
    queryKey:  ["dashboard", "school",     schoolId],
    queryFn:   () => fetchSchoolInfo(schoolId),
    enabled:   !!schoolId,
    staleTime: 1000 * 60 * 10,  // 10 min — school info rarely changes
  });

  const recentExamsQ = useQuery({
    queryKey: ["dashboard", "recentExams", schoolId],
    queryFn:  () => fetchRecentExams(schoolId),
    enabled:  !!schoolId,
  });

  const announcementsQ = useQuery({
    queryKey: ["dashboard", "announcements", schoolId],
    queryFn:  () => fetchRecentAnnouncements(schoolId),
    enabled:  !!schoolId,
  });

  // Pending applications — polled every 2 min, never blocks render
  const pendingQ = useQuery({
    queryKey:        ["dashboard", "pendingApps", schoolId],
    queryFn:         () => fetchPendingStudents(schoolId),
    enabled:         !!schoolId,
    staleTime:       1000 * 60 * 2,
    refetchInterval: 1000 * 60 * 2,
  });

  const pendingCount = pendingQ.data?.pagination?.total ?? 0;

  // ── Block render only on core queries ─────────────────────────────────────
  const coreLoading =
    studentQ.isLoading   ||
    teacherQ.isLoading   ||
    classQ.isLoading     ||
    subjectQ.isLoading   ||
    examQ.isLoading      ||
    attendanceQ.isLoading;

  if (coreLoading) return <PageSpinner />;

  // All fetchers now return zero-fallbacks on error so this is informational
  // only — the dashboard still renders even when some queries fail.
  const coreError =
    studentQ.error  ||
    teacherQ.error  ||
    classQ.error    ||
    subjectQ.error  ||
    examQ.error     ||
    attendanceQ.error;

  // ── Unwrap data ───────────────────────────────────────────────────────────
  const sd = studentQ.data;
  const td = teacherQ.data;
  const cd = classQ.data;
  const bd = subjectQ.data;
  const ed = examQ.data;
  const ad = attendanceQ.data;
  const hd = healthQ.data;

  const alerts = hd ? deriveAlerts(hd) : [];

  // Through the shared formatter, so the date follows the chosen language
  // rather than the browser's locale — those disagree the moment a user
  // switches to French on an English-configured machine.
  const today = fmt.date(new Date());

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/*
        One title, no greeting. "Welcome back, Lenora 👋" is the kind of line
        that reads warm on day one and as noise by day three — it occupied the
        most valuable strip of the page and carried no information.
      */}
      <PageHeader
        title={t("dashboard.title")}
        meta={
          <>
            <span>{today}</span>
            {schoolQ.data && (
              <>
                <span aria-hidden="true">·</span>
                <SchoolBanner school={schoolQ.data} />
              </>
            )}
          </>
        }
      />

      {/* ── Anything needing attention, grouped ───────────────────────────── */}
      {(coreError || pendingCount > 0 || alerts.length > 0) && (
        <div className="space-y-2">
          {coreError && (
            <ErrorBanner
              message={
                (coreError as Error)?.message ?? t("dashboard.statsFailed")
              }
            />
          )}

          <PendingApplications
            count={pendingCount}
            onClick={() => navigate("/students/applications")}
          />

          {alerts.length > 0 && <AlertsPanel alerts={alerts} />}
        </div>
      )}

      {/* ── Metrics ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard
          title={t("academic.student_other")}
          value={fmt.number(sd?.total ?? 0)}
          subtitle={
            pendingCount > 0
              ? t("dashboard.pendingCount", { count: pendingCount })
              : t("dashboard.activeCount",  { count: sd?.active ?? 0 })
          }
          subtitleColor={pendingCount > 0 ? "text-warning font-medium" : undefined}
          icon={GraduationCap}
          href="/students"
        />
        <StatCard
          title={t("academic.teacher_other")}
          value={fmt.number(td?.total ?? 0)}
          subtitle={t("dashboard.activeCount", { count: td?.active ?? 0 })}
          icon={Users}
          href="/teachers"
        />
        <StatCard
          title={t("academic.class_other")}
          value={fmt.number(cd?.total ?? 0)}
          subtitle={t("dashboard.withSubjects", { count: cd?.withSubjects ?? 0 })}
          icon={School}
          href="/classes"
        />
        <StatCard
          title={t("academic.subject_other")}
          value={fmt.number(bd?.total ?? 0)}
          subtitle={t("dashboard.acrossAllClasses")}
          icon={BookOpen}
          href="/classes?tab=subjects"
        />
        <StatCard
          title={t("nav.exams")}
          value={fmt.number(ed?.total ?? 0)}
          subtitle={t("dashboard.ongoingCount", { count: ed?.ongoing ?? 0 })}
          icon={FileText}
          href="/exams"
        />
        <StatCard
          title={t("nav.attendance")}
          value={`${fmt.number(ad?.rate ?? 0)}%`}
          subtitle={t("dashboard.presentToday", { count: ad?.todayPresent ?? 0 })}
          icon={CheckSquare}
          href="/attendance"
        />
      </div>

      {/*
        Content column + rail, rather than six full-width bands stacked down
        the page. The wide column takes the things you read (lists of exams and
        notices); the narrow one takes the things you glance at.
      */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">

        <div className="space-y-4 lg:col-span-2">
          <RecentExams exams={recentExamsQ.data ?? []} />

          <RecentAnnouncements
            announcements={announcementsQ.data ?? []}
            loading={announcementsQ.isLoading}
            error={
              announcementsQ.isError
                ? ((announcementsQ.error as Error)?.message ??
                    "Failed to load announcements")
                : undefined
            }
          />

          {hd && <SystemHealthGrid stats={hd} />}
        </div>

        <div className="space-y-4">
          <AttendanceWidget
            present={ad?.todayPresent ?? 0}
            absent={ad?.todayAbsent   ?? 0}
            rate={ad?.rate            ?? 0}
            loading={attendanceQ.isLoading}
          />

          <ExamStatusChart
            stats={{
              ongoing:   ed?.ongoing   ?? 0,
              completed: ed?.completed ?? 0,
              draft:     ed?.draft     ?? 0,
              total:     ed?.total     ?? 0,
            }}
          />

          <QuickActions />
        </div>

      </div>
    </div>
  );
}
