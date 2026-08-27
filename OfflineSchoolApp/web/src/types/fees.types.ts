// web/src/types/fees.types.ts
//
// Every amount here is a whole number of XAF. The Central African CFA franc has
// no minor unit, so there is nothing to store below the franc — and a float in
// a fee balance eventually shows a parent 29999.999999996. Format with
// useFormat().money, which pins fraction digits to zero.

export type PaymentMethod =
  | "cash"
  | "mobile_money"
  | "bank"
  | "cheque"
  | "waiver"
  | "other";

export interface FeeItem {
  code:        string;
  label:       string;
  labelFr?:    string | null;
  amount:      number;
  isOptional?: boolean;
}

/** What happens once the due date passes. */
export interface FeePenalty {
  mode:      "none" | "fixed" | "percent";
  /** XAF when mode is "fixed"; a percentage 1–100 when "percent". */
  amount:    number;
  /** Days after the due date before a late fee may be raised at all. */
  graceDays: number;
}

export interface FeeStructure {
  _id:          string;
  schoolId:     string;
  academicYear: string;
  /** The classes billed. Empty means every class in the school. */
  classIds:     string[];
  /** Null means the whole year is billed in one go. */
  term:         string | null;
  items:        FeeItem[];
  total?:       number;
  /**
   * The last day these fees may be paid without being late. Required on new
   * structures — reminders and late fees are both calculated from it. Null on
   * structures published before the field existed, which simply means there is
   * nothing to chase.
   */
  dueDate:      string | null;
  penalty?:     FeePenalty;
  isActive:     boolean;
  createdAt?:   string;
}

export interface FeeCharge {
  _id:           string;
  studentId:     string;
  academicYear:  string;
  term:          string | null;
  code:          string;
  label:         string;
  amount:        number;
  waivedAmount:  number;
  waiverReason?: string | null;
  voidedAt?:     string | null;
  voidReason?:   string | null;
  createdAt?:    string;
}

export interface FeePayment {
  _id:            string;
  studentId:      string;
  academicYear:   string;
  term:           string | null;
  /** Negative on a reversal, so a plain sum nets correctly. */
  amount:         number;
  method:         PaymentMethod;
  reference?:     string | null;
  receiptNo?:     string | null;
  note?:          string | null;
  receivedAt?:    string;
  /** Set on a correcting row: the payment it cancels. */
  reversesId?:    string | null;
  /** Set on the original once a reversal exists. */
  reversedById?:  string | null;
  reversalReason?: string | null;
  source?:        "web" | "mobile" | "import";
}

/** Never stored — always computed from the ledger. */
export interface FeeTotals {
  charged: number;
  waived:  number;
  paid:    number;
  balance: number;
}

/** One dated amount in an agreed schedule. */
export interface Instalment {
  seq:     number;
  amount:  number;
  dueDate: string;
}

/**
 * An agreement with ONE family to pay across several dates.
 *
 * Changes WHEN the fees are due, never how much is owed — the ledger does not
 * know this exists. Reminders and late fees measure a plan-holder against these
 * dates instead of the fee structure's due date.
 */
export interface PaymentPlan {
  _id:          string;
  studentId:    string;
  academicYear: string;
  term:         string | null;
  instalments:  Instalment[];
  status:       "active" | "completed" | "cancelled";
  reason:       string | null;
  total?:       number;
  finalDueDate?: string | null;
  agreedAt?:    string;
  cancelledAt?: string | null;
  cancelledReason?: string | null;
}

/**
 * Where a family stands against their plan, computed server-side.
 *
 * Cumulative: by the third date they should have paid the first three
 * instalments in total, so paying double early and nothing next is on track.
 * Never recomputed in the browser — the ledger screen and the arrears list must
 * not be able to disagree about whether a family is behind.
 */
export interface PlanStatus {
  dueByNow:    number;
  behindBy:    number;
  isBehind:    boolean;
  nextDue:     string | null;
  nextAmount:  number;
  missedSince: string | null;
  settled:     boolean;
}

export interface StudentFeeAccount {
  charges:  FeeCharge[];
  payments: FeePayment[];
  totals:   FeeTotals;
  /** The active plan, if the family is on one. */
  plan?:       PaymentPlan | null;
  planStatus?: PlanStatus | null;
}

export interface OutstandingRow extends FeeTotals {
  studentId:    string;
  name:         string;
  enrollmentNo: string | null;
  classId:      string | null;
}

export interface OutstandingReport {
  count:            number;
  totalOutstanding: number;
  rows:             OutstandingRow[];
}
