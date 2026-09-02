// web/src/types/exam.types.ts

export type ExamStatus =
| "draft"
| "scheduled"
| "ongoing"
| "completed"
| "published"
| "archived";

/** Simplified exam type — only 3 values */
export type ExamType =
| "test"
| "practical"
| "promotion_exam";

export type SequenceNumber = 1 | 2 | 3 | 4 | 5 | 6;
export type TermNumber = 1 | 2 | 3;

export type SubmissionStatus =
| "pending"
| "submitted"
| "approved"
| "rejected";

// ─── Academic Structure ────────────────────────────────────

export interface AssessmentConfig {
  type: "test" | "practical" | "promotion_exam";
  label?: string;
}

export interface SequenceConfig {
  number: SequenceNumber;
  name: string;
  weight: number; // % within the term (equal = 50)
  assessment: AssessmentConfig;
}

export interface TermConfig {
  number: TermNumber;
  name: string;
  weight: number; // % in annual average
  sequences: SequenceConfig[];
}

export interface AcademicStructure {
  _id: string;
  schoolId: string;
  academicYear: string;
  terms: TermConfig[];
  annualAverageMethod: "terms" | "sequences";
  promotionExams: SequenceNumber[];
  promotionThreshold: number;
  passMark: number;
  maxAbsences: number | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Core Models ──────────────────────────────────────────

export interface Exam {
_id: string;
schoolId: string;
name: string;
type: ExamType;
sequenceNumber: SequenceNumber | null;
academicYear: string;
term: TermNumber;
status: ExamStatus;
classId: string | null;
className: string | null;
classIds: string[];
classNames: string | null;
startDate: string | null;
endDate: string | null;
totalMarks: number;
passMark: number;
weight: number;
description: string | null;
instructions: string | null;
resultsPublished: boolean;
resultsPublishedAt: string | null;
publishedBy: string | null;
createdBy: string | null;
createdAt: string;
updatedAt: string;
deletedAt: string | null;
}

export interface ExamSubject {
_id: string;
examId: string;
subjectId: string;
classId: string;
schoolId: string;
teacherId: string | null;
subjectName: string | null;
teacherName: string | null;
maxScore: number;
passMark: number;
weight: number;
isPractical: boolean;
isTheory: boolean;
isOral: boolean;
submissionStatus: SubmissionStatus;
submittedAt: string | null;
submittedBy: string | null;
approvedAt: string | null;
approvedBy: string | null;
rejectedAt: string | null;
rejectedBy: string | null;
rejectReason: string | null;
totalScoresEntered?: number;
}

export interface StudentScore {
_id: string;
examId: string;
examSubjectId: string;
subjectId: string;
studentId: string;
classId: string;
schoolId: string;
score: number | null;
maxScore: number;
percentage: number | null;
grade: string | null;
gpaPoints: number | null;
isPassing: boolean | null;
isAbsent: boolean;
isExempt: boolean;
teacherRemark: string | null;
}

export interface ResultSummary {
_id: string;
examId: string;
studentId: string;
classId: string;
schoolId: string;
studentName: string | null;
admissionNo: string | null;
className: string | null;
totalScore: number;
maxTotalScore: number;
percentage: number;
average: number;
overallGrade: string | null;
overallRemark: string | null;
gpa: number | null;
subjectsPassed: number;
subjectsFailed: number;
subjectsTotal: number;
isPassing: boolean;
classPosition: number | null;
gradePosition: number | null;
schoolPosition: number | null;
totalInClass: number | null;
totalInGrade: number | null;
totalInSchool: number | null;
isPublished: boolean;
isPartial: boolean;
subjectBreakdown: SubjectBreakdown[];
}

export interface SubjectBreakdown {
subjectId: string;
subjectName: string | null;
score: number;
maxScore: number;
normalizedMark: number;
grade: string | null;
points: number;
remark: string | null;
isPassing: boolean;
isAbsent: boolean;
}

// ─── Term / Annual Results ─────────────────────────────────

export interface SequenceAverage {
sequence: SequenceNumber;
examId: string | null;
average: number;
overallGrade: string | null;
isComplete: boolean;
}

export interface TermResult {
_id: string;
schoolId: string;
academicYear: string;
term: TermNumber;
classId: string;
studentId: string;
studentName: string | null;
admissionNo: string | null;
className: string | null;
sequenceAverages: SequenceAverage[];
/**
 * True when a sequence mark behind this term is newer than the term itself.
 *
 * A term average is computed once and never recomputed on its own, so a mark
 * corrected afterwards leaves it disagreeing with the subject rows on the same
 * report card — those are rebuilt on every print. The server compares the
 * timestamps and says so rather than recomputing, because when a term is final
 * is the school's call.
 */
isStale?: boolean;
termAverage: number;
overallGrade: string | null;
overallRemark: string | null;
classPosition: number | null;
schoolPosition: number | null;
totalInClass: number | null;
totalInSchool: number | null;
isPassing: boolean;
isPublished: boolean;
createdAt: string;
updatedAt: string;
}

export interface TermAverage {
term: TermNumber;
average: number;
overallGrade: string | null;
isComplete: boolean;
}

export interface AnnualResult {
_id: string;
schoolId: string;
academicYear: string;
classId: string;
studentId: string;
studentName: string | null;
admissionNo: string | null;
className: string | null;
termAverages: TermAverage[];
/**
 * True when a TERM result behind this year is newer than the year itself.
 *
 * Compared against the terms rather than the marks: an annual average is built
 * from term averages, so a corrected mark makes the term stale first. Saying
 * the year is stale before its term has been recomputed would send a school to
 * the wrong screen.
 */
isStale?: boolean;
annualAverage: number;
overallGrade: string | null;
overallRemark: string | null;
promotionStatus: "promoted" | "repeated" | "conditional" | "graduated" | "pending";
promotionThreshold: number | null;
classPosition: number | null;
schoolPosition: number | null;
totalInClass: number | null;
totalInSchool: number | null;
isPassing: boolean;
isPublished: boolean;
createdAt: string;
updatedAt: string;
}

// ─── API Response Shapes ──────────────────────────────────

export interface ExamsListResponse {
success: boolean;
exams: Exam[];
total: number;
page: number;
totalPages: number;
}

export interface ExamDetailResponse {
success: boolean;
exam: Exam & { subjects?: ExamSubject[] };
}

export interface DashboardResponse {
success: boolean;
dashboard: {
exams: {
  total: number;
  draft: number;
  scheduled: number;
  ongoing: number;
  completed: number;
  published: number;
  archived: number;
};
results: {
  published: number;
  pending: number;
  missingGrades: number;
  averagePerformance: number;
  passRate: number;
  /**
   * The exams behind the two actionable counts, capped at twenty.
   *
   * A count is not a destination: the results strip links every tile, and
   * without an id there is nowhere for "1 missing grade" to go. Optional
   * because a client may be talking to a server that predates them.
   */
  missingGradeExams?: string[];
  pendingExams?: string[];
};
};
}

export interface SubmissionsResponse {
success: boolean;
submissions: ExamSubject[];
}

export interface ResultsResponse {
success: boolean;
results: ResultSummary[];
}

export interface TermResultsResponse {
/** How many of the results on this page the sequence marks have overtaken. */
staleCount?: number;
/** The latest mark behind them, for a screen that wants to say when. */
latestMark?: string | null;
success: boolean;
results: TermResult[];
total: number;
page: number;
totalPages: number;
}

export interface AnnualResultsResponse {
/** How many of these the TERM results have overtaken. */
staleCount?: number;
latestTerm?: string | null;
success: boolean;
results: AnnualResult[];
total: number;
page: number;
totalPages: number;
}

export interface StatsResponse {
success: boolean;
data: {
totalStudents: number;
passed: number;
failed: number;
average: number;
highest: number;
lowest: number;
passRate: number;
averageGpa: number;
gradeDistribution: Record<string, number>;
subjectStats: SubjectStat[];
};
}

export interface SubjectStat {
subjectId: string;
subjectName: string;
average: number;
highest: number;
lowest: number;
passRate: number;
total: number;
}

// ─── Form Shapes ──────────────────────────────────────────

export interface CreateExamForm {
/**
 * The id the client chose for this exam, sent so the create is idempotent.
 *
 * POST /exams answers with the existing exam when it is given an _id it has
 * already seen, so a double click cannot make a second exam. Optional: a caller
 * that does not care lets the server mint one.
 */
_id?: string;
name: string;
type: ExamType;
sequenceNumber: SequenceNumber | null;
academicYear: string;
term: TermNumber;
status: ExamStatus;
startDate: string;
endDate: string;
totalMarks: number;
passMark: number;
description: string;
instructions: string;
classIds: string[];
}

export interface ScoreEntry {
studentId: string;
studentName: string;
admissionNo: string | null;
score: string;
isAbsent: boolean;
teacherRemark: string;
}
