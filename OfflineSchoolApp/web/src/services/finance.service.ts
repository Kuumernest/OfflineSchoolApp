// web/src/services/finance.service.ts
import api from "@/services/api";
import type {
  ExpenseCategory,
  Expense,
  SalaryStructure,
  SalaryComponent,
  PayrollRun,
  PayrollDetail,
  StaffRef,
  FinanceReport,
  SpendMethod,
} from "@/types/finance.types";

const BASE = "/finance";

const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
};

const unwrap = <T,>(body: unknown, key = "data"): T =>
  (body as Record<string, T>)?.[key] ?? (body as T);

// ─── Expense categories ───────────────────────────────────────────────────────

export async function fetchCategories(schoolId: string): Promise<ExpenseCategory[]> {
  const { data } = await api.get(`${BASE}/expense-categories${qs({ schoolId })}`);
  return unwrap<ExpenseCategory[]>(data) ?? [];
}

export async function createCategory(payload: {
  schoolId: string;
  code:     string;
  label:    string;
  labelFr?: string | null;
}): Promise<ExpenseCategory> {
  const { data } = await api.post(`${BASE}/expense-categories`, payload);
  return unwrap<ExpenseCategory>(data);
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

export async function fetchExpenses(
  schoolId: string,
  opts: { from?: string; to?: string; categoryId?: string } = {}
): Promise<{ rows: Expense[]; total: number }> {
  const { data } = await api.get(`${BASE}/expenses${qs({ schoolId, ...opts })}`);
  const body = data as { data: Expense[]; total: number };
  return { rows: body.data ?? [], total: body.total ?? 0 };
}

export async function recordExpense(payload: {
  schoolId:     string;
  categoryId:   string;
  amount:       number;
  description?: string | null;
  vendor?:      string | null;
  method:       SpendMethod;
  reference?:   string | null;
  incurredAt?:  string;
}): Promise<Expense> {
  const { data } = await api.post(`${BASE}/expenses`, payload);
  return unwrap<Expense>(data);
}

/** Voids never delete — the row stays visible and drops out of the totals. */
export async function voidExpense(
  id: string,
  schoolId: string,
  reason: string
): Promise<Expense> {
  const { data } = await api.post(`${BASE}/expenses/${id}/void`, { schoolId, reason });
  return unwrap<Expense>(data);
}

// ─── Staff ────────────────────────────────────────────────────────────────────

/**
 * Everyone who can be put on payroll.
 *
 * Not /admin/teachers — that returns role "teacher" only, which would leave the
 * head and the bursar off the payroll.
 */
export async function fetchStaff(schoolId: string): Promise<StaffRef[]> {
  const { data } = await api.get(`${BASE}/staff${qs({ schoolId })}`);
  return unwrap<StaffRef[]>(data) ?? [];
}

// ─── Salary structures ────────────────────────────────────────────────────────

export async function fetchSalaryStructures(
  schoolId: string,
  history = false
): Promise<SalaryStructure[]> {
  const { data } = await api.get(
    `${BASE}/salary-structures${qs({ schoolId, history: history ? 1 : undefined })}`
  );
  return unwrap<SalaryStructure[]>(data) ?? [];
}

/**
 * Publish a structure for a staff member.
 *
 * The server closes the previous one at `effectiveFrom - 1ms` rather than
 * overwriting it, so an old payslip still reproduces the figures that were in
 * force when it was issued.
 */
export async function createSalaryStructure(payload: {
  schoolId:      string;
  userId:        string;
  baseAmount:    number;
  allowances:    SalaryComponent[];
  deductions:    SalaryComponent[];
  effectiveFrom: string;
}): Promise<SalaryStructure> {
  const { data } = await api.post(`${BASE}/salary-structures`, payload);
  return unwrap<SalaryStructure>(data);
}

// ─── Payroll ──────────────────────────────────────────────────────────────────

export async function fetchRuns(schoolId: string): Promise<PayrollRun[]> {
  const { data } = await api.get(`${BASE}/payroll${qs({ schoolId })}`);
  return unwrap<PayrollRun[]>(data) ?? [];
}

export async function fetchRun(runId: string, schoolId: string): Promise<PayrollDetail> {
  const { data } = await api.get(`${BASE}/payroll/${runId}${qs({ schoolId })}`);
  return unwrap<PayrollDetail>(data);
}

/** Produces DRAFTS. Nobody is paid until the run is confirmed. */
export async function generateRun(
  schoolId: string,
  periodMonth: string
): Promise<{ run: PayrollRun; message: string }> {
  const { data } = await api.post(`${BASE}/payroll/generate`, { schoolId, periodMonth });
  return data as { run: PayrollRun; message: string };
}

export async function confirmRun(
  runId: string,
  schoolId: string,
  method: SpendMethod
): Promise<{ paid: number }> {
  const { data } = await api.post(`${BASE}/payroll/${runId}/confirm`, { schoolId, method });
  return data as { paid: number };
}

export async function reverseRun(
  runId: string,
  schoolId: string,
  reason: string
): Promise<{ reversed: number }> {
  const { data } = await api.post(`${BASE}/payroll/${runId}/reverse`, { schoolId, reason });
  return data as { reversed: number };
}

// ─── Reports ──────────────────────────────────────────────────────────────────

/**
 * Income against expenditure, plus arrears as they stand.
 *
 * Derived server-side on every call — there is no stored total to go stale.
 */
export async function fetchReport(
  schoolId: string,
  opts: { from?: string; to?: string; academicYear?: string } = {}
): Promise<FinanceReport> {
  const { data } = await api.get(`${BASE}/reports/summary${qs({ schoolId, ...opts })}`);
  return unwrap<FinanceReport>(data);
}
