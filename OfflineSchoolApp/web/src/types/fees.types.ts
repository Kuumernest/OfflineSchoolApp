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

export interface StudentFeeAccount {
  charges:  FeeCharge[];
  payments: FeePayment[];
  totals:   FeeTotals;
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
