// backend/middleware/permissions.js
"use strict";

/**
 * Permission guards.
 *
 * The companion to authorize() in middleware/auth.js, and the one to reach for
 * from now on. authorize() asks who somebody is; these ask what they may do,
 * which is the question a route actually has — and it is the only form a school
 * can adjust, because config/permissions.js defaults are overridable per school
 * and a hard-coded role list is not.
 *
 * Both remain valid. A handful of guards stay on authorize() because the thing
 * they protect is genuinely about identity rather than capability: "is this my
 * own record", "is this the student surface".
 */

const permissions = require("../src/services/permissions.service");
const { isPermission } = require("../src/config/permissions");

/**
 * Require one permission.
 *
 *   router.use(requirePermission("fees.view"));
 *   router.post("/payments", requirePermission("fees.manage"), handler);
 *
 * @param {string} key a key from config/permissions.js
 */
const requirePermission = (key) => {
  // Thrown at startup, not at request time. A typo in a permission key would
  // otherwise produce a route that answers 403 to everybody including the
  // super admin, which reads as a broken feature rather than a broken guard —
  // and would very likely ship.
  if (!isPermission(key)) {
    throw new Error(
      `requirePermission("${key}") — not a permission in config/permissions.js`
    );
  }

  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    try {
      if (await permissions.can(req.user, key)) return next();

      return res.status(403).json({
        success: false,
        code:    "FORBIDDEN",
        // The key is named on purpose. An administrator reading a support
        // message can look it up on the permissions screen and grant it, or
        // see that it is one of the locked ones and know why not.
        message: `Access denied. This action requires "${key}".`,
        permission: key,
      });
    } catch (err) {
      return next(err);
    }
  };
};

/**
 * Require any one of several permissions.
 *
 * For a route that serves two audiences answering the same question from
 * different sides — the roster read that a bursar makes through students.view
 * and a teacher through students.viewTaught.
 */
const requireAnyPermission = (...keys) => {
  const wanted = keys.flat();

  wanted.forEach((key) => {
    if (!isPermission(key)) {
      throw new Error(
        `requireAnyPermission("${key}") — not a permission in config/permissions.js`
      );
    }
  });

  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    try {
      for (const key of wanted) {
        if (await permissions.can(req.user, key)) return next();
      }

      return res.status(403).json({
        success: false,
        code:    "FORBIDDEN",
        message: `Access denied. This action requires one of: ${wanted.join(", ")}.`,
        permission: wanted,
      });
    } catch (err) {
      return next(err);
    }
  };
};

module.exports = { requirePermission, requireAnyPermission };
