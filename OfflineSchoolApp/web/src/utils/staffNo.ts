// web/src/utils/staffNo.ts
//
// A teacher's staff number (CODE-STF-NNN) as an administrator types it.
//
// The server issues the number (backend services/staffNumber.service.js) and
// is the judge of an override; these are its rules (normaliseStaffNo), checked
// here first so the administrator is told before a round trip.

export const STAFF_NO_MAX = 32;

/** As the server will store it: trimmed, upper-cased. */
export const normaliseStaffNoInput = (raw: string): string => raw.trim().toUpperCase();

/** The i18n key of what is wrong with a (normalised) number, or null. */
export const staffNoErrorKey = (value: string): string | null => {
  if (!value) return "teachersEdit.errStaffNoRequired";
  if (value.length > STAFF_NO_MAX) return "teachersEdit.errStaffNoTooLong";
  if (!/^[A-Z0-9][A-Z0-9\-/._]*$/.test(value)) return "teachersEdit.errStaffNoChars";
  return null;
};
