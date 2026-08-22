// web/src/utils/search.ts
import { fetchStudents }        from "@/services/student.service";
import { fetchTeachers }        from "@/services/teacher.service";
import { fetchClasses }         from "@/services/class.service";
import { subjectService }       from "@/services/subject.service";
import { useAuthStore }         from "@/store/auth.store";

// ─── Unified search result type ───────────────────────────────────────────────
export interface SearchResult {
  id:        string;
  label:     string;
  sublabel?: string;
  path:      string;
  type:      "page" | "student" | "teacher" | "class" | "subject";
}

// ─── Static page items ────────────────────────────────────────────────────────
const PAGE_ITEMS: SearchResult[] = [
  { id: "dashboard",          label: "Dashboard",          path: "/dashboard",          type: "page" },
  { id: "students",           label: "Students",           path: "/students",           type: "page" },
  { id: "teachers",           label: "Teachers",           path: "/teachers",           type: "page" },
  { id: "classes",            label: "Classes",            path: "/classes",            type: "page" },
  { id: "subjects",           label: "Subjects",           path: "/subjects",           type: "page" },
  { id: "attendance",         label: "Attendance",         path: "/attendance",         type: "page" },
  { id: "attendance-reports", label: "Attendance Reports", path: "/attendance/reports", type: "page" },
  { id: "timetable",          label: "Timetable",          path: "/timetable",          type: "page" },
  { id: "periods",            label: "Periods",            path: "/periods",            type: "page" },
  { id: "exams",              label: "Exams",              path: "/exams",              type: "page" },
  { id: "exam-results",       label: "Exam Results",       path: "/exams/results",      type: "page" },
  { id: "exam-reports",       label: "Exam Reports",       path: "/exams/reports",      type: "page" },
  { id: "admissions",         label: "Admissions",         path: "/students/admissions",   type: "page" },
  { id: "applications",       label: "Applications",       path: "/students/applications", type: "page" },
  { id: "assignments",        label: "Teacher Assignments", path: "/teachers/assignments", type: "page" },
  { id: "announcements",      label: "Announcements",      path: "/announcements",      type: "page" },
  { id: "reports",            label: "Reports",            path: "/reports",            type: "page" },
  { id: "report-templates",   label: "Report Templates",   path: "/reports/templates",  type: "page" },
  { id: "settings",           label: "Settings",           path: "/settings",           type: "page" },
];

// "Grades" and "Finance" were listed here and are not pages in this app —
// searching either one and pressing Enter navigated to the 404. Removed, and
// the pages that do exist but were missing from the index are added above.

// ─── Cache layer (5 min TTL) ──────────────────────────────────────────────────
interface CacheEntry<T> {
  data:      T;
  expiresAt: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache     = new Map<string, CacheEntry<SearchResult[]>>();

function getCached(key: string): SearchResult[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key: string, data: SearchResult[]): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

// ─── Clear cache (call after mutations / logout) ──────────────────────────────
export function clearSearchCache(): void {
  cache.clear();
}

// ─── Fetch + cache students ───────────────────────────────────────────────────
async function getStudentResults(schoolId: string): Promise<SearchResult[]> {
  const cacheKey = `students-${schoolId}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  try {
    const { students } = await fetchStudents({
      schoolId,
      limit:  500,
      status: "approved",
    });

    const results: SearchResult[] = students.map((s) => ({
      id:    `student-${s._id}`,
      label: s.name,
      sublabel: [
        s.class?.name     ? `Class ${s.class.name}`      : null,
        s.enrollmentNo    ? `No. ${s.enrollmentNo}`       : null,
        s.admissionNumber ? `Adm. ${s.admissionNumber}`   : null,
      ]
        .filter(Boolean)
        .join(" · "),
      path: `/students/${s._id}`,
      type: "student" as const,
    }));

    setCached(cacheKey, results);
    return results;
  } catch (err) {
    console.warn("[Search] Failed to fetch students:", err);
    return [];
  }
}

// ─── Fetch + cache teachers ───────────────────────────────────────────────────
async function getTeacherResults(schoolId: string): Promise<SearchResult[]> {
  const cacheKey = `teachers-${schoolId}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  try {
    const { teachers } = await fetchTeachers({ schoolId, limit: 500 });

    const results: SearchResult[] = teachers.map((t) => ({
      id:    `teacher-${t._id}`,
      label: t.name,
      sublabel: [
        t.email,
        t.subjects?.length
          ? `${t.subjects.length} subject${t.subjects.length > 1 ? "s" : ""}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      path: `/teachers/${t._id}`,
      type: "teacher" as const,
    }));

    setCached(cacheKey, results);
    return results;
  } catch (err) {
    console.warn("[Search] Failed to fetch teachers:", err);
    return [];
  }
}

// ─── Fetch + cache classes ────────────────────────────────────────────────────
async function getClassResults(schoolId: string): Promise<SearchResult[]> {
  const cacheKey = `classes-${schoolId}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  try {
    const classes = await fetchClasses(schoolId);

    const results: SearchResult[] = classes.map((c) => ({
      id:    `class-${c._id}`,
      label: c.name,
      sublabel: [
        c.level   ? `Level ${c.level}`     : null,
        c.section ? `Section ${c.section}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      path: `/classes/${c._id}`,
      type: "class" as const,
    }));

    setCached(cacheKey, results);
    return results;
  } catch (err) {
    console.warn("[Search] Failed to fetch classes:", err);
    return [];
  }
}

// ─── Fetch + cache subjects ───────────────────────────────────────────────────
async function getSubjectResults(schoolId: string): Promise<SearchResult[]> {
  const cacheKey = `subjects-${schoolId}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  try {
    const subjects = await subjectService.getAll({ schoolId, limit: 500 });

    const results: SearchResult[] = subjects.map((s) => ({
      id:    `subject-${String(s._id ?? s.id ?? "")}`,
      label: String(s.name ?? ""),
      sublabel: [
        s.className  || s.class_name
          ? `Class ${s.className   ?? s.class_name}`
          : null,
        s.teacherName || s.teacher_name
          ? `Teacher: ${s.teacherName ?? s.teacher_name}`
          : null,
        s.code
          ? `Code: ${s.code}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      path: `/subjects/${String(s._id ?? s.id ?? "")}`,
      type: "subject" as const,
    }));

    setCached(cacheKey, results);
    return results;
  } catch (err) {
    console.warn("[Search] Failed to fetch subjects:", err);
    return [];
  }
}

// ─── MAIN SEARCH FUNCTION ─────────────────────────────────────────────────────
export async function globalSearch(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  // Get schoolId from auth store
  const schoolId = useAuthStore.getState().user?.schoolId ?? "";
  if (!schoolId) {
    console.warn("[Search] No schoolId found in auth store");
    return [];
  }

  const q = query.toLowerCase().trim();

  // Fetch all data sources in parallel
  const [studentResults, teacherResults, classResults, subjectResults] =
    await Promise.all([
      getStudentResults(schoolId),
      getTeacherResults(schoolId),
      getClassResults(schoolId),
      getSubjectResults(schoolId),
    ]);

  // Filter pages
  const pageResults = PAGE_ITEMS.filter((p) =>
    p.label.toLowerCase().includes(q)
  );

  // Filter dynamic results — matches on label OR sublabel
  const filter = (items: SearchResult[]) =>
    items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.sublabel?.toLowerCase().includes(q)
    );

  // Return grouped: pages first, then dynamic results
  return [
    ...pageResults,
    ...filter(studentResults),
    ...filter(teacherResults),
    ...filter(classResults),
    ...filter(subjectResults),
  ];
}