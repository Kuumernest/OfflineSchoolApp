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

export const fetchSubjects = async (schoolId: string): Promise<RawSubject[]> => {
  const { data } = await api.get<SubjectListEnvelope | RawSubject[]>(
    "/admin/subjects",
    { params: { schoolId } }
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
  getAll: async (params: GetAllSubjectsParams): Promise<RawSubject[]> => {
    const { data } = await api.get<SubjectListEnvelope | RawSubject[]>(
      "/admin/subjects",
      { params }
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