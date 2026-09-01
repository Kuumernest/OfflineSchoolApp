// web/src/pages/exams/index.tsx
"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useNavigate }     from "react-router-dom";
import {
  Plus, FileText, Clock, CheckCircle, AlertCircle,
  TrendingUp, Filter, Search, RefreshCw, Bell,
  Calendar, BarChart2, ChevronLeft, ChevronRight,
  X, MoreVertical,
  BookOpen, AlertTriangle,
} from "lucide-react";
import {
  useExams,
  useExamDashboard,
  useUpdateExamStatus,
  useDeleteExam,
} from "@/hooks/useExams";
import { useAuthStore }       from "@/store/auth.store";
import { EXAM_STATUS_META, examTypeLabel }   from "@/constants/exam.constants";
import type { Exam, ExamStatus } from "@/types/exam.types";
import api                    from "@/lib/axios";
import { useToast }           from "@/components/ui/Toast";
import { useTranslation } from "react-i18next";
import { currentLocale }      from "@/i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode = "table" | "calendar" | "timeline";

interface ClassOption   { _id: string; name: string; section?: string }
interface SubjectOption { _id: string; name: string }

interface AlertItem {
  type:    "conflict" | "reminder" | "warning" | "atRisk";
  message: string;
  action:  string;
  examId?: string;
  onAction?: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────


const STATUS_TRANSITIONS: Record<ExamStatus, ExamStatus[]> = {
  draft:     ["scheduled", "ongoing"],
  scheduled: ["ongoing",   "draft"],
  ongoing:   ["completed", "draft"],
  completed: ["published", "archived"],
  published: ["archived"],
  archived:  ["draft"],
};

// `value` is the sort key the table reads — it must not change. Only the
// label is localised, resolved at render because module scope has no `t`.
const SORT_OPTIONS = [
  { value: "createdAt_desc", labelKey: "exams.sortNewest"   },
  { value: "createdAt_asc",  labelKey: "exams.sortOldest"   },
  { value: "name_asc",       labelKey: "exams.sortNameAsc"  },
  { value: "name_desc",      labelKey: "exams.sortNameDesc" },
  { value: "startDate_asc",  labelKey: "exams.sortDateAsc"  },
  { value: "startDate_desc", labelKey: "exams.sortDateDesc" },
];

// `value` is the stored/queried term string; only the label is localised.
const TERM_FILTER_OPTIONS = [
  { value: "Term 1",    labelKey: "exams.term1"    },
  { value: "Term 2",    labelKey: "exams.term2"    },
  { value: "Term 3",    labelKey: "exams.term3"    },
  { value: "Full Year", labelKey: "exams.fullYear" },
];

const VIEW_TITLE_KEYS: Record<ViewMode, string> = {
  table:    "exams.viewTable",
  calendar: "exams.viewCalendar",
  timeline: "exams.viewTimeline",
};

/** Month and weekday names come from Intl so they follow the chosen language. */
const monthLabel = (year: number, month: number) =>
  new Date(year, month, 1).toLocaleDateString(currentLocale(), {
    month: "long", year: "numeric",
  });

/** Monday-first short weekday names in the active language. */
const shortWeekdays = () => {
  // 2024-01-01 was a Monday; seven consecutive days give Mon…Sun.
  const locale = currentLocale();
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: "short" })
  );
};

// ─── Utilities ────────────────────────────────────────────────────────────────

