// mobile/src/i18n/useTranslation.js
"use strict";

/**
 * The React binding for i18n-js.
 *
 * i18n-js is a plain object with no React integration: setting `i18n.locale`
 * changes what `t()` returns but re-renders nothing, so a language switch
 * would only take effect on the next navigation. This hook subscribes to the
 * change event and forces a re-render, which is what makes the switch feel
 * immediate.
 *
 * Usage mirrors the web side deliberately:
 *
 *   const { t, locale, setLanguage } = useTranslation();
 *   <Text>{t("dashboard.title")}</Text>
 */

import { useSyncExternalStore, useCallback } from "react";

import {
  i18n,
  onLanguageChange,
  setLanguage as applyLanguage,
  getLanguage,
  currentLocale,
} from "./index";

/**
 * useSyncExternalStore rather than useState + useEffect: it is the API built
 * for exactly this — an external mutable source that React must stay in step
 * with — and it avoids the tearing you get when two components read the
 * locale during the same render as a change.
 */
const subscribe = (cb) => onLanguageChange(cb);

export const useTranslation = () => {
  const language = useSyncExternalStore(subscribe, getLanguage, getLanguage);

  const t = useCallback(
    (key, options) => i18n.t(key, options),
    // `language` is the dependency that matters: it is not read inside t(),
    // but a new identity on change is what lets memoised children update.
    [language]
  );

  const setLanguage = useCallback((code) => applyLanguage(code), []);

  return {
    t,
    language,
    locale: currentLocale(),
    setLanguage,
  };
};

export default useTranslation;
