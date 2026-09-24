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

// ── Calibration review — the engine's conclusions, judged by a teacher ──────
//
// Stage 7C. The server builds the review sheet, decides what this viewer may
// see of other reviewers' answers, and validates the form against the one
// contract in scripts/calibration. The browser renders three things kept apart
// on the screen: the evidence (marks, metrics), what the engine made of it
// (classifications, guidance, thresholds) and what the teacher makes of it (the
// form). Nothing here interprets a mark.

export type ReviewStatus = "UNREVIEWED" | "ONE_REVIEW" | "MULTIPLE_REVIEWS";

export interface ReviewForm {
  observedPattern:           string | null;
  classificationAppropriate: string | null;
  evidenceSufficient:        string | null;
  guidanceAppropriate:       string | null;
  reason:      string | null;
  notes:       string | null;
  dataQuality: string[];
  temporal?: { interpretationReasonable: string | null; possibleExplanation: string | null };
}

/** The allowed values for every field, published by the server. */
export interface ReviewFormContract {
  observedPattern:           string[];
  classificationAppropriate: string[];
  evidenceSufficient:        string[];
  guidanceAppropriate:       string[];
  dataQuality:               string[];
  temporal: { appliesTo: string[]; interpretationReasonable: string[]; possibleExplanation: string[] };
}

export interface RecordedReview {
  reviewId:       string;
  reviewedBy:     string;
  reviewedByName: string | null;
  reviewedAt:     string;
  revisedAt:      string | null;
  engineVersion:  string;
  version:        number;
  review:         ReviewForm;
}

export interface ReviewCase {
  caseId:       string;
  priority:     number;
  category:     string;
  studentId:    string;
  studentName:  string | null;
  enrollmentNo: string | null;
  classId:      string | null;
  className:    string | null;
  subjectId:    string | null;
  subjectName:  string | null;
  observations: number;
  marks:        string[];
  trajectory:   string | null;
  metrics: {
    recentAverage: number | null; priorAverage: number | null; overallAverage: number | null;
    delta: number | null; spread: number | null; consistency: string | null;
    latestStep: number | null; belowPass: number; strongMarks: number;
  } | null;
  classifications: Array<{ code: string; confidence: string }>;
  guidance:        Array<{ type: string; rationaleCode: string; priority: string }>;
  confidence:      string;
  thresholdsInvolved: Array<{ threshold: string; value: number }>;
  explanation:     Array<{ code: string; evidence: Evidence[] }>;
  selectedBecause: string;
  review:          ReviewForm;
  // As this viewer may see it.
  reviewStatus:  ReviewStatus;
  reviewCount:   number;
  reviewerCount: number;
  agreement:     "AGREE" | "DIFFER" | null;
  myReview:      RecordedReview | null;
  othersHidden:  boolean;
  reviews:       RecordedReview[];
}

export interface ReviewStatusBlock {
  cases: number; unreviewed: number; oneReview: number; multipleReviews: number;
  agreement: { agree: number; differ: number };
  reviewsRecorded: number; reviewers: number;
  /** Categories where reviewers differed on more than one case. A pattern, never a score. */
  repeatedDisagreements: string[];
  byCategory: Record<string, { cases: number; reviewed: number; multipleReviews: number; differ: number }>;
}

export type ConcernGroup = "interpretationDisagreement" | "dataQuality" | "missingEvidence" | "contextualLimitation";

export interface ReviewFeedback {
  totals: { cases: number; reviewed: number; unreviewed: number; byOutcome: Record<string, number> };
  /** Four phenomena, never summed: each with its review count and the codes repeated above the support minimum. */
  concerns: Record<ConcernGroup, { reviews: number; repeated: Array<{ code: string; support: number }> }>;
  sharesWithheld: string | null;
  patterns: Array<{ kind: string; support: number; of?: number; note: string }>;
  dataQualityCitations: Record<string, number>;
  casesCitingDataQuality: number;
}

export interface ReviewPackage {
  generatedAt:   string;
  engineVersion: string;
  scope:         { schoolId: string; classIds: string[] | null; students: number };
  reviewForm:    ReviewFormContract;
  categories:    string[];
  priority:      string[];
  coverage:      Record<string, number>;
  reviewStatus:  ReviewStatusBlock;
  cases:         ReviewCase[];
  totalCases:    number;
  feedback:      ReviewFeedback;
}

export interface ReviewScopeParams { schoolId?: string; classId?: string; limit?: number }

export async function fetchReviewCases(params: ReviewScopeParams): Promise<ReviewPackage> {
  const { data } = await api.get("/insights/review-cases", { params });
  return (data as { data: ReviewPackage }).data;
}

