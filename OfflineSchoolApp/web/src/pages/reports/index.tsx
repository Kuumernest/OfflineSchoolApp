// web/src/pages/reports/index.tsx
//
// The Reports landing page: school-wide numbers, plus the way in to the report
// card builder and the exam reports.
//
// /reports is linked from both the sidebar and the dashboard quick actions, but
// only /reports/templates, /reports/builder and /reports/preview existed — so
// the parent route went nowhere.
//
// Each figure is fetched by its own query rather than one combined call. The
// stat endpoints are independent and some of them are slow; one query per card
// means a slow exam count does not hold up the student total, and a single
// endpoint being down degrades one card instead of the page.

import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import {
  Users,
  School,
  BookMarked,
  FileText,
  LayoutTemplate,
  ClipboardCheck,
  ArrowRight,
  TrendingUp,
} from "lucide-react";

import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import {
  fetchStudentStats,
  fetchTeacherStats,
  fetchClassStats,
  fetchSubjectStats,
  fetchExamStats,
} from "@/services/dashboard.service";
import { fetchOverview } from "@/services/attendance.service";
import { useUser } from "@/store/auth.store";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────

export default function ReportsOverviewPage() {
  const { t } = useTranslation();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [students, teachers, classes, subjects, exams, attendance] = useQueries({
    queries: [
      { queryKey: ["stats", "students", schoolId], queryFn: () => fetchStudentStats(schoolId), enabled: !!schoolId },
      { queryKey: ["stats", "teachers", schoolId], queryFn: () => fetchTeacherStats(schoolId), enabled: !!schoolId },
      { queryKey: ["stats", "classes",  schoolId], queryFn: () => fetchClassStats(schoolId),   enabled: !!schoolId },
      { queryKey: ["stats", "subjects", schoolId], queryFn: () => fetchSubjectStats(schoolId), enabled: !!schoolId },
      { queryKey: ["stats", "exams",    schoolId], queryFn: () => fetchExamStats(schoolId),    enabled: !!schoolId },
      { queryKey: ["attendance-overview", schoolId, "today"], queryFn: () => fetchOverview(schoolId), enabled: !!schoolId },
    ],
  });

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-lg font-semibold text-gray-900">{t("reports.title")}</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Where the school stands today, and the tools to produce paperwork
          from it.
        </p>
      </div>

      {/* ── Figures ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatCard
          icon={Users}
          label={t("academic.student_other")}
          value={students.data?.total}
          detail={
            students.data
              ? `${students.data.active ?? 0} active`
              : undefined
          }
          loading={students.isLoading}
          failed={students.isError}
        />
        <StatCard
          icon={School}
          label={t("academic.teacher_other")}
          value={teachers.data?.total}
          detail={
            teachers.data
              ? `${teachers.data.active ?? 0} active`
              : undefined
          }
          loading={teachers.isLoading}
          failed={teachers.isError}
        />
        <StatCard
          icon={BookMarked}
          label={t("academic.class_other")}
          value={classes.data?.total}
          loading={classes.isLoading}
          failed={classes.isError}
        />
        <StatCard
          icon={BookMarked}
          label={t("academic.subject_other")}
          value={subjects.data?.total}
          loading={subjects.isLoading}
          failed={subjects.isError}
        />
        <StatCard
          icon={FileText}
          label={t("nav.exams")}
          value={exams.data?.total}
          detail={
            exams.data
              ? `${exams.data.completed ?? 0} completed`
              : undefined
          }
          loading={exams.isLoading}
          failed={exams.isError}
        />
        <StatCard
          icon={ClipboardCheck}
          label={t("reports.presentToday")}
          value={attendance.data?.students.rate}
          suffix="%"
          detail={
            attendance.data
              ? `${attendance.data.students.present} of ${attendance.data.students.total}`
              : undefined
          }
          loading={attendance.isLoading}
          failed={attendance.isError}
        />
      </div>

      {/* ── Tools ───────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title={t("reports.produce")}
          subtitle={t("reports.builtFromTemplate")}
        />

        <div className="grid sm:grid-cols-2 gap-3">
          <ToolLink
            to="/reports/templates"
            icon={LayoutTemplate}
            title={t("reports.cardTemplates")}
            description={t("reports.cardTemplatesBlurb")}
          />
          <ToolLink
            to="/reports/cards"
            icon={FileText}
            title={t("reports.generateCards")}
            description={t("reports.generateCardsBlurb")}
          />
          <ToolLink
            to="/exams/results"
            icon={TrendingUp}
            title={t("reports.examResults")}
            description={t("reports.examResultsBlurb")}
          />
          <ToolLink
            to="/attendance/reports"
            icon={ClipboardCheck}
            title={t("reports.attendance")}
            description={t("reports.attendanceBlurb")}
          />
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  suffix,
  detail,
  loading,
  failed,
}: {
  icon:     React.ComponentType<{ className?: string }>;
  label:    string;
  value?:   number;
  suffix?:  string;
  detail?:  string;
  loading:  boolean;
  failed:   boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="w-9 h-9 rounded-lg bg-primary-50 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-primary-600" />
        </div>
        {/* A failed card says so rather than showing a confident zero — "0
            students" and "we couldn't ask" are very different facts. */}
        {failed && <Badge label={t("common.unavailable")} variant="default" />}
      </div>

      <div className="mt-3">
        {loading ? (
          <Spinner className="w-5 h-5" />
        ) : (
          <p className={cn(
            "text-2xl font-semibold leading-none tabular-nums",
            failed ? "text-gray-300" : "text-gray-900",
          )}>
            {failed || value === undefined ? "—" : value.toLocaleString()}
            {!failed && value !== undefined && suffix}
          </p>
        )}
        <p className="mt-1.5 text-xs text-gray-500">{label}</p>
        {detail && !failed && (
          <p className="text-[11px] text-gray-400 mt-0.5">{detail}</p>
        )}
      </div>
    </Card>
  );
}

function ToolLink({
  to,
  icon: Icon,
  title,
  description,
}: {
  to:          string;
  icon:        React.ComponentType<{ className?: string }>;
  title:       string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "group flex items-start gap-3 p-4 rounded-lg border border-gray-200",
        "hover:border-primary-300 hover:bg-primary-50/40 transition-colors",
      )}
    >
      <div className="w-9 h-9 rounded-lg bg-gray-50 group-hover:bg-white flex items-center justify-center shrink-0 transition-colors">
        <Icon className="w-4 h-4 text-gray-500 group-hover:text-primary-600 transition-colors" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-800 flex items-center gap-1">
          {title}
          <ArrowRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-primary-500 group-hover:translate-x-0.5 transition-all" />
        </p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
    </Link>
  );
}
