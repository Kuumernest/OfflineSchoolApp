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
  ShieldCheck,
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
//
// "admin" used to appear in every entry here and has been removed throughout.
// It was never a role the User schema could store — the enum has only ever held
// super_admin, school_admin, teacher and student — so it matched no account
// that has ever existed. See backend/src/config/roles.js.
//
// ── The rail a bursar sees ────────────────────────────────────────────────
//
// Six entries: Dashboard, Students to watch, Fees, Finance, Exports, Messages.
// Every other one is absent, and each absence matches a guard on the server
// rather than merely hiding a link — a bursar who types /settings into the
// address bar is stopped by RequireRole, and the API behind it would refuse
// them regardless.
//
// Two absences look like oversights and are not:
//
//   Students   A bursar CAN read the roster — the API allows it, because a
//              payment has to be posted against a real child. What these pages
//              are is the admission console: approve, reject, suspend, move,
//              promote. Every one of those actions is admin-only, so for a
//              bursar the screen would be a list with five dead buttons on it.
//              They reach a child through Fees instead, where the ledger
//              already carries the name, class and guardian a receipt needs.
//
//   Printing   Class lists, ID cards and transcripts are academic documents.
//              Receipts and fee statements print from the fee pages instead.

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
  // One path, two pages. /dashboard resolves by role in App.tsx: an admin gets
  // the whole school, a bursar gets the money. Sharing the path keeps the rail
  // and the post-login redirect from having to know the difference.
  {
    label: "Dashboard",
    labelKey: "nav.dashboard",
    path:  "/dashboard",
    icon:  LayoutDashboard,
    roles: ["super_admin", "school_admin", "bursar", "teacher"],
  },

  // ── Students to watch ────────────────────────────────────
  // Teachers deliberately absent: the list names children by fee arrears,
  // which is bursar knowledge. A teacher view would first need the money
  // signal stripped — the API refuses them for the same reason.
  //
  // And the bursar is exactly who that sentence describes, so they are listed.
  // Read-only: the endpoint behind it owns no collection and has no write
  // route at all.
  {
    label: "Students to watch",
    labelKey: "nav.watchlist",
    path:  "/watchlist",
    icon:  Eye,
    roles: ["super_admin", "school_admin", "bursar"],
  },

  // ── Students ─────────────────────────────────────────────
  {
    label: "Students",
    labelKey: "nav.students",
    icon:  GraduationCap,
    roles: ["super_admin", "school_admin", "teacher"],
    children: [
      {
        label: "All Students",
        labelKey: "nav.allStudents",
        path:  "/students",
        icon:  Users,
        roles: ["super_admin", "school_admin", "teacher"],
      },
      {
        label: "Admissions",
        labelKey: "nav.admissions",
        path:  "/students/admissions",
        icon:  UserCheck,
        roles: ["super_admin", "school_admin"],
      },
    ],
  },

  // ── Teachers ─────────────────────────────────────────────
  {
    label: "Teachers",
    labelKey: "nav.teachers",
    icon:  School,
    roles: ["super_admin", "school_admin"],
    children: [
      {
        label: "All Teachers",
        labelKey: "nav.allTeachers",
        path:  "/teachers",
        icon:  Users,
        roles: ["super_admin", "school_admin"],
      },
      {
        label: "Assignments",
        labelKey: "nav.assignments",
        path:  "/teachers/assignments",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin"],
      },
    ],
  },

  // ── Academic ─────────────────────────────────────────────
  {
    label: "Academic",
    labelKey: "nav.academic",
    icon:  BookOpen,
    roles: ["super_admin", "school_admin", "teacher"],
    children: [
      {
        label: "Classes",
        labelKey: "nav.classes",
        path:  "/classes",
        icon:  School,
        roles: ["super_admin", "school_admin"],
      },
      {
        label: "Subjects",
        labelKey: "nav.subjects",
        path:  "/subjects",
        icon:  BookMarked,
        roles: ["super_admin", "school_admin", "teacher"],
      },
      {
        label: "Timetable",
        labelKey: "nav.timetable",
        path:  "/timetable",
        icon:  CalendarDays,
        roles: ["super_admin", "school_admin", "teacher"],
      },
      {
        label: "Periods",
        labelKey: "nav.periods",
        path:  "/periods",
        icon:  Clock,
        roles: ["super_admin", "school_admin"],
      },
    ],
  },

  // ── Attendance ────────────────────────────────────────────
  {
    label: "Attendance",
    labelKey: "nav.attendance",
    icon:  ClipboardCheck,
    roles: ["super_admin", "school_admin", "teacher"],
    children: [
      {
        label: "Mark Attendance",
        labelKey: "nav.markAttendance",
        path:  "/attendance",
        icon:  UserCheck,
        roles: ["super_admin", "school_admin", "teacher"],
      },
      {
        label: "Reports",
        labelKey: "nav.reports",
        path:  "/attendance/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "teacher"],
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
    roles: ["super_admin", "school_admin", "bursar"],
    children: [
      {
        label: "Outstanding",
        labelKey: "nav.feesOverview",
        path:  "/fees",
        icon:  Wallet,
        roles: ["super_admin", "school_admin", "bursar"],
      },
      {
        label: "Fee structures",
        labelKey: "nav.feeStructures",
        path:  "/fees/structures",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin", "bursar"],
      },
    ],
  },

  // ── Approvals ────────────────────────────────────────────
  // Above Finance rather than buried inside it: for a head teacher this is an
  // inbox, and for a bursar it is where their own requests are. Neither is a
  // sub-page of expenses.
  //
  // Teachers are absent — nothing in the approval workflow is academic. The
  // page itself shows Approve buttons only to somebody holding
  // approvals.decide, which the bursar does not have and cannot be given.
  {
    label: "Approvals",
    labelKey: "nav.approvals",
    path:  "/approvals",
    icon:  ShieldCheck,
    roles: ["super_admin", "school_admin", "bursar"],
  },

  // ── Finance ──────────────────────────────────────────────
  // Money going out, kept apart from fees (money coming in) so a bursar
  // reconciling receipts is never one mis-click from generating payroll.
  {
    label: "Finance",
    labelKey: "nav.finance",
    icon:  Banknote,
    roles: ["super_admin", "school_admin", "bursar"],
    children: [
      {
        label: "Expenses",
        labelKey: "nav.expenses",
        path:  "/finance/expenses",
        icon:  Receipt,
        roles: ["super_admin", "school_admin", "bursar"],
      },
      // Listed for the bursar, who prepares and pays the payroll and cannot do
      // either without seeing the figures. Setting a salary is the one write in
      // this section they do not get: POST /finance/salary-structures is
      // admin-only, so the New button on this page answers 403 for them. That
      // is the intended shape rather than a bug to route around — what a member
      // of staff is owed is the school decision, not the paying clerk decision.
      {
        label: "Salaries",
        labelKey: "nav.salaries",
        path:  "/finance/salaries",
        icon:  Banknote,
        roles: ["super_admin", "school_admin", "bursar"],
      },
      {
        label: "Payroll",
        labelKey: "nav.payroll",
        path:  "/finance/payroll",
        icon:  CalendarClock,
        roles: ["super_admin", "school_admin", "bursar"],
      },
      {
        label: "Financial reports",
        labelKey: "nav.reportsFinance",
        path:  "/finance/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "bursar"],
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
    roles: ["super_admin", "school_admin", "teacher"],
  },

  // Teachers are listed, but the server decides what they actually get: the
  // page builds its tiles from /api/exports, which returns only what the
  // caller may run. A teacher sees the roster and no Payroll tile at all.
  {
    label: "Exports",
    labelKey: "nav.exports",
    path:  "/exports",
    icon:  FileSpreadsheet,
    roles: ["super_admin", "school_admin", "bursar", "teacher"],
  },

  // Issuing a guardian code is office work, not a teacher's.
  {
    label: "Portal access",
    labelKey: "codes.title",
    path:  "/portal-codes",
    icon:  KeyRound,
    roles: ["super_admin", "school_admin"],
  },

  // ── End of year ──────────────────────────────────────────
  // Kept out of Students and out of Classes on purpose: this rewrites every
  // student's class in one act, and it should not sit one mis-click from
  // routine roster work.
  {
    label: "End of year",
    labelKey: "nav.promotion",
    icon:  GraduationCap,
    roles: ["super_admin", "school_admin"],
    children: [
      {
        label: "Promotion",
        labelKey: "nav.rollover",
        path:  "/promotion",
        icon:  GraduationCap,
        roles: ["super_admin", "school_admin"],
      },
      {
        label: "Class progression",
        labelKey: "nav.progression",
        path:  "/promotion/progression",
        icon:  LayoutTemplate,
        roles: ["super_admin", "school_admin"],
      },
    ],
  },

  // ── Exams ────────────────────────────────────────────────
  {
    label: "Exams",
    labelKey: "nav.exams",
    icon:  FileText,
    roles: ["super_admin", "school_admin", "teacher"],
    children: [
      {
        label: "All Exams",
        labelKey: "nav.allExams",
        path:  "/exams",
        icon:  FileText,
        roles: ["super_admin", "school_admin", "teacher"],
      },
      {
        label: "Results",
        labelKey: "nav.results",
        path:  "/exams/results",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin", "teacher"],
      },
      {
        label: "Term Results",
        labelKey: "nav.termResults",
        path:  "/exams/term-results",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin"],
      },
      {
        label: "Annual Results",
        labelKey: "nav.annualResults",
        path:  "/exams/annual-results",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin"],
      },
      // Report cards are deliberately NOT listed here. They used to appear
      // both under Exams and under Reports, which read as two features and
      // sent people to whichever they found first. They now live once, under
      // Reports, alongside the templates they are built from.
    ],
  },

  // ── Announcements ─────────────────────────────────────────
  {
    label: "Announcements",
    labelKey: "nav.announcements",
    path:  "/announcements",
    icon:  Megaphone,
    roles: ["super_admin", "school_admin", "teacher"],
  },

  // ── Messages ──────────────────────────────────────────────
  // Teachers included: a teacher talking to a parent about one child is the
  // single most useful thing in the module, and it is theirs to start.
  //
  // The bursar too, and this is where their communication belongs: "your
  // payment of 75,000 FCFA has been received" is addressed to one family.
  // Announcements above is absent for the mirror-image reason — a broadcast to
  // the whole school is not a finance decision. Message audit below is absent
  // as well: the bursar sends, and does not read other threads.
  {
    label: "Messages",
    labelKey: "nav.messages",
    path:  "/messages",
    icon:  MessageSquare,
    roles: ["super_admin", "school_admin", "bursar", "teacher"],
  },

  // ── Message audit ─────────────────────────────────────────
  // Administrators only. Reading a thread here is recorded server-side, so
  // this is a deliberate destination rather than a tab off Messages.
  {
    label: "Message audit",
    labelKey: "nav.messageAudit",
    path:  "/messages/audit",
    icon:  ShieldAlert,
    roles: ["super_admin", "school_admin"],
  },

  // ── Reports ───────────────────────────────────────────────
  {
    label: "Reports",
    labelKey: "nav.reports",
    icon:  BarChart3,
    roles: ["super_admin", "school_admin"],
    children: [
      {
        label: "Overview",
        labelKey: "nav.overview",
        path:  "/reports",
        icon:  BarChart3,
        roles: ["super_admin", "school_admin"],
      },
      {
        // The report card generator. Was /exams/reports and was reachable
        // from the Exams group; that route now redirects here.
        label: "Report cards",
        labelKey: "reportCards.title",
        path:  "/reports/cards",
        icon:  ClipboardList,
        roles: ["super_admin", "school_admin"],
      },
      {
        // ✅ Matches App.tsx route and pages/reports/templates.tsx
        label: "Templates",
        labelKey: "nav.templates",
        path:  "/reports/templates",
        icon:  LayoutTemplate,
        roles: ["super_admin", "school_admin"],
      },
    ],
  },

  // ── Settings ─────────────────────────────────────────────
  {
    label: "Settings",
    labelKey: "nav.settings",
    path:  "/settings",
    icon:  Settings,
    roles: ["super_admin", "school_admin"],
  },
];