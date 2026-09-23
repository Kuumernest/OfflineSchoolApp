// web/src/services/insights.service.ts
//
// Cross-module reads — the early-warning watch list. The server does all the
// joining and scoring; this file only names the shapes.

import api from "@/services/api";

export type WatchTier = "high" | "medium" | "low";

export type WatchSignalCode =
  | "absence"
  | "late"
  | "failed_exam"
  | "grade_drop"
  | "subjects_failed"
  | "missing_homework"
  | "fees_outstanding";

export interface WatchSignal {
  code:   WatchSignalCode;
  points: number;
  /** The numbers behind the signal — the client owns the wording. */
  data:   Record<string, number | string | null>;
}

export interface WatchStudent {
  studentId:    string;
  name:         string | null;
  enrollmentNo: string | null;
  classId:      string | null;
  className:    string | null;
  score:        number;
  tier:         WatchTier;
  signals:      WatchSignal[];
}

export interface Watchlist {
  generatedAt: string;
  windowDays:  number;
  counts: { high: number; medium: number; low: number; students: number };
  students: WatchStudent[];
}

export async function fetchWatchlist(
  schoolId: string, days: number
): Promise<Watchlist> {
  const { data } = await api.get("/insights/early-warning", {
    params: { schoolId, days },
  });
  return (data as { data: Watchlist }).data;
}

// ── Subject intelligence and guidance ────────────────────────────────────────
//
// Stage 2 added the per-subject engine, Stage 3 the guidance projection over it.
// The server does all the analysis; these types name what comes back. Nothing
// here recomputes a mark, a trend or a threshold — a second implementation in
// the browser is how a screen comes to disagree with the report card.

import type { OpenIntervention } from "@/services/intervention.service";

/** A measurement behind a statement. `scale` is present when it is a mark. */
export interface Evidence {
  metric: string;
  value:  number | string;
  scale?: number;
}

export type GuidanceType = "academic_support" | "strength_development" | "monitoring";
export type Confidence   = "strong" | "emerging" | "insufficient";

/** What a class list carries: the area and the reason, without the evidence. */
export interface GuidanceSummary {
  type:          GuidanceType;
  priority:      "high" | "moderate" | "low";
  subjectId:     string | null;
  subjectName:   string | null;
  rationaleCode: string;
  confidence:    Confidence;
}

/** What the pupil route carries: the same, plus why and what could be done. */
export interface GuidanceItem extends GuidanceSummary {
  sourceInsightCode?: string;
  evidence: Evidence[];
  recommendedActionCodes: string[];
}

export interface ClassStudentRow {
  studentId:    string;
  name:         string | null;
  enrollmentNo: string | null;
  coverage:     { sequences: number; subjects: number; sufficient: boolean } | null;
  guidance:     GuidanceSummary[];
  openInterventions: OpenIntervention[];
}

export interface ClassIntelligence {
  generatedAt: string;
  classId:     string;
  className:   string | null;
  engine: {
    version: string;
    passMark: number;
    strongMark: number;
    strongBand: string | null;
    strongMarkBasis: string;
    scale: number;
  };
  counts:   { students: number; withRisk: number; withStrength: number };
  students: ClassStudentRow[];
}

export interface StudentGuidance {
  generatedAt: string;
  studentId:   string;
  classId:     string | null;
  guidance:    GuidanceItem[];
}

export async function fetchClassIntelligence(classId: string): Promise<ClassIntelligence> {
  const { data } = await api.get(`/insights/class/${classId}`);
  return (data as { data: ClassIntelligence }).data;
}

export async function fetchStudentGuidance(studentId: string): Promise<StudentGuidance> {
  const { data } = await api.get(`/insights/student/${studentId}/guidance`);
  return (data as { data: StudentGuidance }).data;
}
