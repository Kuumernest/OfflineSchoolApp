/**
 * An Error that carries a translation key alongside an English fallback.
 * `message` stays English so anything still reading err.message keeps
 * working; screens that know about i18nKey render the translated text.
 */
export const appError = (i18nKey, fallback) => {
  const err = new Error(fallback);
  err.i18nKey = i18nKey;
  return err;
};

/**
 * Refusals the server names with a code, said from the locale files: the
 * server's own sentence is English. Anything else falls back as before.
 */
export const SERVER_CODE_KEYS = Object.freeze({
  PUBLISHED_RESULTS:   "serverRefusal.PUBLISHED_RESULTS",
  RESULTS_LOCKED:      "serverRefusal.RESULTS_LOCKED",
  REASON_REQUIRED:     "serverRefusal.REASON_REQUIRED",
  PROMOTION_RUN_DRAFT: "serverRefusal.PROMOTION_RUN_DRAFT",
  NO_STRUCTURE:        "serverRefusal.NO_STRUCTURE",
  RULE_FIXED:          "serverRefusal.RULE_FIXED",
  PROMOTION_RUN_EXISTS: "serverRefusal.PROMOTION_RUN_EXISTS",
  CLASS_REQUIRED:      "serverRefusal.CLASS_REQUIRED",
});

/** Resolve an error to display text, preferring its translation key. */
export const errorText = (t, err, fallbackKey) => {
  if (err?.i18nKey) return t(err.i18nKey);
  const code = err?.response?.data?.code;
  if (typeof code === "string" && Object.prototype.hasOwnProperty.call(SERVER_CODE_KEYS, code)) return t(SERVER_CODE_KEYS[code]);
  if (err?.message) return err.message;
  return fallbackKey ? t(fallbackKey) : "";
};
