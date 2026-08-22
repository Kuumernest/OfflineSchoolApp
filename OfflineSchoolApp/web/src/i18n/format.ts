// web/src/i18n/format.ts
//
// Locale-aware formatting. This is the half of bilingual support that gets
// forgotten: translating the labels but leaving the numbers in en-US.
//
//   en-CM  1,234    ·  21 August 2026
//   fr-CM  1 234    ·  21 août 2026
//
// On a fee receipt that difference is not cosmetic — a francophone parent
// reading "1,234" reads one point two three four.

import { useTranslation } from "react-i18next";
import { currentLocale }  from "./index";

/**
 * The school's currency.
 *
 * XAF — the Central African CFA franc — has NO minor unit. There are no
 * centimes in circulation, so amounts are whole francs and fraction digits are
 * forced to zero. Intl would otherwise render "1 234,00 F CFA", implying a
 * precision the currency does not have.
 */
export const CURRENCY = "XAF";

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

const numberFormat = (locale: string, opts: Intl.NumberFormatOptions) => {
  const key = `n:${locale}:${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  // Constructing an Intl formatter is expensive enough that doing it per cell
  // shows up in a long table; they are immutable, so caching is safe.
  if (!f) { f = new Intl.NumberFormat(locale, opts); cache.set(key, f); }
  return f;
};

const dateFormat = (locale: string, opts: Intl.DateTimeFormatOptions) => {
  const key = `d:${locale}:${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) { f = new Intl.DateTimeFormat(locale, opts); cache.set(key, f); }
  return f;
};

const toDate = (value: string | number | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ─── Standalone helpers, for code outside a component ────────────────────────

export const formatNumber = (
  value: number | null | undefined,
  locale = currentLocale()
): string => (typeof value === "number" && Number.isFinite(value)
  ? numberFormat(locale, { maximumFractionDigits: 0 }).format(value)
  : "—");

/** A mark or average, where one decimal is meaningful. */
export const formatDecimal = (
  value: number | null | undefined,
  digits = 1,
  locale = currentLocale()
): string => (typeof value === "number" && Number.isFinite(value)
  ? numberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  : "—");

export const formatMoney = (
  amount: number | null | undefined,
  locale = currentLocale()
): string => (typeof amount === "number" && Number.isFinite(amount)
  ? numberFormat(locale, {
      style: "currency",
      currency: CURRENCY,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)
  : "—");

export const formatDate = (
  value: string | number | Date | null | undefined,
  locale = currentLocale()
): string => {
  const d = toDate(value);
  return d
    ? dateFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(d)
    : "—";
};

export const formatDateShort = (
  value: string | number | Date | null | undefined,
  locale = currentLocale()
): string => {
  const d = toDate(value);
  return d
    ? dateFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(d)
    : "—";
};

export const formatDateTime = (
  value: string | number | Date | null | undefined,
  locale = currentLocale()
): string => {
  const d = toDate(value);
  return d
    ? dateFormat(locale, {
        day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }).format(d)
    : "—";
};

/**
 * A payroll period ("2026-03") as a month a person reads — "March 2026",
 * "mars 2026".
 *
 * Built from Date.UTC rather than `new Date("2026-03")`, which a browser reads
 * as UTC midnight and then renders in local time — west of Greenwich that is
 * the last day of February, so the label names the wrong month.
 */
export const formatMonth = (
  periodMonth: string | null | undefined,
  locale = currentLocale()
): string => {
  if (!periodMonth) return "—";
  const [y, m] = String(periodMonth).split("-").map(Number);
  if (!y || !m) return String(periodMonth);
  return dateFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, 1)));
};

// ─── Hook, for components ────────────────────────────────────────────────────

/**
 * Formatters bound to the active language.
 *
 * Subscribing through useTranslation is what makes a table of amounts
 * re-render when the language changes — a module-level formatter would keep
 * the locale it was first called with until a reload.
 */
export const useFormat = () => {
  const { i18n } = useTranslation();
  const locale =
    SUPPORTED_LOCALES[i18n.resolvedLanguage ?? "en"] ?? "en-CM";

  return {
    locale,
    number:    (v: number | null | undefined) => formatNumber(v, locale),
    decimal:   (v: number | null | undefined, d?: number) => formatDecimal(v, d, locale),
    money:     (v: number | null | undefined) => formatMoney(v, locale),
    date:      (v: string | number | Date | null | undefined) => formatDate(v, locale),
    dateShort: (v: string | number | Date | null | undefined) => formatDateShort(v, locale),
    dateTime:  (v: string | number | Date | null | undefined) => formatDateTime(v, locale),
    monthLabel: (v: string | null | undefined) => formatMonth(v, locale),
  };
};

const SUPPORTED_LOCALES: Record<string, string> = {
  en: "en-CM",
  fr: "fr-CM",
};
