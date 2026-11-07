// web/src/utils/percentShares.ts

/**
 * Whole-number percentages that add up to exactly 100.
 *
 * Rounding each share on its own does not: three equal parts round to
 * 33 + 33 + 33 = 99, and a legend that reads 99% of a whole looks like it
 * has lost something. The largest-remainder method floors every share, then
 * gives the leftover points to the shares that lost the most in flooring.
 *
 * All zeros when the total is zero, so an empty chart reads 0%, not NaN%.
 */
export function percentShares(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);

  const raw    = values.map((v) => (v / total) * 100);
  const floors = raw.map(Math.floor);
  let left     = 100 - floors.reduce((a, b) => a + b, 0);

  const order = raw
    .map((r, i) => ({ i, rem: r - floors[i] }))
    .sort((a, b) => b.rem - a.rem);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}
