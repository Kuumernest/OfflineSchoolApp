// web/src/services/intervention.service.ts
//
// Support actions: the one thing in the intelligence stack a human writes.
//
// The server owns every rule — school isolation, teacher scope, the lifecycle,
// what a valid assignee is, what a valid outcome is. This file names shapes and
// calls endpoints; it validates nothing on its own, because a second copy of a
// rule is a second answer waiting to disagree with the first.

import api from "@/services/api";

/** The lifecycle, exactly as backend/src/services/intervention.service.js has it. */
export type InterventionStatus = "planned" | "active" | "completed" | "cancelled";

/** The four a teacher may record. The server rejects anything else. */
export type OutcomeCode =
  | "improved" | "no_change" | "further_support" | "not_assessed";

/** Which moves the UI may offer. The server decides; this only hides dead buttons. */
export const NEXT_STATUSES: Record<InterventionStatus, InterventionStatus[]> = {
  planned:   ["active", "cancelled"],
  active:    ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const OPEN_STATUSES: InterventionStatus[] = ["planned", "active"];

export interface StatusChange {
  from: InterventionStatus;
  to:   InterventionStatus;
  by:   string;
  at:   string;
}

export interface Intervention {
  _id:         string;
  studentId:   string;
  classId:     string;
  sourceType:  "guidance" | "other";
  sourceCode:  string | null;
  subjectId:   string | null;
  actionCode:  string;
  notes:       string | null;
  assignedTo:  string | null;
  status:      InterventionStatus;
  outcomeCode: OutcomeCode | null;
  outcomeNotes: string | null;
  statusHistory: StatusChange[];
  startedAt?:   string | null;
  completedAt?: string | null;
  version:   number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What a class list carries per pupil — a summary, not the whole record. */
export interface OpenIntervention {
  _id:        string;
  status:     InterventionStatus;
  actionCode: string;
  sourceType: "guidance" | "other";
  sourceCode: string | null;
  subjectId:  string | null;
  assignedTo: string | null;
  updatedAt:  string;
}

// ── The before/after comparison ──────────────────────────────────────────────
//
// An OBSERVATION and never a verdict. `reading` is a code the client renders in
// the reader's language; none of the codes assert that the intervention caused
// anything, because the system cannot know that. See the header of
// backend/src/services/intelligence/interventionOutcome.service.js.

export type EvidenceStatus =
  | "compared" | "awaiting_after" | "no_before" | "no_evidence" | "not_subject_specific";

export type EvidenceReading =
  | "INCREASED_AFTER" | "DECREASED_AFTER" | "NO_CHANGE_OBSERVED"
  | "AWAITING_POST_EVIDENCE" | "NO_PRIOR_EVIDENCE"
  | "NO_COMPARABLE_EVIDENCE" | "NOT_SUBJECT_SPECIFIC";

export interface EvidenceSide {
  average:      number;
  observations: number;
  from: { academicYear: string; term: number; sequence: number | null };
  to:   { academicYear: string; term: number; sequence: number | null };
}

export interface OutcomeEvidence {
  interventionId: string;
  studentId:   string;
  subjectId:   string | null;
  subjectName: string | null;
  scale:  number;
  pivot:  string;
  pivotSource: "startedAt" | "createdAt";
  before: EvidenceSide | null;
  after:  EvidenceSide | null;
  change: number | null;
  status:  EvidenceStatus;
  reading: EvidenceReading;
}

export interface CreateInterventionInput {
  studentId:   string;
  actionCode:  string;
  sourceType?: "guidance" | "other";
  sourceCode?: string | null;
  subjectId?:  string | null;
  notes?:      string | null;
  assignedTo?: string | null;
}

export async function fetchStudentInterventions(studentId: string): Promise<Intervention[]> {
  const { data } = await api.get(`/interventions/student/${studentId}`);
  return (data as { data: Intervention[] }).data;
}

export async function createIntervention(
  input: CreateInterventionInput
): Promise<Intervention> {
  const { data } = await api.post("/interventions", input);
  return (data as { data: Intervention }).data;
}

/**
 * Move it along, or record what happened.
 *
 * `version` is what the client last saw. The server answers 409 VERSION_CONFLICT
 * when another device got there first, rather than letting the last write win.
 */
export async function updateIntervention(
  id: string,
  patch: Partial<{
    status: InterventionStatus;
    outcomeCode: OutcomeCode | null;
    outcomeNotes: string | null;
    notes: string | null;
    assignedTo: string | null;
  }> & { version: number }
): Promise<Intervention> {
  const { data } = await api.patch(`/interventions/${id}`, patch);
  return (data as { data: Intervention }).data;
}

export async function fetchOutcomeEvidence(id: string): Promise<OutcomeEvidence> {
  const { data } = await api.get(`/interventions/${id}/evidence`);
  return (data as { data: OutcomeEvidence }).data;
}
