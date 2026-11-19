// shared/compliance.d.ts — types for shared/compliance.js (an ES module).

export type ComplianceStatus = "compliant" | "due" | "non_compliant" | "authorized";
export type PaymentState = "confirmed" | "pending" | "rejected";

export interface ComplianceCharge { amount: number; waivedAmount?: number; dueDate?: string | Date | null; createdAt?: string | Date; voidedAt?: string | Date | null; deletedAt?: string | Date | null }
export interface CompliancePayment { amount: number; receivedAt?: string | Date | null; state?: PaymentState; deletedAt?: string | Date | null }
export interface ComplianceInstalment { seq: number; amount: number; dueDate: string | Date }
export interface CompliancePlan {
  _id?: string; status: string; approvalStatus?: "pending" | "approved" | "rejected" | null;
  instalments: ComplianceInstalment[]; basis?: "total" | "balance" | null; baselinePaid?: number;
  agreedTotal?: number | null; effectiveFrom?: string | Date | null; expiresAt?: string | Date | null; deletedAt?: string | Date | null;
}
export interface GateAuthorizationFacts { _id?: string; validFrom?: string | Date; validUntil: string | Date; reason?: string | null; grantedBy?: string | null; revokedAt?: string | Date | null; deletedAt?: string | Date | null }

export interface ComplianceResult {
  status: ComplianceStatus;
  asOf: Date;
  arrangement: "agreement" | "standard";
  agreementState: "in_force" | "pending_approval" | "rejected" | "outside_dates" | string | null;
  totalFees: number;
  agreedTotal: number | null;
  expectedInstalment: number;
  amountDue: number;
  totalPaid: number;
  outstandingDue: number;
  remainingBalance: number;
  nextDueDate: Date | string | null;
  nextDueAmount: number;
  overdueSince: Date | string | null;
  lastPaymentDate: Date | null;
  schedule: Array<{ seq: number; amount: number; dueDate: Date | string | null; isDue: boolean; paid: number; unpaid: number }>;
  authorization: { _id: string | null; validUntil: string | Date; reason: string | null; grantedBy: string | null } | null;
  pending: { count: number; amount: number; statusIfConfirmed: ComplianceStatus };
  rejected: { count: number; amount: number };
  dependsOnPending: boolean;
  dataAsOf: Date | null;
  stale: boolean;
}

export function compliance(p?: {
  charges?: ComplianceCharge[];
  payments?: CompliancePayment[];
  plan?: CompliancePlan | null;
  authorizations?: GateAuthorizationFacts[] | GateAuthorizationFacts | null;
  asOf?: Date | string;
  dataAsOf?: Date | string | null;
  dueSoonDays?: number;
  staleAfterHours?: number;
}): ComplianceResult;

export function standardSchedule(charges: ComplianceCharge[], asOf: Date): ComplianceInstalment[];
export function authorizationApplies(a: GateAuthorizationFacts | null, asOf: Date): boolean;
export function isPlanApplicable(plan: CompliancePlan | null | undefined, asOf?: Date | string): boolean;
export const STATUS: Readonly<{ COMPLIANT: "compliant"; DUE: "due"; NON_COMPLIANT: "non_compliant"; AUTHORIZED: "authorized" }>;
export const DUE_SOON_DAYS: number;
export const STALE_AFTER_HOURS: number;
