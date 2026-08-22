// web/src/services/assignment.service.ts
"use strict";

// This file was empty, which is why pages/assignments/assign.tsx and
// pages/assignments/[id].tsx both failed to compile — every symbol they import
// from here was missing. The API below is defined by what those two pages
// already call, so they need no changes.
//
// One naming trap to be aware of: the server stores the relation under
// `teacher` / `class` / `subject` (bare Mongo refs) and QUERIES by those names,
// but it responds with `teacherId` / `classId` / `subjectId` alongside
// populated `teacher` / `class` / `subject` objects. So a filter goes out as
// `?teacherId=…` while the row that comes back carries both spellings.

import api from "@/lib/axios";
import { unwrapList, unwrapSingle } from "@/utils/unwrap";
import { API } from "@/services/apiEndpoints";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface AssignmentRef {
  _id:      string;
  name?:    string;
  code?:    string;
  email?:   string;
  role?:    string;
  level?:   string;
  section?: string;
}

export interface Assignment {
  _id:  string;
  id?:  string;

  schoolId:   string | null;
  isActive:   boolean;
  validFrom:  string | null;
  validUntil: string | null;

  // Flat ids — what the grouping logic in [id].tsx keys on.
  teacherId: string | null;
  classId:   string | null;
  subjectId: string | null;

  // Populated shapes — what the UI reads names from.
  teacher:    AssignmentRef | null;
  class:      AssignmentRef | null;
  subject:    AssignmentRef | null;
  assignedBy: AssignmentRef | null;

  createdAt?: string;
  updatedAt?: string;
}

export interface CreateAssignmentPayload {
  teacherId: string;
  classId:   string;
  subjectId: string;
  schoolId?: string;
}

export interface BulkAssignmentPayload {
  teacherId:   string;
  assignments: { classId: string; subjectId: string }[];
  schoolId?:   string;
}

/** One row's outcome in a bulk create. */
export interface BulkRow {
  classId?:   string;
  subjectId?: string;
  reason?:    string;
}

/**
 * The bulk endpoint separates "skipped" from "failed" and this distinction
 * matters to the user: skipped means the assignment already existed (harmless,
 * arguably success), failed means the class or subject could not be resolved.
 * Collapsing them would report a no-op as an error.
 */
export interface BulkAssignmentResult {
  created: BulkRow[];
  skipped: BulkRow[];
  failed:  BulkRow[];
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISER
// ─────────────────────────────────────────────────────────────────────────────

const asRef = (v: unknown): AssignmentRef | null => {
  if (!v) return null;
  if (typeof v === "string") return { _id: v };
  const o = v as Record<string, unknown>;
  return {
    _id:     String(o._id ?? o.id ?? ""),
    name:    o.name    as string | undefined,
    code:    o.code    as string | undefined,
    email:   o.email   as string | undefined,
    role:    o.role    as string | undefined,
    level:   o.level   as string | undefined,
    section: o.section as string | undefined,
  };
};

const normalise = (raw: Record<string, unknown>): Assignment => {
  const teacher = asRef(raw.teacher);
  const cls     = asRef(raw.class);
  const subject = asRef(raw.subject);

  return {
    _id: String(raw._id ?? raw.id ?? ""),
    id:  raw.id ? String(raw.id) : undefined,

    schoolId:   (raw.schoolId as string) ?? null,
    isActive:   raw.isActive !== false,
    validFrom:  (raw.validFrom  as string) ?? null,
    validUntil: (raw.validUntil as string) ?? null,

    // Fall back to the populated object's id: the flat fields are only present
    // on the list endpoint's normalised rows, not on a create response.
    teacherId: (raw.teacherId as string) ?? teacher?._id ?? null,
    classId:   (raw.classId   as string) ?? cls?._id     ?? null,
    subjectId: (raw.subjectId as string) ?? subject?._id ?? null,

    teacher,
    class:      cls,
    subject,
    assignedBy: asRef(raw.assignedBy),

    createdAt: raw.createdAt as string | undefined,
    updatedAt: raw.updatedAt as string | undefined,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────────────────────

export interface AssignmentFilters {
  schoolId?:  string;
  teacherId?: string;
  classId?:   string;
  subjectId?: string;
}

export async function fetchAssignments(
  filters: AssignmentFilters = {},
): Promise<Assignment[]> {
  const { data } = await api.get(API.admin.assignments.list, {
    params: filters,
  });
  return unwrapList<Record<string, unknown>>(data, "assignments").map(normalise);
}

export async function fetchAssignmentsByTeacher(
  teacherId: string,
  schoolId?: string,
): Promise<Assignment[]> {
  if (!teacherId) return [];
  return fetchAssignments({ teacherId, ...(schoolId ? { schoolId } : {}) });
}

export async function fetchAssignmentsByClass(
  classId:   string,
  schoolId?: string,
): Promise<Assignment[]> {
  if (!classId) return [];
  return fetchAssignments({ classId, ...(schoolId ? { schoolId } : {}) });
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function createAssignment(
  payload: CreateAssignmentPayload,
): Promise<Assignment> {
  const { data } = await api.post(API.admin.assignments.list, payload);
  return normalise(unwrapSingle<Record<string, unknown>>(data, "assignment"));
}

export async function createBulkAssignments(
  payload: BulkAssignmentPayload,
): Promise<BulkAssignmentResult> {
  const { data } = await api.post(API.admin.assignments.bulk, payload);
  const body = (data ?? {}) as Record<string, unknown>;
  // sendSuccess() may nest the payload under `data`, so read through both.
  const src = (body.data && typeof body.data === "object"
    ? (body.data as Record<string, unknown>)
    : body);

  const rows = (key: string): BulkRow[] =>
    Array.isArray(src[key]) ? (src[key] as BulkRow[]) : [];

  return {
    created: rows("created"),
    skipped: rows("skipped"),
    failed:  rows("failed"),
    message: String(src.message ?? ""),
  };
}

export async function deleteAssignment(assignmentId: string): Promise<void> {
  await api.delete(API.admin.assignments.detail(assignmentId));
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUPING
// ─────────────────────────────────────────────────────────────────────────────

export interface TeacherAssignmentSummary {
  teacherId:   string;
  teacherName: string;
  classes:     number;
  subjects:    number;
  total:       number;
}

/**
 * Rolls assignments up per teacher for the list page.
 *
 * `classes` and `subjects` are DISTINCT counts, not row counts — a teacher
 * taking four subjects in one class covers one class, not four.
 */
export function summariseByTeacher(
  assignments: Assignment[],
): TeacherAssignmentSummary[] {
  const map = new Map<string, {
    name: string;
    classes: Set<string>;
    subjects: Set<string>;
    total: number;
  }>();

  for (const a of assignments) {
    if (!a.teacherId) continue;
    let entry = map.get(a.teacherId);
    if (!entry) {
      entry = {
        name:     a.teacher?.name ?? "Unknown teacher",
        classes:  new Set(),
        subjects: new Set(),
        total:    0,
      };
      map.set(a.teacherId, entry);
    }
    if (a.classId)   entry.classes.add(a.classId);
    if (a.subjectId) entry.subjects.add(a.subjectId);
    entry.total += 1;
  }

  return [...map.entries()]
    .map(([teacherId, e]) => ({
      teacherId,
      teacherName: e.name,
      classes:     e.classes.size,
      subjects:    e.subjects.size,
      total:       e.total,
    }))
    .sort((a, b) => a.teacherName.localeCompare(b.teacherName));
}
