// web/src/services/fee.service.ts
import api from "@/services/api";
import type {
  PaymentPlan,
  FeeStructure,
  FeeItem,
  StudentFeeAccount,
  OutstandingReport,
  OutstandingRow,
  FeePayment,
  FeeTotals,
  PaymentMethod,
} from "@/types/fees.types";

const BASE = "/fees";

const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

/**
 * The server answers `{ success, data }` on most routes and puts extra fields
 * (count, totals) beside `data` on some. Unwrapping in one place keeps the
 * shape-guessing out of the components.
 */
const unwrap = <T,>(body: unknown, key = "data"): T =>
  (body as Record<string, T>)?.[key] ?? (body as T);

// ─── Structures ───────────────────────────────────────────────────────────────

export async function fetchStructures(
  schoolId: string,
  academicYear?: string
): Promise<FeeStructure[]> {
  const { data } = await api.get(`${BASE}/structures${qs({ schoolId, academicYear })}`);
  return unwrap<FeeStructure[]>(data) ?? [];
}

export async function createStructure(payload: {
  /** Required. "2026-09-15". See FeeStructure.dueDate. */
  dueDate:      string;
  penalty?:     { mode: "none" | "fixed" | "percent"; amount: number; graceDays: number };
  schoolId:     string;
  academicYear: string;
  /** Empty or omitted bills every class in the school. */
  classIds?:    string[];
  term?:        string | null;
  items:        FeeItem[];
}): Promise<FeeStructure> {
  const { data } = await api.post(`${BASE}/structures`, payload);
  return unwrap<FeeStructure>(data);
}

export async function deactivateStructure(
  id: string,
  schoolId: string
): Promise<FeeStructure> {
  const { data } = await api.patch(`${BASE}/structures/${id}/deactivate`, { schoolId });
  return unwrap<FeeStructure>(data);
}

export async function activateStructure(
  id: string,
  schoolId: string
): Promise<FeeStructure> {
  const { data } = await api.patch(`${BASE}/structures/${id}/activate`, { schoolId });
  return unwrap<FeeStructure>(data);
}

/**
 * Raise the charges for a class.
 *
 * Safe to call twice — the server's unique index means a repeat raises nothing
 * and reports what it skipped, so a double-click cannot double-bill a class.
 */
export async function applyStructure(
  id: string,
  schoolId: string,
  classId?: string | null
): Promise<{ students: number; raised: number; skipped: number; message: string }> {
  const { data } = await api.post(`${BASE}/structures/${id}/apply`, { schoolId, classId });
  return data as { students: number; raised: number; skipped: number; message: string };
}

// ─── A student's account ──────────────────────────────────────────────────────

export async function fetchStudentAccount(
  studentId: string,
  schoolId: string,
  academicYear?: string
): Promise<StudentFeeAccount> {
  const { data } = await api.get(
    `${BASE}/students/${studentId}${qs({ schoolId, academicYear })}`
  );
  return unwrap<StudentFeeAccount>(data);
}

// ─── Payments ─────────────────────────────────────────────────────────────────

export async function recordPayment(payload: {
  /** Optional client id. Supplying one makes the request safe to retry. */
  _id?:         string;
  schoolId:     string;
  studentId:    string;
  academicYear: string;
  term?:        string | null;
  amount:       number;
  method:       PaymentMethod;
  reference?:   string | null;
  note?:        string | null;
}): Promise<{ payment: FeePayment; totals: FeeTotals }> {
  const { data } = await api.post(`${BASE}/payments`, payload);
  return {
    payment: unwrap<FeePayment>(data),
    totals:  (data as { totals: FeeTotals }).totals,
  };
}

/**
 * Corrections append a reversing row; the original is never edited. The reason
 * is required by the server, which is why it is not optional here.
 */
export async function reversePayment(
  paymentId: string,
  schoolId: string,
  reason: string
): Promise<{ reversal: FeePayment; totals: FeeTotals }> {
  const { data } = await api.post(`${BASE}/payments/${paymentId}/reverse`, {
    schoolId,
    reason,
  });
  return {
    reversal: unwrap<FeePayment>(data),
    totals:   (data as { totals: FeeTotals }).totals,
  };
}

// ─── Instalment plans ─────────────────────────────────────────────────────────

export async function fetchPlans(
  schoolId: string,
  opts: { studentId?: string; academicYear?: string; status?: string } = {}
): Promise<PaymentPlan[]> {
  const { data } = await api.get(`${BASE}/plans${qs({ schoolId, ...opts })}`);
  return (data?.data as PaymentPlan[]) ?? [];
}

/**
 * Agree a plan.
 *
 * The instalments must add up to exactly what is outstanding — the server
 * refuses anything else, because a plan for less would quietly forgive the
 * difference (that is a waiver, and waivers go through approval) and a plan for
 * more would chase money the ledger says is not owed.
 */