export interface SubmitReviewInput {
  schoolId?:     string;
  studentId:     string;
  subjectId:     string | null;
  category:      string;
  engineVersion: string;
  review:        ReviewForm;
}

export async function submitReview(input: SubmitReviewInput): Promise<RecordedReview> {
  const { data } = await api.post("/insights/reviews", input);
  return (data as { data: RecordedReview }).data;
}

export async function reviseReview(
  id: string, input: { schoolId?: string; version: number; review: ReviewForm }
): Promise<RecordedReview> {
  const { data } = await api.patch(`/insights/reviews/${id}`, input);
  return (data as { data: RecordedReview }).data;
}

/** The operator's cross-school picture: counts from recorded reviews, no pupil. */
export interface PlatformCalibrationRow {
  schoolId: string; schoolName: string; isActive: boolean;
  reviews: number; reviewers: number; engineVersions: string[];
  byOutcome: Record<string, number>; byCategory: Record<string, number>;
  dataQualityCitations: Record<string, number>;
  patterns: Array<{ kind: string; support: number; note: string }>;
  sharesWithheld: string | null;
}

export async function fetchPlatformCalibration(): Promise<{ engineVersion: string; schools: PlatformCalibrationRow[] }> {
  // The super-admin router spreads its payload beside `success`.
  const { data } = await api.get("/super-admin/intelligence/calibration");
  return data as { engineVersion: string; schools: PlatformCalibrationRow[] };
}

// ── Pilot — the frame around a validation exercise ──────────────────────────
//
// Stage 7D. A pilot says which school, which classes, which engine version,
// what kind of exercise (synthetic, development, real), how far it has got and
// what was decided. Status is written by the server's state machine only; the
// evidence a decision rests on is the server's snapshot, never posted.

export type PilotKind   = "synthetic" | "development" | "real";
export type PilotStatus = "READY" | "ACTIVE" | "REVIEWING" | "ANALYSIS_READY" | "CALIBRATED" | "INSUFFICIENT_EVIDENCE" | "CLOSED";
export type PilotOutcome = "KEEP" | "CALIBRATE" | "INSUFFICIENT_EVIDENCE";

export interface PilotEvidence {
  takenAt: string;
  casesSelected: number; casesReviewed: number; casesAwaitingReview: number; casesWithMultipleReviews: number;
  studentsReviewed: number; reviewsRecorded: number; reviewers: number;
  categories: string[]; subjects: string[]; temporalPatterns: string[]; repeatedDisagreements: string[];
  dataQualityCitations: Record<string, number>; byOutcome: Record<string, number>;
}

export interface PilotShortfall { requirement: string; minimum: number; actual: number }

export type FindingCategory = "ENGINE" | "DATA_QUALITY" | "MAPPING" | "AUTHORIZATION" | "UX" | "MISSING_EVIDENCE" | "GUIDANCE" | "REVIEW_WORKFLOW" | "OFFLINE_CONSISTENCY";
export type FindingSeverity = "low" | "medium" | "high";
export type FindingStatus   = "open" | "investigating" | "confirmed" | "resolved" | "not_reproduced";
export interface PilotFinding {
  findingId: string; category: FindingCategory; severity: FindingSeverity; summary: string; evidence: string | null;
  affectedCases: number; engineVersion: string; status: FindingStatus; recommendedNextAction: string | null;
  raisedBy: string; raisedAt: string; updatedAt: string;
}

export interface PreflightCheck { key: string; kind: "automatic" | "suite" | "manual"; ok: boolean | null; detail: string }
export interface Preflight {
  ready: boolean; blockers: string[]; checks: PreflightCheck[];
  counts: { students: number; published: number; cases: number; reviewers: number; multiReviewCapable: number; consistencyChecked: number };
  consistency: Array<{ studentId: string; identical: boolean; differences: number }>;
}

export interface Pilot {
  pilotRunId: string; schoolId: string; classIds: string[] | null; label: string | null;
  kind: PilotKind; status: PilotStatus; engineVersion: string;
  startedAt: string | null; endedAt: string | null; createdBy: string; createdAt: string; updatedAt: string; version: number;
  transitions: Array<{ from: PilotStatus | null; to: PilotStatus; at: string; by: string; note: string | null }>;
  evidence: PilotEvidence | null;
  decision: { outcome: PilotOutcome; summary: string; recordedAt: string; recordedBy: string } | null;
  allowedTransitions: PilotStatus[];
  evidenceShortfalls: PilotShortfall[];
  findings: PilotFinding[];
  attestations: { schoolParticipates: boolean; reviewersUnderstandTask: boolean; by: string | null; at: string | null } | null;
}

