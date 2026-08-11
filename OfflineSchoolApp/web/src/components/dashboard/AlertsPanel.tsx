// web/src/components/dashboard/AlertsPanel.tsx
import { useNavigate }           from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronRight,
} from "lucide-react";
import { type SystemHealthStats } from "@/services/dashboard.service";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

type AlertSeverity = "danger" | "warning" | "info";

export interface DashAlert {
  id:      string;
  type:    AlertSeverity;
  message: string;
  route:   string;
}

// ─────────────────────────────────────────────────────────
// ALERT DERIVATION
// Pure function — easy to unit-test independently.
// ─────────────────────────────────────────────────────────

export function deriveAlerts(stats: SystemHealthStats): DashAlert[] {
  const list: DashAlert[] = [];

  if (stats.stalePendingApps > 0) {
    const n = stats.stalePendingApps;
    list.push({
      id:      "stale",
      type:    "danger",
      message: `${n} application${n > 1 ? "s" : ""} pending over 3 days`,
      // FIXED: route updated to match actual AdmissionsPage location
      route:   "/admissions",
    });
  }

  if (stats.unassignedTeachers > 0) {
    const n = stats.unassignedTeachers;
    list.push({
      id:      "unassigned",
      type:    "warning",
      message: `${n} teacher${n > 1 ? "s" : ""} not yet assigned`,
      route:   "/assignments",
    });
  }

  if (stats.classesWithoutSubjects > 0) {
    const n = stats.classesWithoutSubjects;
    list.push({
      id:      "missing-subjects",
      type:    "warning",
      message: `${n} class${n > 1 ? "es" : ""} missing subjects`,
      route:   "/classes?tab=subjects",
    });
  }

  if (stats.timetableConflicts > 0) {
    const n = stats.timetableConflicts;
    list.push({
      id:      "conflicts",
      type:    "danger",
      message: `${n} timetable conflict${n > 1 ? "s" : ""} detected`,
      route:   "/timetable",
    });
  }

  if (stats.incompleteTimetableSlots > 0 && stats.totalClasses > 0) {
    const pct = Math.round(
      (stats.incompleteTimetableSlots / stats.totalClasses) * 100
    );
    if (pct > 50) {
      const n = stats.incompleteTimetableSlots;
      list.push({
        id:      "timetable-incomplete",
        type:    "info",
        message: `${n} class${n > 1 ? "es" : ""} without timetable (${pct}%)`,
        route:   "/timetable",
      });
    }
  }

  /**
   * FIXED (Issue 3 from admin.routes.js fix):
   * assignedSubjects is now returned by the backend stats endpoint.
   * This alert fires correctly when no teacher-subject assignments exist
   * but teachers and subjects have been created.
   */
  if (
    stats.assignedSubjects === 0 &&
    stats.totalTeachers     >  0 &&
    stats.totalSubjects     >  0
  ) {
    list.push({
      id:      "no-assignments",
      type:    "warning",
      message: "No teacher assignments yet — assign teachers to subjects",
      route:   "/assignments",
    });
  }

  return list;
}

// ─────────────────────────────────────────────────────────
// STYLE MAP
// ─────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<
  AlertSeverity,
  {
    wrap:    string;
    icon:    string;
    text:    string;
    chevron: string;
    Icon:    typeof AlertCircle;
  }
> = {
  danger: {
    wrap:    "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800",
    icon:    "text-red-600 dark:text-red-400",
    text:    "text-red-800 dark:text-red-300",
    chevron: "text-red-400",
    Icon:    AlertCircle,
  },
  warning: {
    wrap:    "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800",
    icon:    "text-amber-600 dark:text-amber-400",
    text:    "text-amber-800 dark:text-amber-300",
    chevron: "text-amber-400",
    Icon:    AlertTriangle,
  },
  info: {
    wrap:    "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800",
    icon:    "text-blue-600 dark:text-blue-400",
    text:    "text-blue-800 dark:text-blue-300",
    chevron: "text-blue-400",
    Icon:    Info,
  },
};

// ─────────────────────────────────────────────────────────
// SINGLE ALERT ROW
// ─────────────────────────────────────────────────────────

function AlertRow({
  alert,
  onClick,
}: {
  alert:   DashAlert;
  onClick: () => void;
}) {
  const s = SEVERITY_STYLES[alert.type];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        w-full flex items-center gap-3
        rounded-lg border px-3 py-2.5 text-left
        transition-opacity hover:opacity-80
        ${s.wrap}
      `}
    >
      <s.Icon
        className={`h-4 w-4 shrink-0 ${s.icon}`}
        aria-hidden="true"
      />
      <span className={`flex-1 text-sm font-medium ${s.text}`}>
        {alert.message}
      </span>
      <ChevronRight
        className={`h-4 w-4 shrink-0 ${s.chevron}`}
        aria-hidden="true"
      />
    </button>
  );
}

// ─────────────────────────────────────────────────────────
// PUBLIC COMPONENT
// Returns null when there are no alerts so the parent grid
// does not leave an empty white card on screen.
// ─────────────────────────────────────────────────────────

export default function AlertsPanel({ alerts }: { alerts: DashAlert[] }) {
  const navigate = useNavigate();

  if (alerts.length === 0) return null;

  return (
    <div
      className="
        rounded-xl border border-gray-200 dark:border-gray-700
        bg-white dark:bg-gray-800
        p-4 shadow-sm
      "
    >
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        Alerts{" "}
        <span className="text-red-500 font-bold">({alerts.length})</span>
      </h3>

      <div className="space-y-2">
        {alerts.map((alert) => (
          <AlertRow
            key={alert.id}
            alert={alert}
            onClick={() => navigate(alert.route)}
          />
        ))}
      </div>
    </div>
  );
}