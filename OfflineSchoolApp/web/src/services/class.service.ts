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

// ─── Raw wire shapes ──────────────────────────────────────────────────────────
//
// The API is inconsistent across endpoints: some send camelCase, some snake_case,
// some populate `class`/`teacher` as objects and others send a bare id string.
// The normalisers below probe every one of those spellings, so the raw types
// spell them out rather than falling back to `any` — that way a field the API
// stops sending shows up here instead of silently becoming undefined.

interface RawTeacher {
  _id?:      string;
  id?:       string;
  name?:     string;
  email?:    string;
  schoolId?: string;
  isActive?: boolean;
}

interface RawClass {
  _id?:           string;
  id?:            string;
  name?:          string;
  level?:         string;
  section?:       string;
  schoolId?:      string;
  school_id?:     string;
  classTeacherId?:     string | null;
  class_teacher_id?:   string | null;
  classTeacherName?:   string | null;
  class_teacher_name?: string | null;
  isActive?:      boolean;
  deletedAt?:     string | null;
  deleted_at?:    string | null;
  createdAt?:     string;
  created_at?:    string;
  updatedAt?:     string;
  updated_at?:    string;
  subjectCount?:  number | string | null;
  studentCount?:  number | string | null;
}

interface RawSubject {
  _id?:          string;
  id?:           string;
  name?:         string;
  code?:         string;
  coefficient?:  number | string;
  class?:        RawClass | string | null;
  classId?:      string;
  class_id?:     string;
  teacher?:      RawTeacher | string | null;
  teacherId?:    string;
  teacher_id?:   string;
  teacherName?:  string;
  teacher_name?: string;
  teacherEmail?: string;
  schoolId?:     string;
  school_id?:    string;
  createdAt?:    string;
  created_at?:   string;
  updatedAt?:    string;
  updated_at?:   string;
}

// ─── Normalise class ──────────────────────────────────────────────────────────

