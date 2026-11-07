// OfflineSchoolApp/shared/studentValidation.js
"use strict";

/**
 * What a pupil's record must satisfy when it is typed in (B3, decided
 * 2026-10-27). Pure. The server routes and the desktop mirror call it; the web
 * form carries a copy (web/src/utils/studentValidation.ts) because the bundler
 * does not take CommonJS from outside node_modules — change both together.
 *
 *   - A date of birth is a real YYYY-MM-DD date, not in the future. (Refused.)
 *   - An age outside the class level's range is WARNED about, never refused —
 *     a pupil repeating, or skipped ahead, is real. Form 1 is 9–14; each level
 *     up the minimum rises one year and the maximum two (Upper Sixth 15–26).
 *     A school may set its own ranges per level.
 *   - A Cameroon phone number is stored one way: +237 and nine digits. A
 *     foreign number written with its own +code is kept as typed.
 */

// ── Date of birth ────────────────────────────────────────────────────────────

/** @returns {{ value: string|null } | { error: string }} */
function checkDateOfBirth(raw, now = new Date()) {
  if (raw == null || raw === "") return { value: null };
  // A Date or an ISO timestamp from an older client: its calendar date.
  const v = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: "dateOfBirth must be in YYYY-MM-DD format" };
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    return { error: "dateOfBirth is not a real date" };
  }
  if (d.getTime() > now.getTime()) return { error: "dateOfBirth cannot be in the future" };
  return { value: v };
}

/** Whole years between a YYYY-MM-DD birth date and `now`. */
function ageOn(dob, now = new Date()) {
  const [y, m, d] = String(dob).split("-").map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
}

// ── Class level and its age range ────────────────────────────────────────────

/**
 * The secondary level a class name states, 1 (Form 1 / 6e) to 7 (Upper Sixth
 * / Terminale), or null. Class.level is blank on real classes, so the name is
 * what there is. "Form 1A", "FORM ONE", "Lower Sixth Arts", "6ème", "Tle C".
 */
function levelOfClassName(name) {
  const n = String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (!n) return null;
  if (/\bupper\s*(6|six)/.test(n) || /^(tle|terminale)\b/.test(n)) return 7;
  if (/\blower\s*(6|six)/.test(n) || /^(1ere|1re|premiere)\b/.test(n)) return 6;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  // "Form 5B": the stream letter may follow the number; "Form 10" is no level.
  const form = /\bform\s*(one|two|three|four|five|\d+)/.exec(n);
  if (form) {
    const k = words[form[1]] ?? Number(form[1]);
    return k >= 1 && k <= 5 ? k : null;
  }
  const fr = /^(\d)\s*(e|eme)\b/.exec(n);
  if (fr) return { 6: 1, 5: 2, 4: 3, 3: 4 }[fr[1]] ?? null;
  if (/^(2nde|2de|seconde)\b/.test(n)) return 5;
  return null;
}

/** The decided default range for a level: Form 1 9–14, then +1 / +2 a level. */
const defaultAgeRange = (level) => ({ min: 9 + (level - 1), max: 14 + 2 * (level - 1) });

/**
 * @param {string} className
 * @param {object} [overrides]  a school's own { [level]: { min, max } }
 */
function ageRangeFor(className, overrides = null) {
  const level = levelOfClassName(className);
  if (!level) return null;
  const own = overrides?.[level] ?? overrides?.[String(level)];
  const def = defaultAgeRange(level);
  const min = Number.isFinite(Number(own?.min)) ? Number(own.min) : def.min;
  const max = Number.isFinite(Number(own?.max)) ? Number(own.max) : def.max;
  return { level, min, max };
}

/**
 * A warning when a pupil's age is outside their class level's range, or null.
 * @returns {null | { code: "age_out_of_range", age, min, max, className, message }}
 */
