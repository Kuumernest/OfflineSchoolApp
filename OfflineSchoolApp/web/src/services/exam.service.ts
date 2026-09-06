// web/src/services/exam.service.ts
import api, { TIMEOUTS } from "@/lib/axios";
import { batchSize } from "@/lib/linkQuality";
import type {
ExamsListResponse,
ExamDetailResponse,
DashboardResponse,
SubmissionsResponse,
ResultsResponse,
StatsResponse,
TermResultsResponse,
AnnualResultsResponse,
AcademicStructure,
CreateExamForm,
ExamSubject,
TermResult,
AnnualResult,
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
const { data } = await api.get(`/exams/${examId}`, {
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
const { data } = await api.put(`/exams/${examId}`, payload);
return data;
};

export const updateExamStatus = async (
examId: string,
status: string,
schoolId: string
) => {
const { data } = await api.patch(`/exams/${examId}/status`, {
status,
schoolId,
});
return data;
};

export const deleteExam = async (
examId: string,
schoolId: string
) => {
const { data } = await api.delete(`/exams/${examId}`, {
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
`/exams/${params.examId}/submissions`,
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
const { data } = await api.post(`/exams/${examId}/subjects`, payload);
return data;
};

/**
 * Update one exam subject's settings — coefficient included.
 *
 * The API stores the coefficient as percentage-style `weight` (100 = ×1,
 * 200 = ×2). `reprocessRequired` comes back true when marks already exist
 * and the change makes computed averages stale.
 */
export const updateExamSubject = async (
examId: string,
examSubjectId: string,
payload: {
weight?: number;
maxScore?: number;
passMark?: number;
teacherId?: string | null;
schoolId: string;
}
): Promise<{ success: boolean; subject: ExamSubject; reprocessRequired: boolean }> => {
const { data } = await api.put(
`/exams/${examId}/subjects/${examSubjectId}`,
payload
);
return data;
};

export const approveSubmission = async (
examId: string,
examSubjectId: string,
schoolId: string
) => {
const { data } = await api.patch(
`/exams/${examId}/subjects/${examSubjectId}/approve`,
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
`/exams/${examId}/subjects/${examSubjectId}/reject`,
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
const { data } = await api.get(`/exams/${params.examId}/scores`, {
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
/**
 * Why a published or locked result is being changed.
 *
 * The server refuses the write with 423 REASON_REQUIRED without it, and
 * only an administrator may supply one at all. It rides on every chunk
 * because each chunk is its own request and each is guarded separately.
 */
changeReason?: string;
},
  opts: {
    /** Rows per request. 0 or below sends everything in one. */
    chunkSize?:  number;
    onProgress?: (done: number, total: number) => void;
  } = {},
) => {
  // Sent in chunks, for two reasons that turn out to be one reason.
  //
  // A mark sheet is the screen where somebody types for twenty minutes and
  // then presses Save, and over a school WAN a single request carrying four
  // hundred rows is precisely the request that times out — losing all of it.
  // Each row is an independent upsert keyed on (exam, student, subject), so
  // a chunk is safe to send alone and safe to send twice; nothing in the
  // write depends on the rest of the sheet.
  //
  // And a chunk boundary is the only honest source of a percentage. A single
  // request can report that it is in flight, and nothing beyond that.
  const rows  = payload.scores;
  // 25 is the size for a link that is behaving. What actually goes out follows
  // the connection: halved after a timeout, crept back up after a clean run.
  // A chunk that keeps timing out is not fixed by a longer timeout — it is
  // fixed by being smaller.
  const size  = opts.chunkSize ?? batchSize(25);
  const total = rows.length;

  if (size <= 0 || total <= size) {
    opts.onProgress?.(0, total);
    const { data } = await api.post(
      `/exams/${payload.examId}/scores/bulk`,
      payload,
    );
    opts.onProgress?.(total, total);
    return data;
  }

  let saved  = 0;
  let failed = 0;
  const failedRecords: unknown[] = [];

  for (let i = 0; i < total; i += size) {
    const slice = rows.slice(i, i + size);
    opts.onProgress?.(i, total);

    // Deliberately not caught: a failed chunk stops the run and throws, so
    // the caller reports a failure rather than a save that half happened.
    // The chunks already sent stay sent, which is the point — the teacher
    // presses Save again and the upserts make the retry cost nothing.
    const { data } = await api.post(
      `/exams/${payload.examId}/scores/bulk`,
      { ...payload, scores: slice },
    );

    saved  += Number(data?.saved)  || 0;
    failed += Number(data?.failed) || 0;
    if (Array.isArray(data?.failedRecords)) failedRecords.push(...data.failedRecords);

    opts.onProgress?.(Math.min(i + size, total), total);
  }

  return { success: true, saved, failed, failedRecords };
};

// ─────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────

export const getExamResults = async (
examId: string,
schoolId: string,
classId?: string
): Promise<ResultsResponse> => {
const { data } = await api.get(`/exams/${examId}/results`, {
params: { schoolId, classId },
});
return data;
};

export const getExamStats = async (
examId: string,
schoolId: string
): Promise<StatsResponse> => {
const { data } = await api.get(`/results/${examId}/stats`, {
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
const { data } = await api.get(`/results/${examId}/rankings`, {
params: { schoolId, rankBy, classId },
});
return data;
};

export const processResults = async (
  examId: string,
  schoolId: string,
  classId?: string
) => {
  const { data } = await api.post(`/exams/${examId}/process`, {
    schoolId,
    classId,
  }, { timeout: TIMEOUTS.long });
  return data;
};

export const publishResults = async (
examId: string,
schoolId: string
) => {
const { data } = await api.patch(`/exams/${examId}/status`, {
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
`/results/${examId}/student/${studentId}`,
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
`/results/${examId}/student/${studentId}/reportcard`,
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
const { data } = await api.get(`/results/${params.examId}`, {
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

// ─────────────────────────────────────────────────────────
// ACADEMIC STRUCTURE
// ─────────────────────────────────────────────────────────

export const getAcademicStructure = async (
schoolId: string,
academicYear: string
): Promise<{ success: boolean; structure: AcademicStructure }> => {
const { data } = await api.get(`/academic-structure/${schoolId}/${encodeURIComponent(academicYear)}`);
return data;
};

export const updateAcademicStructure = async (
schoolId: string,
academicYear: string,
payload: Partial<AcademicStructure>
): Promise<{ success: boolean; structure: AcademicStructure }> => {
const { data } = await api.put(`/academic-structure/${schoolId}/${encodeURIComponent(academicYear)}`, payload);
return data;
};

// ─────────────────────────────────────────────────────────
// TERM RESULTS
// ─────────────────────────────────────────────────────────

export const getTermResults = async (params: {
schoolId: string;
academicYear: string;
term: number;
classId?: string;
page?: number;
limit?: number;
}): Promise<TermResultsResponse> => {
const { data } = await api.get("/term-results", { params });
return data;
};

export const computeTermResults = async (payload: {
schoolId: string;
academicYear: string;
term: number;
classId?: string;
}) => {
const { data } = await api.post("/term-results/compute", payload, { timeout: TIMEOUTS.long });
return data;
};

export const publishTermResults = async (payload: {
schoolId: string;
academicYear: string;
term: number;
classId?: string;
}) => {
const { data } = await api.post("/term-results/publish", payload, { timeout: TIMEOUTS.long });
return data;
};

// ─────────────────────────────────────────────────────────
// ANNUAL RESULTS
// ─────────────────────────────────────────────────────────

export const getAnnualResults = async (params: {
schoolId: string;
academicYear: string;
classId?: string;
page?: number;
limit?: number;
}): Promise<AnnualResultsResponse> => {
const { data } = await api.get("/annual-results", { params });
return data;
};

export const computeAnnualResults = async (payload: {
schoolId: string;
academicYear: string;
classId?: string;
}) => {
const { data } = await api.post("/annual-results/compute", payload, { timeout: TIMEOUTS.long });
return data;
};

export const publishAnnualResults = async (payload: {
schoolId: string;
academicYear: string;
classId?: string;
}) => {
const { data } = await api.post("/annual-results/publish", payload, { timeout: TIMEOUTS.long });
return data;
};