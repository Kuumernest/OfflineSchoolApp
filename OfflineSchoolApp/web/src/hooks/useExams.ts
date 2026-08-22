// web/src/hooks/useExams.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth.store";
import * as ExamService from "@/services/exam.service";
import type { CreateExamForm } from "@/types/exam.types";
import { useToast } from "@/components/ui/Toast";

// ─── Query key factory ────────────────────────────────────────────────────────

export const examQueryKeys = {
  all:       ()                  => ["exams"]                         as const,
  lists:     ()                  => ["exams", "list"]                 as const,
  list:      (f: object)         => ["exams", "list", f]              as const,
  dashboard: (schoolId: string)  => ["exam-dashboard", schoolId]      as const,
  detail:    (id: string)        => ["exam", id]                      as const,
};

// ─── LIST ─────────────────────────────────────────────────────────────────────

export const useExams = (filters?: {
  status?:       string;
  classId?:      string;
  academicYear?: string;
  term?:         string;
  page?:         number;
  limit?:        number;
}) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useQuery({
    queryKey: examQueryKeys.list({ schoolId, ...filters }),
    queryFn:  () => ExamService.getExams({ schoolId, ...filters }),
    enabled:  !!schoolId,
    staleTime: 30_000,
  });
};

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

export const useExamDashboard = () => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useQuery({
    queryKey: examQueryKeys.dashboard(schoolId),
    queryFn:  () => ExamService.getExamDashboard(schoolId),
    enabled:  !!schoolId,
    staleTime: 60_000,
  });
};

// ─── CREATE ───────────────────────────────────────────────────────────────────

export const useCreateExam = () => {
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (payload: Partial<CreateExamForm> & { schoolId: string }) =>
      ExamService.createExam({ ...payload, schoolId }),

    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examQueryKeys.lists()             });
      qc.invalidateQueries({ queryKey: examQueryKeys.dashboard(schoolId) });
      toast({ title: "Exam created", kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: e.message || "Failed to create exam", kind: "error" }),
  });
};

// ─── UPDATE STATUS ────────────────────────────────────────────────────────────

export const useUpdateExamStatus = () => {
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: ({ examId, status }: { examId: string; status: string }) =>
      ExamService.updateExamStatus(examId, status, schoolId),

    onSuccess: (_data, { examId }) => {
      qc.invalidateQueries({ queryKey: examQueryKeys.lists()             });
      qc.invalidateQueries({ queryKey: examQueryKeys.detail(examId)      });
      qc.invalidateQueries({ queryKey: examQueryKeys.dashboard(schoolId) });
      toast({ title: "Status updated", kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: e.message || "Failed to update status", kind: "error" }),
  });
};

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const useDeleteExam = () => {
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (examId: string) =>
      ExamService.deleteExam(examId, schoolId),

    onSuccess: () => {
      qc.invalidateQueries({ queryKey: examQueryKeys.lists()             });
      qc.invalidateQueries({ queryKey: examQueryKeys.dashboard(schoolId) });
      toast({ title: "Exam deleted", kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: e.message || "Failed to delete exam", kind: "error" }),
  });
};