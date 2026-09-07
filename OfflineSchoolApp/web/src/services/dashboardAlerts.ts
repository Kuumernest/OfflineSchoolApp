// web/src/services/dashboardAlerts.ts
//
// The dashboard's alert shape and the pure function that derives it.
//
// This lived in components/dashboard/AlertsPanel.tsx, which made two problems
// out of one file. notification.service.ts needs deriveAlerts, so a service
// was importing from a component module and pulling React, react-router and
// lucide-react in behind it. And a module that exports both a component and a
// plain function loses React Fast Refresh: editing the panel remounted the
// subtree instead of preserving its state.
//
// The function was always meant to stand alone — its own comment said "easy to
// unit-test independently" while sitting in a file that could not be imported
// without a DOM.

import { type SystemHealthStats } from "@/services/dashboard.service";

export type AlertSeverity = "danger" | "warning" | "info";

export interface DashAlert {
  id:      string;
  type:    AlertSeverity;
  /** Resolved by AlertsPanel so the text follows the active language. */
  messageKey: string;
  params?: Record<string, unknown>;
  route:   string;
}

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

