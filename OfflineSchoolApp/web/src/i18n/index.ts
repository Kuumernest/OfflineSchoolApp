// web/src/i18n/index.ts
//
// Cameroon is bilingual, so this is a requirement rather than a nicety, and it
// is cheapest to stand up before the remaining screens are written.
//
// Two rules for anyone adding strings after this:
//
//   1. en.json and fr.json must keep the SAME key tree. A key present in one
//      and missing from the other silently falls back to English, which reads
//      as a bug to a francophone user rather than as a missing translation.
//      `npm run i18n:check` compares them.
//
//   2. Academic terms come from academic.* and are not free translation.
//      "Matricule", "Moyenne", "Appréciation", "Rang", "Redouble" are the
//      terms a Cameroonian francophone school actually uses on a bulletin;
//      a literal translation of the English produces something no parent
//      recognises.

import i18n                from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector     from "i18next-browser-languagedetector";

import en from "./locales/en.json";
import fr from "./locales/fr.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English",  locale: "en-CM" },
  { code: "fr", label: "Français", locale: "fr-CM" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/** Where the chosen language is remembered. Shared with the detector below. */
export const LANGUAGE_STORAGE_KEY = "school.language";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      fr: { translation: fr },
    },
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),

    // "fr-CM" and "fr-FR" both resolve to the "fr" bundle. Without this a
    // browser reporting a regional locale finds no resources and silently
    // falls back to English.
    load: "languageOnly",

    detection: {
      // An explicit choice outranks the browser, and survives a reload.
      order:  ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },

    interpolation: {
      // React escapes for us; letting i18next escape as well double-encodes
      // any apostrophe, which French has in almost every other string.
      escapeValue: false,
    },

    returnEmptyString: false,
  });

/**
 * Keep <html lang> in step with the language the app is actually showing.
 *
 * index.html ships lang="en" and nothing updated it, so a French console still
 * announced itself as English. Two things follow from that, and the second is
 * the one that broke a screen:
 *
 *   a screen reader reads French text with an English voice, and
 *
 *   the browser offers to translate a page it believes is in the wrong
 *     language. Accepting rewrites every text node under React — Google
 *     Translate wraps them in <font> elements — and the next render that
 *     touches one throws "insertBefore ... is not a child of this node",
 *     after the save it was rendering has already succeeded.
 *
 * translate="no" in index.html is the guard; this is the reason the browser
 * should not have been asking in the first place.
 */
const syncDocumentLanguage = (lng?: string) => {
  if (typeof document === "undefined") return;
  const code = (lng || i18n.resolvedLanguage || "en").split("-")[0];
  document.documentElement.setAttribute("lang", code);
};

syncDocumentLanguage();
i18n.on("languageChanged", syncDocumentLanguage);

/** The BCP-47 locale for the active language — for Intl, not for i18next. */
export const currentLocale = (): string =>
  SUPPORTED_LANGUAGES.find((l) => l.code === i18n.resolvedLanguage)?.locale ??
  "en-CM";

export default i18n;
