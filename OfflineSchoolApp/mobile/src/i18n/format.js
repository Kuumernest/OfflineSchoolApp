// mobile/src/i18n/format.js
"use strict";

/**
 * Locale-aware formatting, matching web/src/i18n/format.ts.
 *
 *   en-CM  1,234  ·  27/10/2026
 *   fr-CM  1 234  ·  27/10/2026
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

// Dates and times: DD/MM/YYYY and HH:mm (24-hour) in both languages (C7).
// Mobile's copy of shared/dateFormat.js — Metro does not reach outside the app
// folder. Change both together. No Intl, so a Hermes build without ICU writes
// the same thing.
const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, "0");

const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const m = DAY_ONLY.exec(value);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
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

/** 27/10/2026. The locale parameter is kept for callers; it no longer matters. */
export const formatDate = (value) => {
  const d = toDate(value);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : "—";
};

export const formatDateShort = formatDate;

/**
 * A clock time, for a moment where only the time of day is the point.
 *
 * The gate records an instant; a parent reading it wants "07:42", not the date
 * they already know they are looking at. Two digits on the hour so a column of
 * arrivals lines up.
 */
export const formatTime = (value) => {
  const d = toDate(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "—";
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

/** 27/10/2026 14:05. */
export const formatDateTime = (value) => {
  const d = toDate(value);
  return d ? `${formatDate(d)} ${formatTime(d)}` : "—";
};
