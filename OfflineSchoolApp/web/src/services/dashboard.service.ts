// web/src/services/dashboard.service.ts
import api from "@/lib/axios";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface StudentStats {
  total:  number;
  active: number;
  new:    number;
}

export interface TeacherStats {
  total:  number;
  active: number;
}

export interface ClassStats {
  total:        number;
  withSubjects: number;
}

export interface SubjectStats {
  total: number;
}

export interface ExamStats {
  total:     number;
  ongoing:   number;
  completed: number;
  draft:     number;
  scheduled: number;
}

export interface AttendanceStats {
  todayPresent: number;
  todayAbsent:  number;
  rate:         number;
  /** Register rows written today — includes late and excused. */
  marked:       number;
  /** The roster this rate is a percentage of. */
  total:        number;
}

export interface RecentExam {
  _id:        string;
  title:      string;
  status:     "draft" | "ongoing" | "completed" | "scheduled";
  subject?:   string;
  className?: string;
  date?:      string;
  createdAt?: string;
}

export interface RecentAnnouncement {
  _id:       string;
  title:     string;
  content:   string;
  createdAt: string;
  priority?: "low" | "normal" | "high";
  author?:   string;
}

export interface SystemHealthStats {
  // row 1
  pendingApplications:      number;
  approvedStudents:         number;
  totalTeachers:            number;
  unassignedTeachers:       number;
  // row 2
  totalClasses:             number;
  totalSubjects:            number;
  assignedSubjects:         number;
  activeAnnouncements:      number;
  // row 3
  totalPeriods:             number;
  incompleteTimetableSlots: number;
  timetableConflicts:       number;
  classesWithoutSubjects:   number;
  // alert-only field
  stalePendingApps:         number;
}

export interface SchoolInfo {
  name:     string;
  motto?:   string;
  /** Stored path ("/uploads/…"), absolute URL, or raw base64. */
  logo?:    string;
  logoUrl?: string;
  /** Byte length of an inline logo the server chose not to send. */
  logoLen?: number | null;

  // ── Extended school profile (school settings screen) ──────────────────
  code?:                string;
  address?:             string;
  postalCode?:          string;
  city?:                string;
  state?:               string;
  country?:             string;
  phone?:               string;
  email?:               string;
  website?:             string;
  schoolType?:          string;
  termSystem?:          string;
  registrationNumber?:  string;
  foundedYear?:         number | null;
  principalName?:       string;
  description?:         string;
  academicYearStart?:   string;
  academicYearEnd?:     string;
  schoolDays?:          string[];
  schoolStartTime?:     string;
  schoolEndTime?:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== "") {
      p.set(k, String(v));
    }
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

