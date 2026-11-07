// web/src/pages/portal/format.ts
//
// How the portal says a rank and a mark.

/** "3rd" / "3e": a class position as people say it. */
export function ordinal(n: number, lang: string | undefined): string {
  if (lang?.startsWith("fr")) return n === 1 ? "1er" : `${n}e`;
  const rule = new Intl.PluralRules("en", { type: "ordinal" }).select(n);
  return `${n}${({ one: "st", two: "nd", few: "rd" } as Record<string, string>)[rule] ?? "th"}`;
}

/** The decimal sign as people write it: a comma in French (14,24), a point in English. */
const decimalSign = (s: string, lang: string | undefined) => (lang?.startsWith("fr") ? s.replace(".", ",") : s);

/** An average on twenty, always two decimals: 14.24 / 14,24. */
export const on20 = (v: number | null | undefined, lang: string | undefined) =>
  (v == null ? "–" : decimalSign(v.toFixed(2), lang));

/** A subject's mark as the school sent it, at its own precision: 12.5 / 12,5. */
export const mark = (v: number | null | undefined, lang: string | undefined) =>
  (v == null ? "–" : decimalSign(String(v), lang));
