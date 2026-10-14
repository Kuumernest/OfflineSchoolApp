// backend/src/utils/schoolContext.js
"use strict";

const School = require("../db/models/School");
const { ROLES, normalizeRole } = require("../config/roles");

/**
 * What the platform knows about a school, for the door.
 *
 * middleware/auth.js asks two questions of this module on every authenticated
 * request, and both are answered from one cached row read:
 *
 *   Is the caller's OWN school open?  A school the platform has switched off,
 *   or deleted, takes its staff and pupils with it: every request they make is
 *   refused from then on, so a token issued before the switch stops working at
 *   its very next use. No blacklist — the check is this read.
 *
 *   Is the school a super_admin NAMED real?  utils/tenant.js takes that role at
 *   its word about which school a request is for; the word is checked here, and
 *   a mistyped or deleted id is a 404 rather than an empty page that looks like
 *   a real school with nothing in it. A deactivated school IS still found for
 *   them — switching it back on is done from inside.
 *
 * A schoolId that matches no School document at all is reported as unknown,
 * not as closed. That is a dangling reference, not a decision anybody took:
 * fixtures and early deployments hold users whose school was never a row.
 *
 * Cached briefly per process. Every request pays one map lookup rather than a
 * row read for a fact that changes only when a school is created, switched, or
 * deleted — and the routes that do those call invalidateSchool.
 */

const CACHE_TTL_MS = 30_000;

/** id → { at, status | null } */
const cache = new Map();

const looksLikeSchoolId = (v) => /^[a-f\d]{24}$/i.test(String(v));

/**
 * The school's status, or null when there is no such document.
 *
 * @param {unknown} schoolId
 * @returns {Promise<{_id:string,name:string,isActive:boolean,deleted:boolean}|null>}
 */
const lookupSchoolStatus = async (schoolId) => {
  const id = String(schoolId ?? "").trim();
  if (!id) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.status;

  let status = null;
  if (looksLikeSchoolId(id)) {
    const row = await School.findById(id).select("_id name isActive deletedAt").lean();
    if (row) {
      status = {
        _id:      String(row._id),
        name:     row.name,
        isActive: row.isActive !== false,
        deleted:  Boolean(row.deletedAt),
      };
    }
  }

  cache.set(id, { at: Date.now(), status });
  return status;
};

/**
 * The school a super_admin named: exists and is not deleted, or null.
 * Deactivated schools are returned, flagged.
 *
 * @returns {Promise<{_id:string,name:string,isActive:boolean}|null>}
 */
const lookupSchool = async (schoolId) => {
  const status = await lookupSchoolStatus(schoolId);
  if (!status || status.deleted) return null;
  return { _id: status._id, name: status.name, isActive: status.isActive };
};

/**
 * True when this user's own school has been switched off or deleted, so they
 * may not sign in or be served. Never true for a super_admin (no school), nor
 * for a user whose schoolId matches no document.
 */
const isSchoolClosedFor = async (user) => {
  if (!user || !user.schoolId) return false;
  if (normalizeRole(user.role) === ROLES.SUPER_ADMIN) return false;
  const status = await lookupSchoolStatus(user.schoolId);
  return Boolean(status && (status.deleted || !status.isActive));
};

const invalidateSchool = (schoolId) => { cache.delete(String(schoolId ?? "").trim()); };

module.exports = {
  lookupSchool, lookupSchoolStatus, isSchoolClosedFor,
  invalidateSchool, looksLikeSchoolId, CACHE_TTL_MS,
};
