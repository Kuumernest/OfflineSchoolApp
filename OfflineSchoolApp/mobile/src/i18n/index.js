// mobile/src/i18n/index.js
"use strict";

/**
 * Bilingual support for the phone app.
 *
 * Offline-first constraints shape every decision here:
 *
 *   Translations are imported, not fetched. They land in the JS bundle, so a
 *   phone that has never had signal since install still opens in the right
 *   language. No remote locale loading, ever — that is the pattern that leaves
 *   a field user staring at raw keys.
 *
 *   The initial language is resolved synchronously from the device locale, so
 *   the very first frame is already correct. The stored override is applied
 *   asynchronously right after; AsyncStorage cannot be read synchronously, and
 *   a brief English flash for a francophone user would be worse than reading
 *   the device setting first.
 *
 * The key tree is identical to web/src/i18n/locales. Keep them in step —
 * `npm run i18n:check` in the web package compares en/fr, and the same key
 * names are what let a string be written once and used on both sides.
 */

import { I18n }        from "i18n-js";
import * as Localization from "expo-localization";

import { getItem, setItem } from "../services/storage.service";

import en from "./locales/en.json";
import fr from "./locales/fr.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English",  locale: "en-CM" },
  { code: "fr", label: "Français", locale: "fr-CM" },
];

const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
const FALLBACK        = "en";

export const LANGUAGE_STORAGE_KEY = "school.language";

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE
// ─────────────────────────────────────────────────────────────────────────────

export const i18n = new I18n({ en, fr });

i18n.defaultLocale = FALLBACK;
i18n.enableFallback = true;   // a missing French key falls back to English
                              // rather than rendering "[missing …]" to a user

/**
 * Reduce a device locale to a language we ship.
 * "fr-CM", "fr_FR", "fr" all become "fr"; anything else becomes English.
 */
const normalise = (tag) => {
  const code = String(tag || "").toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_CODES.includes(code) ? code : FALLBACK;
};

/** The device's preferred language, read synchronously at import time. */
const deviceLanguage = () => {
  try {
    const locales = Localization.getLocales?.() ?? [];
    for (const l of locales) {
      const code = normalise(l.languageCode || l.languageTag);
      // Only accept a locale we actually ship; otherwise keep looking down
      // the user's preference list before giving up on English.
      if (SUPPORTED_CODES.includes(code) && code !== FALLBACK) return code;
      if (code === FALLBACK) return FALLBACK;
    }
  } catch {
    // Localization is unavailable in some test environments.
  }
  return FALLBACK;
};

// Correct on the first frame; possibly replaced a tick later by the stored
// override in loadStoredLanguage().
i18n.locale = deviceLanguage();

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

const listeners = new Set();

/** Subscribe to language changes. Returns an unsubscribe function. */
export const onLanguageChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const notify = () => { for (const fn of listeners) { try { fn(i18n.locale); } catch { /* a bad listener must not break the switch */ } } };

/**
 * Apply the user's saved choice, if there is one.
 * Call once during app startup, after storage is available.
 */
export const loadStoredLanguage = async () => {
  try {
    const saved = await getItem(LANGUAGE_STORAGE_KEY);
    if (saved && SUPPORTED_CODES.includes(saved) && saved !== i18n.locale) {
      i18n.locale = saved;
      notify();
    }
  } catch {
    // Keep the device-derived language.
  }
  return i18n.locale;
};

/** Change language and remember it across launches. */
export const setLanguage = async (code) => {
  const next = SUPPORTED_CODES.includes(code) ? code : FALLBACK;
  if (next === i18n.locale) return next;

  i18n.locale = next;
  notify();

  try {
    await setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // The switch still applies for this session even if it cannot be saved.
  }
  return next;
};

export const getLanguage = () => i18n.locale;

/** BCP-47 locale for Intl — not the same thing as the i18n language code. */
export const currentLocale = () =>
  SUPPORTED_LANGUAGES.find((l) => l.code === i18n.locale)?.locale ?? "en-CM";

// ─────────────────────────────────────────────────────────────────────────────
// TRANSLATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * t("dashboard.title")
 * t("dashboard.recordsToday", { count: 3 })
 *
 * i18n-js pluralises on `count` the same way the web side does, so a string
 * written once works in both apps.
 */
export const t = (key, options) => i18n.t(key, options);

export default i18n;
