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
  Wallet,
  Receipt,
  Banknote,
  CalendarClock,
  Printer,
  FileSpreadsheet,
  KeyRound,
  Eye,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";
import { type LucideIcon } from "lucide-react";
import { type UserRole }   from "@/types";

// NOTE ON ROLES
//
// "student" appears in no entry below, and that is deliberate. Dashboard,
// Timetable, Exams, Results and Announcements all used to list it, but each of
// those pages reads from /admin/* — which answers 403 for a student — so the
// sidebar was offering five links that could only fail. The web console is a
// staff tool; the mobile app is the student experience.
//
// If a student view is built for the web, add "student" back to the entries it
// covers and drop the StaffOnly gate in App.tsx.

export interface NavItem {
  /**
   * English label. Kept as the fallback and as what the code reads when a
   * translation key is missing, so a new entry is never blank in the rail.
   */
  label:     string;
  /** Key into nav.* — see src/i18n/locales. */
  labelKey?: string;
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
    labelKey: "nav.dashboard",
    path:  "/dashboard",
    icon:  LayoutDashboard,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
  },

  // ── Students to watch ────────────────────────────────────
  // Teachers deliberately absent: the list names children by fee arrears,
  // which is bursar knowledge. A teacher view would first need the money
  // signal stripped — the API refuses them for the same reason.
  {
    label: "Students to watch",
    labelKey: "nav.watchlist",
    path:  "/watchlist",
    icon:  Eye,
    roles: ["super_admin", "school_admin", "admin"],
  },

  // ── Students ─────────────────────────────────────────────
  {
    label: "Students",
    labelKey: "nav.students",
    icon:  GraduationCap,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
    children: [
      {
        label: "All Students",
        labelKey: "nav.allStudents",
        path:  "/students",
        icon:  Users,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Admissions",
        labelKey: "nav.admissions",
        path:  "/students/admissions",
        icon:  UserCheck,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Teachers ─────────────────────────────────────────────
  {
    label: "Teachers",
    labelKey: "nav.teachers",
    icon:  School,
    roles: ["super_admin", "school_admin", "admin"],
    children: [
      {
        label: "All Teachers",
        labelKey: "nav.allTeachers",
        path:  "/teachers",
        icon:  Users,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Assignments",
        labelKey: "nav.assignments",
        path:  "/teachers/assignments",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Academic ─────────────────────────────────────────────
  {
    label: "Academic",
    labelKey: "nav.academic",
    icon:  BookOpen,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
    children: [
      {
        label: "Classes",
        labelKey: "nav.classes",
        path:  "/classes",
        icon:  School,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Subjects",
        labelKey: "nav.subjects",
        path:  "/subjects",
        icon:  BookMarked,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Timetable",
        labelKey: "nav.timetable",
        path:  "/timetable",
        icon:  CalendarDays,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Periods",
        labelKey: "nav.periods",
        path:  "/periods",
        icon:  Clock,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Attendance ────────────────────────────────────────────
  {
    label: "Attendance",
    labelKey: "nav.attendance",
    icon:  ClipboardCheck,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
    children: [
      {
        label: "Mark Attendance",
        labelKey: "nav.markAttendance",
        path:  "/attendance",
        icon:  UserCheck,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Reports",
        labelKey: "nav.reports",
        path:  "/attendance/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
    ],
  },

  // ── Fees ─────────────────────────────────────────────────
  // Money is bursar work, so teachers are deliberately absent from these
  // roles — the API refuses them anyway, and offering a link that 403s is
  // worse than not offering it.
  {
    label: "Fees",
    labelKey: "nav.fees",
    icon:  Wallet,
    roles: ["super_admin", "school_admin", "admin"],
    children: [
      {
        label: "Outstanding",
        labelKey: "nav.feesOverview",
        path:  "/fees",
        icon:  Wallet,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Fee structures",
        labelKey: "nav.feeStructures",
        path:  "/fees/structures",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Finance ──────────────────────────────────────────────
  // Money going out, kept apart from fees (money coming in) so a bursar
  // reconciling receipts is never one mis-click from generating payroll.
  {
    label: "Finance",
    labelKey: "nav.finance",
    icon:  Banknote,
    roles: ["super_admin", "school_admin", "admin"],
    children: [
      {
        label: "Expenses",
        labelKey: "nav.expenses",
        path:  "/finance/expenses",
        icon:  Receipt,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Salaries",
        labelKey: "nav.salaries",
        path:  "/finance/salaries",
        icon:  Banknote,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Payroll",
        labelKey: "nav.payroll",
        path:  "/finance/payroll",
        icon:  CalendarClock,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Financial reports",
        labelKey: "nav.reportsFinance",
        path:  "/finance/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Printing ─────────────────────────────────────────────
  // Teachers belong here: a class register is theirs to print. The API agrees,
  // so unlike Finance this link does not 403 for them.
  {
    label: "Printing",
    labelKey: "nav.documents",
    path:  "/documents",
    icon:  Printer,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
  },

  // Teachers are listed, but the server decides what they actually get: the
  // page builds its tiles from /api/exports, which returns only what the
  // caller may run. A teacher sees the roster and no Payroll tile at all.
  {
    label: "Exports",
    labelKey: "nav.exports",
    path:  "/exports",
    icon:  FileSpreadsheet,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
  },

  // Issuing a guardian code is office work, not a teacher's.
  {
    label: "Portal access",
    labelKey: "codes.title",
    path:  "/portal-codes",
    icon:  KeyRound,
    roles: ["super_admin", "school_admin", "admin"],
  },

  // ── End of year ──────────────────────────────────────────
  // Kept out of Students and out of Classes on purpose: this rewrites every
  // student's class in one act, and it should not sit one mis-click from
  // routine roster work.
  {
    label: "End of year",
    labelKey: "nav.promotion",
    icon:  GraduationCap,
    roles: ["super_admin", "school_admin", "admin"],
    children: [
      {
        label: "Promotion",
        labelKey: "nav.rollover",
        path:  "/promotion",
        icon:  GraduationCap,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        label: "Class progression",
        labelKey: "nav.progression",
        path:  "/promotion/progression",
        icon:  LayoutTemplate,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Exams ────────────────────────────────────────────────
  {
    label: "Exams",
    labelKey: "nav.exams",
    icon:  FileText,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
    children: [
      {
        label: "All Exams",
        labelKey: "nav.allExams",
        path:  "/exams",
        icon:  FileText,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Results",
        labelKey: "nav.results",
        path:  "/exams/results",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "admin", "teacher"],
      },
      {
        label: "Reports",
        labelKey: "nav.reports",
        path:  "/exams/reports",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Announcements ─────────────────────────────────────────
  {
    label: "Announcements",
    labelKey: "nav.announcements",
    path:  "/announcements",
    icon:  Megaphone,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
  },

  // ── Messages ──────────────────────────────────────────────
  // Teachers included: a teacher talking to a parent about one child is the
  // single most useful thing in the module, and it is theirs to start.
  {
    label: "Messages",
    labelKey: "nav.messages",
    path:  "/messages",
    icon:  MessageSquare,
    roles: ["super_admin", "school_admin", "admin", "teacher"],
  },

  // ── Message audit ─────────────────────────────────────────
  // Administrators only. Reading a thread here is recorded server-side, so
  // this is a deliberate destination rather than a tab off Messages.
  {
    label: "Message audit",
    labelKey: "nav.messageAudit",
    path:  "/messages/audit",
    icon:  ShieldAlert,
    roles: ["super_admin", "school_admin", "admin"],
  },

  // ── Reports ───────────────────────────────────────────────
  {
    label: "Reports",
    labelKey: "nav.reports",
    icon:  BarChart3,
    roles: ["super_admin", "school_admin", "admin"],
    children: [
      {
        label: "Overview",
        labelKey: "nav.overview",
        path:  "/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "admin"],
      },
      {
        // ✅ Matches App.tsx route and pages/reports/templates.tsx
        label: "Templates",
        labelKey: "nav.templates",
        path:  "/reports/templates",
        icon:  LayoutTemplate,
        roles: ["super_admin", "school_admin", "admin"],
      },
    ],
  },

  // ── Settings ─────────────────────────────────────────────
  {
    label: "Settings",
    labelKey: "nav.settings",
    path:  "/settings",
    icon:  Settings,
    roles: ["super_admin", "school_admin", "admin"],
  },
];