function ageWarning(dob, className, overrides = null, now = new Date()) {
  const ok = checkDateOfBirth(dob, now);
  if (!ok.value) return null;
  const range = ageRangeFor(className, overrides);
  if (!range) return null;
  const age = ageOn(ok.value, now);
  if (age >= range.min && age <= range.max) return null;
  return {
    code: "age_out_of_range", age, min: range.min, max: range.max, className: className ?? null,
    message: `Age ${age} is outside the usual ${range.min}–${range.max} for ${className}. Check the date of birth.`,
  };
}

// ── Phone ────────────────────────────────────────────────────────────────────

/**
 * A Cameroon number as +237 and nine digits: "677 12 34 56", "00237677123456",
 * "+237-677-123-456" → "+237677123456". Nine digits starting 6 (mobile) or 2
 * (fixed line). A number with another country's +code is kept, spaces taken out.
 *
 * @returns {{ value: string|null } | { error: string }}
 */
function normalisePhone(raw, field = "phone") {
  if (raw == null || String(raw).trim() === "") return { value: null };
  const typed = String(raw).trim();
  let digits = typed.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (digits.startsWith("+") && !digits.startsWith("+237")) {
    const rest = digits.slice(1).replace(/\D/g, "");
    return rest.length >= 7 && rest.length <= 15 ? { value: `+${rest}` } : { error: `${field} is not a valid phone number` };
  }
  digits = digits.replace(/\D/g, "");
  if (digits.startsWith("237") && digits.length === 12) digits = digits.slice(3);
  if (/^[26]\d{8}$/.test(digits)) return { value: `+237${digits}` };
  return { error: `${field} must be a Cameroon number: 9 digits starting with 6 or 2 (e.g. 677 12 34 56)` };
}

const PHONE_FIELDS = ["phone", "alternatePhone", "guardianPhone", "parentPhone"];

/**
 * Check what a create or edit carries: refusals in `errors`, the stored forms
 * in `values`, the age warning (if a class name is known) in `warnings`.
 */
function checkStudentInput(body, { className = null, ageRanges = null, now = new Date() } = {}) {
  const errors = [], values = {}, warnings = [];
  if (body && "dateOfBirth" in body) {
    const r = checkDateOfBirth(body.dateOfBirth, now);
    if (r.error) errors.push(r.error); else values.dateOfBirth = r.value;
  }
  for (const f of PHONE_FIELDS) {
    if (!body || !(f in body)) continue;
    const r = normalisePhone(body[f], f);
    if (r.error) errors.push(r.error); else values[f] = r.value;
  }
  if (!errors.length && values.dateOfBirth && className) {
    const w = ageWarning(values.dateOfBirth, className, ageRanges, now);
    if (w) warnings.push(w);
  }
  return { errors, values, warnings };
}

/**
 * A school's own age ranges as Settings sends them: { "1": { min, max }, … }
 * for levels 1–7, whole years 3–40, min ≤ max. Null resets to the defaults.
 * @returns {{ value: object|null } | { error: string }}
 */
function checkAgeRanges(raw) {
  if (raw == null) return { value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "studentAgeRanges must be an object by level" };
  const out = {};
  for (const [k, r] of Object.entries(raw)) {
    const level = Number(k);
    if (!Number.isInteger(level) || level < 1 || level > 7) return { error: `studentAgeRanges: unknown level ${k}` };
    const min = Number(r?.min), max = Number(r?.max);
    if (![min, max].every((n) => Number.isInteger(n) && n >= 3 && n <= 40) || min > max) {
      return { error: `studentAgeRanges: level ${k} needs whole years 3–40 with min ≤ max` };
    }
    out[String(level)] = { min, max };
  }
  return { value: Object.keys(out).length ? out : null };
}

module.exports = {
  checkAgeRanges,
  checkDateOfBirth, ageOn, levelOfClassName, defaultAgeRange, ageRangeFor, ageWarning,
  normalisePhone, checkStudentInput, PHONE_FIELDS,
};
