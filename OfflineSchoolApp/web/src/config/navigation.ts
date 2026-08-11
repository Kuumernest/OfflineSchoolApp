// web/src/config/navigation.ts
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  BookOpen,
  CalendarDays,
  ClipboardList,
  FileText,
  Megaphone,
  Settings,
  BarChart3,
  UserCheck,
  School,
  BookMarked,
  ClipboardCheck,
  Clock,
  LayoutTemplate,
} from "lucide-react";
import { type LucideIcon } from "lucide-react";
import { type UserRole }   from "@/types";

export interface NavItem {
  label:     string;
  path?:     string;
  icon:      LucideIcon;
  roles:     UserRole[];
  children?: NavItem[];
  badge?:    string;
}

export const NAV_ITEMS: NavItem[] = [

  // ── Dashboard ───────────────────────────────────────────
  {
    label: "Dashboard",
    path:  "/dashboard",
    icon:  LayoutDashboard,
    roles: ["super_admin", "school_admin", "admin", "teacher", "student"],
  },

  // ── Students ─────────────────────────────────────────────
  {
    label: "Students",
    icon:  GraduationCap,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
    children: [
      {
        label: "All Students",
        path:  "/students",
        icon:  Users,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Admissions",
        path:  "/students/admissions",
        icon:  UserCheck,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Teachers ─────────────────────────────────────────────
  {
    label: "Teachers",
    icon:  School,
    roles: ["super_admin", "school_admin", "admin"],
    children: [
      {
        label: "All Teachers",
        path:  "/teachers",
        icon:  Users,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Assignments",
        path:  "/teachers/assignments",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Academic ─────────────────────────────────────────────
  {
    label: "Academic",
    icon:  BookOpen,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
    children: [
      {
        label: "Classes",
        path:  "/classes",
        icon:  School,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Subjects",
        path:  "/subjects",
        icon:  BookMarked,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Timetable",
        path:  "/timetable",
        icon:  CalendarDays,
        roles: ["super_admin", "school_admin", "admin", "teacher", "student"],
      },
      {
        label: "Periods",
        path:  "/periods",
        icon:  Clock,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Attendance ────────────────────────────────────────────
  {
    label: "Attendance",
    icon:  ClipboardCheck,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
    children: [
      {
        label: "Mark Attendance",
        path:  "/attendance",
        icon:  UserCheck,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Reports",
        path:  "/attendance/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
    ],
  },

  // ── Exams ────────────────────────────────────────────────
  {
    label: "Exams",
    icon:  FileText,
    roles: ["super_admin", "school_admin", "admin", "teacher", "student"],
    children: [
      {
        label: "All Exams",
        path:  "/exams",
        icon:  FileText,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Results",
        path:  "/exams/results",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "admin", "teacher", "student"],
      },
      {
        label: "Reports",
        path:  "/exams/reports",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Announcements ─────────────────────────────────────────
  {
    label: "Announcements",
    path:  "/announcements",
    icon:  Megaphone,
    roles: ["super_admin", "school_admin", "admin", "teacher", "student"],
  },

  // ── Reports ───────────────────────────────────────────────
  {
    label: "Reports",
    icon:  BarChart3,
    roles: ["super_admin", "school_admin", "admin"],
    children: [
      {
        label: "Overview",
        path:  "/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        // ✅ Matches App.tsx route and pages/reports/templates.tsx
        label: "Templates",
        path:  "/reports/templates",
        icon:  LayoutTemplate,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Settings ─────────────────────────────────────────────
  {
    label: "Settings",
    path:  "/settings",
    icon:  Settings,
    roles: ["super_admin", "school_admin", "admin"],
  },
];