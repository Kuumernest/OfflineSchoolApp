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
  /** What the action is about — the tile wears that section's colour. */
  tone:     TileTone;
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
  /** What the module is about — the tile wears that section's colour. */
  tone:        TileTone;
}

export interface HealthMetric {
  key:             string;
  label:           string;
  icon:            LucideIcon;
  /** What the count is about — the tile wears that section's colour. */
  tone:            TileTone;
  /** Renders in the danger tone when the value is above zero. */
  alertOnNonZero?: boolean;
}

// ─────────────────────────────────────────────────────────
// QUICK ACTIONS
// All paths must match routes defined in App.tsx
// ─────────────────────────────────────────────────────────

// Lucide, not emoji. Emoji render differently on every OS, cannot inherit
// colour or weight, and put a cartoon next to a table of student records —
// they were the single loudest thing making this screen look unserious.
export const QUICK_ACTIONS: QuickAction[] = [
  { label: "Add student",       labelKey: "quickActions.addStudent",       icon: GraduationCap,  path: "/students/new",                tone: "students" },
  { label: "Add teacher",       labelKey: "quickActions.addTeacher",       icon: Users,          path: "/teachers/new",                tone: "teachers" },
  { label: "Create exam",       labelKey: "quickActions.createExam",       icon: FileText,       path: "/exams/new",                   tone: "exams" },
  { label: "Take attendance",   labelKey: "quickActions.takeAttendance",   icon: ClipboardCheck, path: "/attendance",                  tone: "attendance" },
  { label: "Post announcement", labelKey: "quickActions.postAnnouncement", icon: Megaphone,      path: "/announcements",               tone: "comms" },
  { label: "View reports",      labelKey: "quickActions.viewReports",      icon: BarChart3,      path: "/reports",                     tone: "reports" },
  { label: "Add class",         labelKey: "quickActions.addClass",         icon: School,         path: "/classes",                     tone: "students" },
  { label: "Assign teacher",    labelKey: "quickActions.assignTeacher",    icon: GitBranch,      path: "/teachers/assignments/assign", tone: "teachers" },
  { label: "Report templates",  labelKey: "quickActions.reportTemplates",  icon: LayoutTemplate, path: "/reports/templates",           tone: "reports" },
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
    tone:        "students",
  },
  {
    id:          "subjects",
    title:       "Subjects",
    description: "Create & link subjects",
    titleKey:    "modules.subjects",
    descKey:     "modules.subjectsDesc",    icon:        BookOpen,
    href:        "/subjects",
    tone:        "academic",
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
    tone:        "attendance",
  },
  {
    id:          "timetable",
    title:       "Timetable",
    description: "Schedule builder",
    titleKey:    "modules.timetable",
    descKey:     "modules.timetableDesc",    icon:        Clock,
    href:        "/timetable",
    tone:        "attendance",
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
    { key: "pendingApplications", label: "Pending Apps",  tone: "students", icon: FileText                       },
    { key: "approvedStudents",    label: "Students",      tone: "students", icon: GraduationCap                       },
    { key: "totalTeachers",       label: "Teachers",      tone: "teachers", icon: Users                       },
    { key: "unassignedTeachers",  label: "Unassigned",    tone: "teachers", icon: Users, alertOnNonZero: true },
  ],
  [
    { key: "totalClasses",        label: "Classes",       tone: "students", icon: School                       },
    { key: "totalSubjects",       label: "Class-subjects", tone: "academic", icon: BookOpen                       },
    { key: "unassignedClassSubjects", label: "No teacher", tone: "academic", icon: GitBranch, alertOnNonZero: true },
    { key: "activeAnnouncements", label: "Notices",       tone: "comms", icon: Megaphone                       },
  ],
  [
    { key: "totalPeriods",             label: "Teaching periods", tone: "attendance", icon: Clock                       },
    { key: "incompleteTimetableSlots", label: "No Timetable", tone: "attendance", icon: Calendar, alertOnNonZero: true },
    { key: "timetableConflicts",       label: "Conflicts",    tone: "attendance", icon: FileText, alertOnNonZero: true },
    { key: "classesWithoutSubjects",   label: "No Subjects",  tone: "academic", icon: School, alertOnNonZero: true },
  ],
  [
    { key: "totalReportTemplates", label: "Templates",   tone: "reports", icon: LayoutTemplate },
    { key: "defaultTemplateSet",   label: "Has Default", tone: "reports", icon: LayoutTemplate },
  ],
];