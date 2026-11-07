// web/src/utils/studentValidation.ts
//
// The form's copy of shared/studentValidation.js (B3) — the bundler does not
// take CommonJS from outside node_modules. The server re-checks everything;
// this only lets the form say so before the round trip. Change both together.

export type AgeRanges = Record<string, { min: number; max: number }> | null;

/** "" for a valid (or blank) date of birth, else the reason. */
export function dobError(v: string, now = new Date()): string {
  if (!v) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "dateOfBirth must be in YYYY-MM-DD format";
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return "dateOfBirth is not a real date";
  if (d.getTime() > now.getTime()) return "dateOfBirth cannot be in the future";
  return "";
}

export function ageOn(dob: string, now = new Date()): number {
  const [y, m, d] = dob.split("-").map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** Form 1 / 6e = 1 … Upper Sixth / Terminale = 7, or null. */
export function levelOfClassName(name: string | null | undefined): number | null {
  const n = String(name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (!n) return null;
  if (/\bupper\s*(6|six)/.test(n) || /^(tle|terminale)\b/.test(n)) return 7;
  if (/\blower\s*(6|six)/.test(n) || /^(1ere|1re|premiere)\b/.test(n)) return 6;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const form = /\bform\s*(one|two|three|four|five|\d+)/.exec(n);
  if (form) {
    const k = words[form[1]] ?? Number(form[1]);
    return k >= 1 && k <= 5 ? k : null;
  }
  const fr = /^(\d)\s*(e|eme)\b/.exec(n);
  if (fr) return ({ 6: 1, 5: 2, 4: 3, 3: 4 } as Record<string, number>)[fr[1]] ?? null;
  if (/^(2nde|2de|seconde)\b/.test(n)) return 5;
  return null;
}

/** Form 1 9–14; each level up the minimum +1 and the maximum +2. */
export const defaultAgeRange = (level: number) => ({ min: 9 + (level - 1), max: 14 + 2 * (level - 1) });

export function ageRangeFor(className: string | null | undefined, overrides: AgeRanges = null) {
  const level = levelOfClassName(className);
  if (!level) return null;
  const own = overrides?.[String(level)];
  const def = defaultAgeRange(level);
  return { level, min: own?.min ?? def.min, max: own?.max ?? def.max };
}

/** The out-of-range age, or null. A warning only — the form still saves. */
export function ageWarning(dob: string, className: string | null | undefined, overrides: AgeRanges = null, now = new Date()) {
  if (!dob || dobError(dob, now)) return null;
  const r = ageRangeFor(className, overrides);
  if (!r) return null;
  const age = ageOn(dob, now);
  return age >= r.min && age <= r.max ? null : { age, min: r.min, max: r.max };
}

/** +237 and nine digits; a foreign +code kept. `error` when neither. */
export function normalisePhone(raw: string): { value: string | null; error?: string } {
  const typed = raw.trim();
  if (!typed) return { value: null };
  let digits = typed.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  if (digits.startsWith("+") && !digits.startsWith("+237")) {
    const rest = digits.slice(1).replace(/\D/g, "");
    return rest.length >= 7 && rest.length <= 15 ? { value: `+${rest}` } : { value: null, error: "invalid" };
  }
  digits = digits.replace(/\D/g, "");
  if (digits.startsWith("237") && digits.length === 12) digits = digits.slice(3);
  return /^[26]\d{8}$/.test(digits) ? { value: `+237${digits}` } : { value: null, error: "invalid" };
}
