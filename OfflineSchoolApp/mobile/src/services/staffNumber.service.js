// src/services/staffNumber.service.js
"use strict";

/**
 * The signed-in teacher's own staff number, offline.
 *
 * Read from their row in the local users table (the pull mirrors every
 * teacher of the school, staff_no included), falling back to the sign-in
 * payload (auth user.staffNo). A signed-in account is one the server has, so
 * it is never "pending": it has a number or it has "not assigned yet".
 */

import { getDatabase } from "../db/database";
import { staffNoStatus } from "../utils/staffNumber";

/** @returns {Promise<{ kind: "assigned"|"none", value: string|null }>} */
export const loadOwnStaffNo = async (user) => {
  const id = String(user?._id || user?.id || "").trim();
  let row = null;
  if (id) {
    try {
      const db = await getDatabase();
      row = await db.getFirstAsync("SELECT staff_no FROM users WHERE id = ?", [id]);
    } catch { /* no table yet: the sign-in payload below */ }
  }
  const status = staffNoStatus({ id, staffNo: row?.staff_no || user?.staffNo || null, syncedAt: "signed-in" });
  return status.kind === "assigned" ? status : { kind: "none", value: null };
};