function toArray<T>(raw: unknown, ...keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const k of [...keys, "data", "results", "items"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}

const n = (v: unknown, fallback = 0): number =>
  typeof v === "number" && !isNaN(v) ? v : fallback;

// ─────────────────────────────────────────────────────────────────────────────
// BASE PATH
// ─────────────────────────────────────────────────────────────────────────────

const BASE = "/admin";

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT STATS
// GET /admin/students/stats
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchStudentStats(schoolId: string): Promise<StudentStats> {
  try {
    const { data } = await api.get(`${BASE}/students/stats${qs({ schoolId })}`);

    // Handle both flat and nested responses
    const d = (data as Record<string, unknown>)?.data ?? data;

    return {
      total:  n((d as Record<string, number>).total  ?? (d as Record<string, number>).approved),
      active: n((d as Record<string, number>).active ?? (d as Record<string, number>).approved),
      new:    n((d as Record<string, number>).new    ?? (d as Record<string, number>).pending),
    };
  } catch (err) {
    console.warn("[dashboard] fetchStudentStats failed:", err);
    return { total: 0, active: 0, new: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER STATS
// GET /admin/teachers/stats
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchTeacherStats(schoolId: string): Promise<TeacherStats> {
  try {
    const { data } = await api.get(`${BASE}/teachers/stats${qs({ schoolId })}`);
    const d = (data as Record<string, unknown>)?.data ?? data;
    return {
      total:  n((d as Record<string, number>).total),
      active: n((d as Record<string, number>).active),
    };
  } catch (err) {
    console.warn("[dashboard] fetchTeacherStats failed:", err);
    return { total: 0, active: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASS STATS
// GET /admin/classes/stats
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchClassStats(schoolId: string): Promise<ClassStats> {
  try {
    const { data } = await api.get(`${BASE}/classes/stats${qs({ schoolId })}`);
    const d = (data as Record<string, unknown>)?.data ?? data;
    return {
      total:        n((d as Record<string, number>).total),
      withSubjects: n((d as Record<string, number>).withSubjects),
    };
  } catch (err) {
    console.warn("[dashboard] fetchClassStats failed:", err);
    return { total: 0, withSubjects: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SUBJECT STATS
// GET /admin/subjects/stats
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchSubjectStats(schoolId: string): Promise<SubjectStats> {
  try {
    const { data } = await api.get(`${BASE}/subjects/stats${qs({ schoolId })}`);
    const d = (data as Record<string, unknown>)?.data ?? data;
    return {
      total: n((d as Record<string, number>).total),
    };
  } catch (err) {
    console.warn("[dashboard] fetchSubjectStats failed:", err);
    return { total: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXAM STATS
// GET /admin/exams/stats
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchExamStats(schoolId: string): Promise<ExamStats> {
  try {
    const { data } = await api.get(`${BASE}/exams/stats${qs({ schoolId })}`);
    const d = (data as Record<string, unknown>)?.data ?? data;
    return {
      total:     n((d as Record<string, number>).total),
      ongoing:   n((d as Record<string, number>).ongoing),
      completed: n((d as Record<string, number>).completed),
      draft:     n((d as Record<string, number>).draft),
      scheduled: n((d as Record<string, number>).scheduled),
    };
  } catch (err) {
    console.warn("[dashboard] fetchExamStats failed:", err);
    return { total: 0, ongoing: 0, completed: 0, draft: 0, scheduled: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE STATS
//
// The Attendance model may not exist yet on every deployment.
// This function tries multiple endpoint paths and always returns zeros
// gracefully rather than causing a 500 to break the dashboard.
//
// GET /admin/attendance/stats  (primary)
// GET /admin/attendance/today  (fallback 1)
// GET /attendance/stats        (fallback 2)
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAttendanceStats(
  schoolId: string
): Promise<AttendanceStats> {
  const endpoints = [
    `${BASE}/attendance/stats`,
    `${BASE}/attendance/today`,
    `/attendance/stats`,
  ];

  for (const endpoint of endpoints) {
    try {
      const { data } = await api.get(`${endpoint}${qs({ schoolId })}`);

      // Handle both flat and nested shapes
      const d = (data as Record<string, unknown>)?.data ?? data;
      const r  = d as Record<string, number>;

      const present = n(r.todayPresent ?? r.present    ?? r.totalPresent);
      const absent  = n(r.todayAbsent  ?? r.absent     ?? r.totalAbsent);
      const rate    = n(r.rate         ?? r.percentage  ?? r.attendanceRate);

      // `marked` counts every register row, late and excused included.
      // The widget used to derive it as present + absent, which reads a
      // register where nobody was simply present or absent as a register
      // nobody took. Older responses carry neither field, hence the
      // fallback to the old arithmetic.
      const marked = n(r.marked ?? (present + absent));
      const total  = n(r.total  ?? marked);

      return { todayPresent: present, todayAbsent: absent, rate, marked, total };

    } catch (err) {
      const status = (err as { response?: { status?: number } })
        ?.response?.status;

      // 404 → endpoint doesn't exist, try the next one
      if (status === 404) continue;

      // 500 → backend error (e.g. Attendance model missing) — return zeros
      // without retrying because retrying a broken endpoint is pointless
      if (status === 500) {
        console.warn(
          `[dashboard] fetchAttendanceStats: ${endpoint} returned 500 — ` +
          `attendance module may not be configured yet`
        );
        return { todayPresent: 0, todayAbsent: 0, rate: 0, marked: 0, total: 0 };
      }

      // Network / other error — log and fall through to zeros
      console.warn(`[dashboard] fetchAttendanceStats (${endpoint}):`, err);
      return { todayPresent: 0, todayAbsent: 0, rate: 0, marked: 0, total: 0 };
    }
  }

  // All endpoints exhausted
  return { todayPresent: 0, todayAbsent: 0, rate: 0, marked: 0, total: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECENT EXAMS
// GET /exams
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRecentExams(
  schoolId: string,
  limit = 5,
): Promise<RecentExam[]> {
  try {
    const { data } = await api.get(`/exams${qs({ schoolId, limit, sort: "-createdAt" })}`);
    return toArray<Record<string, unknown>>(data, "exams", "results").map((e) => ({
      _id:        String(e._id       || e.id     || ""),
      title:      String(e.title     || e.name   || e.examName || "Untitled"),
      status:     String(e.status    || "draft") as RecentExam["status"],
      subject:    e.subject    ? String(e.subject)    : undefined,
      className:  e.class      ? String(e.class)
                : e.className  ? String(e.className)  : undefined,
      date:       e.date       ? String(e.date)
                : e.examDate   ? String(e.examDate)
                : e.createdAt  ? String(e.createdAt)  : undefined,
      createdAt:  e.createdAt  ? String(e.createdAt)  : undefined,
    }));
  } catch (err) {
    console.warn("[dashboard] fetchRecentExams failed:", err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECENT ANNOUNCEMENTS
// GET /announcements
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRecentAnnouncements(
  schoolId: string,
  limit = 5,
): Promise<RecentAnnouncement[]> {
  try {
    const { data } = await api.get(
      `/announcements${qs({ schoolId, limit, sort: "-createdAt" })}`
    );
    return toArray<Record<string, unknown>>(data, "announcements").map((a) => ({
      _id:       String(a._id      || a.id     || ""),
      title:     String(a.title    || a.subject || "Untitled"),
      content:   String(a.content  || a.message || a.body || ""),
      createdAt: String(a.createdAt || ""),
      priority:  (a.priority as RecentAnnouncement["priority"]) ?? "normal",
      author:
        typeof a.author === "object" && a.author !== null
          ? String((a.author as Record<string, unknown>).name ?? "")
          : String(a.author ?? ""),
    }));
  } catch (err) {
    console.warn("[dashboard] fetchRecentAnnouncements failed:", err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM HEALTH
//
// Reads from the single /admin/stats endpoint which computes all 12 metrics.
// No additional HTTP request is needed — the backend already aggregates
// everything into one response.
//
// GET /admin/stats
// ─────────────────────────────────────────────────────────────────────────────

interface AdminStatsPayload {
  pendingApplications?:      number;
  approvedStudents?:         number;
  totalTeachers?:            number;
  unassignedTeachers?:       number;
  totalClasses?:             number;
  totalSubjects?:            number;
  totalAssignments?:         number;   // backend key → maps to assignedSubjects
  activeAnnouncements?:      number;
  totalPeriods?:             number;
  incompleteTimetableSlots?: number;
  timetableConflicts?:       number;
  classesWithoutSubjects?:   number;
  stalePendingApps?:         number;
}

interface AdminStatsResponse {
  success?: boolean;
  stats?:   AdminStatsPayload;
  data?:    AdminStatsPayload;
}

export async function fetchSystemHealth(
  schoolId: string
): Promise<SystemHealthStats> {
  const ZERO: SystemHealthStats = {
    pendingApplications:      0,
    approvedStudents:         0,
    totalTeachers:            0,
    unassignedTeachers:       0,
    totalClasses:             0,
    totalSubjects:            0,
    assignedSubjects:         0,
    activeAnnouncements:      0,
    totalPeriods:             0,
    incompleteTimetableSlots: 0,
    timetableConflicts:       0,
    classesWithoutSubjects:   0,
    stalePendingApps:         0,
  };

  try {
    const { data } = await api.get<AdminStatsResponse>(
      `${BASE}/stats${qs({ schoolId })}`
    );

    // /admin/stats may wrap under "stats" or "data"
    const s = data.stats ?? data.data;

    if (!s || typeof s !== "object") {
      console.warn("[dashboard] fetchSystemHealth: unexpected shape", data);
      return ZERO;
    }

    return {
      pendingApplications:      n(s.pendingApplications),
      approvedStudents:         n(s.approvedStudents),
      totalTeachers:            n(s.totalTeachers),
      unassignedTeachers:       n(s.unassignedTeachers),
      totalClasses:             n(s.totalClasses),
      totalSubjects:            n(s.totalSubjects),
      assignedSubjects:         n(s.totalAssignments),   // key rename
      activeAnnouncements:      n(s.activeAnnouncements),
      totalPeriods:             n(s.totalPeriods),
      incompleteTimetableSlots: n(s.incompleteTimetableSlots),
      timetableConflicts:       n(s.timetableConflicts),
      classesWithoutSubjects:   n(s.classesWithoutSubjects),
      stalePendingApps:         n(s.stalePendingApps),
    };
  } catch (err) {
    console.warn("[dashboard] fetchSystemHealth failed:", err);
    return ZERO;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL INFO
//
// GET /admin/school-info
// ─────────────────────────────────────────────────────────────────────────────

interface AdminSchoolInfoResponse {
  success?: boolean;
  school?:  SchoolInfo & Record<string, unknown>;
  data?:    SchoolInfo & Record<string, unknown>;
}

export async function fetchSchoolInfo(
  schoolId: string
): Promise<SchoolInfo | null> {
  try {
    const unwrap = (d: AdminSchoolInfoResponse) =>
      d.school ?? d.data ?? (d as unknown as SchoolInfo & Record<string, unknown>);

    const { data } = await api.get<AdminSchoolInfoResponse>(
      `${BASE}/school-info${qs({ schoolId })}`
    );

    let s = unwrap(data);

    if (!s?.name) return null;

    // The endpoint withholds the logo by default — a legacy school stores it
    // inline as ~160 KB of base64, and re-reading that on every poll was what
    // made this call time out. It sends `logoLen` as a fingerprint instead.
    //
    // So: a logo that is absent but has a non-zero length was withheld, not
    // missing, and needs the explicit opt-in request. A migrated school
    // returns its "/uploads/..." path on the light path and skips this.
    const logoLen = Number(s.logoLen ?? 0);
    if (!s.logo && !s.logoUrl && logoLen > 0) {
      try {
        const full = await api.get<AdminSchoolInfoResponse>(
          `${BASE}/school-info${qs({ schoolId, includeLogo: 1 })}`
        );
        const withLogo = unwrap(full.data);
        if (withLogo?.logo) s = withLogo;
      } catch {
        // Non-fatal: fall through and render the placeholder rather than
        // failing the whole dashboard over a picture.
      }
    }

    return {
      name:    String(s.name),
      motto:   s.motto   ? String(s.motto)   : undefined,
      // Accept both "logo" (raw base64) and "logoUrl" (full URL / data URI)
      // Passed through verbatim; utils/logoSrc decides how to render it,
      // since the value may be a stored path, a URL, or raw base64.
      logo:    s.logo    ? String(s.logo)
             : s.logoUrl ? String(s.logoUrl) : undefined,
      // Extended school profile — carried through so any consumer (dashboard,
      // student detail, etc.) can render the full picture without a second
      // request or a local copy that has fewer fields than the server.
      code:               s.code               ? String(s.code)               : undefined,
      address:            s.address            ? String(s.address)            : undefined,
      postalCode:         s.postalCode         ? String(s.postalCode)         : undefined,
      city:               s.city               ? String(s.city)               : undefined,
      state:              s.state              ? String(s.state)              : undefined,
      country:            s.country            ? String(s.country)            : undefined,
      phone:              s.phone              ? String(s.phone)              : undefined,
      email:              s.email              ? String(s.email)              : undefined,
      website:            s.website            ? String(s.website)            : undefined,
      schoolType:         s.schoolType         ? String(s.schoolType)         : undefined,
      termSystem:         s.termSystem         ? String(s.termSystem)         : undefined,
      registrationNumber: s.registrationNumber ? String(s.registrationNumber) : undefined,
      foundedYear:        typeof s.foundedYear === "number" ? s.foundedYear : undefined,
      principalName:      s.principalName      ? String(s.principalName)      : undefined,
      description:        s.description        ? String(s.description)        : undefined,
      academicYearStart:  s.academicYearStart  ? String(s.academicYearStart)  : undefined,
      academicYearEnd:    s.academicYearEnd    ? String(s.academicYearEnd)    : undefined,
      schoolDays:         Array.isArray(s.schoolDays) ? s.schoolDays.map(String) : undefined,
      schoolStartTime:    s.schoolStartTime    ? String(s.schoolStartTime)    : undefined,
      schoolEndTime:      s.schoolEndTime      ? String(s.schoolEndTime)      : undefined,
    };
  } catch (err) {
    console.warn("[dashboard] fetchSchoolInfo failed:", err);
    return null;
  }
}