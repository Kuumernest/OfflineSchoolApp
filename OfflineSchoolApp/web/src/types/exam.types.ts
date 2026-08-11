// web/src/types/exam.types.ts

export type ExamStatus =
| "draft"
| "scheduled"
| "ongoing"
| "completed"
| "published"
| "archived";

export type ExamType =
| "first_test"
| "second_test"
| "mid_term"
| "practical"
| "final_exam"
| "mock_exam"
| "promotion_exam"
| "continuous_assessment";

export type SubmissionStatus =
| "pending"
| "submitted"
| "approved"
| "rejected";

// ─── Core Models ──────────────────────────────────────────

export interface Exam {
_id: string;
schoolId: string;
name: string;
type: ExamType;
academicYear: string;
term: string;
status: ExamStatus;
classId: string | null;
className: string | null;
classIds: string[];
classNames: string | null;
startDate: string | null;
endDate: string | null;
totalMarks: number;
passMark: number;
description: string | null;
instructions: string | null;
resultsPublished: boolean;
resultsPublishedAt:string | null;
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
name: string;
type: ExamType;
academicYear: string;
term: string;
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