function normaliseClass(raw: RawClass): Class {
  const id = raw._id || raw.id || "";

  return {
    _id:      id,
    id,
    name:     raw.name    || "",
    level:    raw.level   || "",
    section:  raw.section || "",
    schoolId: raw.schoolId || raw.school_id || "",

    // The form master, carried through.
    //
    // This was the one field on the Class type the normaliser did not fill,
    // and because it is optional nothing complained. Two things followed. The
    // Edit Class dialog reset classTeacherId to "" every time it opened, so a
    // class with a form master showed "No teacher assigned"; and the form then
    // submitted that "" back, which the server reads — correctly — as an
    // instruction to clear the assignment. Opening the dialog to rename a
    // class and pressing Save unassigned its teacher, silently.
    //
    // The name comes across too. It is stored on the class rather than looked
    // up, because a report card prints whoever held the class when it was
    // issued and a teacher who leaves has their account deactivated.
    classTeacherId:
      raw.classTeacherId ?? raw.class_teacher_id ?? null,
    classTeacherName:
      raw.classTeacherName ?? raw.class_teacher_name ?? null,

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

function normaliseSubject(raw: RawSubject): Subject {
  const rawClass   = typeof raw.class   === "object" && raw.class   ? raw.class   : null;
  const rawTeacher = typeof raw.teacher === "object" && raw.teacher ? raw.teacher : null;

  const classId =
    (typeof raw.class === "string" ? raw.class : null) ||
    rawClass?._id   ||
    rawClass?.id    ||
    raw.classId     ||
    raw.class_id    ||
    "";

  const teacherId =
    (typeof raw.teacher === "string" ? raw.teacher : null) ||
    rawTeacher?._id   ||
    rawTeacher?.id    ||
    raw.teacherId     ||
    raw.teacher_id    ||
    "";

  const teacherName =
    rawTeacher?.name  ||
    raw.teacherName   ||
    raw.teacher_name  ||
    "";

  const teacherEmail =
    rawTeacher?.email  ||
    raw.teacherEmail   ||
    "";

  const teacher: TeacherRef | undefined =
    rawTeacher
      ? {
          _id:      rawTeacher._id   || rawTeacher.id || "",
          name:     rawTeacher.name  || "",
          email:    rawTeacher.email || "",
          role:     "teacher" as const,
          schoolId: rawTeacher.schoolId || "",
          isActive: rawTeacher.isActive !== false,
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

  const classObj: Class | undefined = rawClass ? normaliseClass(rawClass) : undefined;

  const subjectId = raw._id || raw.id || "";

  return {
    _id:         subjectId,
    id:          subjectId,
    name:        raw.name || "",
    code:        raw.code || "",
    // Subjects created before the field existed have none; the server
    // normaliser defaults them to 1, and this mirrors that for safety.
    coefficient: Number(raw.coefficient) > 0 ? Number(raw.coefficient) : 1,
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

// Responses arrive as a bare array, as { <primaryKey>: [...] }, or as { data: ... }.
// The caller states which element type it expects; nothing here can verify that,
// which is exactly what the normalisers above are for.
type Envelope = Record<string, unknown> | unknown[] | null | undefined;

function unwrapList<T>(data: Envelope, primaryKey: string): T[] {
  if (Array.isArray(data)) return data as T[];
  const obj = (data ?? {}) as Record<string, unknown>;
  if (Array.isArray(obj[primaryKey])) return obj[primaryKey] as T[];
  if (Array.isArray(obj.data))        return obj.data as T[];
  return [];
}

function unwrapSingle<T>(data: Envelope, primaryKey: string): T {
  const obj = (data ?? {}) as Record<string, unknown>;
  return (obj[primaryKey] ?? obj.data ?? data) as T;
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
  return unwrapList<RawClass>(data, "classes").map(normaliseClass);
}

export async function createClass(
  payload: CreateClassPayload,
): Promise<Class> {
  const { data } = await api.post("/admin/classes", payload);
  return normaliseClass(unwrapSingle<RawClass>(data, "class"));
}

export async function updateClass(
  classId: EntityId,
  payload: UpdateClassPayload,
): Promise<Class> {
  const { data } = await api.put(`/admin/classes/${classId}`, payload);
  return normaliseClass(unwrapSingle<RawClass>(data, "class"));
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
  return normaliseClass(unwrapSingle<RawClass>(data, "class"));
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
  return unwrapList<RawSubject>(data, "subjects").map(normaliseSubject);
}

export async function createSubject(
  payload: CreateSubjectPayload,
): Promise<Subject> {
  const { data } = await api.post("/admin/subjects", payload);
  return normaliseSubject(unwrapSingle<RawSubject>(data, "subject"));
}

/**
 * What a coefficient change did to the exams beyond the subject row.
 *
 * The endpoint pushes a new coefficient into the exam subjects that were still
 * following the old one, and leaves alone both the ones set for a single exam
 * and the ones on exams whose results have already gone out. It reports which,
 * because until it did, the only way to discover that an edit had reached
 * nothing was to open a marks sheet and notice the old number.
 *
 * Nothing is recomputed: `reprocessRequired` says an exam that already has
 * marks now has stale averages, and when to redo them is the school's call.
 */
export interface CoefficientCascade {
  examSubjectsUpdated: number;
  examsAffected:       number;
  skippedFinalised:    number;
  skippedOverridden:   number;
  reprocessRequired:   boolean;
}

/** The subject, and what the change did elsewhere. */
export async function updateSubjectDetailed(
  subjectId: EntityId,
  payload:   UpdateSubjectPayload,
): Promise<{ subject: Subject; cascade: CoefficientCascade | null }> {
  const { data } = await api.put(`/admin/subjects/${subjectId}`, payload);
  return {
    subject: normaliseSubject(unwrapSingle<RawSubject>(data, "subject")),
    // Optional: a client may be talking to a server that predates it.
    cascade: (data as { coefficientCascade?: CoefficientCascade })
      ?.coefficientCascade ?? null,
  };
}

export async function updateSubject(
  subjectId: EntityId,
  payload:   UpdateSubjectPayload,
): Promise<Subject> {
  return (await updateSubjectDetailed(subjectId, payload)).subject;
}

export async function deleteSubject(subjectId: EntityId): Promise<void> {
  await api.delete(`/admin/subjects/${subjectId}`);
}