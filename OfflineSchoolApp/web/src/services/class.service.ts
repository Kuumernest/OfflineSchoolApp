// web/src/services/class.service.ts
import api from "@/services/api";
import type {
  Class,
  Subject,
  TeacherRef,
  CreateClassPayload,
  UpdateClassPayload,
  CreateSubjectPayload,
  UpdateSubjectPayload,
  DeleteClassResult,
  EntityId,
} from "@/types/classes.types";

// ─── Normalise class ──────────────────────────────────────────────────────────

function normaliseClass(raw: any): Class {
  const id = raw._id || raw.id || "";

  return {
    _id:      id,
    id,
    name:     raw.name    || "",
    level:    raw.level   || "",
    section:  raw.section || "",
    schoolId: raw.schoolId || raw.school_id || "",
    isActive:
      raw.isActive !== false &&
      !raw.deletedAt         &&
      !raw.deleted_at,
    createdAt: raw.createdAt || raw.created_at || "",
    updatedAt: raw.updatedAt || raw.updated_at || "",
    subjectCount:
      raw.subjectCount != null ? Number(raw.subjectCount) : undefined,
    studentCount:
      raw.studentCount != null ? Number(raw.studentCount) : undefined,
  };
}

// ─── Normalise subject ────────────────────────────────────────────────────────

function normaliseSubject(raw: any): Subject {
  const classId =
    (typeof raw.class === "string" ? raw.class : null) ||
    raw.class?._id  ||
    raw.class?.id   ||
    raw.classId     ||
    raw.class_id    ||
    "";

  const teacherId =
    (typeof raw.teacher === "string" ? raw.teacher : null) ||
    raw.teacher?._id  ||
    raw.teacher?.id   ||
    raw.teacherId     ||
    raw.teacher_id    ||
    "";

  const teacherName =
    raw.teacher?.name ||
    raw.teacherName   ||
    raw.teacher_name  ||
    "";

  const teacherEmail =
    raw.teacher?.email ||
    raw.teacherEmail   ||
    "";

  const teacher: TeacherRef | undefined =
    raw.teacher && typeof raw.teacher === "object"
      ? {
          _id:      raw.teacher._id   || raw.teacher.id || "",
          name:     raw.teacher.name  || "",
          email:    raw.teacher.email || "",
          role:     "teacher" as const,
          schoolId: raw.teacher.schoolId || "",
          isActive: raw.teacher.isActive !== false,
        }
      : teacherId
        ? {
            _id:      teacherId,
            name:     teacherName,
            email:    teacherEmail,
            role:     "teacher" as const,
            schoolId: raw.schoolId || raw.school_id || "",
            isActive: true,
          }
        : undefined;

  const classObj: Class | undefined =
    raw.class && typeof raw.class === "object"
      ? normaliseClass(raw.class)
      : undefined;

  const subjectId = raw._id || raw.id || "";

  return {
    _id:         subjectId,
    id:          subjectId,
    name:        raw.name || "",
    code:        raw.code || "",
    classId,
    teacherId,
    teacherName,
    schoolId:    raw.schoolId || raw.school_id || "",
    class:       classObj,
    teacher,
    createdAt:   raw.createdAt || raw.created_at || "",
    updatedAt:   raw.updatedAt || raw.updated_at || "",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function unwrapList(data: any, primaryKey: string): any[] {
  if (Array.isArray(data))               return data;
  if (Array.isArray(data?.[primaryKey])) return data[primaryKey];
  if (Array.isArray(data?.data))         return data.data;
  return [];
}

function unwrapSingle(data: any, primaryKey: string): any {
  return data?.[primaryKey] ?? data?.data ?? data;
}

// ─── Classes ──────────────────────────────────────────────────────────────────

export async function fetchClasses(
  schoolId:        EntityId,
  includeInactive: boolean = false,
): Promise<Class[]> {
  const { data } = await api.get("/admin/classes", {
    params: {
      schoolId,
      includeInactive: String(includeInactive),
    },
  });
  return unwrapList(data, "classes").map(normaliseClass);
}

export async function createClass(
  payload: CreateClassPayload,
): Promise<Class> {
  const { data } = await api.post("/admin/classes", payload);
  return normaliseClass(unwrapSingle(data, "class"));
}

export async function updateClass(
  classId: EntityId,
  payload: UpdateClassPayload,
): Promise<Class> {
  const { data } = await api.put(`/admin/classes/${classId}`, payload);
  return normaliseClass(unwrapSingle(data, "class"));
}

export async function deleteClass(
  classId: EntityId,
): Promise<DeleteClassResult> {
  const { data } = await api.delete(`/admin/classes/${classId}`);
  return {
    deletedSubjects:    data?.deletedSubjects    ?? 0,
    deletedAssignments: data?.deletedAssignments ?? 0,
  };
}

export async function toggleClassActive(
  classId: EntityId,
): Promise<Class> {
  const { data } = await api.patch(
    `/admin/classes/${classId}/toggle-active`
  );
  return normaliseClass(unwrapSingle(data, "class"));
}

// ─── Subjects ─────────────────────────────────────────────────────────────────

export async function fetchSubjects(
  schoolId: EntityId,
  classId?: EntityId,
): Promise<Subject[]> {
  const { data } = await api.get("/admin/subjects", {
    params: {
      schoolId,
      ...(classId ? { classId } : {}),
    },
  });
  return unwrapList(data, "subjects").map(normaliseSubject);
}

export async function createSubject(
  payload: CreateSubjectPayload,
): Promise<Subject> {
  const { data } = await api.post("/admin/subjects", payload);
  return normaliseSubject(unwrapSingle(data, "subject"));
}

export async function updateSubject(
  subjectId: EntityId,
  payload:   UpdateSubjectPayload,
): Promise<Subject> {
  const { data } = await api.put(`/admin/subjects/${subjectId}`, payload);
  return normaliseSubject(unwrapSingle(data, "subject"));
}

export async function deleteSubject(subjectId: EntityId): Promise<void> {
  await api.delete(`/admin/subjects/${subjectId}`);
}