// backend/src/utils/schoolContext.js
"use strict";

const School = require("../db/models/School");

/**
 * The school a super_admin has named, checked.
 *
 * utils/tenant.js takes a super_admin at their word about which school a
 * request is about — that is what the role is for. Until now nothing checked
 * the word itself, so a mistyped or stale id was answered with an empty page
 * that looked exactly like a real school with nothing in it. middleware/auth.js
 * calls this once per request that names a school and refuses with a 404 when
 * there is no such school, or it has been deleted.
 *
 * Deactivated schools are still found. Switching one back on is done from
 * inside it, and the figures of a school that has closed are still figures.
 * The flag travels on the result so a route (or the client) can say so.
 *
 * Cached for a short while per process: a super_admin's every request names a
 * school, and one row read per request is a price worth avoiding for a fact
 * that changes when a school is created or switched off — both of which
 * invalidate here.
 */

const CACHE_TTL_MS = 30_000;

/** id → { at, school | null } */
const cache = new Map();

const looksLikeSchoolId = (v) => /^[a-f\d]{24}$/i.test(String(v));

/**
 * @param {unknown} schoolId
 * @returns {Promise<{_id:string,name:string,isActive:boolean}|null>}
 */
const lookupSchool = async (schoolId) => {
  const id = String(schoolId ?? "").trim();
  if (!id) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.school;

  let school = null;
  if (looksLikeSchoolId(id)) {
    const row = await School.findOne({ _id: id, ...School.notDeletedClause() })
      .select("_id name isActive")
      .lean();
    if (row) {
      school = { _id: String(row._id), name: row.name, isActive: row.isActive !== false };
    }
  }

  cache.set(id, { at: Date.now(), school });
  return school;
};

const invalidateSchool = (schoolId) => { cache.delete(String(schoolId ?? "").trim()); };

module.exports = { lookupSchool, invalidateSchool, looksLikeSchoolId, CACHE_TTL_MS };
