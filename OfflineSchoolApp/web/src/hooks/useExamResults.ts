// web/src/hooks/useExamResults.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthStore }   from "@/store/auth.store";
import * as ExamService   from "@/services/exam.service";
import { examQueryKeys }  from "./useExams";
import { useToast }       from "@/components/ui/Toast";

import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@/lib/axios";

// ─── Query key factory ────────────────────────────────────────────────────────

const resultKeys = {
  results:  (examId: string, classId?: string) =>
    ["results", examId, classId ?? "all"] as const,
  stats:    (examId: string, classId?: string) =>
    ["exam-stats", examId, classId ?? "all"] as const,
  rankings: (examId: string, scope: string, classId?: string) =>
    ["rankings", examId, scope, classId ?? "all"] as const,
  student:  (examId: string, studentId: string) =>
    ["student-result", examId, studentId] as const,
};

/** A whole-school compute leaves classes with published results as they are and names them. */
const refusedClassesText = (data: unknown, t: (k: string, o?: Record<string, unknown>) => string): string | null => {
  const r = (data as { refusedClasses?: { classId: string; className?: string | null }[] } | null)?.refusedClasses;
  if (!r?.length) return null;
  return t("results.refusedPublished", { count: r.length, classes: r.map((c) => c.className ?? c.classId).join(", ") });
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

export const useExamStats = (examId: string, classId?: string) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: resultKeys.stats(examId, classId),
    queryFn:  () => ExamService.getExamStats(examId, schoolId, classId),
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
  const { t } = useTranslation();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: ({
      examId,
      classId,
    }: { examId: string; classId?: string }) =>
      ExamService.processResults(examId, schoolId, classId),

    onSuccess: (_data, { examId }) => {
      qc.invalidateQueries({ queryKey: resultKeys.results(examId)              });
      qc.invalidateQueries({ queryKey: ["exam-stats", examId]                });
      // Prefix: every scope and every class filter of this exam's rankings.
      qc.invalidateQueries({ queryKey: ["rankings", examId]                    });
      qc.invalidateQueries({ queryKey: examQueryKeys.detail(examId)            });
      toast({ title: t("results.toastCalculated"), kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: t("exams.errProcessResults"), message: getErrorMessage(e), kind: "error" }),
  });
};

// ─── PUBLISH RESULTS ──────────────────────────────────────────────────────────

export const usePublishResults = () => {
  const { t } = useTranslation();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (examId: string) =>
      ExamService.publishResults(examId, schoolId),

    onSuccess: (_data, examId) => {
      qc.invalidateQueries({ queryKey: examQueryKeys.detail(examId)            });
      qc.invalidateQueries({ queryKey: examQueryKeys.lists()                   });
      qc.invalidateQueries({ queryKey: examQueryKeys.dashboard(schoolId)       });
      qc.invalidateQueries({ queryKey: resultKeys.results(examId)              });
      toast({ title: t("results.toastPublished"), kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: t("exams.errPublishResults"), message: getErrorMessage(e), kind: "error" }),
  });
};

// ─── UNPUBLISH (sequence, term, year), with a reason ──────────────────────────

export const useUnpublishResults = (layer: ExamService.UnpublishLayer) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (p: Omit<ExamService.UnpublishParams, "schoolId">) =>
      ExamService.unpublishResults(layer, { ...p, schoolId }),
    onSuccess: (data) => {
      // Results, exams, terms and years all show the published state.
      void qc.invalidateQueries();
      toast({
        kind: "success",
        title: t("unpublish.done", { count: data?.unpublished ?? 0 }),
        message: t("unpublish.issuedStay"),
      });
    },
    onError: (e: Error) =>
      toast({ kind: "error", title: t("unpublish.failed"), message: getErrorMessage(e) }),
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
      const { default: api } = await import("../lib/axios");
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

// ─── TERM RESULTS ────────────────────────────────────────────────────────────

