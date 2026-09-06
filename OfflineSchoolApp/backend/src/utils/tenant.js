// backend/src/utils/tenant.js
"use strict";

/**
 * Which school a request is allowed to be about.
 *
 * Seventeen routers already carried a private copy of this rule, and the three
 * that did not — academicStructure, termResults, annualResults — took schoolId
 * off the query string and used it as given. With data in two schools, a pupil
 * of one could read the other's whole term-results table by changing a
 * parameter, and rewrite the other's academic structure, which is where
 * passMark and promotionThreshold live.
 *
 * A copied rule is a rule that gets missed on the next router. This is the one
 * copy.
 *
 * The rule itself: a super_admin may name a school and is taken at their word,
 * because operating across schools is what the role is for. Everybody else is
 * their own school, whatever they asked for. Not an error — silently correcting
 * is right here, because a client legitimately sends its own schoolId on every
 * request and refusing would break all of them; the point is only that the
 * value cannot be used to reach further than the caller.
 */

/**
 * @param {import("express").Request} req
 * @param {string} [provided] an explicit candidate, e.g. req.params.schoolId
 * @returns {string|null} the school this request may read and write
 */
const resolveSchoolId = (req, provided) => {
  const asked =
    provided ??
    req.body?.schoolId ??
    req.query?.schoolId ??
    req.params?.schoolId;

  if (req.user?.role === "super_admin" && asked) return String(asked).trim();

  const own = req.user?.schoolId ?? req.portal?.schoolId ?? null;
  return own ? String(own) : null;
};

/**
 * True when the caller named a school that is not theirs.
 *
 * Reads are corrected silently by resolveSchoolId, which is the right default.
 * A write is different: quietly redirecting an update to a different school
 * than the URL named would be its own kind of wrong, so writes should refuse
 * instead. Use this to decide.
 */
const namedAnotherSchool = (req, provided) => {
  const asked = provided ?? req.params?.schoolId ?? req.body?.schoolId;
  if (!asked) return false;
  if (req.user?.role === "super_admin") return false;
  const own = req.user?.schoolId ?? req.portal?.schoolId ?? null;
  return own != null && String(asked).trim() !== String(own);
};

module.exports = { resolveSchoolId, namedAnotherSchool };
