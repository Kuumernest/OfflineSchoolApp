// web/src/services/subject.service.ts
"use strict";

import api from "@/services/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateSubjectPayload {
  name:         string;
  code?:        string;
  classId:      string;
  teacherId?:   string;
  /** Optional weighting toward the average; 1 = normal, 2 = counts double. */
  coefficient?: number;
  schoolId:     string;
}

export interface UpdateSubjectPayload {
  name?:        string;
  code?:        string;
  classId?:     string;
  teacherId?:   string;
  coefficient?: number;
  schoolId?:    string;
}

export interface Subject {
  _id:          string;
  id?:          string;
  name:         string;
  code?:        string;
  coefficient?: number;
  classId:      string;
  teacherId?:   string;
  teacherName?: string;
  schoolId:     string;
  createdAt:    string;
  updatedAt:    string;
}

export interface RawSubject {
  _id?:          unknown;
  id?:           unknown;
  name?:         unknown;
  code?:         unknown;
  coefficient?:  unknown;
  classId?:      unknown;
  class_id?:     unknown;
  class?:        unknown;
  className?:    string;
  class_name?:   string;
  teacherId?:    unknown;
  teacher_id?:   unknown;
  teacher?:      unknown;
  teacherName?:  string;
  teacher_name?: string;
  schoolId?:     unknown;
}

export interface GetAllSubjectsParams {
  schoolId:   string;
  classId?:   string;
  teacherId?: string;
  limit?:     number;
  page?:      number;
  /**
   * The caller's role. When it is "teacher" the request goes to
   * /teacher/my-subjects instead of /admin/subjects — see fetchSubjects for
   * why these are two different lists rather than one route with a filter.
   */
  role?:      string;
}

// ─── Response envelopes ───────────────────────────────────────────────────────

interface SubjectListEnvelope {
  subjects?: RawSubject[];
  data?:     RawSubject[];
}

interface SubjectSingleEnvelope {
  subject?: Subject;
  data?:    Subject;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const unwrapList = (raw: SubjectListEnvelope | RawSubject[]): RawSubject[] => {
  if (Array.isArray(raw)) return raw;
  return raw.subjects ?? raw.data ?? [];
};

const unwrapSingle = (raw: SubjectSingleEnvelope | Subject): Subject => {
  const envelope = raw as SubjectSingleEnvelope;
  return envelope.subject ?? envelope.data ?? (raw as Subject);
};

// ─── Named exports ────────────────────────────────────────────────────────────

export const createSubject = async (
  payload: CreateSubjectPayload
): Promise<Subject> => {
  const { data } = await api.post<SubjectSingleEnvelope | Subject>(
    "/admin/subjects",
    payload
  );
  return unwrapSingle(data);
};

/**
 * The subject list, from whichever endpoint the caller is entitled to.
 *
 * The sidebar has always offered teachers a Subjects link, and this function
 * has always asked /admin/subjects — which is admin-only. So for a teacher the
 * link rendered a page of 403s: the nav promised something the API refused.
 *
 * Fixed on the client rather than by widening the admin route, because the two
 * are not the same list. /admin/subjects is every subject in the school, which
 * is an administrator's view. A teacher wants the subjects they have been
 * assigned to teach, and /teacher/my-subjects already answers exactly that from
 * their TeacherAssignment rows. Opening the admin route to teachers would have
 * given them the whole catalogue and called it a fix.
 *
 * Both endpoints answer { subjects: [...] }, so unwrapList handles either.
 */
export const fetchSubjects = async (
  schoolId: string,
  role?: string
): Promise<RawSubject[]> => {
  const mine = role === "teacher";

  const { data } = await api.get<SubjectListEnvelope | RawSubject[]>(
    mine ? "/teacher/my-subjects" : "/admin/subjects",
    // my-subjects reads the school from the token; passing schoolId would be
    // ignored, and passing it anyway invites the idea that it could be changed.
    mine ? undefined : { params: { schoolId } }
  );
  return unwrapList(data);
};

export const fetchSubjectById = async (subjectId: string): Promise<Subject> => {
  const { data } = await api.get<SubjectSingleEnvelope | Subject>(
    `/admin/subjects/${subjectId}`
  );
  return unwrapSingle(data);
};

export const updateSubject = async (
  subjectId: string,
  payload:   UpdateSubjectPayload
): Promise<Subject> => {
  const { data } = await api.put<SubjectSingleEnvelope | Subject>(
    `/admin/subjects/${subjectId}`,
    payload
  );
  return unwrapSingle(data);
};

export const deleteSubject = async (subjectId: string): Promise<void> => {
  await api.delete(`/admin/subjects/${subjectId}`);
};

// ─── Service object ───────────────────────────────────────────────────────────

export const subjectService = {
  getAll: async ({ role, ...params }: GetAllSubjectsParams): Promise<RawSubject[]> => {
    const mine = role === "teacher";

    const { data } = await api.get<SubjectListEnvelope | RawSubject[]>(
      mine ? "/teacher/my-subjects" : "/admin/subjects",
      // my-subjects takes the teacher and the school from the token. classId is
      // dropped with the rest deliberately: the endpoint already returns only
      // the classes they teach, and a filter it ignores would leave the class
      // selector on the page looking broken rather than absent.
      mine ? undefined : { params }
    );
    return unwrapList(data);
  },

  getById: async (subjectId: string): Promise<RawSubject> => {
    const { data } = await api.get<RawSubject>(`/admin/subjects/${subjectId}`);
    return data;
  },

  create: async (payload: CreateSubjectPayload): Promise<Subject> =>
    createSubject(payload),

  update: async (
    subjectId: string,
    payload:   UpdateSubjectPayload
  ): Promise<Subject> => updateSubject(subjectId, payload),

  delete: async (subjectId: string): Promise<void> =>
    deleteSubject(subjectId),
};