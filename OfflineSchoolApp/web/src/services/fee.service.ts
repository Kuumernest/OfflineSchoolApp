// web/src/services/fee.service.ts
import api from "@/services/api";
import type {
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
