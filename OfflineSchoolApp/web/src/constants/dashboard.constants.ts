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
}

export interface HealthMetric {
  key:             string;
  label:           string;
  icon:            LucideIcon;
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
  { label: "Add student",       labelKey: "quickActions.addStudent",       icon: GraduationCap,  path: "/students/new"                },
  { label: "Add teacher",       labelKey: "quickActions.addTeacher",       icon: Users,          path: "/teachers/new"                },
  { label: "Create exam",       labelKey: "quickActions.createExam",       icon: FileText,       path: "/exams/new"                   },
  { label: "Take attendance",   labelKey: "quickActions.takeAttendance",   icon: ClipboardCheck, path: "/attendance"                  },
  { label: "Post announcement", labelKey: "quickActions.postAnnouncement", icon: Megaphone,      path: "/announcements"               },
  { label: "View reports",      labelKey: "quickActions.viewReports",      icon: BarChart3,      path: "/reports"                     },
  { label: "Add class",         labelKey: "quickActions.addClass",         icon: School,         path: "/classes"                     },
  { label: "Assign teacher",    labelKey: "quickActions.assignTeacher",    icon: GitBranch,      path: "/teachers/assignments/assign" },
  { label: "Report templates",  labelKey: "quickActions.reportTemplates",  icon: LayoutTemplate, path: "/reports/templates"           },
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
  },
  {
    id:          "subjects",
    title:       "Subjects",
    description: "Create & link subjects",
    titleKey:    "modules.subjects",
    descKey:     "modules.subjectsDesc",    icon:        BookOpen,
    href:        "/subjects",
  },
  {
    id:          "teachers",
    title:       "Teachers",
    description: "Manage teacher profiles",
    titleKey:    "modules.teachers",
    descKey:     "modules.teachersDesc",    icon:        Users,
    href:        "/teachers",
  },
  {
    id:          "applications",
    title:       "Applications",
    description: "Review student applications",
    titleKey:    "modules.applications",
    descKey:     "modules.applicationsDesc",    icon:        GraduationCap,
    href:        "/students/admissions",
  },
  {
    id:          "students",
    title:       "Students",
    description: "Approved student roster",
    titleKey:    "modules.students",
    descKey:     "modules.studentsDesc",    icon:        Users,
    href:        "/students",
  },
  {
    id:          "assignments",
    title:       "Assignments",
    description: "Teacher-subject allocation",
    titleKey:    "modules.assignments",
    descKey:     "modules.assignmentsDesc",    icon:        GitBranch,
    href:        "/teachers/assignments",
  },
  {
    id:          "periods",
    title:       "Periods",
    description: "Manage time periods",
    titleKey:    "modules.periods",
    descKey:     "modules.periodsDesc",    icon:        Clock,
    href:        "/periods",
  },
  {
    id:          "timetable",
    title:       "Timetable",
    description: "Schedule builder",
    titleKey:    "modules.timetable",
    descKey:     "modules.timetableDesc",    icon:        Clock,
    href:        "/timetable",
  },
  {
    id:          "attendance",
    title:       "Attendance",
    description: "Tracking & reports",
    titleKey:    "modules.attendance",
    descKey:     "modules.attendanceDesc",    icon:        Calendar,
    href:        "/attendance",
  },
  {
    id:          "exams",
    title:       "Exams",
    description: "Exams & results",
    titleKey:    "modules.exams",
    descKey:     "modules.examsDesc",    icon:        Trophy,
    href:        "/exams",
  },
  {
    id:          "announcements",
    title:       "Announcements",
    description: "Broadcast system",
    titleKey:    "modules.announcements",
    descKey:     "modules.announcementsDesc",    icon:        Megaphone,
    href:        "/announcements",
  },
  {
    id:          "report-templates",
    title:       "Report Templates",
    description: "Design report card layouts",
    titleKey:    "modules.reportTemplates",
    descKey:     "modules.reportTemplatesDesc",    icon:        LayoutTemplate,
    href:        "/reports/templates",
  },
  {
    id:          "settings",
    title:       "Settings",
    description: "System configuration",
    titleKey:    "modules.settings",
    descKey:     "modules.settingsDesc",    icon:        Settings,
    href:        "/settings",
  },
];

// ─────────────────────────────────────────────────────────
// HEALTH METRIC ROWS
// ─────────────────────────────────────────────────────────

export const HEALTH_METRIC_ROWS: HealthMetric[][] = [
  [
    { key: "pendingApplications", label: "Pending Apps",  icon: FileText                       },
    { key: "approvedStudents",    label: "Students",      icon: GraduationCap                       },
    { key: "totalTeachers",       label: "Teachers",      icon: Users                       },
    { key: "unassignedTeachers",  label: "Unassigned",    icon: Users, alertOnNonZero: true },
  ],
  [
    { key: "totalClasses",        label: "Classes",       icon: School                       },
    { key: "totalSubjects",       label: "Subjects",      icon: BookOpen                       },
    { key: "assignedSubjects",    label: "Assigned",      icon: GitBranch                       },
    { key: "activeAnnouncements", label: "Notices",       icon: Megaphone                       },
  ],
  [
    { key: "totalPeriods",             label: "Periods",      icon: Clock                       },
    { key: "incompleteTimetableSlots", label: "No Timetable", icon: Calendar, alertOnNonZero: true },
    { key: "timetableConflicts",       label: "Conflicts",    icon: FileText, alertOnNonZero: true },
    { key: "classesWithoutSubjects",   label: "No Subjects",  icon: School, alertOnNonZero: true },
  ],
  [
    { key: "totalReportTemplates", label: "Templates",   icon: LayoutTemplate },
    { key: "defaultTemplateSet",   label: "Has Default", icon: LayoutTemplate },
  ],
];