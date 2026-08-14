// web/src/services/student.service.ts
import api from "@/services/api";
import { type Student } from "@/types";

type NormalisedStudent = Student & {
  enrollmentNo?:      string | null;
  admissionNumber?:   string;
  mustResetPassword?: boolean;
};

// ═════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═════════════════════════════════════════════════════════════════════════════

export interface StudentFilters {
  schoolId: string;
  classId?: string;
  status?:  string;
  search?:  string;
  page?:    number;
  limit?:   number;
}

export interface StudentListResponse {
  students: Student[];
  total:    number;
  page:     number;
  pages:    number;
}

export interface ApproveStudentPayload {
  classId: string;
}

export interface ApproveStudentResult {
  success:      boolean;
  enrollmentNo: string | null;
  tempPassword: string | null;
  emailSent:    boolean;
  warning?:     string | null;
  message:      string;
  data: {
    studentId:    string;
    userId:       string;
    classId:      string;
    className:    string;
    status:       string;
    enrollmentNo: string | null;
  };
}

export interface RejectStudentPayload {
  reason?: string;
}

export interface RejectStudentResult {
  success:   boolean;
  emailSent: boolean;
  message:   string;
  data: {
    studentId: string;
    status:    string;
  };
}

export interface EnrollmentNoResult {
  success:      boolean;
  enrollmentNo: string;
}

