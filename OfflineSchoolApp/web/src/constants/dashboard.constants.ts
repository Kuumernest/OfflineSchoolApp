// web/src/constants/dashboard.constants.ts
import {
  GraduationCap,
  Users,
  School,
  BookOpen,
  FileText,
  Megaphone,
  Clock,
  GitBranch,
  Calendar,
  Trophy,
  Settings,
  LayoutTemplate,
  ClipboardCheck,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import type { TileTone } from "@/config/sections";
import type { DashAccent } from "@/config/dashboardTint";

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

export interface QuickAction {
  /** English label — the fallback when a translation key is missing. */
  label:    string;
  /** Key into quickActions.* — see src/i18n/locales. */
  labelKey: string;
  icon:     LucideIcon;
  path:     string;
  /**
   * The page's highlighted action (Create exam): the same tinted card as the
   * others, with a blue border and a ringed icon. There is no solid tile.
   */
  primary?: boolean;
  /** The action's colour — its card wash and icon square (config/dashboardTint.ts). */
  accent:   DashAccent;
}

export interface Module {
  id:          string;
  /** English title — the fallback when a translation key is missing. */
  title:       string;
  /** Key into modules.* — see src/i18n/locales. */
  titleKey:    string;
  description: string;
  /** Key into modules.*Desc — see src/i18n/locales. */
  descKey:     string;
  icon:        LucideIcon;
  href:        string;
  /** What the module is about — picks its icon box accent. */
  tone:        TileTone;
}

export interface HealthMetric {
  key:             string;
  label:           string;
  icon:            LucideIcon;
  /** What the count is about — picks its icon box accent. */
  tone:            TileTone;
  /**
   * A count that is a problem when above zero. White at zero; above zero it
   * takes the `alert` status tint (default: error).
   */
  alertOnNonZero?: boolean;
  alert?:          "warning" | "error";
  /** A count that is always shown in a status tint (notices → info). */
  semantic?:       "info";
}

// ─────────────────────────────────────────────────────────
// QUICK ACTIONS
// All paths must match routes defined in App.tsx
// ─────────────────────────────────────────────────────────

// Lucide, not emoji. Emoji render differently on every OS, cannot inherit
// colour or weight, and put a cartoon next to a table of student records —
// they were the single loudest thing making this screen look unserious.
export const QUICK_ACTIONS: QuickAction[] = [
  { label: "Add student",       labelKey: "quickActions.addStudent",       icon: GraduationCap,  path: "/students/new", accent: "blue" },
  { label: "Add teacher",       labelKey: "quickActions.addTeacher",       icon: Users,          path: "/teachers/new", accent: "violet" },
  { label: "Create exam",       labelKey: "quickActions.createExam",       icon: FileText,       path: "/exams/new", primary: true, accent: "blue" },
  { label: "Take attendance",   labelKey: "quickActions.takeAttendance",   icon: ClipboardCheck, path: "/attendance", accent: "green" },
  { label: "Post announcement", labelKey: "quickActions.postAnnouncement", icon: Megaphone,      path: "/announcements", accent: "sky" },
  { label: "View reports",      labelKey: "quickActions.viewReports",      icon: BarChart3,      path: "/reports", accent: "slate" },
  { label: "Add class",         labelKey: "quickActions.addClass",         icon: School,         path: "/classes", accent: "indigo" },
  { label: "Assign teacher",    labelKey: "quickActions.assignTeacher",    icon: GitBranch,      path: "/teachers/assignments/assign", accent: "violet" },
  { label: "Report templates",  labelKey: "quickActions.reportTemplates",  icon: LayoutTemplate, path: "/reports/templates", accent: "teal" },
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
    titleKey:    "modules.classes",
    descKey:     "modules.classesDesc",    icon:        School,
    href:        "/classes",
    tone:        "classes",
  },
  {
    id:          "subjects",
    title:       "Subjects",
    description: "Create & link subjects",
    titleKey:    "modules.subjects",
    descKey:     "modules.subjectsDesc",    icon:        BookOpen,
    href:        "/subjects",
    tone:        "subjects",
  },
  {
    id:          "teachers",
    title:       "Teachers",
    description: "Manage teacher profiles",
    titleKey:    "modules.teachers",
    descKey:     "modules.teachersDesc",    icon:        Users,
    href:        "/teachers",
    tone:        "teachers",
  },
  {
    id:          "applications",
    title:       "Admissions",
    description: "Review student applications",
    titleKey:    "modules.applications",
    descKey:     "modules.applicationsDesc",    icon:        GraduationCap,
    href:        "/students/admissions",
    tone:        "students",
  },
  {
    id:          "students",
    title:       "Students",
    description: "Approved student roster",
    titleKey:    "modules.students",
    descKey:     "modules.studentsDesc",    icon:        Users,
    href:        "/students",
    tone:        "students",
  },
  {
    id:          "assignments",
    title:       "Assignments",
    description: "Teacher-subject allocation",
    titleKey:    "modules.assignments",
    descKey:     "modules.assignmentsDesc",    icon:        GitBranch,
    href:        "/teachers/assignments",
    tone:        "teachers",
  },
  {
    id:          "periods",
    title:       "Periods",
    description: "Manage time periods",
    titleKey:    "modules.periods",
    descKey:     "modules.periodsDesc",    icon:        Clock,
    href:        "/periods",
    tone:        "timetable",
  },
  {
    id:          "timetable",
    title:       "Timetable",
    description: "Schedule builder",
    titleKey:    "modules.timetable",
    descKey:     "modules.timetableDesc",    icon:        Clock,
    href:        "/timetable",
    tone:        "timetable",
  },
  {
    id:          "attendance",
    title:       "Attendance",
    description: "Tracking & reports",
    titleKey:    "modules.attendance",
    descKey:     "modules.attendanceDesc",    icon:        Calendar,
    href:        "/attendance",
    tone:        "attendance",
  },
  {
    id:          "exams",
    title:       "Exams",
    description: "Exams & results",
    titleKey:    "modules.exams",
    descKey:     "modules.examsDesc",    icon:        Trophy,
    href:        "/exams",
    tone:        "exams",
  },
  {
    id:          "announcements",
    title:       "Announcements",
    description: "Broadcast system",
    titleKey:    "modules.announcements",
    descKey:     "modules.announcementsDesc",    icon:        Megaphone,
    href:        "/announcements",
    tone:        "comms",
  },
  {
    id:          "report-templates",
    title:       "Report Templates",
    description: "Design report card layouts",
    titleKey:    "modules.reportTemplates",
    descKey:     "modules.reportTemplatesDesc",    icon:        LayoutTemplate,
    href:        "/reports/templates",
    tone:        "reports",
  },
  {
    id:          "settings",
    title:       "Settings",
    description: "System configuration",
    titleKey:    "modules.settings",
    descKey:     "modules.settingsDesc",    icon:        Settings,
    href:        "/settings",
    tone:        "settings",
  },
];

