// web/src/services/promotion.service.ts
import api, { TIMEOUTS } from "@/services/api";
import type {
  ProgressionClass, ProgressionResponse,
  PromotionRun, PromotionDetail, PromotionDecision,
  PromotionCounts, Outcome, EnrollmentRow,
} from "@/types/promotion.types";

const BASE = "/promotion";

const qs = (params: Record<string, string | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ─── Progression ──────────────────────────────────────────────────────────────

export async function fetchProgression(schoolId: string): Promise<ProgressionResponse> {
  const { data } = await api.get(`${BASE}/progression${qs({ schoolId })}`);
  const body = data as ProgressionResponse;
  return { data: body.data ?? [], count: body.count ?? 0, incomplete: body.incomplete ?? 0 };
}

export async function saveProgression(
  schoolId: string,
  entries: {
    classId: string;
    nextClassId: string | null;
    isFinalYear: boolean;
    promotionAverage: number | null;
  }[]
): Promise<ProgressionClass[]> {
  const { data } = await api.put(`${BASE}/progression`, { schoolId, entries });
  return (data as { data: ProgressionClass[] }).data ?? [];
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function fetchRuns(schoolId: string): Promise<PromotionRun[]> {
  const { data } = await api.get(`${BASE}/runs${qs({ schoolId })}`);
  return (data as { data: PromotionRun[] }).data ?? [];
}

export async function fetchRun(runId: string, schoolId: string): Promise<PromotionDetail> {
  const { data } = await api.get(`${BASE}/runs/${runId}${qs({ schoolId })}`);
  return (data as { data: PromotionDetail }).data;
}

/** Produces a DRAFT. No student moves until the run is committed. */
export async function generateRun(
  schoolId: string, fromYear: string, toYear: string
): Promise<{ run: PromotionRun; message: string }> {
  // A promotion run walks every pupil in the school.
  const { data } = await api.post(
    `${BASE}/runs`, { schoolId, fromYear, toYear }, { timeout: TIMEOUTS.long }
  );
  return data as { run: PromotionRun; message: string };
}

export async function setDecision(
  runId: string, studentId: string, schoolId: string,
  outcome: Outcome, toClassId: string | null
): Promise<{ data: PromotionDecision; counts: PromotionCounts }> {
  const { data } = await api.patch(
    `${BASE}/runs/${runId}/decisions/${studentId}`,
    { schoolId, outcome, toClassId }
  );
  return data as { data: PromotionDecision; counts: PromotionCounts };
}

export async function commitRun(
  runId: string, schoolId: string
): Promise<{ run: PromotionRun; applied: number }> {
  const { data } = await api.post(
    `${BASE}/runs/${runId}/commit`, { schoolId }, { timeout: TIMEOUTS.long }
  );
  return data as { run: PromotionRun; applied: number };
}

export async function reverseRun(
  runId: string, schoolId: string, reason: string
): Promise<{ run: PromotionRun; restored: number }> {
  const { data } = await api.post(
    `${BASE}/runs/${runId}/reverse`, { schoolId, reason }, { timeout: TIMEOUTS.long }
  );
  return data as { run: PromotionRun; restored: number };
}

/** Only a draft can be discarded — a committed run is undone by reversing it. */
export async function discardRun(runId: string, schoolId: string): Promise<void> {
  await api.delete(`${BASE}/runs/${runId}${qs({ schoolId })}`);
}

// ─── History ──────────────────────────────────────────────────────────────────

export async function fetchStudentHistory(
  studentId: string, schoolId: string
): Promise<EnrollmentRow[]> {
  const { data } = await api.get(`${BASE}/students/${studentId}/history${qs({ schoolId })}`);
  return (data as { data: EnrollmentRow[] }).data ?? [];
}