const fmtDate = (d?: string | null) => {
  if (!d) return "—";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString(currentLocale(), {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return d; }
};

const daysUntil = (dateStr?: string | null) => {
    if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d     = new Date(dateStr + "T00:00:00");
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
};

const sortExams = (exams: Exam[], sortBy: string): Exam[] => {
  const [field, dir] = sortBy.split("_");
  return [...exams].sort((a, b) => {
    // Exam has no index signature, so TS refuses the direct cast; going via
    // unknown is the sanctioned way to say "index this by a runtime key".
    let av = ((a as unknown as Record<string, unknown>)[field] as string) ?? "";
    let bv = ((b as unknown as Record<string, unknown>)[field] as string) ?? "";
    if (field === "createdAt" || field === "startDate") {
      av = av || ""; bv = bv || "";
    }
    const cmp = String(av).localeCompare(String(bv));
    return dir === "desc" ? -cmp : cmp;
  });
};

// ─── Small shared components ──────────────────────────────────────────────────

const StatusBadge = ({ status }: { status: ExamStatus }) => {
  const { t } = useTranslation();
  const cfg = EXAM_STATUS_META[status] ?? EXAM_STATUS_META.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
      text-xs font-semibold ${cfg.color} ${cfg.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {t(cfg.labelKey)}
    </span>
  );
};

const Spinner = ({ size = "md" }: { size?: "sm" | "md" | "lg" }) => {
  const s = { sm: "w-4 h-4", md: "w-6 h-6", lg: "w-10 h-10" }[size];
  return (
    <div className={`${s} border-4 border-primary-600
                    border-t-transparent rounded-full animate-spin`} />
  );
};

// ─── Stat Card ────────────────────────────────────────────────────────────────

const StatCard = ({
  label, value, sub, icon: Icon, color, onClick, highlight,
}: {
  label:      string;
  value:      number | string;
  sub?:       string;
  icon:       React.ElementType;
  color:      string;
  onClick?:   () => void;
  highlight?: boolean;
}) => (
  <button
    onClick={onClick}
    className={`bg-white rounded-xl p-5 flex items-center gap-4 shadow-sm
      border transition-all text-left w-full
      ${highlight
        ? "border-primary-300 ring-2 ring-primary-100"
        : "border-gray-100 hover:shadow-md hover:border-gray-200"
      }`}
  >
    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
      <Icon className="w-6 h-6" />
    </div>
    <div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  </button>
);

// ─── Alerts Panel ─────────────────────────────────────────────────────────────

const AlertsPanel = ({
  alerts,
  onClose,
}: {
  alerts:  AlertItem[];
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const iconMap = {
    conflict: <AlertTriangle className="w-4 h-4 text-red-500"    />,
    reminder: <Bell          className="w-4 h-4 text-blue-500"   />,
    warning:  <AlertCircle  className="w-4 h-4 text-orange-500" />,
    atRisk:   <TrendingUp   className="w-4 h-4 text-purple-500" />,
  };
  const bgMap = {
    conflict: "bg-red-50 border-red-100",
    reminder: "bg-blue-50 border-blue-100",
    warning:  "bg-orange-50 border-orange-100",
    atRisk:   "bg-purple-50 border-purple-100",
  };

  return (
    <div className="fixed right-4 top-20 w-80 z-50 bg-white rounded-xl
                    shadow-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3
                      border-b border-gray-100 bg-gray-50">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-semibold text-gray-900">{t("exams.alerts")}</span>
          {alerts.length > 0 && (
            <span className="bg-red-500 text-white text-xs rounded-full
                             w-5 h-5 flex items-center justify-center font-bold">
              {alerts.length}
            </span>
          )}
        </div>
        <button onClick={onClose}
          className="text-gray-400 hover:text-gray-600 p-1">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {!alerts.length ? (
          <div className="px-4 py-8 text-center">
            <p className="text-2xl mb-2">🎉</p>
            <p className="text-sm text-gray-400">{t("exams.noAlerts")}</p>
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {alerts.map((a, i) => (
              <div key={i}
                className={`p-3 rounded-lg border text-xs ${bgMap[a.type]}`}>
                <div className="flex items-start gap-2">
                  {iconMap[a.type]}
                  <div className="flex-1">
                    <p className="text-gray-800 leading-snug">{a.message}</p>
                    {a.action && (
                      <button
                        onClick={() => { a.onAction?.(); onClose(); }}
                        className="text-blue-600 font-semibold mt-1 hover:underline
                                   cursor-pointer">
                        {a.action} →
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Quick Actions Menu ───────────────────────────────────────────────────────

const QuickActionsMenu = ({
  onClose,
  onArchiveCompleted,
  schoolId,
}: {
  onClose:            () => void;
  onArchiveCompleted: () => void;
  schoolId:           string;
}) => {
  const { t } = useTranslation();
  const { toast } = useToast();

  const navigate = useNavigate();

  const actions = [
    {
      id: "schedule", icon: "➕", label: t("exams.qaSchedule"),
      onClick: () => { navigate("/exams/new"); onClose(); },
    },
    {
      id: "export", icon: "📊", label: t("exams.qaExportCsv"),
      onClick: async () => {
        try {
          const res = await api.get("/exams/reports/results", {
            params:       { schoolId },
            responseType: "blob",
          });
          const url = URL.createObjectURL(new Blob([res.data]));
          const a   = document.createElement("a");
          a.href    = url;
          a.download = `results-${new Date().toISOString().split("T")[0]}.csv`;
          a.click();
          URL.revokeObjectURL(url);
        } catch {
          toast({ title: t("exams.exportFailed"), kind: "error" });
        }
        onClose();
      },
    },
    {
      id: "print", icon: "🖨️", label: t("exams.qaPrintTimetable"),
      onClick: () => { window.print(); onClose(); },
    },
    {
      id: "archive", icon: "🗑️", label: t("exams.qaArchiveCompleted"),
      onClick: () => { onArchiveCompleted(); onClose(); },
    },
    {
      id: "cards", icon: "📋", label: t("exams.qaReportCards"),
      onClick: () => { navigate("/reports/cards"); onClose(); },
    },
    {
      id: "analytics", icon: "📈", label: t("results.analytics"),
      onClick: () => { navigate("/exams/results"); onClose(); },
    },
  ];

  return (
    <div className="absolute right-0 top-10 w-52 bg-white rounded-xl shadow-xl
                    border border-gray-100 z-40 py-1 overflow-hidden">
      {actions.map((a) => (
        <button key={a.id} onClick={a.onClick}
          className="w-full text-left px-4 py-2.5 text-sm text-gray-700
                     hover:bg-gray-50 flex items-center gap-2.5 transition-colors">
          <span>{a.icon}</span>
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );
};

// ─── Exam Row (Table View) ────────────────────────────────────────────────────

const ExamRow = ({
  exam,
  onStatusChange,
  onDelete,
  canManage,
  index,
}: {
  exam:           Exam;
  onStatusChange: (id: string, status: ExamStatus) => void;
  onDelete:       (id: string, name: string) => void;
  canManage:      boolean;
  index:          number;
}) => {
  const { t } = useTranslation();
  const navigate  = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef                 = useRef<HTMLDivElement>(null);

  const nextStatuses = STATUS_TRANSITIONS[exam.status] ?? [];
  const days         = daysUntil(exam.startDate);

  // Close menu on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) document.addEventListener("mousedown", handle);
    return ()    => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  return (
    <tr className="hover:bg-gray-50/60 transition-colors group">
      {/* # */}
      <td className="px-4 py-3 text-xs text-gray-400 font-medium">
        {index + 1}
      </td>

      {/* Exam name + type */}
      <td className="px-4 py-3 min-w-[200px]">
        <button
          onClick={() => navigate(`/exams/${exam._id}`)}
          className="font-semibold text-gray-900 text-sm hover:text-primary-600
                     text-left transition-colors leading-snug"
        >
          {exam.name}
        </button>
        <p className="text-xs text-gray-400 mt-0.5">
          {examTypeLabel(t, exam.type)}
          {exam.term         ? ` · ${exam.term}`         : ""}
          {exam.academicYear ? ` · ${exam.academicYear}` : ""}
        </p>
      </td>

      {/* Class */}
      <td className="px-4 py-3 text-sm text-gray-600 max-w-[140px]">
        <span className="truncate block">
          {exam.classNames || exam.className || t("exams.allClasses")}
        </span>
      </td>

      {/* Dates */}
      <td className="px-4 py-3">
        <div className="text-sm text-gray-700">{fmtDate(exam.startDate)}</div>
        {exam.endDate && exam.endDate !== exam.startDate && (
          <div className="text-xs text-gray-400">→ {fmtDate(exam.endDate)}</div>
        )}
        {exam.status === "scheduled" && days !== null && days >= 0 && days <= 7 && (
          <div className={`text-xs font-semibold mt-0.5
            ${days === 0 ? "text-red-600" : "text-orange-500"}`}>
            {days === 0 ? t("exams.today") : t("exams.inDays", { count: days })}
          </div>
        )}
      </td>

      {/* Status */}
      <td className="px-4 py-3">
        <StatusBadge status={exam.status} />
      </td>

      {/* Marks */}
      <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
        <span className="font-medium text-gray-700">{exam.totalMarks}</span>
        <span className="text-gray-300 mx-1">/</span>
        <span>{exam.passMark}</span>
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100
                        transition-opacity">
          <Link to={`/exams/${exam._id}`}
            className="text-xs font-semibold text-primary-600 hover:text-primary-700
                       bg-primary-50 hover:bg-primary-100 px-2.5 py-1.5 rounded-lg
                       transition-colors whitespace-nowrap">
            {t("common.view")}
          </Link>

          {canManage && (
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="p-1.5 text-gray-400 hover:text-gray-600
                           hover:bg-gray-100 rounded-lg transition-colors"
              >
                <MoreVertical className="w-4 h-4" />
              </button>

              {menuOpen && (
                <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl
                                shadow-lg border border-gray-100 z-30 py-1
                                overflow-hidden">
                  {/* Status transitions */}
                  {nextStatuses.map((s) => (
                    <button key={s}
                      onClick={() => { onStatusChange(exam._id, s); setMenuOpen(false); }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700
                                 hover:bg-gray-50 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${EXAM_STATUS_META[s]?.dot}`} />
                      → {t(EXAM_STATUS_META[s]?.labelKey ?? "examStatus.draft")}
                    </button>
                  ))}

                  {nextStatuses.length > 0 && <hr className="my-1 border-gray-100" />}

                  <Link to={`/exams/${exam._id}?tab=details`}
                    className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    onClick={() => setMenuOpen(false)}>
                    ✏️ {t("common.edit")}
                  </Link>
                  <Link to={`/exams/${exam._id}?tab=marks`}
                    className="block px-4 py-2 text-sm text-indigo-600 hover:bg-indigo-50"
                    onClick={() => setMenuOpen(false)}>
                    ✏️ {t("exams.enterMarks")}
                  </Link>
                  <Link to={`/exams/${exam._id}?tab=results`}
                    className="block px-4 py-2 text-sm text-green-600 hover:bg-green-50"
                    onClick={() => setMenuOpen(false)}>
                    📊 {t("exams.viewResults")}
                  </Link>

                  <hr className="my-1 border-gray-100" />
                  <button
                    onClick={() => { onDelete(exam._id, exam.name); setMenuOpen(false); }}
                    className="w-full text-left px-4 py-2 text-sm text-red-600
                               hover:bg-red-50">
                    🗑️ {t("common.delete")}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
};

// ─── Calendar View ────────────────────────────────────────────────────────────

const CalendarView = ({
  exams,
  onExamClick,
}: {
  exams:       Exam[];
  onExamClick: (e: Exam) => void;
}) => {
  const { t } = useTranslation();
  const today = new Date();
  const [cur, setCur] = useState({
    year:  today.getFullYear(),
    month: today.getMonth(),
  });

  const { year, month } = cur;
  const firstDay        = new Date(year, month, 1).getDay();
  const daysInMonth     = new Date(year, month + 1, 0).getDate();

  // Map exam start dates to this month
  const byDate = useMemo(() => {
    const map: Record<string, Exam[]> = {};
    for (const e of exams) {
      if (!e.startDate) continue;
      const [ey, em] = e.startDate.split("-").map(Number);
      if (ey !== year || em - 1 !== month) continue;
      const key = e.startDate;
      map[key] = map[key] || [];
      map[key].push(e);
    }
    return map;
  }, [exams, year, month]);

  const blanks = (firstDay + 6) % 7; // Monday start

  const prevMonth = () => setCur((p) => {
    const d = new Date(p.year, p.month - 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const nextMonth = () => setCur((p) => {
    const d = new Date(p.year, p.month + 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Nav */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <button onClick={prevMonth}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
          <ChevronLeft className="w-5 h-5 text-gray-500" />
        </button>
        <h3 className="font-semibold text-gray-900 text-lg capitalize">
          {monthLabel(year, month)}
        </h3>
        <button onClick={nextMonth}
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
          <ChevronRight className="w-5 h-5 text-gray-500" />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50">
        {shortWeekdays().map((label, i) => (
          <div key={i}
            className="py-2 text-center text-xs font-semibold text-gray-400 uppercase">
            {label}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-7">
        {/* Blank cells */}
        {Array.from({ length: blanks }).map((_, i) => (
          <div key={`b${i}`}
            className="min-h-[100px] border-b border-r border-gray-50 bg-gray-50/30" />
        ))}

        {/* Day cells */}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day      = i + 1;
          const dateStr  = `${year}-${pad(month + 1)}-${pad(day)}`;
          const dayExams = byDate[dateStr] || [];
          const isToday  =
            today.getFullYear() === year &&
            today.getMonth()    === month &&
            today.getDate()     === day;

          return (
            <div key={day}
              className={`min-h-[100px] border-b border-r border-gray-50 p-1.5
                ${isToday ? "bg-blue-50/60" : "hover:bg-gray-50/60"} transition-colors`}>
              {/* Day number */}
              <div className={`w-6 h-6 flex items-center justify-center
                text-xs font-semibold mb-1 rounded-full
                ${isToday ? "bg-primary-600 text-white" : "text-gray-600"}`}>
                {day}
              </div>

              {/* Exam chips */}
              <div className="space-y-0.5">
                {dayExams.slice(0, 3).map((e) => {
                  const cfg = EXAM_STATUS_META[e.status] ?? EXAM_STATUS_META.draft;
                  return (
                    <button key={e._id} onClick={() => onExamClick(e)}
                      title={e.name}
                      className={`w-full text-left text-xs px-1.5 py-0.5 rounded
                        truncate font-medium transition-opacity hover:opacity-80
                        ${cfg.bg} ${cfg.color}`}>
                      {e.name}
                    </button>
                  );
                })}
                {dayExams.length > 3 && (
                  <p className="text-xs text-gray-400 px-1">
                    {t("exams.moreCount", { count: dayExams.length - 3 })}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="px-4 py-3 border-t border-gray-100 flex flex-wrap gap-3">
        {(Object.keys(EXAM_STATUS_META) as ExamStatus[]).map((s) => {
          const cfg = EXAM_STATUS_META[s];
          return (
            <div key={s} className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className={`w-2.5 h-2.5 rounded-full ${cfg.dot}`} />
              {t(cfg.labelKey)}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Timeline / Gantt View ────────────────────────────────────────────────────

const TimelineView = ({
  exams,
  onExamClick,
}: {
  exams:       Exam[];
  onExamClick: (e: Exam) => void;
}) => {
  const { t } = useTranslation();
  // Group by subject/name prefix
  const byType = useMemo(() => {
    const map: Record<string, { id: string; label: string; exams: Exam[] }> = {};
    for (const e of exams) {
      const key = e.type || "other";
      if (!map[key]) map[key] = { id: key, label: examTypeLabel(t, key), exams: [] };
      map[key].exams.push(e);
    }
    return Object.values(map);
  }, [exams, t]);

  // Date range
  const allDates = exams
    .map((e) => e.startDate)
    .filter(Boolean)
    .sort() as string[];

  if (!allDates.length) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <BarChart2 className="w-12 h-12 mb-3 text-gray-200" />
          <p className="font-medium text-gray-500">{t("exams.noDates")}</p>
          <p className="text-sm mt-1">{t("exams.addDates")}</p>
        </div>
      </div>
    );
  }

  const startDate = new Date(allDates[0] + "T00:00:00");
  const endDate   = new Date(allDates[allDates.length - 1] + "T00:00:00");
  const totalMs   = Math.max(
    endDate.getTime() - startDate.getTime(),
    30 * 86_400_000   // minimum 30 days
  );

  const leftPct = (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00");
    return Math.max(0, Math.min(98,
      ((d.getTime() - startDate.getTime()) / totalMs) * 100
    ));
  };

  // Month markers
  const monthMarkers: Array<{ label: string; pct: number }> = [];
  const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (cur <= endDate) {
    const pct = ((cur.getTime() - startDate.getTime()) / totalMs) * 100;
    if (pct >= 0 && pct <= 100) {
      monthMarkers.push({
        label: cur.toLocaleDateString(currentLocale(), { month: "short", year: "2-digit" }),
        pct,
      });
    }
    cur.setMonth(cur.getMonth() + 1);
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          {/* Month header */}
          <div className="flex border-b border-gray-100 bg-gray-50">
            <div className="w-36 shrink-0 px-4 py-3 text-xs font-semibold
                            text-gray-400 uppercase tracking-wide">
              {t("common.type")}
            </div>
            <div className="flex-1 relative h-10">
              {monthMarkers.map((m) => (
                <div key={m.label}
                  className="absolute top-0 h-full flex items-center"
                  style={{ left: `${m.pct}%` }}>
                  <div className="w-px h-full bg-gray-200" />
                  <span className="ml-1 text-xs text-gray-400 whitespace-nowrap">
                    {m.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Rows */}
          {byType.map(({ id, label, exams: typeExams }) => (
            <div key={id}
              className="flex border-b border-gray-50 hover:bg-gray-50/40 group">
              <div className="w-36 shrink-0 px-4 py-3 text-sm text-gray-700
                              font-medium truncate">
                {label}
              </div>
              <div className="flex-1 relative h-12 flex items-center">
                {typeExams.map((e) => {
                  if (!e.startDate) return null;
                  const left = leftPct(e.startDate);
                  const cfg  = EXAM_STATUS_META[e.status] ?? EXAM_STATUS_META.draft;

                  return (
                    <button key={e._id} onClick={() => onExamClick(e)}
                      title={`${e.name} — ${fmtDate(e.startDate)}`}
                      className={`absolute flex items-center px-2 py-1 rounded-lg
                        text-xs font-semibold cursor-pointer
                        hover:shadow-md transition-shadow whitespace-nowrap
                        ${cfg.bg} ${cfg.color}`}
                      style={{ left: `${left}%`, maxWidth: "120px" }}>
                      <span className="truncate">{e.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-400">
        {t("exams.timelineRange", {
          from: fmtDate(allDates[0]),
          to:   fmtDate(allDates[allDates.length - 1]),
        })}
      </div>
    </div>
  );
};

// ─── Exam Detail Slide-over ───────────────────────────────────────────────────

const ExamDetailSlideOver = ({
  exam,
  onClose,
  onStatusChange,
  canManage,
}: {
  exam:           Exam;
  onClose:        () => void;
  onStatusChange: (id: string, status: ExamStatus) => void;
  canManage:      boolean;
}) => {
  const { t } = useTranslation();
  const navigate     = useNavigate();
  const nextStatuses = STATUS_TRANSITIONS[exam.status] ?? [];

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-md bg-white shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-start
                        justify-between sticky top-0 bg-white z-10">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <StatusBadge status={exam.status} />
              <span className="text-xs text-gray-400">
                {examTypeLabel(t, exam.type)}
              </span>
            </div>
            <h2 className="text-base font-bold text-gray-900 leading-snug">
              {exam.name}
            </h2>
          </div>
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 mt-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Details */}
        <div className="flex-1 p-5 space-y-5">
          {/* Grid details */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            {[
              { labelKey: "academic.term",         value: exam.term                                },
              { labelKey: "academic.schoolYear",   value: exam.academicYear                        },
              { labelKey: "academic.class",        value: exam.classNames || exam.className || "—" },
              { labelKey: "common.startDate",      value: fmtDate(exam.startDate)                  },
              { labelKey: "common.endDate",        value: fmtDate(exam.endDate)                    },
              { labelKey: "examCreate.totalMarks", value: String(exam.totalMarks)                  },
              { labelKey: "academic.passMark",     value: String(exam.passMark)                    },
            ].map(({ labelKey, value }) => (
              <div key={labelKey}>
                <p className="text-xs text-gray-400 font-medium">{t(labelKey)}</p>
                <p className="font-semibold text-gray-800 mt-0.5">{value || "—"}</p>
              </div>
            ))}
          </div>

          {/* Description */}
          {exam.description && (
            <div className="bg-gray-50 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-400 uppercase mb-1">
                {t("common.description")}
              </p>
              <p className="text-sm text-gray-700 leading-relaxed">{exam.description}</p>
            </div>
          )}

          {/* Instructions */}
          {exam.instructions && (
            <div className="bg-amber-50 rounded-xl p-4">
              <p className="text-xs font-semibold text-amber-600 uppercase mb-1">
                {t("common.instructions")}
              </p>
              <p className="text-sm text-amber-900 leading-relaxed">{exam.instructions}</p>
            </div>
          )}

          {/* Status transitions */}
          {canManage && nextStatuses.length > 0 && (
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase mb-2">
                {t("exams.moveTo")}
              </p>
              <div className="flex flex-wrap gap-2">
                {nextStatuses.map((s) => {
                  const cfg = EXAM_STATUS_META[s];
                  return (
                    <button key={s}
                      onClick={() => { onStatusChange(exam._id, s); onClose(); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold
                        border-2 transition-colors
                        ${cfg.color} ${cfg.bg}
                        hover:opacity-80`}>
                      → {t(cfg.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t border-gray-100 flex gap-2 sticky bottom-0 bg-white">
          <button onClick={() => { navigate(`/exams/${exam._id}`); onClose(); }}
            className="flex-1 py-2 bg-primary-600 text-white rounded-xl text-sm
                       font-semibold hover:bg-primary-700 transition-colors">
            {t("exams.openExam")}
          </button>
          {canManage && (
            <button
              onClick={() => { navigate(`/exams/${exam._id}?tab=marks`); onClose(); }}
              className="flex-1 py-2 bg-indigo-50 text-indigo-700 rounded-xl
                         text-sm font-semibold hover:bg-indigo-100 transition-colors">
              {t("exams.enterMarks")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═════════════════════════════════════════════════════════════════════════════

const ADMIN_ROLES = new Set(["super_admin", "school_admin", "admin"]);

export default function ExamsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate  = useNavigate();
  const user      = useAuthStore((s) => s.user);
  const schoolId  = user?.schoolId ?? "";
  const canManage = ADMIN_ROLES.has(user?.role ?? "");

  // ── Filters ──────────────────────────────────────────────────────────────
  const [statusFilter,  setStatusFilter]  = useState<string>("all");
  const [search,        setSearch]        = useState("");
  const [classFilter,   setClassFilter]   = useState("");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [termFilter,    setTermFilter]    = useState("");
  const [typeFilter,    setTypeFilter]    = useState("");
  const [dateFrom,      setDateFrom]      = useState("");
  const [dateTo,        setDateTo]        = useState("");
  const [sortBy,        setSortBy]        = useState("createdAt_desc");
  const [view,          setView]          = useState<ViewMode>("table");

  // ── UI state ─────────────────────────────────────────────────────────────
  const [showAlerts,      setShowAlerts]      = useState(false);
  const [showQuickMenu,   setShowQuickMenu]   = useState(false);
  const [showFilters,     setShowFilters]     = useState(false);
  const [selectedExam,    setSelectedExam]    = useState<Exam | null>(null);
  const [alerts,          setAlerts]          = useState<AlertItem[]>([]);
  const [classes,         setClasses]         = useState<ClassOption[]>([]);
  const [subjects,        setSubjects]        = useState<SubjectOption[]>([]);
  const [availableTypes,  setAvailableTypes]  = useState<string[]>([]);

  const quickMenuRef = useRef<HTMLDivElement>(null);

  // ── Data fetching ─────────────────────────────────────────────────────────
  const filterParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (statusFilter !== "all") p.status       = statusFilter;
    if (termFilter)             p.term         = termFilter;
    if (classFilter)            p.classId      = classFilter;
    return p;
  }, [statusFilter, termFilter, classFilter]);

  const { data: dashData,  refetch: refetchDash } = useExamDashboard();
  const { data: examsData, isLoading, refetch     } = useExams(filterParams);
  const updateStatus = useUpdateExamStatus();
  const deleteExam   = useDeleteExam();

  const d = dashData?.dashboard?.exams;

  // ── Load support data ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!schoolId) return;

    Promise.all([
      api.get("/admin/classes",  { params: { schoolId } }).catch(() => ({ data: {} })),
      api.get("/admin/subjects", { params: { schoolId } }).catch(() => ({ data: {} })),
    ]).then(([cl, su]) => {
      setClasses(cl.data?.classes  || []);
      setSubjects(su.data?.subjects || []);
    });
  }, [schoolId]);

  // ── Derive filter options from loaded exams ───────────────────────────────
  useEffect(() => {
    const exams = examsData?.exams ?? [];
    setAvailableTypes([...new Set(exams.map((e) => e.type).filter(Boolean))]);
  }, [examsData]);

  // ── Derive alerts from dashboard data ────────────────────────────────────
  useEffect(() => {
    const derived: AlertItem[] = [];
    if (!d) return;

    if (d.draft > 0) {
      derived.push({
        type:    "reminder",
        message: t("exams.alertDraft", { count: d.draft }),
        action:  t("exams.actionViewDrafts"),
        onAction: () => setStatusFilter("draft"),
      });
    }
    if (d.ongoing > 0) {
      derived.push({
        type:    "warning",
        message: t("exams.alertOngoing", { count: d.ongoing }),
        action:  t("exams.actionViewOngoing"),
        onAction: () => setStatusFilter("ongoing"),
      });
    }
    if ((dashData?.dashboard?.results?.missingGrades ?? 0) > 0) {
      const missing = dashData!.dashboard.results.missingGrades;
      derived.push({
        type:    "warning",
        message: t("exams.alertMissingGrades", { count: missing }),
        action:  t("exams.actionEnterResults"),
        onAction: () => navigate("/exams/results"),
      });
    }
    if ((dashData?.dashboard?.results?.pending ?? 0) > 0) {
      const pending = dashData!.dashboard.results.pending;
      derived.push({
        type:    "atRisk",
        message: t("exams.alertPending", { count: pending }),
        action:  t("exams.actionPublishResults"),
        onAction: () => navigate("/exams/results"),
      });
    }

    setAlerts(derived);
  }, [d, dashData, t, navigate, setStatusFilter]);

  // ── Close quick menu on outside click ────────────────────────────────────
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (quickMenuRef.current && !quickMenuRef.current.contains(e.target as Node)) {
        setShowQuickMenu(false);
      }
    };
    if (showQuickMenu) document.addEventListener("mousedown", handle);
    return ()         => document.removeEventListener("mousedown", handle);
  }, [showQuickMenu]);

  // ── Client-side filter + sort ─────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = examsData?.exams ?? [];

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((e) =>
        e.name?.toLowerCase().includes(q)       ||
        e.term?.toString().includes(q)       ||

        e.academicYear?.toLowerCase().includes(q) ||
        e.className?.toLowerCase().includes(q)  ||
        e.classNames?.toLowerCase().includes(q)
      );
    }

    // Subject filter (client-side — ExamSubject lookup would need backend)
    // For now we match against name heuristic
    if (subjectFilter) {
      const sub = subjects.find((s) => s._id === subjectFilter);
      if (sub) {
        list = list.filter((e) =>
          e.name.toLowerCase().includes(sub.name.toLowerCase())
        );
      }
    }

    // Type filter
    if (typeFilter) {
      list = list.filter((e) => e.type === typeFilter);
    }

    // Date range
    if (dateFrom) {
      list = list.filter((e) => e.startDate && e.startDate >= dateFrom);
    }
    if (dateTo) {
      list = list.filter((e) => e.startDate && e.startDate <= dateTo);
    }

    return sortExams(list, sortBy);
  }, [examsData, search, subjectFilter, subjects, typeFilter, dateFrom, dateTo, sortBy]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleStatusChange = useCallback((examId: string, status: ExamStatus) => {
    updateStatus.mutate({ examId, status });
  }, [updateStatus]);

  const handleDelete = useCallback((examId: string, name: string) => {
    if (!window.confirm(t("exams.deleteConfirm", { name }))) return;
    deleteExam.mutate(examId);
  }, [deleteExam, t]);

  const handleArchiveCompleted = useCallback(async () => {
    const completed = (examsData?.exams ?? []).filter((e) => e.status === "completed");
    if (!completed.length) {
      toast({ title: t("exams.noCompletedToArchive"), kind: "info" });
      return;
    }
    if (!window.confirm(t("exams.archiveConfirm", { count: completed.length }))) return;

    let count = 0;
    for (const e of completed) {
      try {
        await api.patch(`/exams/${e._id}/status`, { status: "archived", schoolId });
        count++;
      } catch { /* continue */ }
    }
    toast({ title: t("exams.archivedCount", { count }), kind: "success" });
    refetch();
    refetchDash();
  }, [examsData, schoolId, refetch, refetchDash, toast, t]);

  const handleRefresh = () => { refetch(); refetchDash(); };

  // ── Active filter count ───────────────────────────────────────────────────
  const activeFilterCount = [
    statusFilter !== "all",
    !!search,
    !!classFilter,
    !!subjectFilter,
    !!termFilter,
    !!typeFilter,
    !!dateFrom,
    !!dateTo,
  ].filter(Boolean).length;

  const clearFilters = () => {
    setSearch("");
    setClassFilter("");
    setSubjectFilter("");
    setTermFilter("");
    setTypeFilter("");
    setDateFrom("");
    setDateTo("");
    setStatusFilter("all");
    setSortBy("createdAt_desc");
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Page Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("exams.title")}</h1>
          <p className="text-gray-500 text-sm mt-1">
            {t("exams.blurb")}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Refresh */}
          <button onClick={handleRefresh}
            className="p-2 border border-gray-200 rounded-xl bg-white
                       hover:bg-gray-50 transition-colors"
            title={t("common.refresh")}>
            <RefreshCw className={`w-4 h-4 text-gray-500
              ${isLoading ? "animate-spin" : ""}`} />
          </button>

          {/* Alerts bell */}
          {canManage && (
            <button onClick={() => setShowAlerts((v) => !v)}
              className="relative p-2 border border-gray-200 rounded-xl bg-white
                         hover:bg-gray-50 transition-colors"
              title={t("exams.alerts")}>
              <Bell className="w-4 h-4 text-gray-500" />
              {alerts.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white
                                 text-xs rounded-full w-4 h-4 flex items-center
                                 justify-center font-bold">
                  {alerts.length}
                </span>
              )}
            </button>
          )}

          {/* View toggle */}
          <div className="flex border border-gray-200 rounded-xl overflow-hidden bg-white">
            {([
              { key: "table",    Icon: Filter   },
              { key: "calendar", Icon: Calendar },
              { key: "timeline", Icon: BarChart2},
            ] as const).map(({ key, Icon }) => (
              <button key={key} onClick={() => setView(key)}
                title={t(VIEW_TITLE_KEYS[key])}
                className={`px-3 py-2 transition-colors
                  ${view === key
                    ? "bg-primary-600 text-white"
                    : "text-gray-500 hover:bg-gray-50"
                  }`}>
                <Icon className="w-4 h-4" />
              </button>
            ))}
          </div>

          {/* Quick actions */}
          {canManage && (
            <div className="relative" ref={quickMenuRef}>
              <button onClick={() => setShowQuickMenu((v) => !v)}
                className="p-2 border border-gray-200 rounded-xl bg-white
                           hover:bg-gray-50 transition-colors"
                title={t("dashboard.quickActions")}>
                <MoreVertical className="w-4 h-4 text-gray-500" />
              </button>
              {showQuickMenu && (
                <QuickActionsMenu
                  onClose={() => setShowQuickMenu(false)}
                  onArchiveCompleted={handleArchiveCompleted}
                  schoolId={schoolId}
                />
              )}
            </div>
          )}

          {/* New exam */}
          {canManage && (
            <Link to="/exams/new"
              className="inline-flex items-center gap-2 bg-primary-600
                         hover:bg-primary-700 text-white px-4 py-2.5 rounded-xl
                         font-semibold text-sm transition-colors shadow-sm">
              <Plus className="w-4 h-4" />
              {t("exams.new")}
            </Link>
          )}
        </div>
      </div>

      {/* ── Stats Cards ─────────────────────────────────────────────────── */}
      {d && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard
            label={t("common.total")}     value={d.total}
            icon={FileText}   color="bg-gray-100 text-gray-600"
            highlight={statusFilter === "all"}
            onClick={() => setStatusFilter("all")}
          />
          <StatCard
            label={t("examStatus.draft")}     value={d.draft}
            icon={FileText}   color="bg-gray-100 text-gray-400"
            highlight={statusFilter === "draft"}
            onClick={() => setStatusFilter("draft")}
          />
          <StatCard
            label={t("examStatus.scheduled")} value={d.scheduled}
            icon={Clock}      color="bg-indigo-50 text-indigo-600"
            highlight={statusFilter === "scheduled"}
            onClick={() => setStatusFilter("scheduled")}
          />
          <StatCard
            label={t("examStatus.ongoing")}   value={d.ongoing}
            icon={AlertCircle}color="bg-amber-50 text-amber-600"
            highlight={statusFilter === "ongoing"}
            onClick={() => setStatusFilter("ongoing")}
          />
          <StatCard
            label={t("examStatus.completed")} value={d.completed}
            icon={CheckCircle}color="bg-green-50 text-green-600"
            highlight={statusFilter === "completed"}
            onClick={() => setStatusFilter("completed")}
          />
          <StatCard
            label={t("results.published")} value={d.published}
            icon={TrendingUp} color="bg-purple-50 text-purple-600"
            highlight={statusFilter === "published"}
            onClick={() => setStatusFilter("published")}
          />
                    <StatCard
            label={t("exams.passRate")}
            value={`${dashData?.dashboard?.results?.passRate ?? 0}%`}
            icon={BookOpen}   color="bg-teal-50 text-teal-600"
            sub={t("exams.schoolAvg")}
            onClick={() => navigate("/exams/results")}
          />
        </div>
      )}

            {/* Results overview strip — every item links to the results page */}
      {dashData?.dashboard?.results && (
        <div className="bg-white rounded-xl border border-gray-100 px-5 py-4 shadow-sm">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <h3 className="text-sm font-semibold text-gray-700">{t("exams.resultsOverview")}</h3>
            <div className="flex flex-wrap gap-6">
              {[
                { id:    "published", label: t("results.published"),     value: (dashData.dashboard.results.published            ?? 0),               color: "text-purple-600" },
                { id:    "pending",   label: t("results.pending"),       value: (dashData.dashboard.results.pending              ?? 0),               color: "text-amber-600"  },
                { id:    "missing",   label: t("exams.missingGrades"),   value: (dashData.dashboard.results.missingGrades          ?? 0),               color: "text-red-600"    },
                { id:    "avg",       label: t("exams.avgScore"),        value: `${dashData.dashboard.results.averagePerformance ?? 0}%`, color: "text-green-600" },
                { id:    "passRate",  label: t("exams.passRate"),        value: `${dashData.dashboard.results.passRate             ?? 0}%`, color: "text-primary-600"},
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate("/exams/results")}
                  className="text-center hover:opacity-80 transition-opacity cursor-pointer"
                >
                  <p className={`text-xl font-bold ${item.color}`}>{item.value}</p>
                  <p className="text-xs text-gray-400 font-medium">{item.label}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Filters Bar ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
        {/* Primary filter row */}
        <div className="p-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2
                               w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("exams.searchPh")}
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg
                         text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          {/* Status quick pills */}
          <div className="flex gap-1.5 flex-wrap">
            {(["all","draft","scheduled","ongoing","completed","published"] as const).map((s) => (
              <button key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold
                  transition-colors capitalize
                  ${statusFilter === s
                    ? "bg-primary-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}>
                {s === "all" ? t("common.all") : t(EXAM_STATUS_META[s]?.labelKey ?? "examStatus.draft")}
              </button>
            ))}
          </div>

          {/* Toggle advanced filters */}
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm
              border transition-colors relative
              ${showFilters || activeFilterCount > 0
                ? "border-primary-300 bg-primary-50 text-primary-700"
                : "border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}>
            <Filter className="w-4 h-4" />
            {t("exams.filters")}
            {activeFilterCount > 0 && (
              <span className="bg-primary-600 text-white text-xs rounded-full
                               w-4 h-4 flex items-center justify-center font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Sort */}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm
                       text-gray-600 focus:outline-none focus:ring-2
                       focus:ring-primary-500 bg-white">
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
        </div>

        {/* Advanced filters panel */}
        {showFilters && (
          <div className="px-4 pb-4 border-t border-gray-100 pt-4
                          grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
            {/* Class */}
            <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white">
              <option value="">{t("exams.allClasses")}</option>
              {classes.map((c) => (
                <option key={c._id} value={c._id}>{c.name}</option>
              ))}
            </select>

            {/* Subject */}
            <select value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white">
              <option value="">{t("exams.allSubjects")}</option>
              {subjects.map((s) => (
                <option key={s._id} value={s._id}>{s.name}</option>
              ))}
            </select>

            {/* Term */}
            <select value={termFilter} onChange={(e) => setTermFilter(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white">
              <option value="">{t("exams.allTerms")}</option>
              {TERM_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
              ))}
            </select>

            {/* Type */}
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white">
              <option value="">{t("exams.allTypes")}</option>
              {availableTypes.map((ty) => (
                <option key={ty} value={ty}>{examTypeLabel(t, ty)}</option>
              ))}
            </select>

            {/* Date from */}
            <input type="date" value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder={t("common.fromDate")}
            />

            {/* Date to */}
            <input type="date" value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder={t("common.toDate")}
            />

            {/* Clear filters */}
            {activeFilterCount > 0 && (
              <button onClick={clearFilters}
                className="col-span-full flex items-center gap-1.5 text-xs
                           text-red-600 hover:text-red-700 font-semibold
                           justify-center pt-1">
                <X className="w-3 h-3" />
                {t("common.clearAllFilters")}
              </button>
            )}
          </div>
        )}

        {/* ── Main Content ───────────────────────────────────────────────── */}

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Spinner size="lg" />
          </div>

        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center
                            justify-center mx-auto mb-4">
              <FileText className="w-8 h-8 text-gray-300" />
            </div>
            <p className="font-semibold text-gray-700">{t("exams.none")}</p>
            <p className="text-gray-400 text-sm mt-1">
              {activeFilterCount > 0
                ? t("exams.adjustFilters")
                : t("exams.createFirst")
              }
            </p>
            {activeFilterCount > 0 && (
              <button onClick={clearFilters}
                className="mt-3 text-sm text-primary-600 font-semibold hover:underline">
                {t("common.clearFilters")}
              </button>
            )}
            {canManage && !activeFilterCount && (
              <Link to="/exams/new"
                className="inline-flex items-center gap-2 mt-4 bg-primary-600
                           text-white px-4 py-2 rounded-xl text-sm font-semibold
                           hover:bg-primary-700 transition-colors">
                <Plus className="w-4 h-4" /> {t("exams.create")}
              </Link>
            )}
          </div>

        ) : view === "calendar" ? (
          <div className="p-4">
            <CalendarView
              exams={filtered}
              onExamClick={(e) => setSelectedExam(e)}
            />
          </div>

        ) : view === "timeline" ? (
          <div className="p-4">
            <TimelineView
              exams={filtered}
              onExamClick={(e) => setSelectedExam(e)}
            />
          </div>

        ) : (
          /* ── Table View ──────────────────────────────────────────────── */
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 text-xs font-semibold text-gray-500
                               uppercase tracking-wide border-b border-gray-100">
                  <th className="px-4 py-3 text-left w-8">#</th>
                  <th className="px-4 py-3 text-left">{t("academic.exam")}</th>
                  <th className="px-4 py-3 text-left">{t("academic.class")}</th>
                  <th className="px-4 py-3 text-left">{t("common.dates")}</th>
                  <th className="px-4 py-3 text-left">{t("common.status")}</th>
                  <th className="px-4 py-3 text-left">{t("exams.marks")}</th>
                  <th className="px-4 py-3 text-left">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((exam, i) => (
                  <ExamRow
                    key={exam._id}
                    exam={exam}
                    index={i}
                    canManage={canManage}
                    onStatusChange={handleStatusChange}
                    onDelete={handleDelete}
                  />
                ))}
              </tbody>
            </table>

            {/* Count footer */}
            <div className="px-4 py-3 border-t border-gray-100 text-xs text-gray-400">
              {t("exams.showingCount", { count: filtered.length })}
              {activeFilterCount > 0 && ` ${t("exams.filteredNote")}`}
            </div>
          </div>
        )}
      </div>

      {/* ── Alerts Panel ────────────────────────────────────────────────── */}
      {showAlerts && (
        <AlertsPanel
          alerts={alerts}
          onClose={() => setShowAlerts(false)}
        />
      )}

      {/* ── Exam Detail Slide-over ───────────────────────────────────────── */}
      {selectedExam && (
        <ExamDetailSlideOver
          exam={selectedExam}
          onClose={() => setSelectedExam(null)}
          onStatusChange={handleStatusChange}
          canManage={canManage}
        />
      )}
    </div>
  );
}