// ─────────────────────────────────────────────────────────
// HEALTH METRIC ROWS
// ─────────────────────────────────────────────────────────

export const HEALTH_METRIC_ROWS: HealthMetric[][] = [
  [
    { key: "pendingApplications", label: "Pending Apps",  tone: "students", icon: FileText, alertOnNonZero: true, alert: "warning" },
    { key: "approvedStudents",    label: "Students",      tone: "students", icon: GraduationCap },
    { key: "totalTeachers",       label: "Teachers",      tone: "teachers", icon: Users },
    { key: "unassignedTeachers",  label: "Unassigned",    tone: "teachers", icon: Users, alertOnNonZero: true },
  ],
  [
    { key: "totalClasses",        label: "Classes",        tone: "classes",  icon: School },
    { key: "totalSubjects",       label: "Class-subjects", tone: "subjects", icon: BookOpen },
    { key: "unassignedClassSubjects", label: "No teacher", tone: "subjects", icon: GitBranch, alertOnNonZero: true },
    { key: "activeAnnouncements", label: "Notices",        tone: "comms",    icon: Megaphone, semantic: "info" },
  ],
  [
    { key: "totalPeriods",             label: "Teaching periods", tone: "timetable", icon: Clock },
    { key: "incompleteTimetableSlots", label: "No Timetable", tone: "timetable", icon: Calendar, alertOnNonZero: true },
    { key: "timetableConflicts",       label: "Conflicts",    tone: "timetable", icon: FileText, alertOnNonZero: true },
    { key: "classesWithoutSubjects",   label: "No Subjects",  tone: "subjects",  icon: School, alertOnNonZero: true },
  ],
  [
    { key: "totalReportTemplates", label: "Templates",   tone: "reports", icon: LayoutTemplate },
    { key: "defaultTemplateSet",   label: "Has Default", tone: "reports", icon: LayoutTemplate },
  ],
];
