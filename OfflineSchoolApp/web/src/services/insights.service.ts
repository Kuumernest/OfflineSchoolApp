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
  // Stage 18: the window the counts were taken in, and the engines against the baseline.
  pilotRunId: string | null; since: string | null; engineVersion: string | null; reviewsExcluded: number;
  engineVersionsMatch: boolean; engineDrift: EngineDrift[];
  advanced: AdvancedTally | null; studentFeedback: StudentFeedbackSummary | null;
}

export interface PilotShortfall { requirement: string; minimum: number; actual: number }

/** The eleven engines a pilot is of, in the brief's vocabulary. Stamped by the server. */
export const ENGINE_KEYS = ["academic", "strengths", "exploration", "learningEvidence", "learningIntegration", "development", "guidance", "intervention", "developmentPlanning", "adaptiveSupport", "advancedIntelligence"] as const;
export type EngineKey = (typeof ENGINE_KEYS)[number];
export type EngineVersions = Record<EngineKey, string>;
export interface EngineDrift { engine: EngineKey; pilot: string; current: string }

/** The four things a person signs to open a REAL pilot. */
export const ATTESTATION_KEYS = ["schoolParticipates", "reviewersUnderstandTask", "noticeRequirementsMet", "retentionAgreed"] as const;
export type AttestationKey = (typeof ATTESTATION_KEYS)[number];
export type Attestations = Record<AttestationKey, boolean>;

/** The explanation layer inside a pilot, counted. Never a question, an answer or a pupil. */
export interface AdvancedTally {
  advancedIntelligenceVersion: string; validatorMandatory: boolean;
  requests: number; modelValidated: number; refused: number; providerFailures: number; validatorRejections: number;
  byRequestType: Record<string, number>; byMode: Record<string, number>; byFallbackReason: Record<string, number>;
  byQuestionCategory: Record<string, number>; byValidationIssue: Record<string, number>;
  explanationValidation: { modelAnswersKept: number; modelAnswersRejected: number };
  citationValidation: Record<string, number>; safety: Record<string, number>; fallbackUsage: Record<string, number>;
  lastAt: string | null;
}

export const FEEDBACK_QUESTIONS = ["observedClear", "inferredClear", "uncertaintyClear", "evidenceClear", "explorationClear", "choiceClear"] as const;
export const FEEDBACK_ANSWERS = ["YES", "PARTLY", "NO", "NOT_SHOWN"] as const;
export interface StudentFeedbackSummary {
  responses: number; minimumForBreakdown: number; withheld: boolean;
  byQuestion: Record<string, Record<string, number>> | null;
  questions: string[]; answers: string[];
}

export type FindingCategory = "ENGINE" | "DATA_QUALITY" | "MAPPING" | "AUTHORIZATION" | "UX" | "MISSING_EVIDENCE" | "GUIDANCE" | "REVIEW_WORKFLOW" | "OFFLINE_CONSISTENCY" | "ADVANCED_INTELLIGENCE";
export type FindingSeverity = "low" | "medium" | "high";
export type FindingStatus   = "open" | "investigating" | "confirmed" | "resolved" | "not_reproduced";
/** Where a disagreement was found to come from — kept apart from any rule change. */
export type FindingSource   = "undetermined" | "data_quality" | "missing_context" | "insufficient_evidence" | "interpretation_ambiguity" | "rule_weakness";
export interface FindingAmendment { at: string; by: string; changes: Array<{ field: string; from: unknown; to: unknown }>; reason: string; pilotClosed: boolean }
export interface PilotFinding {
  findingId: string; category: FindingCategory; severity: FindingSeverity; summary: string; evidence: string | null;
  affectedCases: number; engineVersion: string; status: FindingStatus; disagreementSource: FindingSource; recommendedNextAction: string | null;
  raisedBy: string; raisedAt: string; updatedAt: string; updatedBy: string | null; amendments: FindingAmendment[];
}

export type ReadinessGroup  = "technical" | "operational" | "evidence" | "reviewer" | "privacy";
export type ReadinessStatus = "READY" | "BLOCKED" | "REQUIRES_CONFIRMATION";
export interface PreflightCheck { key: string; kind: "automatic" | "suite" | "manual"; group: ReadinessGroup; ok: boolean | null; detail: string; missing?: string | string[] }
export interface Preflight {
  ready: boolean; technicalReady: boolean; operationalReady: boolean;
  readiness: Record<ReadinessGroup, { status: ReadinessStatus; checks: string[]; missing: string[]; pending: string[] }>;
  status: "TECHNICAL_NOT_READY" | "REAL_PILOT_BLOCKED" | "AWAITING_ATTESTATION";
  realPilotStatus: "BLOCKED" | "AWAITING_ATTESTATION";
  missing: string[]; attestationsPending: string[]; attestations: AttestationKey[]; engineVersions: EngineVersions;
  blockers: string[]; checks: PreflightCheck[];
  counts: { students: number; published: number; cases: number; reviewers: number; multiReviewCapable: number; consistencyChecked: number };
  consistency: Array<{ studentId: string; identical: boolean; differences: number }>;
}

