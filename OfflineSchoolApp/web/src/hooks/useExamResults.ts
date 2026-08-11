// web/src/hooks/useExamResults.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore }   from "@/store/auth.store";
import * as ExamService   from "@/services/exam.service";
import { examQueryKeys }  from "./useExams";
import toast              from "react-hot-toast";

// ─── Query key factory ────────────────────────────────────────────────────────

const resultKeys = {
  results:  (examId: string, classId?: string) =>
    ["results", examId, classId ?? "all"] as const,
  stats:    (examId: string)                   =>
    ["exam-stats", examId]               as const,
  rankings: (examId: string, scope: string, classId?: string) =>
    ["rankings", examId, scope, classId ?? "all"] as const,
  student:  (examId: string, studentId: string) =>
    ["student-result", examId, studentId] as const,
};

// ─── RESULTS LIST ─────────────────────────────────────────────────────────────

export const useExamResults = (examId: string, classId?: string) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: resultKeys.results(examId, classId),
    queryFn:  () => ExamService.getExamResults(examId, schoolId, classId),
    enabled:  !!examId && !!schoolId,
    staleTime: 2 * 60_000,
  });
};

// ─── STATS ────────────────────────────────────────────────────────────────────

export const useExamStats = (examId: string) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: resultKeys.stats(examId),
    queryFn:  () => ExamService.getExamStats(examId, schoolId),
    enabled:  !!examId && !!schoolId,
    staleTime: 2 * 60_000,
  });
};

// ─── RANKINGS ─────────────────────────────────────────────────────────────────

export const useRankings = (
  examId:   string,
  rankBy:   "class" | "grade" | "school" = "class",
  classId?: string
) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: resultKeys.rankings(examId, rankBy, classId),
    queryFn:  () => ExamService.getRankings(examId, schoolId, rankBy, classId),
    enabled:  !!examId && !!schoolId,
    staleTime: 2 * 60_000,
  });
};

// ─── STUDENT RESULT ───────────────────────────────────────────────────────────

export const useStudentResult = (examId: string, studentId: string) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: resultKeys.student(examId, studentId),
    queryFn:  () => ExamService.getStudentResult(examId, studentId, schoolId),
    enabled:  !!examId && !!studentId && !!schoolId,
  });
};

// ─── PROCESS RESULTS ──────────────────────────────────────────────────────────

export const useProcessResults = () => {
  const qc       = useQueryClient();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: ({
      examId,
      classId,
    }: { examId: string; classId?: string }) =>
      ExamService.processResults(examId, schoolId, classId),

    onSuccess: (_data, { examId }) => {
      qc.invalidateQueries({ queryKey: resultKeys.results(examId)              });
      qc.invalidateQueries({ queryKey: resultKeys.stats(examId)                });
      qc.invalidateQueries({ queryKey: resultKeys.rankings(examId, "class")    });
      qc.invalidateQueries({ queryKey: resultKeys.rankings(examId, "grade")    });
      qc.invalidateQueries({ queryKey: resultKeys.rankings(examId, "school")   });
      qc.invalidateQueries({ queryKey: examQueryKeys.detail(examId)            });
      toast.success("Results calculated successfully 🎉");
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to process results"),
  });
};

// ─── PUBLISH RESULTS ──────────────────────────────────────────────────────────

export const usePublishResults = () => {
  const qc       = useQueryClient();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (examId: string) =>
      ExamService.publishResults(examId, schoolId),

    onSuccess: (_data, examId) => {
      qc.invalidateQueries({ queryKey: examQueryKeys.detail(examId)            });
      qc.invalidateQueries({ queryKey: examQueryKeys.lists()                   });
      qc.invalidateQueries({ queryKey: examQueryKeys.dashboard(schoolId)       });
      qc.invalidateQueries({ queryKey: resultKeys.results(examId)              });
      toast.success("Results published! Students can now view their scores 📢");
    },
    onError: (e: Error) =>
      toast.error(e.message || "Failed to publish results"),
  });
};

// ─── ALL RESULTS PAGINATED ────────────────────────────────────────────────────

export const useAllResults = (
  examId:   string,
  classId?: string,
  page:     number = 1,
  limit:    number = 50
) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: ["all-results", examId, classId, page, limit],
    queryFn:  async () => {
      const { default: api } = await import("../lib/api");
      const { data } = await api.get(`/results/${examId}`, {
        params: { schoolId, classId, page, limit },
      });
      return {
        results: data?.data  || [],
        total:   data?.total || 0,
        page:    data?.page  || 1,
        pages:   data?.pages || 1,
      };
    },
    enabled:   !!examId && !!schoolId,
    staleTime: 2 * 60_000,
  });
};