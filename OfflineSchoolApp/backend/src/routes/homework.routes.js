"use strict";

const router = require("express").Router();
const controller = require("../controllers/homework.controller");

const { requirePermission } = require("../../middleware/permissions");
const { ROLES, normalizeRole } = require("../config/roles");

/**
 * Every write here already goes through assertManager in the controller, which
 * refuses anybody without homework.manage. What was missing was a decision
 * about the LIST: it was open to any signed-in account, which for students is
 * correct — homework is for them to read — and for a bursar is simply noise
 * they have no reason to see.
 *
 * Two doors rather than one capability, because they answer different
 * questions. A student is let through on identity: reading your own homework is
 * not a permission a school should be able to revoke. Everybody else needs
 * homework.view, which a school can adjust.
 */
const canList = requirePermission("homework.view");

router.get("/", (req, res, next) => {
  if (normalizeRole(req.user?.role) === ROLES.STUDENT) return next();
  return canList(req, res, next);
}, controller.list);
router.post("/", controller.upsert);
router.put("/:id", (req, _res, next) => { req.body.id = req.params.id; next(); }, controller.upsert);
router.delete("/:id", controller.remove);
router.post("/:id/submissions", controller.submit);
router.patch("/:id/submissions/:submissionId/grade", controller.grade);

module.exports = router;