export interface Pilot {
  pilotRunId: string; schoolId: string; classIds: string[] | null; label: string | null;
  kind: PilotKind; status: PilotStatus; engineVersion: string; engineVersions: EngineVersions | null; engineDrift: EngineDrift[];
  startedAt: string | null; endedAt: string | null; createdBy: string; createdAt: string; updatedAt: string; version: number;
  transitions: Array<{ from: PilotStatus | null; to: PilotStatus; at: string; by: string; note: string | null }>;
  evidence: PilotEvidence | null;
  decision: { outcome: PilotOutcome; summary: string; recordedAt: string; recordedBy: string } | null;
  allowedTransitions: PilotStatus[];
  evidenceShortfalls: PilotShortfall[];
  findings: PilotFinding[];
  attestations: (Attestations & { by: string | null; at: string | null }) | null;
  advanced: AdvancedTally;
}

/** What a teacher is sent: that a pilot is on, its kind and state. */
export type LeanPilot = Pick<Pilot, "pilotRunId" | "kind" | "status" | "engineVersion" | "engineVersions" | "label" | "startedAt" | "endedAt">;

/** The real-world validation report (docs/25 §22): counts and codes, one school, no ranking. */
export interface PilotReport {
  generatedAt: string; pilotRunId: string; aggregation: "ONE_SCHOOL"; noRanking: true;
  scope: {
    schoolId: string; classIds: string[] | null; kind: PilotKind; label: string | null; status: PilotStatus;
    startedAt: string | null; endedAt: string | null; createdAt: string;
    engineVersion: string; engineVersions: EngineVersions | null; engineVersionsMatch: boolean; engineDrift: EngineDrift[];
    students: number; cases: number; reviewers: number; attestations: (Attestations & { by: string | null; at: string | null }) | null;
  };
  evidenceCoverage: {
    reviewable: number; reviewed: number; multiReviewed: number; incomplete: number; studentsReviewed: number; reviewsRecorded: number; reviewsExcluded: number;
    window: { pilotRunId: string; since: string | null; engineVersion: string | null };
    byCategory: Record<string, { cases: number; reviewed: number; multipleReviews: number; differ: number }>;
    dataQualityCitations: Record<string, number>;
    evidenceQualityLimitations: Array<{ group: string; code: string; reviews: number }>;
    minimum: Record<string, number>; shortfalls: PilotShortfall[];
  };
  reviewOutcomes: Record<"SUPPORTED" | "PARTLY_SUPPORTED" | "NOT_SUPPORTED" | "INSUFFICIENT_EVIDENCE" | "UNCERTAIN", number>;
  concerns: Record<"INTERPRETATION_DISAGREEMENT" | "DATA_QUALITY" | "MISSING_EVIDENCE" | "CONTEXTUAL_LIMITATION", { reviews: number; examples: Array<{ code: string; reviews: number }> }>;
  agreement: { agree: number; differ: number };
  repeatedDisagreements: string[];
  patterns: Array<{ kind: string; code: string | null; support: number; of: number }>;
  advancedIntelligence: AdvancedTally & { findings: number };
  studentFeedback: StudentFeedbackSummary;
  findings: { total: number; byCategory: Record<string, number>; bySeverity: Record<string, number>; byStatus: Record<string, number>; byDisagreementSource: Record<string, number>; items: PilotFinding[] };
  decision: { outcome: PilotOutcome; summary: string; recordedAt: string; recordedBy: string } | null;
  evidenceOnRecord: PilotEvidence | null;
  limitations: { tested: string[]; notTested: string[]; evidenceSupports: string[]; unknown: string[] };
  notClaimed: string[];
}

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

export async function fetchPilotReport(pilotId: string, schoolId?: string): Promise<PilotReport> {
  const { data } = await api.get(`/insights/pilot/${pilotId}/report`, sp(schoolId));
  return (data as { data: PilotReport }).data;
}

export async function fetchPreflight(schoolId?: string, classIds?: string[]): Promise<Preflight> {
  const { data } = await api.get("/insights/pilot/preflight", { params: { ...(schoolId ? { schoolId } : {}), ...(classIds?.length ? { classId: classIds.join(",") } : {}) } });
  return (data as { data: Preflight }).data;
}

export async function addFinding(pilotId: string, input: { schoolId?: string; category: FindingCategory; severity: FindingSeverity; summary: string; evidence?: string; affectedCases?: number; recommendedNextAction?: string; disagreementSource?: FindingSource }): Promise<PilotFinding> {
  const { data } = await api.post(`/insights/pilot/${pilotId}/findings`, input);
  return (data as { data: PilotFinding }).data;
}

/** An amendment records why. The server refuses one without a reason. */
export async function updateFinding(pilotId: string, findingId: string, input: { schoolId?: string; status?: FindingStatus; recommendedNextAction?: string; disagreementSource?: FindingSource; reason: string }): Promise<PilotFinding> {
  const { data } = await api.patch(`/insights/pilot/${pilotId}/findings/${findingId}`, input);
  return (data as { data: PilotFinding }).data;
}

