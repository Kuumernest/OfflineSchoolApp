// web/src/pages/portal/format.ts
//
// How the portal says a rank and a mark.

/** "3rd" / "3e": a class position as people say it. */
export function ordinal(n: number, lang: string | undefined): string {
  if (lang?.startsWith("fr")) return n === 1 ? "1er" : `${n}e`;
  const rule = new Intl.PluralRules("en", { type: "ordinal" }).select(n);
  return `${n}${({ one: "st", two: "nd", few: "rd" } as Record<string, string>)[rule] ?? "th"}`;
}

/** A mark on twenty, always two decimals: 14.24/20. */
export const on20 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(2));
