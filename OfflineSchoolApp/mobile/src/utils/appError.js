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

/** Resolve an error to display text, preferring its translation key. */
export const errorText = (t, err, fallbackKey) => {
  if (err?.i18nKey) return t(err.i18nKey);
  if (err?.message) return err.message;
  return fallbackKey ? t(fallbackKey) : "";
};
