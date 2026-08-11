// web/src/pages/dashboard/DashboardPage.tsx
import { useQuery }        from "@tanstack/react-query";
import { useNavigate }     from "react-router-dom";
import {
  Users, GraduationCap, School, FileText,
  BookOpen, CheckSquare, TrendingUp, AlertCircle,
  Clock, UserCheck,
} from "lucide-react";

import { useUser }               from "@/store/auth.store";
import { PageSpinner }           from "@/components/ui/Spinner";
import StatCard                  from "@/components/dashboard/StatCard";
import RecentExams               from "@/components/dashboard/RecentExams";
import RecentAnnouncements       from "@/components/dashboard/RecentAnnouncements";
import ExamStatusChart           from "@/components/dashboard/ExamStatusChart";
import AttendanceWidget          from "@/components/dashboard/AttendanceWidget";
import SchoolBanner              from "@/components/dashboard/SchoolBanner";
import SystemHealthGrid          from "@/components/dashboard/SystemHealthGrid";
import AlertsPanel, {
  deriveAlerts,
}                                from "@/components/dashboard/AlertsPanel";
import ModulesGrid               from "@/components/dashboard/ModulesGrid";
import { QUICK_ACTIONS }         from "@/constants/dashboard.constants";

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
      className="
        flex items-center gap-2 rounded-lg
        border border-red-200 dark:border-red-800
        bg-red-50 dark:bg-red-900/20
        px-4 py-3 text-sm text-red-700 dark:text-red-400
      "
    >
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING APPLICATIONS BANNER
// ─────────────────────────────────────────────────────────────────────────────

