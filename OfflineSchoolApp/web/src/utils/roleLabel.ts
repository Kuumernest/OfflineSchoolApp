// web/src/utils/roleLabel.ts
//
// The name a role is shown under, in the reader's language.
//
// The stored value — "school_admin", see backend/src/config/roles.js — is a
// key the API and the sync feed agree on and is never translated. What a
// person reads is a different thing. The sidebar footer and the profile menu
// used to print the stored value with its underscore swapped for a space and
// CSS capitalising each word, which reads "School Admin" whatever language
// the console is set to. The settings page had the translated map below; the
// two rails did not know it existed. One map, used everywhere a role is
// shown, so a francophone admin reads "Administrateur de l'établissement" in
// every corner of the console and not only on the staff table.
//
// "admin" is not a role the API will store, but a school whose database
// predates the enum could still hold a row saying it, and a badge reading
// "Admin" is better than one reading nothing.

import type { TFunction } from "i18next";

export const ROLE_LABEL_KEYS: Record<string, string> = {
  super_admin:  "settings.roleSuperAdmin",
  school_admin: "settings.schoolAdmin",
  bursar:       "settings.roleBursar",
  admin:        "settings.roleAdmin",
  teacher:      "academic.teacher",
  student:      "academic.student",
};

/** The visible name for a role, falling back to the raw value we were sent. */
export const roleLabel = (role: string | undefined, t: TFunction): string => {
  const key = ROLE_LABEL_KEYS[role ?? ""];
  return key ? t(key) : (role ?? "");
};