export async function openPilot(input: { schoolId?: string; kind: PilotKind; classIds?: string[]; label?: string; attestations?: Attestations }): Promise<Pilot> {
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

export interface LearningEventRef { eventId: string; independenceKey: string; sourceKind: string; subjectId: string | null; subjectName: string | null; observedAt: string | null; recency: "RECENT" | "HISTORICAL" | "STALE"; normalizedValue: number }
export interface LearningRelationshipBlock { relationship: string; independentEventCount: number; sourceFamilies: string[]; currentEventCount: number; historicalEventCount: number; staleEventCount: number; subjects: string[] }
export interface CorroborationBlock { supportingSources: string[]; supportingEvents: LearningEventRef[]; contradictingSources: string[]; contradictingEvents: LearningEventRef[]; neutralEvents: number; explorationSupportingEvents: number; explorationContradictingEvents: number; teacherObservers: number }
export interface ContextBlock { attendanceLimited: boolean; attendancePattern: string | null; submissionContextAvailable: boolean; missingModalities: string[] }
export interface LearningContradiction { kind: string; academic: string; supporting: number; contradicting: number; families: string[]; possibleExplanations: string[] }
export interface InterpretationBlock { state: StrengthState; confidence: Confidence; stateSource: string; relationship: string; reasonCodes: string[]; quality: string[]; contradictions: LearningContradiction[] }
export interface AcademicBlock { state: StrengthState; confidence: Confidence; persistence: Persistence; direction: string | null; consistency: string | null }

export interface FusedBlock {
  stateSource: "academic" | "exploration" | "teacher_observation" | "learning_evidence"; reasons: string[];
  events: number; supportingEvents: number; contradictingEvents: number; neutralEvents: number; teacherObservers: number; interestEvents: number;
  participationEvents: number; exposureEvents: number; pair: { interest: string; performance: string } | null;
  recency: { recent: number; historical: number; stale: number }; conflicts: Array<Record<string, unknown>>; evidenceIds: string[];
}

export interface DimensionReading {
  dimension: string; state: StrengthState; confidence: Confidence; persistence: Persistence;
  baseState?: StrengthState; baseConfidence?: Confidence; fused?: FusedBlock;
  baseDirection?: string | null; basePersistence?: Persistence; baseConsistency?: string | null; fusedState?: StrengthState; fusedConfidence?: Confidence;
  academic?: AcademicBlock; learningEvidence?: LearningRelationshipBlock; corroboration?: CorroborationBlock; context?: ContextBlock; interpretation?: InterpretationBlock;
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

export interface LearningIntegrationBlock {
  version: string; learningEvidenceVersion: string | null; asOf: string | null; available: boolean; independentLearningItems: number; duplicateEventsCollapsed: number;
  items: Array<LearningEventRef & { sourceVersion: number | null; dimensions: Record<string, number>; direction: "supports" | "contradicts" | "neutral" }>;
  modalities: Record<string, boolean>; missingModalities: string[]; attendancePattern: string | null;
  relationships: Record<string, string>; contradictions: Array<LearningContradiction & { dimension: string }>; quality: string[];
}

export interface StrengthProfile {
  studentId: string; academicEngineVersion: string | null; strengthEngineVersion: string; learningIntegrationVersion?: string; learningEvidenceVersion?: string | null;
  learningIntegration?: LearningIntegrationBlock;
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
  fusion?: {
    asOf: string; windows: { recentDays: number; historicalDays: number };
    coverage: { overall: string; sources: string[]; stale: number; exploration: { events: number }; teacherObservation: { observers: number }; interest: number; reflection: number; exposure: number; participation: number };
    contradictions: Array<{ dimension: string; kind: string; academic?: string; exploration?: string; interest?: string; performance?: string; teacherObservation?: string; observers?: number; supporting?: number; contradicting?: number }>;
    timeline: Record<string, Array<{ when: string | null; source: string; reading: string; subjectName?: string | null; area?: string; observers?: number; confidence?: string; stateSource?: string }>>;
    evidence: Array<{ evidenceId: string; sourceType: string; eventId: string; dimension: string | null; timestamp: string | null; recency: string; direction: string }>;
  };
}

export interface ProfileChanges {
  previous: { snapshotId: string; profileVersion: number; generatedAt: string; strengthEngineVersion: string; learningIntegrationVersion?: string | null; learningEvidenceVersion?: string | null } | null;
  current: { strengthEngineVersion: string; academicEngineVersion: string; learningIntegrationVersion?: string; learningEvidenceVersion?: string | null; asOf: string } | null;
  newEvidence: { rows: number; byKind: Record<string, number>; explorations: number } | null;
  comparison: {
    newStrengths: ChangeEntry[]; strengthened: ChangeEntry[]; unchanged: ChangeEntry[]; weakened: ChangeEntry[]; newEmerging: ChangeEntry[]; declining: ChangeEntry[];
    newContradictions: Array<{ dimension: string; kind: string }>; coverage: { previous: string | null; current: string | null };
    learningEvidence?: LearningChange[];
  } | null;
  pendingSnapshot: boolean;
}
export interface LearningChange { dimension: string; previous: string | null; current: string | null; reasons: string[] }
export interface ChangeEntry { dimension: string; previous: { state: string; confidence: string }; current: { state: string; confidence: string }; reasons: string[]; learningEvidence?: LearningChange }

export async function fetchProfileChanges(studentId: string, schoolId?: string): Promise<ProfileChanges> {
  const { data } = await api.get(`/insights/student/${studentId}/profile/changes`, schoolId ? { params: { schoolId } } : {});
  return (data as { data: ProfileChanges }).data;
}
export async function rebuildProfile(studentId: string, input: { schoolId?: string; periodLabel?: string }): Promise<{ created: boolean; data: StrengthSnapshot }> {
  const { data } = await api.post(`/insights/student/${studentId}/profile/rebuild`, input);
  return data as { created: boolean; data: StrengthSnapshot };
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


// ── Exploration — the loop above the strengths layer ────────────────────────
//
// Stage 10. The server suggests activities with reasons, records the pupil's
// moves, and turns what happened into evidence rows by kind. Staff read a
// pupil's explorations (the reflection's text only when the pupil shared it),
// observe, and rate against the activity's own criteria.

export type ExplorationStatus = "DISCOVERED" | "SAVED" | "STARTED" | "SUBMITTED" | "REVIEW_REQUIRED" | "COMPLETED" | "ABANDONED" | "SKIPPED" | "NOT_INTERESTED";

export interface ExplorationRow {
  explorationId: string; activityId: string; activityVersion: number; area: string; level: string; title: string;
  status: ExplorationStatus; relevance: string | null; suggestedBecause: string[];
  discoveredAt: string; startedAt: string | null; submittedAt: string | null; completedAt: string | null; closedAt: string | null;
  completionMode: string | null; outputs?: Array<{ label: string; value: string }>;
  performance: { ratings: Array<{ criterion: string; rating: string }>; level: string | null; note: string | null; ratedBy: string; ratedAt: string } | null;
  reflection: { interest: string | null; difficulty: string | null; continue: string | null; enjoyed?: string | null; difficult?: string | null; next?: string | null; shareText: boolean } | null;
  observations: Array<{ observationId: string; level: string; codes: string[]; note: string | null; observedBy: string; observedAt: string }>;
  evidence: Array<{ evidenceId: string; kind: string; source: string; date: string; outcome: string | null }>;
  pattern: { interest: string | null; performance: string | null; pattern: string | null };
  transitions?: Array<{ from: string | null; to: string; at: string; by: string }>;
  version: number; explorationEngineVersion: string;
}

export interface CatalogActivity {
  activityId: string; version: number; area: string; category: string; dimensions: string[]; level: string; estimatedMinutes: number;
  resources: string[]; deliveryMode: string; evidenceTypes: string[]; performanceCriteria: string[]; title: string; description: string; task: string;
  expectedOutputs: string[]; observable: string[]; reflectionPrompts: string[]; engineVersion: string;
}

export interface ExplorationSummary {
  explorationEngineVersion: string; students: number; explorations: number;
  byArea: Record<string, { students: number; started: number; completed: number; skipped: number; notInterested: number; abandoned: number }>;
  frequentlySkipped: Array<{ activityId: string; count: number }>; frequentlyDeclined: Array<{ activityId: string; count: number }>;
  frequentlyCompleted: Array<{ activityId: string; count: number }>; evidenceRows: number;
}

const qs = (schoolId?: string) => (schoolId ? { params: { schoolId } } : {});

export async function fetchExplorations(studentId: string, schoolId?: string): Promise<{ explorations: ExplorationRow[] }> {
  const { data } = await api.get(`/insights/student/${studentId}/explorations`, qs(schoolId));
  return (data as { data: { explorations: ExplorationRow[] } }).data;
}
export async function fetchCatalog(schoolId?: string): Promise<CatalogActivity[]> {
  const { data } = await api.get("/explorations/activities", qs(schoolId));
  return (data as { data: { activities: CatalogActivity[] } }).data.activities;
}
export async function fetchExplorationSummary(params: { schoolId?: string; classId?: string }): Promise<ExplorationSummary> {
  const { data } = await api.get("/insights/explorations/summary", { params });
  return (data as { data: ExplorationSummary }).data;
}
export async function observeExploration(id: string, input: { schoolId?: string; level: string; codes: string[]; note?: string }) {
  const { data } = await api.post(`/explorations/${id}/observation`, input);
  return (data as { data: unknown }).data;
}
export async function rateExploration(id: string, input: { schoolId?: string; ratings: Array<{ criterion: string; rating: string }>; note?: string; version?: number }): Promise<ExplorationRow> {
  const { data } = await api.post(`/explorations/${id}/performance`, input);
  return (data as { data: ExplorationRow }).data;
}


// ── Learning evidence — the school's own records, kept apart by kind ────────
//
// Stage 12. Homework, quiz attempts, subject scores (tests, CA, practicals)
// and attendance become events with their observations apart; patterns need
// evidence; quality is coverage; contradictions stand. Nothing here is a
// score of the pupil, and in 1.0.0 no signal moves any engine.

export interface SeriesReading {
  events: number; validEvents: number; independentEvents: number; recent: number; historical: number; stale: number;
  firstObserved: string | null; lastObserved: string | null; mean: number | null; spread: number | null;
  direction: string | null; delta: number | null; pattern: string;
}
export interface HomeworkReading {
  performance: SeriesReading; assigned: number; completed: number; missing: number; pending: number; ungraded: number; completionRate: number | null; pattern: string;
  submission: { onTime: number; late: number; veryLate: number; missing: number; noDeadline: number; pattern: string };
}
export interface AttendanceReading {
  present: number; absent: number; late: number; excused: number; marked: number; unmarked: number | null; presenceRate: number | null; trend: number | null; pattern: string;
  recent: number; historical: number; stale: number; firstObserved: string | null; lastObserved: string | null;
}
export interface SubjectLearning {
  subjectId: string | null; formal: SeriesReading; continuous: SeriesReading; practical: SeriesReading; quiz: SeriesReading; homework: HomeworkReading;
  persistence: { quizzesRetried: number; quizzesAttempted: number; currentCompletionStreak: number };
}
export interface LearningEvidence {
  learningEvidenceVersion: string | null; asOf: string | null;
  counts: { events: number; bySource: Record<string, number>; rejected: number };
  patterns: { bySubject: Record<string, SubjectLearning>; attendance: { overall: AttendanceReading; bySubject: Record<string, AttendanceReading> } };
  quality: { subjects: Record<string, { subjectId: string | null; level: string; independentEvents: number; families: Record<string, { level: string; independentEvents: number; stale: number; flags: string[] }>; flags: string[]; contradictions: Array<{ code: string } & Record<string, unknown>> }>; attendance: { level: string; marked: number }; overall: { level: string; independentEvents: number; subjects: number; flags: string[] }; contradictions: Array<Record<string, unknown> & { subjectId: string | null; code: string }> };
  signals: Array<{ signal: string; subjectId: string | null; family?: string; code: string; authorizedFor: string[] }>;
  timeline: Array<{ when: string | null; learningEventId: string; sourceType: string; family: string | null; subjectId: string | null; recency: string; observations: Array<{ kind: string; state: string; normalizedValue?: number | null }> }>;
  concise: Array<{ code: string; subjectId: string | null; n?: number; completed?: number; assigned?: number }>;
  notInferred: string[];
}
export interface LearningChanges {
  previous: { snapshotNumber: number; generatedAt: string } | null; current: { learningEvidenceVersion: string; asOf: string | null; events: number } | null; newEvents: number;
  comparison: { changes: Array<{ subjectId: string | null; family: string; previous: string; current: string }>; newContradictions: Array<{ subjectId: string | null; code: string }>; coverage: { previous: string | null; current: string | null } } | null;
  pendingSnapshot: boolean; history: Array<{ snapshotNumber: number; generatedAt: string; events: number; coverage: string | null }>;
}
const lq = (schoolId?: string) => (schoolId ? { params: { schoolId } } : {});
export async function fetchLearningEvidence(studentId: string, schoolId?: string): Promise<LearningEvidence> {
  const { data } = await api.get(`/insights/student/${studentId}/learning-evidence`, lq(schoolId));
  return (data as { data: LearningEvidence }).data;
}
// ── Development (Stage 14) — how the evidence-backed reading changed over time. Categories and counts; no score.
export interface TrajectoryObservation { observedAt: string; source: "snapshot" | "current"; profileVersion: number | null; periodLabel: string | null; state: StrengthState; confidence: Confidence | null; relationship: string | null; sourceFamilies: string[]; independentEventCount: number; explorationEvents: number; teacherObservers: number; missingModalities: string[]; contradictions: string[] }
export interface DevelopmentContradiction { dimension: string; kind: string; status: string; firstSeen: string; lastSeen: string; occurrences: number; independentPeriods: number; current: boolean; priority: string | null; resolutionDate?: string }
export interface DevelopmentChange { changeId: string; dimensionId: string | null; subjectId: string | null; observedAt: string; previousObservedAt: string | null; previousState: string; currentState: string; previousRelationship: string | null; currentRelationship: string | null; changeTypes: string[]; reasonCodes: string[] }
export interface ExplanationLine { code: string; state?: string; relationship?: string | null; n?: number; from?: string; to?: string; at?: string; family?: string; kind?: string; status?: string; occurrences?: number; firstSeen?: string; lastSeen?: string; families?: string[] }
export interface Trajectory {
  dimensionId: string | null; subjectId: string | null; subjectName?: string | null; observations: TrajectoryObservation[]; currentState: StrengthState; currentRelationship: string | null;
  firstObservedAt: string | null; lastObservedAt: string | null; direction: string; trajectory: string;
  persistence: { observationCount: number; independentObservationCount: number; consecutiveObservations?: number; independentPeriods?: number; academic: string | null };
  stateTransitions: Array<{ from: string; to: string; fromAt: string; at: string }>; relationshipTransitions: Array<{ from: string | null; to: string | null; fromAt: string; at: string }>;
  evidenceCoverage: { current: { academicSequences: number; learning: Record<string, number>; learningIndependentEvents: number; learningStale: number; exploration: number; teacherObservers: number; unavailable: string[] } | null; firstSeenFamily: Record<string, string>; corroborationBegan: string | null } | null;
  contradictions: DevelopmentContradiction[]; changes: DevelopmentChange[];
  quality: { coverage: string; recency: string | null; independence: string; conflicts: string; missingModalities: string[]; attendanceLimited?: boolean };
  reasons: string[]; explanation: ExplanationLine[];
}
export interface DevelopmentHistory {
  engineVersion: string | null; asOf: string | null; history: { observationCount: number; independentObservationCount: number; sufficient: boolean; firstObservedAt: string | null; lastObservedAt: string | null } | null;
  observations: Array<{ observedAt: string; source: string; profileVersion: number | null; periodLabel: string | null }>;
  trajectories: Trajectory[]; changes: DevelopmentChange[]; contradictions: DevelopmentContradiction[];
  quality: { history: string; missingModalities: string[]; contradictions: { current: number; historical: number; persistent: number } } | null; notInferred: string[];
}
export async function fetchDevelopment(studentId: string, schoolId?: string): Promise<DevelopmentHistory> {
  const { data } = await api.get(`/insights/student/${studentId}/development`, q(schoolId));
  return (data as { data: DevelopmentHistory }).data;
}

// ── Guidance and interventions (Stage 15) — bounded, categorical, evidence-linked. No score. The pupil decides.
export interface SuggestedAction { type: string; instruction: string; expectedEvidence: string }
export interface DevGuidanceItem {
  id: string; category: string; dimension: string | null; subjectId: string | null; title: { code: string };
  explanation: { observed: { state: string; trajectory: string; observations: number }; changed: { code: string; changeTypes?: string[]; reasonCodes?: string[]; at?: string };
                 relationship: { code: string; relationship?: string; families?: string[] }; why: { code: string; reasons: string[] };
                 uncertain: { missingModalities: string[]; conflicts: string; historySufficient: boolean; recency: string | null; attendanceLimited: boolean } };
  evidence: { state: string; relationship: string | null; trajectory: string; direction: string; coverage: { academicSequences: number; learningIndependentEvents: number; exploration: number; teacherObservers: number } | null; contradictions: Array<{ kind: string; status: string; occurrences: number }> };
  reasons: string[]; suggestedActions: SuggestedAction[]; evidenceToWatch: string[]; evidenceQuality: string;
  developmentContext: { trajectory: string; direction: string; currentState: string; previousState: string | null; independentObservations: number }; engineVersion: string;
}
export interface DevGuidanceResponse { guidanceEngineVersion: string | null; developmentEngineVersion: string | null; asOf: string | null; historySufficient: boolean; items: DevGuidanceItem[]; byCategory: Record<string, number>; agency: string; notInferred: string[] }
export interface InterventionOutcome { asOf: string; reviewDue: boolean; outcome: string; statement: { code: string; outcome: string }; academic: { reading: string; status: string; change: number | null } | null; development: { before: { observedAt: string; state: string } | null; after: { observedAt: string; state: string } | null; reading: string | null }; causal: boolean }
export interface DevelopmentIntervention {
  interventionId: string; studentId: string; subjectId: string | null; dimension: string | null; trigger: string | null; guidanceId: string | null; objective: string | null; action: string; ownerRole: string | null;
  startDate: string | null; durationDays: number | null; reviewDate: string | null; evidenceToCollect: string[]; lifecycle: string; legacyStatus: string;
  lifecycleHistory: Array<{ from: string | null; to: string; action: string; role: string; at: string; by?: string; note?: string | null }>;
  reviews: Array<{ at: string; outcome: { outcome: string } | null; by?: string; note?: string | null }>; proposedByRole: string | null; acceptedAt: string | null; notes?: string | null; outcome: InterventionOutcome | null;
}
export interface InterventionTrigger { dimension: string; trigger: string; evidence: Record<string, unknown>; independentObservations: number }
export interface InterventionsResponse { asOf: string; interventionEngineVersion: string; interventions: DevelopmentIntervention[]; triggers: InterventionTrigger[]; previews: Array<{ dimension: string; trigger: string; objective: string; action: string; ownerRole: string; reviewDate: string; evidenceToCollect: string[] }>; lifecycle: string[] }
export async function fetchDevelopmentGuidance(studentId: string, schoolId?: string): Promise<DevGuidanceResponse> {
  const { data } = await api.get(`/insights/student/${studentId}/development/guidance`, q(schoolId));
  return (data as { data: DevGuidanceResponse }).data;
}
export async function fetchDevelopmentInterventions(studentId: string, schoolId?: string): Promise<InterventionsResponse> {
  const { data } = await api.get(`/insights/student/${studentId}/interventions`, q(schoolId));
  return (data as { data: InterventionsResponse }).data;
}
export async function proposeDevelopmentIntervention(studentId: string, body: { trigger: string; dimension: string; guidanceId?: string | null; ownerRole?: string; notes?: string | null; schoolId?: string }): Promise<DevelopmentIntervention> {
  const { data } = await api.post(`/insights/student/${studentId}/interventions`, body);
  return (data as { data: DevelopmentIntervention }).data;
}
export async function actOnDevelopmentIntervention(studentId: string, interventionId: string, body: { action: string; note?: string | null; schoolId?: string }): Promise<DevelopmentIntervention> {
  const { data } = await api.patch(`/insights/student/${studentId}/interventions/${interventionId}`, body);
  return (data as { data: DevelopmentIntervention }).data;
}
export async function reviewDevelopmentIntervention(studentId: string, interventionId: string, body: { note?: string | null; complete?: boolean; schoolId?: string }): Promise<DevelopmentIntervention> {
  const { data } = await api.post(`/insights/student/${studentId}/interventions/${interventionId}/review`, body);
  return (data as { data: DevelopmentIntervention }).data;
}

// ── Development plans (Stage 16) — objectives, milestones, review, adaptation. Categorical; the human decides.
export interface PlanMilestone { milestoneId: string; kind: string; owner: string; order: number; evidenceFamily: string; state: string; reason: string | null; adaptationIndex: number | null }
export interface PlanReview { reviewId: string; at: string; asOf: string; decision: string; outcome: string | null; reasons?: string[]; teacherReview: { code: string; note?: string | null } | null; contract?: PlanContract | null; adaptation?: { suggestedActions: string[] } | null }
export interface PlanContract { objective: { category: string; code: string }; attempted: { actions: string[]; adaptations: number }; milestones: { progress: { total: number; completed: number; skipped: number; blocked: number }; occurred: Array<{ kind: string; state: string; reason: string | null }> }; evidence: { independentObservations: number; families: string[]; relevantFamilies: string[]; baseline: { state: string; relationship: string | null } | null; latest: { state: string; relationship: string | null } | null }; changed: { reading: string | null; interventionOutcomes: Array<string | null> }; studentReported: { codes: string[]; count: number }; teacherObserved: { code: string | null } | null; uncertain: { noNewEvidence: boolean; contradiction: boolean; constraints: string[]; missingRelevantFamilies: string[] }; next: { outcome: string; suggestedActions: string[] } }
export interface PlanSystemReview { adaptiveSupportEngineVersion: string; asOf: string; outcome: string; reasons: string[]; adaptation: { suggestedActions: string[]; explanations: Record<string, string> }; contradiction: { code: string } | null; contract: PlanContract; statement: { code: string; causal: boolean } }
export interface DevelopmentPlan {
  planId: string; dimension: string | null; subjectId: string | null; objective: { category: string; code: string; evidenceFamilies: string[]; completion: { requiredMilestones: number; independentObservations: number } };
  rationale: { guidanceId?: string; guidanceCategory?: string; reasons?: string[]; observed: { state: string | null; trajectory: string | null; relationship: string | null } | null; evidenceQuality: string | null } | null;
  actions: Array<{ actionType: string; explanation: string; addedAt: string; replacedAt: string | null }>; milestones: PlanMilestone[]; reviewSchedule: { startDate: string; reviewDate: string; intervalDays: number };
  ownerRole: string; studentParticipation: { required: boolean; acceptedAt: string | null; declinedAt: string | null; reflections: number }; status: string;
  reviews: PlanReview[]; adaptations: Array<{ index: number; at: string; previous: { actions: string[] }; next: { actions: string[] }; reason: { outcome: string | null; reasons: string[] } }>;
  reflections?: Array<{ at: string; codes: string[]; note: string | null }>; constraints: Array<{ code: string; at: string }>; reviewDue: boolean; systemReview: PlanSystemReview | null; explanation: Record<string, unknown> | null;
}
export interface PlansResponse { asOf: string | null; engineVersions: { planning: string; adaptive: string }; plans: DevelopmentPlan[]; vocabulary: { objectives: string[]; reflectionCodes: string[]; skipReasons: string[] } }
export async function fetchDevelopmentPlans(studentId: string, schoolId?: string): Promise<PlansResponse> {
  const { data } = await api.get(`/insights/student/${studentId}/development-plans`, q(schoolId));
  return (data as { data: PlansResponse }).data;
}
export async function createDevelopmentPlan(studentId: string, body: { guidanceId: string; schoolId?: string }): Promise<DevelopmentPlan> {
  const { data } = await api.post(`/insights/student/${studentId}/development-plans`, body);
  return (data as { data: DevelopmentPlan }).data;
}
export async function actOnDevelopmentPlan(studentId: string, planId: string, body: { action?: string; actionType?: string; note?: string | null; schoolId?: string }): Promise<DevelopmentPlan> {
  const { data } = await api.patch(`/insights/student/${studentId}/development-plans/${planId}`, body);
  return (data as { data: DevelopmentPlan }).data;
}
export async function moveDevelopmentPlanMilestone(studentId: string, planId: string, milestoneId: string, body: { action: string; reason?: string | null; schoolId?: string }): Promise<DevelopmentPlan> {
  const { data } = await api.post(`/insights/student/${studentId}/development-plans/${planId}/milestones/${milestoneId}`, body);
  return (data as { data: DevelopmentPlan }).data;
}
export async function reviewDevelopmentPlan(studentId: string, planId: string, body: { teacherReview?: { code: string; note?: string | null } | null; decision: string; actionType?: string | null; note?: string | null; schoolId?: string }): Promise<DevelopmentPlan> {
  const { data } = await api.post(`/insights/student/${studentId}/development-plans/${planId}/review`, body);
  return (data as { data: DevelopmentPlan }).data;
}

export async function fetchLearningChanges(studentId: string, schoolId?: string): Promise<LearningChanges> {
  const { data } = await api.get(`/insights/student/${studentId}/learning-changes`, lq(schoolId));
  return (data as { data: LearningChanges }).data;
}
export async function rebuildLearningEvidence(studentId: string, schoolId?: string): Promise<{ created: boolean }> {
  const { data } = await api.post(`/insights/student/${studentId}/learning-evidence/rebuild`, schoolId ? { schoolId } : {});
  return data as { created: boolean };
}

// ── Advanced intelligence (Stage 17) — the deterministic synthesis and the explanation layer above it ──
//
// The summary never involves a model. An explanation is answered by the
// deterministic layer, or by a model provider whose every sentence was
// validated against the evidence first; `mode` says which, and a fallback
// carries its reason. Nothing here computes a state: the client renders
// what the engines said and what the layer explained.

export interface IntelDimension {
  dimension: string; academicState: string; confidence: string; persistence: string | null; developmentDirection: string; trajectory: string; independentObservations: number;
  learningRelationship: string; evidenceQuality: string; recentChange: string; contradictions: { kind: string; status: string | null; current?: boolean }[];
  activePlan: boolean; activePlanIds: string[]; guidanceCategories: string[]; interventionTriggers: string[]; activeInterventions: number;
  explorationAreas: string[]; explorations: { total: number; completed: number }; supportingSubjects: { subjectId: string | null; subjectName: string | null }[];
  crossDomain: { relationship: string; supportingSources: string[]; conflictingSources: string[]; statementCode: string }; citations: string[];
}
export interface ExplorationCandidate {
  domain: string; label: string; description?: string; evidenceQuality: string; whyItAppeared: { code: string; dimension: string | null; area: string | null }[];
  contradictoryEvidence: { code: string }[]; activities: { activityId: string; area: string; level: string; title: string; explored: string | null }[];
  questionsToInvestigate: string[]; skillsToExplore: string[]; limitations: string[];
}
export interface IntelligenceSummary {
  studentId: string; name: string | null; asOf: string; viewer: string; evidenceBoundaryHash: string; engineVersions: Record<string, string | null>;
  synthesis: { dimensions: IntelDimension[]; overall: { profileConfidence: string; coverage: string; historySufficient: boolean; independentObservations: number; dimensionsRead: number; established: number; emerging: number; declining: number; openContradictions: number; activePlans: number; plans: number; guidanceItems: number; explorations: number; explorationsCompleted: number } };
  exploration: { ordering: string; candidates: ExplorationCandidate[]; notSupported: { domain: string; label: string; reason: string }[] };
  limitations: string[]; mode: string;
}
export type ClaimType = "OBSERVED" | "INFERRED_BY_DETERMINISTIC_ENGINE" | "SUGGESTED_EXPLORATION" | "UNCERTAIN" | "NOT_AVAILABLE";
export type ExplainMode = "DETERMINISTIC" | "MODEL_VALIDATED" | "DETERMINISTIC_FALLBACK" | "REFUSED";
export interface ExplainClaim { text: string; type: ClaimType; citations: (string | { sourceId: string })[] }
export interface CitationItem { sourceId: string; item: (Record<string, unknown> & { sourceType: string }) | null }
export interface ExplainResponse {
  classification: { category: string; transformed: string | null }; mode: ExplainMode; fallbackReason: string | null;
  output: { answer: string; claims: ExplainClaim[]; uncertainty: string; limitations: string[]; suggestedQuestions: string[] };
  citations: CitationItem[]; validation: { valid: boolean; issues: { code: string }[] }; asOf: string; evidenceBoundaryHash: string;
}

export async function fetchIntelligenceSummary(studentId: string, schoolId?: string): Promise<IntelligenceSummary> {
  const { data } = await api.get(`/insights/student/${studentId}/intelligence-summary`, q(schoolId));
  return (data as { data: IntelligenceSummary }).data;
}
export async function explainStudent(studentId: string, body: { question: string; schoolId?: string }): Promise<ExplainResponse> {
  const { data } = await api.post(`/insights/student/${studentId}/explain`, body);
  return (data as { data: ExplainResponse }).data;
}
export async function askStudent(studentId: string, body: { question: string; schoolId?: string }): Promise<ExplainResponse> {
  const { data } = await api.post(`/insights/student/${studentId}/ask`, body);
  return (data as { data: ExplainResponse }).data;
}
