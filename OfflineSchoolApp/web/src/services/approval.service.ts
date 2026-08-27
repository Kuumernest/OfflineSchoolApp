// web/src/services/approval.service.ts
import api from "@/services/api";

const BASE = "/approvals";

const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApprovalKind   = "expense" | "refund" | "waiver" | "payroll";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface ApprovalRequest {
  _id:      string;
  schoolId: string;
  kind:     ApprovalKind;
  targetId: string | null;
  /** Whole XAF at stake. */
  amount:   number;
  /**
   * The threshold in force when this was raised — not today's. A school that
   * has since changed the rule would otherwise look as though it had asked
   * somebody to sign off on trivia.
   */
  thresholdAtRequest: number | null;
  reason:   string | null;
  summary:  string | null;
  status:   ApprovalStatus;
  requestedBy:  string | null;
  requestedAt:  string;
  decidedBy:    string | null;
  decidedAt:    string | null;
  decisionNote: string | null;
  /** Set when the decision was recorded but the effect could not be applied. */
  applyError:   string | null;
}

export interface ApprovalThresholds {
  /** Null means a second signature is never required for this. */
  expenseThreshold: number | null;
  refundThreshold:  number | null;
  waiverThreshold:  number | null;
  payrollRequired:  boolean;
}

export interface ApprovalSummary {
  /** Everything waiting in the school. */
  pending:    number;
  /** Of those, the ones this person raised — which they cannot decide. */
  mine:       number;
  canDecide:  boolean;
  thresholds: ApprovalThresholds;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * The queue.
 *
 * Scoping is the server's decision, not a parameter: somebody who can decide
 * gets the school's queue and somebody who can only raise gets their own
 * requests. `canDecide` comes back so the screen knows whether to draw buttons
 * or a status column.
 */
export async function fetchApprovals(
  schoolId: string,
  opts: { status?: ApprovalStatus | "all"; kind?: ApprovalKind } = {}
): Promise<{ rows: ApprovalRequest[]; canDecide: boolean }> {
  const { data } = await api.get(`${BASE}${qs({ schoolId, ...opts })}`);
  return {
    rows:      (data?.data as ApprovalRequest[]) ?? [],
    canDecide: Boolean(data?.canDecide),
  };
}

/** The number for a dashboard tile, plus the rules in force. */
export async function fetchApprovalSummary(schoolId: string): Promise<ApprovalSummary> {
  const { data } = await api.get(`${BASE}/summary${qs({ schoolId })}`);
  return data?.data as ApprovalSummary;
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export async function approveRequest(
  id: string, schoolId: string, note?: string
): Promise<ApprovalRequest> {
  const { data } = await api.post(`${BASE}/${id}/approve`, { schoolId, note });
  return data?.data as ApprovalRequest;
}

/** A note is required — somebody whose request was refused is owed a reason. */
export async function rejectRequest(
  id: string, schoolId: string, note: string
): Promise<ApprovalRequest> {
  const { data } = await api.post(`${BASE}/${id}/reject`, { schoolId, note });
  return data?.data as ApprovalRequest;
}

/** Withdraw your own request, before anybody has decided it. */
export async function cancelRequest(
  id: string, schoolId: string
): Promise<ApprovalRequest> {
  const { data } = await api.post(`${BASE}/${id}/cancel`, { schoolId });
  return data?.data as ApprovalRequest;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

export async function saveThresholds(
  schoolId: string, next: ApprovalThresholds
): Promise<ApprovalThresholds> {
  const { data } = await api.put(`${BASE}/thresholds`, { schoolId, ...next });
  return data?.data as ApprovalThresholds;
}
