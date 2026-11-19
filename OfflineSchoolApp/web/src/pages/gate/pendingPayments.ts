// web/src/pages/gate/pendingPayments.ts
//
// Payments this desktop has recorded and the server has not yet accepted.
//
// The engine never counts them as paid, but the operator should know they
// exist: "would be compliant once the 50,000 recorded here is confirmed" is a
// different conversation at the gate from "owes 50,000". In a browser there is
// no outbox, so this is always empty there (fetchUnconfirmedPaymentIds answers
// [] without asking anything).
//
// Only for a caller who also holds fees.view: the pupil's ledger is read through
// GET /fees/students/:id, which the desktop answers from its local copy.

import type { CompliancePayment } from "../../../../shared/compliance.js";
import { fetchStudentAccount, fetchUnconfirmedPaymentIds } from "@/services/fee.service";

/** The gate must not wait on this: past the budget, it shows without it. */
const BUDGET_MS = 2500;

const withBudget = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), BUDGET_MS))]);

export async function desktopPendingPayments(
  schoolId: string, studentId: string, academicYear: string | null,
): Promise<CompliancePayment[]> {
  try {
    const ids = new Set(await withBudget(fetchUnconfirmedPaymentIds(), [] as string[]));
    if (!ids.size) return [];
    const account = await withBudget(
      fetchStudentAccount(studentId, schoolId, academicYear ?? undefined),
      null,
    );
    return (account?.payments ?? [])
      .filter((p) => ids.has(String(p._id)))
      .map((p) => ({ amount: Number(p.amount) || 0, receivedAt: p.receivedAt ?? null, state: "pending" as const }));
  } catch {
    // No local ledger for this pupil: no pending list, never a failed scan.
    return [];
  }
}