const termResultKeys = {
  list: (schoolId: string, year: string, term: number, classId?: string, page?: number) =>
    ["term-results", schoolId, year, term, classId ?? "all", page ?? 1] as const,
};

export const useTermResults = (
  academicYear: string,
  term: number,
  classId?: string,
  page: number = 1,
  limit: number = 50
) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: termResultKeys.list(schoolId, academicYear, term, classId, page),
    queryFn: () => ExamService.getTermResults({ schoolId, academicYear, term, classId, page, limit }),
    enabled: !!academicYear && !!term && !!schoolId,
    staleTime: 2 * 60_000,
  });
};

export const useComputeTermResults = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const refusedToast = (data: unknown) => {
    const text = refusedClassesText(data, t);
    if (text) toast({ title: text, kind: "error" });
  };

  return useMutation({
    mutationFn: (payload: { academicYear: string; term: number; classId?: string }) =>
      ExamService.computeTermResults({ ...payload, schoolId }),
    onSuccess: (data, payload) => {
      qc.invalidateQueries({
        queryKey: termResultKeys.list(schoolId, payload.academicYear, payload.term, payload.classId),
      });
      toast({ title: t("academicStructure.termComputed"), kind: "success" });
      refusedToast(data);
    },
    onError: (e: Error) =>
      toast({ title: t("exams.errComputeTerm"), message: getErrorMessage(e), kind: "error" }),
  });
};

export const usePublishTermResults = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (payload: { academicYear: string; term: number; classId?: string }) =>
      ExamService.publishTermResults({ ...payload, schoolId }),
    onSuccess: (_data, payload) => {
      qc.invalidateQueries({
        queryKey: termResultKeys.list(schoolId, payload.academicYear, payload.term, payload.classId),
      });
      toast({ title: t("academicStructure.termPublished"), kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: t("exams.errPublishTerm"), message: getErrorMessage(e), kind: "error" }),
  });
};

// ─── ANNUAL RESULTS ──────────────────────────────────────────────────────────

const annualResultKeys = {
  list: (schoolId: string, year: string, classId?: string, page?: number) =>
    ["annual-results", schoolId, year, classId ?? "all", page ?? 1] as const,
};

export const useAnnualResults = (
  academicYear: string,
  classId?: string,
  page: number = 1,
  limit: number = 50
) => {
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");
  return useQuery({
    queryKey: annualResultKeys.list(schoolId, academicYear, classId, page),
    queryFn: () => ExamService.getAnnualResults({ schoolId, academicYear, classId, page, limit }),
    enabled: !!academicYear && !!schoolId,
    staleTime: 2 * 60_000,
  });
};

export const useComputeAnnualResults = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const refusedToast = (data: unknown) => {
    const text = refusedClassesText(data, t);
    if (text) toast({ title: text, kind: "error" });
  };

  return useMutation({
    mutationFn: (payload: { academicYear: string; classId?: string }) =>
      ExamService.computeAnnualResults({ ...payload, schoolId }),
    onSuccess: (data, payload) => {
      qc.invalidateQueries({
        queryKey: annualResultKeys.list(schoolId, payload.academicYear, payload.classId),
      });
      toast({ title: t("academicStructure.annualComputed"), kind: "success" });
      refusedToast(data);
    },
    onError: (e: Error) =>
      toast({ title: t("exams.errComputeAnnual"), message: getErrorMessage(e), kind: "error" }),
  });
};

export const usePublishAnnualResults = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  return useMutation({
    mutationFn: (payload: { academicYear: string; classId?: string }) =>
      ExamService.publishAnnualResults({ ...payload, schoolId }),
    onSuccess: (_data, payload) => {
      qc.invalidateQueries({
        queryKey: annualResultKeys.list(schoolId, payload.academicYear, payload.classId),
      });
      toast({ title: t("academicStructure.annualPublished"), kind: "success" });
    },
    onError: (e: Error) =>
      toast({ title: t("exams.errPublishAnnual"), message: getErrorMessage(e), kind: "error" }),
  });
};