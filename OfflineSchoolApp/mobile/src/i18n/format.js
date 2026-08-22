// mobile/src/i18n/format.js
"use strict";

/**
 * Locale-aware formatting, matching web/src/i18n/format.ts.
 *
 *   en-CM  1,234  ·  21 August 2026
 *   fr-CM  1 234  ·  21 août 2026
 *
 * XAF — the Central African CFA franc — has no minor unit. There are no
 * centimes in circulation, so fraction digits are forced to zero; Intl would
 * otherwise render "1 234,00 F CFA" and imply a precision the currency does
 * not have.
 *
 * Note on Hermes: full ICU is available in Expo SDK 50+, so Intl formats
 * French correctly on device. The try/catch fallbacks below exist because a
 * bare Hermes build without ICU silently formats everything as en-US, and a
 * wrong number is worse than an unformatted one.
 */

import { currentLocale } from "./index";

export const CURRENCY = "XAF";

const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const formatNumber = (value, locale = currentLocale()) => {
  if (!isNum(value)) return "—";
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  } catch {
    return String(Math.round(value));
  }
};

/** A mark or average, where one decimal carries meaning. */
export const formatDecimal = (value, digits = 1, locale = currentLocale()) => {
  if (!isNum(value)) return "—";
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return value.toFixed(digits);
  }
};

export const formatMoney = (amount, locale = currentLocale()) => {
  if (!isNum(amount)) return "—";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: CURRENCY,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount)} FCFA`;
  }
};

export const formatDate = (value, locale = currentLocale()) => {
  const d = toDate(value);
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric", month: "long", year: "numeric",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

export const formatDateShort = (value, locale = currentLocale()) => {
  const d = toDate(value);
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "2-digit", month: "2-digit", year: "numeric",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

/**
 * A payroll period ("2026-03") as a month a person reads.
 *
 * Built from Date.UTC rather than `new Date("2026-03")`, which is parsed as UTC
 * midnight and then rendered in local time — west of Greenwich that lands on
 * the last day of February, so the label names the wrong month.
 */
export const formatMonth = (periodMonth, locale = currentLocale()) => {
  if (!periodMonth) return "—";
  const [y, m] = String(periodMonth).split("-").map(Number);
  if (!y || !m) return String(periodMonth);
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "long", year: "numeric", timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m - 1, 1)));
  } catch {
    return String(periodMonth);
  }
};

export const formatDateTime = (value, locale = currentLocale()) => {
  const d = toDate(value);
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
};
