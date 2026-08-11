// web/src/services/teacher.service.ts
import api from "@/services/api";
import { type Teacher, type Subject } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeacherFilters {
  schoolId: string;
  search?:  string;
  status?:  string;
  page?:    number;
  limit?:   number;
}

export interface TeacherListResponse {
  teachers: Teacher[];
  total:    number;
  page:     number;
  pages:    number;
}

interface RawAssignment {
  teacher?:      string | { _id?: string; id?: string };
  teacherId?:    string;
  teacher_id?:   string;
  subject?:      string | { _id?: string; id?: string; name?: string };
  subjectId?:    string;
  subject_id?:   string;
  subjectName?:  string;
  subject_name?: string;
  class?:        string | { _id?: string; id?: string; name?: string };
  classId?:      string;
  class_id?:     string;
  className?:    string;
  class_name?:   string;
}

interface RawTeacher {
  _id?:              string;
  id?:               string;
  name?:             string;
  fullName?:         string;
  full_name?:        string;
  email?:            string;
  phone?:            string;
  mobile?:           string;
  phoneNumber?:      string;
  schoolId?:         string;
  school_id?:        string;
  isActive?:         boolean;
  deletedAt?:        string | null;
  deleted_at?:       string | null;
  subjects?:         unknown[];
  assignedSubjects?: unknown[];
  createdAt?:        string;
  created_at?:       string;
  updatedAt?:        string;
  updated_at?:       string;
}

interface NormalisedAssignment {
  teacherId:   string;
  subjectId:   string;
  subjectName: string;
  classId:     string;
  className:   string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveId(
  field:      string | { _id?: string; id?: string } | undefined,
  fallback1?: string,
  fallback2?: string
): string {
  if (typeof field === "string") return field;
  if (field?._id) return field._id;
  if (field?.id)  return field.id;
  return fallback1 ?? fallback2 ?? "";
}

function resolveName(
  field: string | { name?: string } | undefined,
  ...fallbacks: (string | undefined)[]
): string {
  if (typeof field === "object" && field?.name) return field.name;
  for (const f of fallbacks) {
    if (f) return f;
  }
  return "";
}

// ─── Normalise assignment ─────────────────────────────────────────────────────

function normaliseAssignment(raw: RawAssignment): NormalisedAssignment {
  return {
    teacherId:   resolveId(raw.teacher,  raw.teacherId,  raw.teacher_id),
    subjectId:   resolveId(raw.subject,  raw.subjectId,  raw.subject_id),
    subjectName: resolveName(raw.subject, raw.subjectName, raw.subject_name),
    classId:     resolveId(raw.class,    raw.classId,    raw.class_id),
    className:   resolveName(raw.class,  raw.className,  raw.class_name),
  };
}

// ─── Normalise teacher ────────────────────────────────────────────────────────

function normaliseTeacher(
  raw: RawTeacher,
  assignmentMap: Map<string, NormalisedAssignment[]>
): Teacher {
  const id       = String(raw._id ?? raw.id ?? "").trim();
  const schoolId = raw.schoolId ?? raw.school_id ?? "";

  let subjects: Teacher["subjects"] = [];

  const embedded = raw.subjects ?? raw.assignedSubjects;
  if (Array.isArray(embedded) && embedded.length > 0) {
    subjects = embedded as Teacher["subjects"];
  }

  if ((subjects ?? []).length === 0 && assignmentMap.has(id)) {
    subjects = (assignmentMap.get(id) ?? []).map((a): Subject => ({
      _id:      a.subjectId,
      name:     a.subjectName || a.subjectId,
      schoolId,
      classId:  a.classId,
      class:    a.classId
        ? {
            _id:      a.classId,
            name:     a.className,
            schoolId,
            isActive: true,
          }
        : undefined,
    }));
  }

  return {
    _id:       id,
    name:      raw.name     ?? raw.fullName ?? raw.full_name ?? "",
    email:     raw.email    ?? "",
    phone:     raw.phone    ?? raw.mobile   ?? raw.phoneNumber ?? "",
    schoolId,
    isActive:  raw.isActive !== false && !raw.deletedAt && !raw.deleted_at,
    subjects:  subjects ?? [],
    createdAt: raw.createdAt ?? raw.created_at ?? "",
    updatedAt: raw.updatedAt ?? raw.updated_at ?? "",
  };
}

// ─── Fetch assignment map ─────────────────────────────────────────────────────

async function fetchAssignmentMap(
  schoolId: string
): Promise<Map<string, NormalisedAssignment[]>> {
  const map = new Map<string, NormalisedAssignment[]>();

  try {
    const { data } = await api.get("/admin/teacher-assignments", {
      params: { schoolId },
    });

    const rawList: RawAssignment[] =
      data?.assignments ??
      data?.data        ??
      (Array.isArray(data) ? data : []);

    for (const raw of rawList) {
      const norm = normaliseAssignment(raw);
      if (!norm.teacherId) continue;
      if (!map.has(norm.teacherId)) map.set(norm.teacherId, []);
      map.get(norm.teacherId)!.push(norm);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[TeacherService] fetchAssignmentMap failed:", message);
  }

  return map;
}

// ─── List teachers ────────────────────────────────────────────────────────────

export async function fetchTeachers(
  filters: TeacherFilters
): Promise<TeacherListResponse> {
  const [teacherRes, assignmentMap] = await Promise.all([
    api.get("/admin/teachers", { params: filters }),
    fetchAssignmentMap(filters.schoolId),
  ]);

  const data = teacherRes.data;

  const rawList: RawTeacher[] =
    data?.teachers ??
    data?.users    ??
    data?.data     ??
    (Array.isArray(data) ? data : []);

  const teachers = rawList.map((raw) => normaliseTeacher(raw, assignmentMap));

  return {
    teachers,
    total: data?.total ?? data?.count ?? teachers.length,
    page:  data?.page  ?? 1,
    pages: data?.pages ?? 1,
  };
}

// ─── Single teacher ───────────────────────────────────────────────────────────

export async function fetchTeacherById(teacherId: string): Promise<Teacher> {
  const { data } = await api.get(`/admin/teachers/${teacherId}`);
  const raw: RawTeacher = data?.teacher ?? data?.user ?? data?.data ?? data;

  const schoolId = String(raw?.schoolId ?? raw?.school_id ?? "").trim();
  const assignmentMap = schoolId
    ? await fetchAssignmentMap(schoolId)
    : new Map<string, NormalisedAssignment[]>();

  return normaliseTeacher(raw, assignmentMap);
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createTeacher(
  payload: Record<string, unknown>
): Promise<unknown> {
  const { data } = await api.post("/admin/teachers", payload);
  return data;
}

// ─── Update ───────────────────────────────────────────────────────────────────

export async function updateTeacher(
  teacherId: string,
  payload:   Record<string, unknown>
): Promise<unknown> {
  const { data } = await api.put(`/admin/teachers/${teacherId}`, payload);
  return data;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteTeacher(teacherId: string): Promise<unknown> {
  const { data } = await api.delete(`/admin/teachers/${teacherId}`);
  return data;
}

// ─── Fetch assignments (public) ───────────────────────────────────────────────

export async function fetchTeacherAssignments(
  schoolId: string
): Promise<RawAssignment[]> {
  const { data } = await api.get("/admin/teacher-assignments", {
    params: { schoolId },
  });
  return (
    data?.assignments ??
    data?.data        ??
    (Array.isArray(data) ? data : [])
  ) as RawAssignment[];
}