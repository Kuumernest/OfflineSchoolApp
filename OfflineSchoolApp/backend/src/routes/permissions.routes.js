// backend/src/routes/permissions.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { requirePermission } = require("../../middleware/permissions");
const permissions           = require("../services/permissions.service");

const {
  PERMISSION_DEFS,
  ADJUSTABLE_ROLES,
  LOCKED_KEYS,
} = require("../config/permissions");

/**
 * Who may do what, and the screen that changes it.
 *
 * Two routes, and the shape of the GET is the important part: it returns the
 * whole matrix — every capability, its module, whether it can be changed, and
 * what each adjustable role currently holds — so the client renders a screen
 * from data rather than from a hard-coded copy of the registry. A permission
 * added in a later release appears on that screen with no client change.
 *
 * The GET is also what makes the locks legible. A capability an administrator
 * cannot grant is still LISTED, marked locked, with the reason attached. A
 * checkbox that is simply missing reads as an oversight and invites a support
 * ticket; one that is present and disabled with "the bursar must never be able
 * to move a mark" next to it answers the question before it is asked.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

// permissions.manage is non-delegable: a role that can grant itself
// capabilities has no ceiling, and neither does anybody it appoints.
router.use(requirePermission("permissions.manage"));

/**
 * GET /api/admin/permissions
 *
 * The matrix, plus what each adjustable role effectively holds right now.
 */
router.get("/", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);

  const effective = {};
  for (const role of ADJUSTABLE_ROLES) {
    effective[role] = await permissions.effectiveFor(role, schoolId);
  }

  return res.json({
    success: true,
    data: {
      // The registry, flattened for a client. `defaults` travels with each row
      // so the screen can show "changed from default" without a second call.
      matrix: PERMISSION_DEFS.map((d) => ({
        key:       d.key,
        module:    d.module,
        delegable: d.delegable,
        note:      d.note ?? null,
        defaults:  d.defaults,
      })),
      /** The only roles this endpoint will write. See config/permissions.js. */
      adjustableRoles: ADJUSTABLE_ROLES,
      lockedKeys:      LOCKED_KEYS,
      effective,
    },
  });
}));

/**
 * PUT /api/admin/permissions/:role   { permissions: [...] }
 *
 * Takes the DESIRED set for that role, not a diff. A screen of checkboxes
 * produces exactly this, and it removes the whole class of bug where a key
 * lands in both the granted and the revoked list.
 *
 * The service stores the difference against the defaults rather than the set
 * itself, so a capability added in a later release still reaches this school.
 */
router.put("/:role", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);

  if (!Array.isArray(req.body?.permissions)) {
    return res.status(400).json({
      success: false,
      code:    "BAD_REQUEST",
      message: "permissions must be an array of permission keys",
    });
  }

  try {
    const result = await permissions.setRolePermissions({
      schoolId,
      role:    req.params.role,
      desired: req.body.permissions,
    });

    console.log(
      `🔐 permissions updated for "${req.params.role}" in school ${schoolId} ` +
      `by ${req.user?.email ?? req.user?._id} — ` +
      `+${result.granted.length} / -${result.revoked.length}`
    );

    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false,
      code:    err.code ?? "ERROR",
      message: err.message,
    });
  }
}));

module.exports = router;