export interface PendingStudentsResponse {
  students:   Student[];
  data:       Student[];
  pagination: {
    page:  number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface StudentStats {
  pending:  number;
  approved: number;
  rejected: number;
  total:    number;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — DATE HELPER
// ═════════════════════════════════════════════════════════════════════════════

const resolveDate = (val: unknown): string => {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "string") return val;
  if (val instanceof Date) return isNaN(val.getTime()) ? "" : val.toISOString();

  if (typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;

    if (obj.$date !== undefined) {
      if (typeof obj.$date === "string") return obj.$date;
      if (typeof obj.$date === "number") return new Date(obj.$date).toISOString();
      if (typeof obj.$date === "object" && obj.$date !== null) {
        const inner = obj.$date as Record<string, unknown>;
        if (inner.$numberLong) {
          return new Date(Number(inner.$numberLong)).toISOString();
        }
      }
    }

    const str = String(obj);
    if (str !== "[object Object]") return str;
  }

  return "";
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — NORMALISE
// ═════════════════════════════════════════════════════════════════════════════

function normaliseStudent(raw: Record<string, unknown>): NormalisedStudent {

  // ── Name ──────────────────────────────────────────────────────────────────
  const nameParts = [raw.firstName, raw.lastName]
    .filter(Boolean)
    .map(String)
    .join(" ")
    .trim();

  const name = (
    (raw.name         as string) ||
    (raw.studentName  as string) ||
    (raw.student_name as string) ||
    (raw.fullName     as string) ||
    (raw.full_name    as string) ||
    nameParts                    ||
    "Unknown Student"
  ).trim();

  // ── Class ─────────────────────────────────────────────────────────────────
  let className = "Unassigned";
  let classId: string | null = null;

  if (raw.class && typeof raw.class === "object") {
    const cls = raw.class as Record<string, unknown>;
    className = String(cls.name || "Unassigned");
    classId   = String(cls._id  || cls.id || "") || null;
  } else if (raw.className || raw.class_name) {
    className = String(raw.className || raw.class_name || "Unassigned");
    classId   = String(raw.classId || raw.class_id || raw.class || "") || null;
  } else if (typeof raw.class === "string" && raw.class.length > 2) {
    classId = raw.class;
  }

  if (className === "Unassigned") {
    if (raw.grade)   className = String(raw.grade);
    if (raw.classId) classId   = String(raw.classId);
  }

  // ── Guardian ──────────────────────────────────────────────────────────────
  const guardianObj =
    raw.guardian && typeof raw.guardian === "object"
      ? (raw.guardian as Record<string, unknown>)
      : null;

  const guardianName: string | null =
    (raw.guardianName  as string) ||
    (raw.guardian_name as string) ||
    (guardianObj?.name as string) ||
    (raw.parentName    as string) ||
    null;

  const guardianPhone: string | null =
    (raw.guardianPhone  as string) ||
    (raw.guardian_phone as string) ||
    (guardianObj?.phone as string) ||
    (raw.parentPhone    as string) ||
    null;

  // ── Enrollment / admission number ─────────────────────────────────────────
  const enrollmentNo: string | null =
    (raw.enrollmentNo     as string) ||
    (raw.enrollment_no    as string) ||
    (raw.admissionNo      as string) ||
    (raw.admissionNumber  as string) ||
    (raw.admission_number as string) ||
    null;

  const admissionNumber = (
    (raw.admissionNumber  as string) ||
    (raw.admission_number as string) ||
    (raw.admissionNo      as string) ||
    (raw.enrollmentNo     as string) ||
    (raw.regNumber        as string) ||
    ""
  ).trim();

  // ── Address ───────────────────────────────────────────────────────────────
  const address: string | null =
    (raw.address      as string) ||
    (raw.homeAddress  as string) ||
    (raw.home_address as string) ||
    null;

  // ── Status / gender / phone ───────────────────────────────────────────────
  const status =
    (raw.status as string) ||
    (raw.isActive === false ? "inactive" : "active");

  const gender =
    (raw.gender as string) ||
    (raw.sex    as string) ||
    "";

  const phone =
    (raw.phone  as string) ||
    (raw.mobile as string) ||
    (raw.tel    as string) ||
    "";

  // ── Assemble ──────────────────────────────────────────────────────────────
  return {
    _id:            String(raw._id || raw.id || ""),
    name,
    email:          String(raw.email || ""),
    phone,
    gender,
    classId:        classId || null,
    schoolId:       String(raw.schoolId || raw.school_id || ""),
    enrollmentNo,
    admissionNumber,
    dateOfBirth:    resolveDate(raw.dateOfBirth ?? raw.date_of_birth ?? raw.dob),
    enrolledAt:     resolveDate(raw.enrolledAt  ?? raw.enrolled_at  ?? raw.approvedAt ?? raw.approved_at),
    createdAt:      resolveDate(raw.createdAt   ?? raw.created_at),
    updatedAt:      resolveDate(raw.updatedAt   ?? raw.updated_at),
    guardianName,
    guardianPhone,
    address,
    status,
    isActive:          raw.isActive !== false,
    mustResetPassword: (raw.mustResetPassword as boolean) ?? false,
    class: {
      _id:  classId  ?? undefined,
      name: className,
    } as Student["class"],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — DIRECT ENROLLMENT
// POST /students  (students.routes.js — admin only, atomic enroll)
//
// FIXED (Issue 2): schoolId is now REQUIRED in the TypeScript interface
// to match the backend which returns 400 if schoolId is missing.
// ═════════════════════════════════════════════════════════════════════════════

export async function enrollStudent(payload: {
  firstName:     string;
  lastName:      string;
  classId:       string;
  schoolId:      string;   // FIXED: was optional, backend requires it
  email?:        string;
  phone?:        string;
  gender?:       string;
  dateOfBirth?:  string;
  address?:      string;
  guardianName?: string;
  guardianPhone?:string;
}) {
  const { data } = await api.post("/students", payload);
  return data as {
    success:      true;
    message:      string;
    warning?:     string;
    enrollmentNo: string;
    tempPassword: string;
    emailSent:    boolean;
    student:      Student;
    data:         Student;
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — SINGLE STUDENT
// GET /admin/students/:id  (admin.routes.js)
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchStudentById(studentId: string): Promise<Student> {
  const { data } = await api.get(`/admin/students/${studentId}`);

  if (import.meta.env.DEV) {
    console.group(`📋 fetchStudentById(${studentId})`);
    console.log("Full API response  :", data);
    const unwrapped = data?.student ?? data?.data ?? data;
    console.log("Unwrapped envelope :", unwrapped);
    console.log("  name             :", unwrapped?.name, "| studentName:", unwrapped?.studentName);
    console.log("  enrollmentNo     :", unwrapped?.enrollmentNo);
    console.log("  dateOfBirth      :", unwrapped?.dateOfBirth);
    console.log("  gender           :", unwrapped?.gender);
    console.log("  address          :", unwrapped?.address);
    console.log("  guardianPhone    :", unwrapped?.guardianPhone);
    console.log("  enrolledAt       :", unwrapped?.enrolledAt);
    console.log("  classId          :", unwrapped?.classId, "| className:", unwrapped?.className);
    console.groupEnd();
  }

  const raw = (data?.student ?? data?.data ?? data) as Record<string, unknown>;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `fetchStudentById(${studentId}): unexpected response shape — ` +
      JSON.stringify(data)
    );
  }

  return normaliseStudent(raw);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — LIST
// GET /admin/students  (admin.routes.js)
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchStudents(
  filters: StudentFilters
): Promise<StudentListResponse> {
  const { data } = await api.get("/admin/students", { params: filters });

  const rawList: unknown[] =
    data?.students ??
    data?.users    ??
    data?.data     ??
    (Array.isArray(data) ? data : []);

  const students = (rawList as Record<string, unknown>[]).map(normaliseStudent);

  return {
    students,
    total: data?.total ?? data?.count ?? students.length,
    page:  data?.page  ?? 1,
    pages: data?.pages ?? 1,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — PENDING LIST
// GET /admin/students/pending  (admin.routes.js)
//
// FIXED (Issue 6): now hits admin.routes.js which is the correct
// admin-facing route. Pagination shape handled for both response formats.
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchPendingStudents(
  schoolId: string,
  page  = 1,
  limit = 50,
): Promise<PendingStudentsResponse> {
  const { data } = await api.get("/admin/students/pending", {
    params: { schoolId, page, limit },
  });

  const rawList: unknown[] =
    data?.students ??
    data?.data     ??
    (Array.isArray(data) ? data : []);

  const students = (rawList as Record<string, unknown>[]).map(normaliseStudent);

  // Handle both pagination shapes:
  //   admin.routes.js → { total, students, data }  (no pagination object)
  //   students.routes.js → { pagination: { page, limit, total, pages } }
  const pagination = data?.pagination;

  return {
    students,
    data: students,
    pagination: {
      page:  pagination?.page  ?? data?.page  ?? page,
      limit: pagination?.limit ?? data?.limit ?? limit,
      total: pagination?.total ?? data?.total ?? students.length,
      pages: pagination?.pages ?? data?.pages ?? Math.ceil((data?.total ?? students.length) / limit),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — APPROVED LIST
// GET /admin/students/approved  (admin.routes.js)
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchApprovedStudents(
  schoolId: string
): Promise<Student[]> {
  const { data } = await api.get("/admin/students/approved", {
    params: { schoolId },
  });

  const rawList: unknown[] =
    data?.students ??
    data?.data     ??
    (Array.isArray(data) ? data : []);

  return (rawList as Record<string, unknown>[]).map(normaliseStudent);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — APPROVE
// PUT /admin/students/:id/approve  (admin.routes.js)
//
// FIXED (Issue 5): was hitting /students/:id/approve (students.routes.js)
// Web admin dashboard should always use /admin/* routes for consistency
// and to avoid role guard conflicts.
// ═════════════════════════════════════════════════════════════════════════════

export async function approveStudent(
  studentId: string,
  payload:   ApproveStudentPayload,
): Promise<ApproveStudentResult> {
  const { data } = await api.put(
    `/admin/students/${studentId}/approve`,   // FIXED: was /students/
    payload
  );

  return {
    success:      data?.success      ?? true,
    enrollmentNo: data?.enrollmentNo ?? data?.data?.enrollmentNo ?? null,
    tempPassword: data?.tempPassword ?? null,
    emailSent:    data?.emailSent    ?? false,
    warning:      data?.warning      ?? null,
    message:      data?.message      ?? "Student approved",
    data: {
      studentId:    data?.data?.studentId    ?? studentId,
      userId:       data?.data?.userId       ?? "",
      classId:      data?.data?.classId      ?? payload.classId,
      className:    data?.data?.className    ?? "",
      status:       data?.data?.status       ?? "approved",
      enrollmentNo: data?.data?.enrollmentNo ?? data?.enrollmentNo ?? null,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — REJECT
// PUT /admin/students/:id/reject  (admin.routes.js)
//
// FIXED (Issue 5): was hitting /students/:id/reject (students.routes.js)
// ═════════════════════════════════════════════════════════════════════════════

export async function rejectStudent(
  studentId: string,
  payload:   RejectStudentPayload = {},
): Promise<RejectStudentResult> {
  const { data } = await api.put(
    `/admin/students/${studentId}/reject`,    // FIXED: was /students/
    payload
  );

  return {
    success:   data?.success   ?? true,
    emailSent: data?.emailSent ?? false,
    message:   data?.message   ?? "Application rejected",
    data: {
      studentId: data?.data?.studentId ?? studentId,
      status:    data?.data?.status    ?? "rejected",
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — DELETE
// DELETE /admin/students/:id  (admin.routes.js)
//
// FIXED (Issue 1): was hitting /students/:id (students.routes.js)
// which is the correct route but admin.routes.js has richer deletion
// logic (also removes linked User account).
// ═════════════════════════════════════════════════════════════════════════════

export async function deleteStudent(studentId: string): Promise<unknown> {
  const { data } = await api.delete(`/students/${studentId}`); // FIXED
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11 — SUSPEND
// PATCH /admin/students/:id/suspend  (admin.routes.js)
//
// FIXED (Issue 3): was hitting /students/:id/suspend which goes through
// studentOnly guard and would reject admin users.
// ═════════════════════════════════════════════════════════════════════════════

export async function suspendStudent(studentId: string): Promise<unknown> {
  const { data } = await api.patch(`/students/${studentId}/suspend`); // FIXED
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12 — RESTORE
// PATCH /admin/students/:id/restore  (admin.routes.js)
//
// FIXED (Issue 3): was hitting /students/:id/restore
// ═════════════════════════════════════════════════════════════════════════════

export async function restoreStudent(studentId: string): Promise<unknown> {
  const { data } = await api.patch(`/students/${studentId}/restore`); // FIXED
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13 — MOVE CLASS
// PATCH /admin/students/:id/move  (admin.routes.js)
//
// FIXED (Issue 3): was hitting /students/:id/move
// ═════════════════════════════════════════════════════════════════════════════

export async function moveStudentToClass(
  studentId: string,
  classId:   string
): Promise<unknown> {
  const { data } = await api.patch(
    `/admin/students/${studentId}/move`,      // FIXED
    { classId }
  );
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14 — GENERATE ENROLLMENT NUMBER
// POST /students/:id/enrollment-number  (students.routes.js)
//
// This one stays on /students/ — it is a student-facing operation
// that does not exist on admin.routes.js
// ═════════════════════════════════════════════════════════════════════════════

export async function generateEnrollmentNo(
  studentId: string,
  schoolId:  string,
): Promise<EnrollmentNoResult> {
  const { data } = await api.post(
    `/students/${studentId}/enrollment-number`,
    { schoolId }
  );

  return {
    success:      data?.success      ?? true,
    enrollmentNo: data?.enrollmentNo ?? "",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15 — CREATE (raw)
// POST /admin/students  (admin.routes.js)
// ═════════════════════════════════════════════════════════════════════════════

export async function createStudent(
  payload: Record<string, unknown>
): Promise<unknown> {
  const { data } = await api.post("/admin/students", payload);
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 16 — UPDATE
// PUT /admin/students/:id  (admin.routes.js)
// ═════════════════════════════════════════════════════════════════════════════

export async function updateStudent(
  studentId: string,
  payload:   Record<string, unknown>
): Promise<unknown> {
  const { data } = await api.put(`/admin/students/${studentId}`, payload);
  return data;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 17 — CLASSES
// GET /admin/classes  (admin.routes.js)
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchClasses(schoolId: string): Promise<unknown[]> {
  const { data } = await api.get("/admin/classes", { params: { schoolId } });
  return data?.classes ?? data?.data ?? (Array.isArray(data) ? data : []);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 18 — STATS
// GET /students/stats/summary  (students.routes.js)
//
// This stays on /students/ — it is the only stats route and exists
// only in students.routes.js, not in admin.routes.js
// ═════════════════════════════════════════════════════════════════════════════

export async function fetchStudentStats(
  schoolId: string
): Promise<StudentStats> {
  const { data } = await api.get("/students/stats/summary", {
    params: { schoolId },
  });

  const stats = data?.data ?? data;

  return {
    pending:  stats?.pending  ?? 0,
    approved: stats?.approved ?? 0,
    rejected: stats?.rejected ?? 0,
    total:    stats?.total    ?? 0,
  };
}