// web/src/hooks/useExamDetail.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore }    from "@/store/auth.store";
import * as ExamService    from "@/services/exam.service";
import { examQueryKeys }   from "./useExams";
import { useToast }        from "@/components/ui/Toast";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (examSubjectId: string) =>
      ExamService.approveSubmission(examId, examSubjectId, schoolId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["submissions", examId] });
      toast({ title: t("exams.toastApproved"), kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: e.message || "Failed to approve submission", kind: "error" }),
  });
};

// ─── REJECT SUBMISSION ────────────────────────────────────────────────────────

export const useRejectSubmission = (examId: string) => {
  const { t } = useTranslation();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: ({
      examSubjectId,
      reason,
    }: { examSubjectId: string; reason: string }) =>
      ExamService.rejectSubmission(examId, examSubjectId, reason, schoolId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["submissions", examId] });
      toast({ title: t("exams.toastRejected"), kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: e.message || "Failed to reject submission", kind: "error" }),
  });
};

// ─── UPDATE EXAM SUBJECT (coefficient, max score, pass mark) ─────────────────

export const useUpdateExamSubject = (examId: string) => {
  const { t } = useTranslation();
  const qc        = useQueryClient();
  const { toast } = useToast();
  const schoolId  = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (vars: {
      examSubjectId: string;
      weight?: number;
      maxScore?: number;
      passMark?: number;
    }) =>
      ExamService.updateExamSubject(examId, vars.examSubjectId, {
        weight:   vars.weight,
        maxScore: vars.maxScore,
        passMark: vars.passMark,
        schoolId,
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["submissions", examId] });
      // Marks already exist for this subject, so every computed average is now
      // stale — say so, rather than letting the change look free.
      toast(
        data.reprocessRequired
          ? {
              title: t("exams.toastNeedsReprocess"),
              message: t("exams.toastReprocessBody"),
              kind: "warning",
            }
          : { title: t("exams.toastSubjectUpdated"), kind: "success" }
      );
    },
    onError: (e: Error) =>
      toast({ title: e.message || "Failed to update subject", kind: "error" }),
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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ExamService.saveBulkScores,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: submissionKeys.scores(vars.examId, vars.subjectId, vars.classId),
      });
      qc.invalidateQueries({ queryKey: ["submissions", vars.examId] });
      toast({ title: t("exams.toastScoresSaved"), kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: e.message || "Failed to save scores", kind: "error" }),
  });
};