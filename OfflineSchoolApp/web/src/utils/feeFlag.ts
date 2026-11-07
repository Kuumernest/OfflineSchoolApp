// web/src/utils/feeFlag.ts
//
// The fee line on Students to watch: what a family owes, and how much of it
// is overdue — the Fees page's two figures, never one printed as the other.
//
// It used to read "Owes FCFA 145,000 (overdue)" for a family whose Fees page
// row said 145,000 owed, 50,000 overdue. The server now sends both
// (earlyWarning.service, from arrears.service like the Fees page).
//
// Imports nothing, so scripts/check-fee-flag.mjs can run it as it is.

/**
 * How much of a balance is overdue, in words: some of it, all of it, or not
 * known (a reply without the overdue figure — never guessed as "all").
 */
export function overdueShare(balance: number, overdue: unknown): "part" | "all" | "unknown" {
  if (overdue == null || overdue === "" || !Number.isFinite(Number(overdue))) return "unknown";
  return Number(overdue) >= balance ? "all" : "part";
}

export interface FeeFlag {
  /** The i18n key under watch.sig. */
  key:    "fees_outstanding" | "fees_outstanding_all" | "fees_owed";
  balance: number;
  overdue: number | null;
}

/**
 * Which sentence, from the signal's numbers.
 *
 *   part overdue  → "Owes 145,000, of which 50,000 is overdue"
 *   all overdue   → "Owes 60,000, all of it overdue"
 *   no overdue figure (a reply without one) → "Owes 145,000" — never a
 *   balance called overdue
 */
export function feeFlag(data: Record<string, number | string | null | undefined>): FeeFlag {
  const balance = Number(data.balance ?? 0);
  const share   = overdueShare(balance, data.overdue);
  if (share === "unknown") return { key: "fees_owed", balance, overdue: null };
  return {
    key: share === "all" ? "fees_outstanding_all" : "fees_outstanding",
    balance,
    overdue: Number(data.overdue),
  };
}
