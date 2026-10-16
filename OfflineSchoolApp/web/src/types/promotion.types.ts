// web/src/types/promotion.types.ts

export interface ProgressionClass {
  _id:          string;
  name:         string;
  level?:       string | null;
  /** Null means no destination is stated — students there cannot be promoted. */
  nextClassId:  string | null;
  isFinalYear:  boolean;
  /**
   * The old promotion bar, 0–100, from before bars were set per year out of
   * 20. Read by no promotion run; shown beside the new bar until an admin
   * confirms one for the class (docs/39 §14). Never converted.
   */
  promotionAverage: number | null;
}

/** What a run for one year would judge a class by. */
export interface ProgressionYearClass {
  /** The class's own bar for the year (/20), or null. */
  bar:             number | null;
  /** True once a bar for this year has been set (confirmed) for the class. */
  confirmed:       boolean;
  /** Its bar, else the school's, else the pass mark. */
  effectiveBar:    number;
  pupils:          number;
  /** Pupils with a published annual result for the year. */
  publishedAnnual: number;
}

export interface ProgressionYear {
  academicYear:       string;
  hasStructure:       boolean;
  passMark:           number;
  /** The school's bar for classes without their own; null = the pass mark. */
  promotionThreshold: number | null;
  defaultBar:         number;
  /** Draft promotion runs for the year; bars cannot change while one exists. */
  draftRuns:          number;
  classes:            Record<string, ProgressionYearClass>;
}

export interface ProgressionResponse {
  data:       ProgressionClass[];
  count:      number;
  /** Classes that are neither final-year nor pointed anywhere. */
  incomplete: number;
  year:       ProgressionYear | null;
}

export type RunStatus = "draft" | "committed" | "reversed";

export type Outcome = "promoted" | "repeated" | "graduated" | "unassigned";

export type Basis =
  | "results_pass" | "results_fail" | "average_fail" | "no_results" | "final_year" | "manual";

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
