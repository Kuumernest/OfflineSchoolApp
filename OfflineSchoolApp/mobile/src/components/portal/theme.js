// src/components/portal/theme.js
//
// The parent portal's colours and the two ways it says a number. The brand
// blue, the neutrals and the status colours come from the app's theme
// (src/theme/colors.js) so the portal is the same blue, grey, green, amber and
// red as everything else; section accents (fees teal, attendance green,
// results slate, messages sky) come from ACCENT. The number helpers are
// web/src/pages/portal/format.ts, copied because Metro does not reach outside
// the app folder. Change both together.

import { COLORS, SEMANTIC } from "../../theme/colors";

export const C = {
  primary:     COLORS.primary,
  primaryBg:   COLORS.primaryLight,
  primaryLine: COLORS.contextBorder,
  danger:      SEMANTIC.error.text,
  dangerBg:    SEMANTIC.error.bg,
  dangerLine:  SEMANTIC.error.box,
  success:     SEMANTIC.success.text,
  successBg:   SEMANTIC.success.bg,
  successLine: SEMANTIC.success.box,
  warning:     SEMANTIC.warning.text,
  warningBg:   SEMANTIC.warning.bg,
  warningLine: SEMANTIC.warning.box,
  ink:         COLORS.text,
  inkBody:     COLORS.textSecondary,
  inkMuted:    COLORS.textSecondary,
  inkFaint:    COLORS.textSubtle,
  line:        COLORS.border,
  lineStrong:  COLORS.border,
  surface:     COLORS.surface,
  canvas:      COLORS.page,
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

/** The decimal sign as people write it: a comma in French (14,24), a point in English. */
const decimalSign = (s, lang) => (lang?.startsWith("fr") ? s.replace(".", ",") : s);

/** An average on twenty, always two decimals: 14.24 / 14,24. */
export const on20 = (v, lang) =>
  (v == null || Number.isNaN(Number(v)) ? "–" : decimalSign(Number(v).toFixed(2), lang));

/** A subject's mark as the school sent it, at its own precision: 12.5 / 12,5. */
export const mark = (v, lang) =>
  (v == null || Number.isNaN(Number(v)) ? "–" : decimalSign(String(Number(v)), lang));
