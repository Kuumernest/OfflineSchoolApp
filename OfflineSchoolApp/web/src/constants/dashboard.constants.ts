// web/src/constants/dashboard.constants.ts
import {
  GraduationCap,
  Users,
  School,
  BookOpen,
  FileText,
  CheckSquare,
  Megaphone,
  Clock,
  GitBranch,
  Calendar,
  Trophy,
  Settings,
  LayoutTemplate,
  type LucideIcon,
} from "lucide-react";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

export interface QuickAction {
  label: string;
  emoji: string;
  path:  string;
}

export interface Module {
  id:          string;
  title:       string;
  description: string;
  icon:        LucideIcon;
  color:       string;
  bg:          string;
  href:        string;
}

export interface HealthMetric {
  key:             string;
  label:           string;
  icon:            LucideIcon;
  color:           string;
  alertOnNonZero?: boolean;
}

// ─────────────────────────────────────────────────────────
// QUICK ACTIONS
// All paths must match routes defined in App.tsx
// ─────────────────────────────────────────────────────────

export const QUICK_ACTIONS: QuickAction[] = [
  { label: "Add Student",      emoji: "👨‍🎓", path: "/students/new"                },
  { label: "Add Teacher",      emoji: "👨‍🏫", path: "/teachers/new"                },
  { label: "Create Exam",      emoji: "📝",  path: "/exams/new"                   },
  { label: "Take Attendance",  emoji: "✅",  path: "/attendance"                  },
  { label: "Announcement",     emoji: "📢",  path: "/announcements"               },
  { label: "View Reports",     emoji: "📊",  path: "/reports"                     },
  { label: "Add Class",        emoji: "🏫",  path: "/classes"                     },
  { label: "Assign Teacher",   emoji: "🔗",  path: "/teachers/assignments/assign" },
  { label: "Report Templates", emoji: "🗂️",  path: "/reports/templates"           },
];

// ─────────────────────────────────────────────────────────
// ALL MODULES
// All hrefs must match routes defined in App.tsx
// ─────────────────────────────────────────────────────────

export const ALL_MODULES: Module[] = [
  {
    id:          "classes",
    title:       "Classes",
    description: "Create & manage classes",
    icon:        School,
    color:       "text-indigo-600",
    bg:          "bg-indigo-50 dark:bg-indigo-900/20",
    href:        "/classes",
  },
  {
    id:          "subjects",
    title:       "Subjects",
    description: "Create & link subjects",
    icon:        BookOpen,
    color:       "text-emerald-600",
    bg:          "bg-emerald-50 dark:bg-emerald-900/20",
    href:        "/subjects",
  },
  {
    id:          "teachers",
    title:       "Teachers",
    description: "Manage teacher profiles",
    icon:        Users,
    color:       "text-violet-600",
    bg:          "bg-violet-50 dark:bg-violet-900/20",
    href:        "/teachers",
  },
  {
    id:          "applications",
    title:       "Applications",
    description: "Review student applications",
    icon:        GraduationCap,
    color:       "text-amber-600",
    bg:          "bg-amber-50 dark:bg-amber-900/20",
    href:        "/students/admissions",
  },
  {
    id:          "students",
    title:       "Students",
    description: "Approved student roster",
    icon:        Users,
    color:       "text-emerald-600",
    bg:          "bg-emerald-50 dark:bg-emerald-900/20",
    href:        "/students",
  },
  {
    id:          "assignments",
    title:       "Assignments",
    description: "Teacher-subject allocation",
    icon:        GitBranch,
    color:       "text-pink-600",
    bg:          "bg-pink-50 dark:bg-pink-900/20",
    href:        "/teachers/assignments",
  },
  {
    id:          "periods",
    title:       "Periods",
    description: "Manage time periods",
    icon:        Clock,
    color:       "text-indigo-600",
    bg:          "bg-indigo-50 dark:bg-indigo-900/20",
    href:        "/periods",
  },
  {
    id:          "timetable",
    title:       "Timetable",
    description: "Schedule builder",
    icon:        Clock,
    color:       "text-red-600",
    bg:          "bg-red-50 dark:bg-red-900/20",
    href:        "/timetable",
  },
  {
    id:          "attendance",
    title:       "Attendance",
    description: "Tracking & reports",
    icon:        Calendar,
    color:       "text-teal-600",
    bg:          "bg-teal-50 dark:bg-teal-900/20",
    href:        "/attendance",
  },
  {
    id:          "exams",
    title:       "Exams",
    description: "Exams & results",
    icon:        Trophy,
    color:       "text-violet-600",
    bg:          "bg-violet-50 dark:bg-violet-900/20",
    href:        "/exams",
  },
  {
    id:          "announcements",
    title:       "Announcements",
    description: "Broadcast system",
    icon:        Megaphone,
    color:       "text-pink-600",
    bg:          "bg-pink-50 dark:bg-pink-900/20",
    href:        "/announcements",
  },
  {
    id:          "report-templates",
    title:       "Report Templates",
    description: "Design report card layouts",
    icon:        LayoutTemplate,
    color:       "text-cyan-600",
    bg:          "bg-cyan-50 dark:bg-cyan-900/20",
    href:        "/reports/templates",
  },
  {
    id:          "settings",
    title:       "Settings",
    description: "System configuration",
    icon:        Settings,
    color:       "text-gray-600",
    bg:          "bg-gray-50 dark:bg-gray-900/20",
    href:        "/settings",
  },
];

// ─────────────────────────────────────────────────────────
// HEALTH METRIC ROWS
// ─────────────────────────────────────────────────────────

export const HEALTH_METRIC_ROWS: HealthMetric[][] = [
  [
    { key: "pendingApplications", label: "Pending Apps",  icon: FileText,      color: "#D97706"                       },
    { key: "approvedStudents",    label: "Students",      icon: GraduationCap, color: "#059669"                       },
    { key: "totalTeachers",       label: "Teachers",      icon: Users,         color: "#4F46E5"                       },
    { key: "unassignedTeachers",  label: "Unassigned",    icon: Users,         color: "#DC2626", alertOnNonZero: true },
  ],
  [
    { key: "totalClasses",        label: "Classes",       icon: School,        color: "#7C3AED"                       },
    { key: "totalSubjects",       label: "Subjects",      icon: BookOpen,      color: "#059669"                       },
    { key: "assignedSubjects",    label: "Assigned",      icon: GitBranch,     color: "#DB2777"                       },
    { key: "activeAnnouncements", label: "Notices",       icon: Megaphone,     color: "#7C3AED"                       },
  ],
  [
    { key: "totalPeriods",             label: "Periods",      icon: Clock,          color: "#4F46E5"                       },
    { key: "incompleteTimetableSlots", label: "No Timetable", icon: Calendar,       color: "#DC2626", alertOnNonZero: true },
    { key: "timetableConflicts",       label: "Conflicts",    icon: FileText,       color: "#DC2626", alertOnNonZero: true },
    { key: "classesWithoutSubjects",   label: "No Subjects",  icon: School,         color: "#D97706", alertOnNonZero: true },
  ],
  [
    { key: "totalReportTemplates", label: "Templates",   icon: LayoutTemplate, color: "#0891B2" },
    { key: "defaultTemplateSet",   label: "Has Default", icon: LayoutTemplate, color: "#059669" },
  ],
];