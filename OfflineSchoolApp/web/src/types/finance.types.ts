// web/src/types/finance.types.ts
//
// Every amount is a whole number of XAF — the franc has no minor unit. Format
// with useFormat().money, which pins fraction digits to zero.

export type SpendMethod = "cash" | "mobile_money" | "bank" | "cheque" | "other";

export interface ExpenseCategory {
  _id:      string;
  schoolId: string;
  code:     string;
  label:    string;
  labelFr?: string | null;
  parentId?: string | null;
  isActive: boolean;
}

export interface Expense {
  _id:          string;
  schoolId:     string;
  categoryId:   string;
  academicYear?: string | null;
  amount:       number;
  description?: string | null;
  vendor?:      string | null;
  method:       SpendMethod;
  reference?:   string | null;
  incurredAt:   string;
  /** Voided rows stay in the list but drop out of every total. */
  voidedAt?:    string | null;
  voidReason?:  string | null;
}

export interface SalaryComponent {
  code:    string;
  label:   string;
  labelFr?: string | null;
  amount:  number;
}

export interface StaffRef {
  _id:   string;
  name:  string;
  email?: string;
  role?: string;
}

export interface SalaryStructure {
  _id:           string;
  schoolId:      string;
  userId:        string;
  baseAmount:    number;
  allowances:    SalaryComponent[];
  deductions:    SalaryComponent[];
  effectiveFrom: string;
  /** Null while this is the row currently in force. */
  effectiveTo:   string | null;
  /** Computed server-side: base + allowances. */
  gross?:        number;
  staff?:        StaffRef | null;
}

export type RunStatus = "draft" | "confirmed" | "reversed";

export interface PayrollRun {
  _id:             string;
  schoolId:        string;
  /** "2026-08" */
  periodMonth:     string;
  status:          RunStatus;
  staffCount:      number;
  totalGross:      number;
  totalDeductions: number;
  totalNet:        number;
  generatedAt?:    string;
  confirmedAt?:    string | null;
  reversedAt?:     string | null;
  reversalReason?: string | null;
}

export interface PayslipLine {
  code:   string;
  label:  string;
  amount: number;
}

export interface Payslip {
  _id:             string;
  userId:          string;
  runId:           string | null;
  periodMonth:     string;
  baseAmount:      number;
  allowances:      PayslipLine[];
  deductions:      PayslipLine[];
  gross:           number;
  totalDeductions: number;
  /** Negative on a reversal, so a plain sum nets corrections off. */
  net:             number;
  status:          "draft" | "paid" | "reversed";
  /** Assigned only on confirmation — a draft has none. */
  payslipNo?:      string | null;
  method?:         SpendMethod;
  paidAt?:         string | null;
  reversesId?:     string | null;
  staff?:          StaffRef | null;
}

export interface PayrollDetail {
  run:      PayrollRun;
  payslips: Payslip[];
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────────────────────

export interface CategorySpend {
  categoryId: string;
  label:      string;
  total:      number;
  count:      number;
}

export interface MonthRow {
  /** "2026-03" */
  month:       string;
  income:      number;
  expenditure: number;
  net:         number;
}

export interface ReportSummary {
  period:      { from: string | null; to: string | null };
  income:      { fees: number; count: number; total: number };
  expenditure: { expenses: number; payroll: number; total: number };
  net:         number;
  byCategory:  CategorySpend[];
  months:      MonthRow[];
}

/**
 * A position, not a flow.
 *
 * Deliberately not bounded by the report period: a debt raised in October is
 * still owed in March, so clipping it to an interval would report it settled.
 */
export interface ArrearsSummary {
  academicYear:   string | null;
  charged:        number;
  waived:         number;
  billed:         number;
  paid:           number;
  outstanding:    number;
  /** Null when nothing has been billed — 0% would be a lie, not a fact. */
  collectionRate: number | null;
}

export interface FinanceReport {
  summary: ReportSummary;
  arrears: ArrearsSummary;
}