export async function createPlan(payload: {
  schoolId:     string;
  studentId:    string;
  academicYear: string;
  term?:        string | null;
  reason:       string;
  instalments:  Array<{ amount: number; dueDate: string }>;
}): Promise<PaymentPlan> {
  const { data } = await api.post(`${BASE}/plans`, payload);
  return unwrap<PaymentPlan>(data);
}

export async function cancelPlan(
  id: string, schoolId: string, reason: string
): Promise<PaymentPlan> {
  const { data } = await api.post(`${BASE}/plans/${id}/cancel`, { schoolId, reason });
  return unwrap<PaymentPlan>(data);
}

// ─── Chasing arrears ──────────────────────────────────────────────────────────
//
// Both jobs are built on the due date entered when the structure was set up: a
// charge with no due date is invisible to them, which is the right reading of a
// bill with no deadline.
//
// Preview and act are separate calls on purpose — these send messages to
// families and add money to their bills, so the bursar sees the list first.

export type ReminderMode = "overdue" | "dueSoon" | "all";

export interface ReminderCandidate {
  studentId:      string;
  name:           string | null;
  enrollmentNo:   string | null;
  classId:        string | null;
  guardianName:   string | null;
  balance:        number;
  earliestDue:    string | null;
  datedCharges:   number;
  undatedCharges: number;
  totalCharges:   number;
  isOverdue:      boolean;
  daysOverdue:    number;
  /** Whether a message can actually reach this family. */
  reachable:      boolean;
  /** Already reminded inside the cooldown, so sending would skip them. */
  recentlyReminded: boolean;
}

export interface PenaltyCandidate {
  studentId:    string;
  name:         string | null;
  enrollmentNo: string | null;
  structureId:  string;
  term:         string | null;
  dueDate:      string;
  graceDays:    number;
  daysOverdue:  number;
  outstanding:  number;
  mode:         "fixed" | "percent";
  rate:         number;
  /** What would actually be charged, computed server-side from the balance. */
  amount:       number;
}

export async function fetchReminderCandidates(
  schoolId: string,
  opts: { academicYear?: string; classId?: string; mode?: ReminderMode } = {}
): Promise<{ rows: ReminderCandidate[]; cooldownDays: number }> {
  const { data } = await api.get(`${BASE}/reminders${qs({ schoolId, ...opts })}`);
  return {
    rows: (data?.data as ReminderCandidate[]) ?? [],
    cooldownDays: Number(data?.cooldownDays) || 0,
  };
}

export async function sendReminders(payload: {
  schoolId:      string;
  academicYear?: string;
  classId?:      string;
  mode?:         ReminderMode;
  studentIds?:   string[];
  /** Send again to families already reminded inside the cooldown. */
  force?:        boolean;
}): Promise<{ queued: number; skippedRecent: number; skippedUnreachable: number }> {
  const { data } = await api.post(`${BASE}/reminders`, payload);
  return data;
}

export async function fetchPenaltyCandidates(
  schoolId: string,
  opts: { academicYear?: string; structureId?: string } = {}
): Promise<{ rows: PenaltyCandidate[]; total: number }> {
  const { data } = await api.get(`${BASE}/penalties${qs({ schoolId, ...opts })}`);
  return { rows: (data?.data as PenaltyCandidate[]) ?? [], total: Number(data?.total) || 0 };
}

export async function applyPenalties(payload: {
  schoolId:      string;
  academicYear?: string;
  structureId?:  string;
  studentIds?:   string[];
}): Promise<{ raised: number; total: number; skipped: number }> {
  const { data } = await api.post(`${BASE}/penalties`, payload);
  return data;
}

// ─── Arrears ──────────────────────────────────────────────────────────────────

export async function fetchOutstanding(
  schoolId: string,
  academicYear?: string,
  classId?: string
): Promise<OutstandingReport> {
  const { data } = await api.get(
    `${BASE}/outstanding${qs({ schoolId, academicYear, classId })}`
  );
  const body = data as {
    count: number;
    totalOutstanding: number;
    data: OutstandingRow[];
  };
  return {
    count:            body.count ?? 0,
    totalOutstanding: body.totalOutstanding ?? 0,
    rows:             body.data ?? [],
  };
}

// ─── Receipt printing ─────────────────────────────────────────────────────────

/**
 * Fetch a printable receipt as HTML from the server.
 *
 * The server builds the same receipt the guardian portal produces, but
 * authenticated as staff.  The caller passes it to `printHtml()`.
 */
export async function fetchReceiptHtml(
  paymentId: string,
  schoolId:  string,
  lang:      string = "en",
): Promise<string> {
  const { data } = await api.get(`${BASE}/receipt/${paymentId}`, {
    params: { schoolId, lang },
    responseType: "text",
  });
  return data as string;
}
