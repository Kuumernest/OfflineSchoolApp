// web/src/types/attendance.types.ts

// ─────────────────────────────────────────────────────────────────────────────
// STATUS
//
// Students and teachers do NOT share a status vocabulary. The backend validates
// students against ["present","absent","late","excused"] and teachers against a
// set that swaps "excused" for "on_leave" (see attendance.routes.js). Keeping
// them as separate unions stops a teacher register from POSTing "excused" and
// getting a silent per-row rejection in the bulk response.
// ─────────────────────────────────────────────────────────────────────────────

export const STUDENT_STATUSES = ["present", "absent", "late", "excused"] as const;
export type StudentAttendanceStatus = (typeof STUDENT_STATUSES)[number];

export const TEACHER_STATUSES = ["present", "absent", "late", "on_leave"] as const;
export type TeacherAttendanceStatus = (typeof TEACHER_STATUSES)[number];

export type AttendanceStatus = StudentAttendanceStatus | TeacherAttendanceStatus;

export type AttendanceSubject = "students" | "teachers";

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present:  "Present",
  absent:   "Absent",
  late:     "Late",
  excused:  "Excused",
  on_leave: "On leave",
};

// ─────────────────────────────────────────────────────────────────────────────
// RECORDS
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendanceRecord {
  _id?:       string;
  schoolId?:  string;
  /** Present on student records only. */
  studentId?: string;
  /** Present on teacher records only. */
  teacherId?: string;
  classId?:   string | null;
  subjectId?: string | null;
  periodId?:  string | null;
  /** "YYYY-MM-DD". */
  date:       string;
  status:     AttendanceStatus;
  /** The server column is `note`, not `remark`. */
  note?:      string | null;
  markedBy?:  string | null;
  markedAt?:  string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A person on the register, whether or not they have been marked yet. */
export interface RosterEntry {
  id:          string;
  name:        string;
  email?:      string | null;
  admissionNo?: string | null;
  classId?:    string | null;
  className?:  string | null;
  /** The saved record for the selected date, or null if unmarked. */
  attendance:  AttendanceRecord | null;
}

/**
 * `marked` and `unmarked` are optional because the weekly trend endpoint omits
 * them — it reports per-day counts against the roster total but never how many
 * rows were written. Only /report/overview and /students/today carry them.
 */
export interface AttendanceSummary {
  total:    number;
  present:  number;
  absent:   number;
  late:     number;
  marked?:  number;
  excused?: number;
  on_leave?: number;
  unmarked?: number;
  rate?:    number;
}

export interface TodayAttendance {
  date:    string;
  roster:  RosterEntry[];
  records: AttendanceRecord[];
  summary: AttendanceSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITES
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkAttendanceRow {
  studentId?: string;
  teacherId?: string;
  status:     AttendanceStatus;
  note?:      string | null;
  /** Teacher registers only. */
  checkInTime?:  string | null;
  checkOutTime?: string | null;
}

export interface BulkAttendancePayload {
  schoolId?:  string;
  classId?:   string;
  subjectId?: string | null;
  periodId?:  string | null;
  date:       string;
  records:    BulkAttendanceRow[];
}

/**
 * The bulk endpoint is per-row tolerant: it answers 201 even when some rows
 * were rejected, reporting `saved` and `failed` as COUNTS and putting the
 * offending rows in `failedRecords`. A caller that only checks the HTTP status
 * will report a clean save for a register that half-failed.
 */
export interface BulkAttendanceResult {
  saved:         number;
  failed:        number;
  failedRecords: { reason?: string; studentId?: string; teacherId?: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────────────────────

export interface AttendanceOverview {
  date:     string;
  students: AttendanceSummary;
  teachers: AttendanceSummary;
}

export interface WeeklyAttendancePoint {
  date:     string;
  label?:   string;
  students?: AttendanceSummary;
  teachers?: AttendanceSummary;
  /** Present-rate for the day, 0–100. */
  rate?:    number;
}