function PendingApplicationsBanner({
  count,
  onClick,
}: {
  count:   number;
  onClick: () => void;
}) {
  if (count === 0) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      className="
        w-full flex items-center gap-3 rounded-xl
        border border-amber-200 bg-amber-50
        px-5 py-4 text-left transition
        hover:bg-amber-100
        dark:border-amber-700 dark:bg-amber-900/20
        dark:hover:bg-amber-900/30
      "
    >
      {/* Pulsing dot */}
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500" />
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-300">
          {count} Pending Student Application{count !== 1 ? "s" : ""}
        </p>
        <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
          {count === 1
            ? "1 student is waiting for review and approval."
            : `${count} students are waiting for review and approval.`}
          {" "}Click to review →
        </p>
      </div>

      {/* Count badge */}
      <span className="
        shrink-0 inline-flex items-center justify-center
        h-8 w-8 rounded-full bg-amber-500 text-white
        text-sm font-bold
      ">
        {count > 99 ? "99+" : count}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Welcome header ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Welcome back, {user?.name?.split(" ")[0]} 👋
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Here&apos;s what&apos;s happening at your school today.
          </p>
        </div>

        {/* Live attendance pill */}
        {ad && (
          <div className="
            flex items-center gap-2 rounded-full
            border border-gray-200 dark:border-gray-700
            bg-white dark:bg-gray-800
            px-4 py-2 shadow-sm text-sm
          ">
            <span
              className={`h-2 w-2 rounded-full ${
                ad.rate >= 75 ? "bg-green-500" : "bg-red-500"
              }`}
              aria-hidden="true"
            />
            <span className="font-medium text-gray-700 dark:text-gray-300">
              Today&apos;s Attendance:
            </span>
            <span className={`font-bold ${
              ad.rate >= 75 ? "text-green-600" : "text-red-600"
            }`}>
              {ad.rate}%
            </span>
          </div>
        )}
      </div>

      {/* ── School banner ── */}
      {schoolQ.data && <SchoolBanner school={schoolQ.data} />}

      {/* ── Pending applications banner ── */}
      <PendingApplicationsBanner
        count={pendingCount}
        onClick={() => navigate("/students/applications")}
      />

      {/* ── Core error (informational — data still shows as zeros) ── */}
      {coreError && (
        <ErrorBanner
          message={
            (coreError as Error)?.message ??
            "Some dashboard stats could not be loaded."
          }
        />
      )}

      {/* ══ ROW 1 — Stat Cards ══════════════════════════════════════════ */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">

        <StatCard
          title="Students"
          value={sd?.total ?? 0}
          subtitle={
            pendingCount > 0
              ? `${pendingCount} pending approval`
              : `${sd?.active ?? 0} active`
          }
          subtitleColor={pendingCount > 0 ? "text-amber-600 font-semibold" : undefined}
          icon={GraduationCap}
          iconColor="text-blue-600"
          iconBg="bg-blue-50 dark:bg-blue-900/20"
          href="/students"
        />

        <StatCard
          title="Teachers"
          value={td?.total ?? 0}
          subtitle={`${td?.active ?? 0} active`}
          icon={Users}
          iconColor="text-green-600"
          iconBg="bg-green-50 dark:bg-green-900/20"
          href="/teachers"
        />

        <StatCard
          title="Classes"
          value={cd?.total ?? 0}
          subtitle={`${cd?.withSubjects ?? 0} with subjects`}
          icon={School}
          iconColor="text-purple-600"
          iconBg="bg-purple-50 dark:bg-purple-900/20"
          href="/classes"
        />

        <StatCard
          title="Subjects"
          value={bd?.total ?? 0}
          subtitle="Across all classes"
          icon={BookOpen}
          iconColor="text-pink-600"
          iconBg="bg-pink-50 dark:bg-pink-900/20"
          href="/classes?tab=subjects"
        />

        <StatCard
          title="Exams"
          value={ed?.total ?? 0}
          subtitle={`${ed?.ongoing ?? 0} ongoing`}
          icon={FileText}
          iconColor="text-orange-600"
          iconBg="bg-orange-50 dark:bg-orange-900/20"
          href="/exams"
        />

        <StatCard
          title="Attendance"
          value={`${ad?.rate ?? 0}%`}
          subtitle={`${ad?.todayPresent ?? 0} present today`}
          icon={CheckSquare}
          iconColor="text-teal-600"
          iconBg="bg-teal-50 dark:bg-teal-900/20"
          href="/attendance"
        />

      </div>

      {/* ══ ROW 2 — Quick-access cards when applications are pending ════ */}
      {pendingCount > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          <button
            type="button"
            onClick={() => navigate("/students/applications")}
            className="
              flex items-center gap-4 rounded-xl text-left transition
              border border-amber-200 bg-amber-50
              px-5 py-4 hover:bg-amber-100
              dark:border-amber-700 dark:bg-amber-900/20
            "
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-white">
              <Clock className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Review Applications
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                {pendingCount} student{pendingCount !== 1 ? "s" : ""} awaiting approval
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={() => navigate("/students?status=approved")}
            className="
              flex items-center gap-4 rounded-xl text-left transition
              border border-emerald-200 bg-emerald-50
              px-5 py-4 hover:bg-emerald-100
              dark:border-emerald-700 dark:bg-emerald-900/20
            "
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white">
              <UserCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                Approved Students
              </p>
              <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
                {sd?.total ?? 0} enrolled
              </p>
            </div>
          </button>

        </div>
      )}

      {/* ══ ROW 3 — System Health + Alerts ═════════════════════════════ */}
      <div className="space-y-4">
        {hd ? (
          <SystemHealthGrid stats={hd} />
        ) : healthQ.isLoading ? (
          <div className="
            flex h-44 items-center justify-center rounded-xl
            border border-gray-200 dark:border-gray-700
            bg-white dark:bg-gray-800 shadow-sm
          ">
            <span className="text-sm text-gray-400">Loading health stats…</span>
          </div>
        ) : null}

        {alerts.length > 0 && <AlertsPanel alerts={alerts} />}
      </div>

      {/* ══ ROW 4 — Chart + Attendance + Announcements ══════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <ExamStatusChart
          stats={{
            ongoing:   ed?.ongoing   ?? 0,
            completed: ed?.completed ?? 0,
            draft:     ed?.draft     ?? 0,
            total:     ed?.total     ?? 0,
          }}
        />
        <AttendanceWidget
          present={ad?.todayPresent ?? 0}
          absent={ad?.todayAbsent   ?? 0}
          rate={ad?.rate            ?? 0}
          loading={attendanceQ.isLoading}
        />
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
      </div>

      {/* ══ ROW 5 — Recent Exams + Quick Actions ════════════════════════ */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        <RecentExams exams={recentExamsQ.data ?? []} />

        {/* Quick Actions */}
        <div className="
          rounded-xl border border-gray-200 dark:border-gray-700
          bg-white dark:bg-gray-800 p-5 shadow-sm
        ">
          <div className="flex items-center gap-2 mb-5">
            <TrendingUp className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            <h3 className="font-semibold text-gray-900 dark:text-white">
              Quick Actions
            </h3>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4 gap-3">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => navigate(action.path)}
                className="
                  flex min-h-24 flex-col items-center justify-center gap-2
                  rounded-xl border border-gray-200 dark:border-gray-700
                  px-3 py-4 text-center
                  hover:bg-gray-50 dark:hover:bg-gray-700
                  transition-colors
                "
              >
                <span className="text-2xl" aria-hidden="true">
                  {action.emoji}
                </span>
                <span className="text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-300 leading-tight">
                  {action.label}
                </span>
              </button>
            ))}
          </div>
        </div>

      </div>

      {/* ══ ROW 6 — Modules Grid ════════════════════════════════════════ */}
      <ModulesGrid />

    </div>
  );
}