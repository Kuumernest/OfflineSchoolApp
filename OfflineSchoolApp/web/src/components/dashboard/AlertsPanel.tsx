// web/src/components/dashboard/AlertsPanel.tsx
import { useNavigate }           from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  Info,
  ChevronRight,
} from "lucide-react";
import { type SystemHealthStats } from "@/services/dashboard.service";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

type AlertSeverity = "danger" | "warning" | "info";

export interface DashAlert {
  id:      string;
  type:    AlertSeverity;
  /** Resolved by AlertsPanel so the text follows the active language. */
  messageKey: string;
  params?: Record<string, unknown>;
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
      messageKey: "alerts.appsPending", params: { count: n },
      // The admissions page is mounted under /students, not at the root. The
      // bare "/admissions" this used to point at matched no route, so acting
      // on the most urgent alert on the dashboard landed on the 404 page.
      route:   "/students/admissions",
    });
  }

  if (stats.unassignedTeachers > 0) {
    const n = stats.unassignedTeachers;
    list.push({
      id:      "unassigned",
      type:    "warning",
      messageKey: "alerts.teachersUnassigned", params: { count: n },
      route:   "/teachers/assignments",
    });
  }

  if (stats.classesWithoutSubjects > 0) {
    const n = stats.classesWithoutSubjects;
    list.push({
      id:      "missing-subjects",
      type:    "warning",
      messageKey: "alerts.classesNoSubjects", params: { count: n },
      route:   "/classes?tab=subjects",
    });
  }

  if (stats.timetableConflicts > 0) {
    const n = stats.timetableConflicts;
    list.push({
      id:      "conflicts",
      type:    "danger",
      messageKey: "alerts.timetableConflicts", params: { count: n },
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
        messageKey: "alerts.classesNoTimetable", params: { count: n, pct },
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
      messageKey: "alerts.noAssignments",
      route:   "/teachers/assignments",
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
    wrap:    "bg-danger-soft border-danger-line hover:brightness-[0.98]",
    icon:    "text-danger",
    text:    "text-danger",
    chevron: "text-danger/50",
    Icon:    AlertCircle,
  },
  warning: {
    wrap:    "bg-warning-soft border-warning-line hover:brightness-[0.98]",
    icon:    "text-warning",
    text:    "text-warning",
    chevron: "text-warning/50",
    Icon:    AlertTriangle,
  },
  info: {
    wrap:    "bg-info-soft border-info-line hover:brightness-[0.98]",
    icon:    "text-info",
    text:    "text-info",
    chevron: "text-info/50",
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
  const { t } = useTranslation();
  const s = SEVERITY_STYLES[alert.type];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        flex w-full items-center gap-3
        rounded-card border px-4 py-3 text-left
        transition-[filter]
        ${s.wrap}
      `}
    >
      <s.Icon
        className={`h-4 w-4 shrink-0 ${s.icon}`}
        aria-hidden="true"
      />
      <span className={`flex-1 text-sm ${s.text}`}>
        {t(alert.messageKey, alert.params)}
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
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (alerts.length === 0) return null;

  return (
    /*
      No card wrapper. These already carry a tinted, bordered surface each —
      nesting them inside a white panel with an "Alerts (3)" heading framed a
      warning inside a box inside a box, and the count restated what three
      visible rows already said.
    */
    <div className="space-y-2">
      {alerts.map((alert) => (
        <AlertRow
          key={alert.id}
          alert={alert}
          onClick={() => navigate(alert.route)}
        />
      ))}
    </div>
  );
}