/** What a teacher is sent: that a pilot is on, its kind and state. */
export type LeanPilot = Pick<Pilot, "pilotRunId" | "kind" | "status" | "engineVersion" | "label" | "startedAt" | "endedAt">;

const sp = (schoolId?: string) => (schoolId ? { params: { schoolId } } : {});

export async function fetchPilot(schoolId?: string): Promise<{ open: boolean; pilot: Pilot | LeanPilot | null }> {
  const { data } = await api.get("/insights/pilot", sp(schoolId));
  return (data as { data: { open: boolean; pilot: Pilot | LeanPilot | null } }).data;
}

export async function fetchPilotEvidence(schoolId?: string): Promise<{ evidence: PilotEvidence; minimum: Record<string, number>; shortfalls: PilotShortfall[] }> {
  const { data } = await api.get("/insights/pilot/evidence", sp(schoolId));
  return (data as { data: { evidence: PilotEvidence; minimum: Record<string, number>; shortfalls: PilotShortfall[] } }).data;
}

export async function fetchPilotHistory(schoolId?: string): Promise<Pilot[]> {
  const { data } = await api.get("/insights/pilot/history", sp(schoolId));
  return (data as { data: Pilot[] }).data;
}

export async function fetchPreflight(schoolId?: string, classIds?: string[]): Promise<Preflight> {
  const { data } = await api.get("/insights/pilot/preflight", { params: { ...(schoolId ? { schoolId } : {}), ...(classIds?.length ? { classId: classIds.join(",") } : {}) } });
  return (data as { data: Preflight }).data;
}

export async function addFinding(pilotId: string, input: { schoolId?: string; category: FindingCategory; severity: FindingSeverity; summary: string; evidence?: string; affectedCases?: number; recommendedNextAction?: string }): Promise<PilotFinding> {
  const { data } = await api.post(`/insights/pilot/${pilotId}/findings`, input);
  return (data as { data: PilotFinding }).data;
}

export async function updateFinding(pilotId: string, findingId: string, input: { schoolId?: string; status?: FindingStatus; recommendedNextAction?: string }): Promise<PilotFinding> {
  const { data } = await api.patch(`/insights/pilot/${pilotId}/findings/${findingId}`, input);
  return (data as { data: PilotFinding }).data;
}

export async function openPilot(input: { schoolId?: string; kind: PilotKind; classIds?: string[]; label?: string; attestations?: { schoolParticipates: boolean; reviewersUnderstandTask: boolean } }): Promise<Pilot> {
  const { data } = await api.post("/insights/pilot", input);
  return (data as { data: Pilot }).data;
}

export async function advancePilot(
  id: string,
  input: { schoolId?: string; to: PilotStatus; version: number; note?: string; decision?: { outcome?: PilotOutcome; summary: string } }
): Promise<Pilot> {
  const { data } = await api.patch(`/insights/pilot/${id}`, input);
  return (data as { data: Pilot }).data;
}

/** One pupil through the live path and the offline path, diffed. Nothing normalised. */
export interface ConsistencyReport {
  studentId: string; identical: boolean;
  engineVersion: { live: string | null; offline: string | null };
  summary: Record<"engineVersion" | "classification" | "metrics" | "evidence" | "guidance" | "coverage", boolean>;
  differences: Array<{ path: string; live: unknown; offline: unknown }>;
}

export async function fetchConsistency(studentId: string, schoolId?: string): Promise<ConsistencyReport> {
  const { data } = await api.get(`/insights/student/${studentId}/consistency`, sp(schoolId));
  return (data as { data: ConsistencyReport }).data;
}


// ── Strengths & exploration — the layer above the academic engine ───────────
//
// Stage 9. shared/strengths reads the academic profile and says where the
// school evidence is consistent with strength, how persistent it is, what it
// rests on, which broad areas it opens, and what it does not infer. Interest
// and exposure are carried apart from strength; teacher confirmation is a
// review, stored apart from the engine's reading. Versioned on its own.

export type StrengthState = "ESTABLISHED" | "EMERGING" | "DECLINING" | "INSUFFICIENT";
export type Persistence   = "persistent" | "recurring" | "emerging" | "none";

export interface StrengthEvidenceItem {
  evidenceType: "subject_performance" | "subject_decline" | "cross_subject_support" | "teacher_observation";
  subjectId?: string; subjectName?: string | null; subjectIds?: string[]; observers?: number;
  observations?: number; strongObservations?: number; persistence?: Persistence; consistency?: string | null;
  direction?: string; overallAverage?: number | null; recentAverage?: number | null; delta?: number | null; supports: boolean;
}

