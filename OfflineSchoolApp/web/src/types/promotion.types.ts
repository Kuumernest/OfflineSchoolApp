// web/src/types/promotion.types.ts

export interface ProgressionClass {
  _id:          string;
  name:         string;
  level?:       string | null;
  /** Null means no destination is stated — students there cannot be promoted. */
  nextClassId:  string | null;
  isFinalYear:  boolean;
}

export interface ProgressionResponse {
  data:       ProgressionClass[];
  count:      number;
  /** Classes that are neither final-year nor pointed anywhere. */
  incomplete: number;
}

export type RunStatus = "draft" | "committed" | "reversed";

export type Outcome = "promoted" | "repeated" | "graduated" | "unassigned";

export type Basis =
  | "results_pass" | "results_fail" | "no_results" | "final_year" | "manual";

export interface PromotionCounts {
  total:      number;
  promoted:   number;
  repeated:   number;
  graduated:  number;
  /** Non-zero blocks the commit. Not a decision — the absence of one. */
  unassigned: number;
}

export interface PromotionRun {
  _id:             string;
  schoolId:        string;
  fromYear:        string;
  toYear:          string;
  status:          RunStatus;
  counts:          PromotionCounts;
  generatedAt?:    string;
  committedAt?:    string | null;
  reversedAt?:     string | null;
  reversalReason?: string | null;
}

export interface PromotionDecision {
  _id:           string;
  runId:         string;
  studentId:     string;
  studentName:   string | null;
  enrollmentNo:  string | null;
  fromClassId:   string | null;
  fromClassName: string | null;
  toClassId:     string | null;
  toClassName:   string | null;
  outcome:       Outcome;
  basis:         Basis;
  average:       number | null;
  overridden:    boolean;
}

export interface PromotionDetail {
  run:       PromotionRun;
  decisions: PromotionDecision[];
}

export interface EnrollmentRow {
  _id:          string;
  studentId:    string;
  academicYear: string;
  classId:      string | null;
  className:    string | null;
  outcome:      string | null;
}
