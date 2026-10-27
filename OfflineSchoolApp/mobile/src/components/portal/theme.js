// src/components/portal/theme.js
//
// The parent portal's colours and the two ways it says a number. The colours
// are the ones the portal has always used on the phone; the number helpers are
// web/src/pages/portal/format.ts, copied because Metro does not reach outside
// the app folder. Change both together.

export const C = {
  primary:     "#3B4996",
  primaryBg:   "#F0F4FF",
  primaryLine: "#C9D2F0",
  danger:      "#9F2318",
  dangerBg:    "#FDF2F1",
  dangerLine:  "#F2D3CF",
  success:     "#12683A",
  successBg:   "#EEF7F1",
  successLine: "#C3E2D0",
  warning:     "#96570B",
  warningBg:   "#FDF6EC",
  warningLine: "#F0DCBB",
  ink:         "#0D1220",
  inkBody:     "#343D4F",
  inkMuted:    "#4F5A70",
  inkFaint:    "#666F84",
  line:        "#E9EBF0",
  lineStrong:  "#D5D9E2",
  surface:     "#FFFFFF",
  canvas:      "#F4F5F8",
};

/** The smallest thing a thumb is asked to hit. */
export const TAP = 44;

/** "3rd" / "3e": a class position as people say it. */
export function ordinal(n, lang) {
  if (lang?.startsWith("fr")) return n === 1 ? "1er" : `${n}e`;
  try {
    const rule = new Intl.PluralRules("en", { type: "ordinal" }).select(n);
    return `${n}${({ one: "st", two: "nd", few: "rd" })[rule] ?? "th"}`;
  } catch {
    // A Hermes build without ICU.
    const tens = n % 100, ones = n % 10;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${({ 1: "st", 2: "nd", 3: "rd" })[ones] ?? "th"}`;
  }
}

/** A mark on twenty, always two decimals: 14.24. */
export const on20 = (v) => (v == null || Number.isNaN(Number(v)) ? "–" : Number(v).toFixed(2));
