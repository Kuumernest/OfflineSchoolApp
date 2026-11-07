// mobile/src/utils/overdueShare.js
//
// How much of a balance is overdue, in words: some of it, all of it, or not
// known. The portal used to colour a whole balance "Overdue" when only part
// of it was late (145,000 owed, 50,000 overdue). Same rule as the web's
// web/src/utils/feeFlag.ts overdueShare — a reply without the overdue figure
// is "unknown", never guessed as "all".

export function overdueShare(balance, overdue) {
  if (overdue == null || overdue === "" || !Number.isFinite(Number(overdue))) return "unknown";
  return Number(overdue) >= Number(balance) ? "all" : "part";
}
