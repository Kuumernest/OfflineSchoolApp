// src/utils/staffNumber.js
"use strict";

/**
 * A teacher's staff number (CODE-STF-NNN) as the phone shows it.
 *
 * The number is issued by the SERVER only — when a teacher is created on the
 * console, or when a create made offline on a phone reaches it (and, for
 * teachers from before numbers existed, by the server's backfill). A phone
 * never makes one: two phones numbering offline would hand out the same
 * number twice.
 *
 * So a row is in one of three states:
 *   assigned  it has a number                        → the number
 *   pending   created on this phone, not yet synced  → "pending"
 *   none      the server has it, but no number came  → "not assigned yet"
 *
 * Stored in users.staff_no (an additive column). The teacher's own typed
 * "Staff ID" from older builds (teacher_profiles.staff_id) is kept in its
 * column but no longer shown: the school's number replaced it.
 */

import { isServerGeneratedId } from "./idHelpers";

/**
 * @param {{ id?: string, staffNo?: string|null, staff_no?: string|null,
 *           syncedAt?: string|null, _synced_at?: string|null }|null} row
 * @returns {{ kind: "assigned"|"pending"|"none", value: string|null }}
 */
export const staffNoStatus = (row) => {
  const value = String(row?.staffNo ?? row?.staff_no ?? "").trim();
  if (value) return { kind: "assigned", value };
  const synced = String(row?.syncedAt ?? row?._synced_at ?? "").trim();
  const known  = isServerGeneratedId(row?.id) || Boolean(synced);
  return { kind: row && !known ? "pending" : "none", value: null };
};

/** What to print for a status: the number, or the translated state. */
export const staffNoText = (t, status) =>
  status.kind === "assigned" ? status.value
    : status.kind === "pending" ? t("staffNo.pending")
      : t("staffNo.none");