export interface DimensionReading {
  dimension: string; state: StrengthState; confidence: Confidence; persistence: Persistence;
  supportingSubjects: Array<{ subjectId: string; subjectName: string | null }>;
  decliningSubjects:  Array<{ subjectId: string; subjectName: string | null }>;
  crossSubject: boolean; evidence: StrengthEvidenceItem[]; limitations: string[];
}

export interface ExplorationArea {
  area: string; evidenceLevel: "strong" | "emerging" | "limited"; openedBy: string[];
  supportingSubjects: Array<{ subjectId: string; subjectName: string | null }>;
  because: Array<{ dimension: string; state: StrengthState; confidence: Confidence; persistence: Persistence }>;
  waysToExplore: string[];
}

export interface InterestSignal {
  kind: "interest" | "exposure" | "student_reflection"; dimension: string | null; area: string | null; activity: string | null;
  date: string | null; source: string | null; participation: string | null; reflection: string | null;
}

export interface StrengthProfile {
  studentId: string; academicEngineVersion: string | null; strengthEngineVersion: string;
  grading: { passMark: number; strongMark: number; strongMarkBasis: string | null };
  evidenceCoverage: { sequences: number; subjects: number; subjectsInTaxonomy: number; sufficient: boolean; explorationEvidence: number };
  confidence: Confidence;
  strengths: DimensionReading[]; emergingAreas: DimensionReading[]; decliningAreas: DimensionReading[];
  singleSubjectStrengths: Array<{ subjectId: string; subjectName: string | null; state: StrengthState; persistence: Persistence; consistency: string | null; direction: string; strongObservations: number }>;
  explorationAreas: ExplorationArea[];
  interestSignals: InterestSignal[];
  subjects: Array<{ subjectId: string; subjectName: string | null; state: StrengthState; persistence: Persistence; consistency: string | null; direction: string; observations: number; strongObservations: number; overallAverage: number | null; recentAverage: number | null }>;
  limitations: string[];
  notInferred: string[];
}

export interface StrengthsResponse { studentId: string; name: string | null; enrollmentNo: string | null; classId: string | null; profile: StrengthProfile | null; reviews?: RecordedReview[] }

export interface StrengthSnapshot {
  snapshotId: string; profileVersion: number; academicEngineVersion: string; strengthEngineVersion: string;
  sourcePeriod: { from: unknown; to: unknown; sequences: number } | null; periodLabel: string | null; generatedAt: string; recordedBy: string;
  profile: { confidence: Confidence; strengths: Array<{ dimension: string; persistence: Persistence }>; emergingAreas: Array<{ dimension: string; persistence: Persistence }>; decliningAreas: Array<{ dimension: string }>; explorationAreas: Array<{ area: string; evidenceLevel: string }>; limitations: string[] };
}

export interface ExplorationEvidenceRow {
  _id: string; kind: string; source: string; dimension: string | null; area: string | null; activity: string; date: string;
  participation: string | null; outcome: string | null; reflection: string | null; notes: string | null; recordedBy: string;
}

const q = (schoolId?: string) => (schoolId ? { params: { schoolId } } : {});

export async function fetchStrengths(studentId: string, schoolId?: string): Promise<StrengthsResponse> {
  const { data } = await api.get(`/insights/student/${studentId}/strengths`, q(schoolId));
  return (data as { data: StrengthsResponse }).data;
}
export async function fetchStrengthProfile(studentId: string, schoolId?: string): Promise<{ current: unknown; history: StrengthSnapshot[] }> {
  const { data } = await api.get(`/insights/student/${studentId}/profile`, q(schoolId));
  return (data as { data: { current: unknown; history: StrengthSnapshot[] } }).data;
}
export async function fetchStrengthEvidence(studentId: string, schoolId?: string): Promise<{ explorationEvidence: ExplorationEvidenceRow[] }> {
  const { data } = await api.get(`/insights/student/${studentId}/evidence`, q(schoolId));
  return (data as { data: { explorationEvidence: ExplorationEvidenceRow[] } }).data;
}
export async function snapshotStrengthProfile(studentId: string, input: { schoolId?: string; periodLabel?: string }): Promise<StrengthSnapshot> {
  const { data } = await api.post(`/insights/student/${studentId}/profile/snapshot`, input);
  return (data as { data: StrengthSnapshot }).data;
}
export async function recordExplorationEvidence(studentId: string, input: { schoolId?: string; kind: string; dimension?: string; area?: string; activity: string; date: string; participation?: string; reflection?: string; outcome?: string; notes?: string }): Promise<ExplorationEvidenceRow> {
  const { data } = await api.post(`/insights/student/${studentId}/evidence`, input);
  return (data as { data: ExplorationEvidenceRow }).data;
}
