// web/src/services/exam.service.ts
import api from "@/lib/api";
import type {
ExamsListResponse,
ExamDetailResponse,
DashboardResponse,
SubmissionsResponse,
ResultsResponse,
StatsResponse,
CreateExamForm,
} from "@/types/exam.types";

// ─────────────────────────────────────────────────────────
// EXAM LIST + DASHBOARD
// ─────────────────────────────────────────────────────────

export const getExams = async (params?: {
schoolId?: string;
status?: string;
classId?: string;
academicYear?: string;
term?: string;
page?: number;
limit?: number;
}): Promise<ExamsListResponse> => {
const { data } = await api.get("/exams", { params });
return data;
};

export const getExamDashboard = async (
schoolId: string
): Promise<DashboardResponse> => {
const { data } = await api.get("/exams/dashboard", {
params: { schoolId },
});
return data;
};

// ─────────────────────────────────────────────────────────
// SINGLE EXAM
// ─────────────────────────────────────────────────────────

export const getExamById = async (
examId: string,
schoolId: string
): Promise<ExamDetailResponse> => {
const { data } = await api.get(/exams/${examId}, {
params: { schoolId },
});
return data;
};

// ─────────────────────────────────────────────────────────
// CREATE / UPDATE / DELETE
// ─────────────────────────────────────────────────────────

export const createExam = async (
payload: Partial<CreateExamForm> & { schoolId: string }
) => {
const { data } = await api.post("/exams", payload);
return data;
};

export const updateExam = async (
examId: string,
payload: Partial<CreateExamForm> & { schoolId: string }
) => {
const { data } = await api.put(/exams/${examId}, payload);
return data;
};

export const updateExamStatus = async (
examId: string,
status: string,
schoolId: string
) => {
const { data } = await api.patch(/exams/${examId}/status, {
status,
schoolId,
});
return data;
};

export const deleteExam = async (
examId: string,
schoolId: string
) => {
const { data } = await api.delete(/exams/${examId}, {
params: { schoolId },
});
return data;
};

// ─────────────────────────────────────────────────────────
// SUBMISSIONS (ExamSubject list)
// ─────────────────────────────────────────────────────────

export const getSubmissions = async (params: {
examId: string;
schoolId: string;
classId?: string;
subjectId?: string;
status?: string;
}): Promise<SubmissionsResponse> => {
const { data } = await api.get(
/exams/${params.examId}/submissions,
{
params: {
schoolId: params.schoolId,
classId: params.classId,
subjectId: params.subjectId,
status: params.status,
},
}
);
return data;
};

export const addSubjectToExam = async (
examId: string,
payload: {
subjectId: string;
classId: string;
teacherId?: string;
maxScore?: number;
passMark?: number;
schoolId: string;
}
) => {
const { data } = await api.post(/exams/${examId}/subjects, payload);
return data;
};

export const approveSubmission = async (
examId: string,
examSubjectId: string,
schoolId: string
) => {
const { data } = await api.patch(
/exams/${examId}/subjects/${examSubjectId}/approve,
{ schoolId }
);
return data;
};

export const rejectSubmission = async (
examId: string,
examSubjectId: string,
reason: string,
schoolId: string
) => {
const { data } = await api.patch(
/exams/${examId}/subjects/${examSubjectId}/reject,
{ reason, schoolId }
);
return data;
};

// ─────────────────────────────────────────────────────────
// SCORES
// ─────────────────────────────────────────────────────────

export const getScores = async (params: {
examId: string;
subjectId?: string;
classId?: string;
schoolId: string;
}) => {
const { data } = await api.get(/exams/${params.examId}/scores, {
params: {
subjectId: params.subjectId,
classId: params.classId,
schoolId: params.schoolId,
},
});
return data;
};

export const saveBulkScores = async (payload: {
examId: string;
classId: string;
subjectId: string;
examSubjectId: string;
scores: Array<{
studentId: string;
score: number | null;
maxScore: number;
isAbsent: boolean;
teacherRemark: string | null;
}>;
schoolId: string;
}) => {
const { data } = await api.post(
/exams/${payload.examId}/scores/bulk,
payload
);
return data;
};

// ─────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────

export const getExamResults = async (
examId: string,
schoolId: string,
classId?: string
): Promise<ResultsResponse> => {
const { data } = await api.get(/exams/${examId}/results, {
params: { schoolId, classId },
});
return data;
};

export const getExamStats = async (
examId: string,
schoolId: string
): Promise<StatsResponse> => {
const { data } = await api.get(/results/${examId}/stats, {
params: { schoolId },
});
return data;
};

export const getRankings = async (
examId: string,
schoolId: string,
rankBy: "class" | "grade" | "school" = "class",
classId?: string
) => {
const { data } = await api.get(/results/${examId}/rankings, {
params: { schoolId, rankBy, classId },
});
return data;
};

export const processResults = async (
examId: string,
schoolId: string,
classId?: string
) => {
const { data } = await api.post(/exams/${examId}/process, {
schoolId,
classId,
});
return data;
};

export const publishResults = async (
examId: string,
schoolId: string
) => {
const { data } = await api.patch(/exams/${examId}/status, {
status: "published",
schoolId,
});
return data;
};

// ─────────────────────────────────────────────────────────
// SINGLE STUDENT RESULT
// GET /results/:examId/student/:studentId
// ─────────────────────────────────────────────────────────

export const getStudentResult = async (
examId: string,
studentId: string,
schoolId: string
) => {
const { data } = await api.get(
/results/${examId}/student/${studentId},
{ params: { schoolId } }
);
return data?.data || data?.result || data || null;
};

// ─────────────────────────────────────────────────────────
// STUDENT REPORT CARD
// GET /results/:examId/student/:studentId/reportcard
// ─────────────────────────────────────────────────────────

export const getStudentReportCard = async (
examId: string,
studentId: string,
schoolId: string
) => {
const { data } = await api.get(
/results/${examId}/student/${studentId}/reportcard,
{ params: { schoolId } }
);
return data?.data || data || null;
};

// ─────────────────────────────────────────────────────────
// ALL RESULTS PAGINATED
// GET /results/:examId
// ─────────────────────────────────────────────────────────

export const getAllResults = async (params: {
examId: string;
schoolId: string;
classId?: string;
page?: number;
limit?: number;
}) => {
const { data } = await api.get(/results/${params.examId}, {
params: {
schoolId: params.schoolId,
classId: params.classId,
page: params.page ?? 1,
limit: params.limit ?? 50,
},
});
return {
results: data?.data || [],
total: data?.total || 0,
page: data?.page || 1,
pages: data?.pages || 1,
};
};