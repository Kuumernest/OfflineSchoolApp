// web/src/hooks/useExamDetail.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore }    from "@/store/auth.store";
import * as ExamService    from "@/services/exam.service";
import { examQueryKeys }   from "./useExams";
import toast               from "react-hot-toast";

// ─── Query key factory ────────────────────────────────────────────────────────

const submissionKeys = {
  list: (examId: string, classId?: string) =>
    ["submissions", examId, classId ?? "all"] as const,
  scores: (examId: string, subjectId: string, classId: string) =>
    ["scores", examId, subjectId, classId] as const,
};

// ─── EXAM DETAIL ──────────────────────────────────────────────────────────────

export const useExamDetail = (examId: string) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: examQueryKeys.detail(examId),
    queryFn:  () => ExamService.getExamById(examId, schoolId),
    enabled:  !!examId && !!schoolId,
    staleTime: 30_000,
  });
};

// ─── SUBMISSIONS LIST ─────────────────────────────────────────────────────────

export const useSubmissions = (examId: string, classId?: string) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: submissionKeys.list(examId, classId),
    queryFn:  () => ExamService.getSubmissions({ examId, schoolId, classId }),
    enabled:  !!examId && !!schoolId,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
};

// ─── APPROVE SUBMISSION ───────────────────────────────────────────────────────

export const useApproveSubmission = (examId: string) => {
  const qc       = useQueryClient();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (examSubjectId: string) =>
      ExamService.approveSubmission(examId, examSubjectId, schoolId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["submissions", examId] });
      toast.success("Marks approved ✅");
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to approve submission"),
  });
};

// ─── REJECT SUBMISSION ────────────────────────────────────────────────────────

export const useRejectSubmission = (examId: string) => {
  const qc       = useQueryClient();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: ({
      examSubjectId,
      reason,
    }: { examSubjectId: string; reason: string }) =>
      ExamService.rejectSubmission(examId, examSubjectId, reason, schoolId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["submissions", examId] });
      toast.success("Submission rejected");
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to reject submission"),
  });
};

// ─── SCORES ───────────────────────────────────────────────────────────────────

export const useScores = (
  examId:    string,
  subjectId: string,
  classId:   string
) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: submissionKeys.scores(examId, subjectId, classId),
    queryFn:  () =>
      ExamService.getScores({ examId, subjectId, classId, schoolId }),
    enabled:  !!examId && !!subjectId && !!classId && !!schoolId,
    staleTime: 15_000,
  });
};

// ─── SAVE BULK SCORES ─────────────────────────────────────────────────────────

export const useSaveBulkScores = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ExamService.saveBulkScores,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: submissionKeys.scores(vars.examId, vars.subjectId, vars.classId),
      });
      qc.invalidateQueries({ queryKey: ["submissions", vars.examId] });
      toast.success("Scores saved");
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to save scores"),
  });
};