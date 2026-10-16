// web/src/lib/errorCodes.ts
//
// Refusals the server names with a code, shown in the user's language.
//
// The server's own sentence is English (and written for developers as often
// as for people), so where a response carries one of these codes the screen
// says it from the locale files instead. Anything else falls back to the
// server's text, as before (getErrorMessage in ./axios).

export const ERROR_CODE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  // A published result is never recalculated (docs/39 §21.1, D3).
  PUBLISHED_RESULTS:   "errors.code.PUBLISHED_RESULTS",
  RESULTS_LOCKED:      "errors.code.RESULTS_LOCKED",
  REASON_REQUIRED:     "errors.code.REASON_REQUIRED",
  PROMOTION_RUN_DRAFT: "errors.code.PROMOTION_RUN_DRAFT",
  NO_STRUCTURE:        "errors.code.NO_STRUCTURE",
  RULE_FIXED:          "errors.code.RULE_FIXED",
  PROMOTION_RUN_EXISTS: "errors.code.PROMOTION_RUN_EXISTS",
  CLASS_REQUIRED:      "errors.code.CLASS_REQUIRED",
});

/** The locale key for a response body's code, or null. */
export const errorCodeKey = (data: unknown): string | null => {
  if (!data || typeof data !== "object") return null;
  const code = (data as Record<string, unknown>).code;
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODE_KEYS, code)
    ? ERROR_CODE_KEYS[code]
    : null;
};
