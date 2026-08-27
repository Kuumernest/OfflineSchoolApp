// backend/routes/sync.routes.js
"use strict";

const express    = require("express");
const router     = express.Router();
const syncCtrl   = require("../controllers/sync.controller");
const feedCtrl   = require("../controllers/syncFeed.controller");
const { authenticate } = require("../../middleware/auth");
const { requirePermission } = require("../../middleware/permissions");

/**
 * The offline engine.
 *
 * PULL is deliberately left open to any authenticated account, and that is a
 * decision rather than an omission — but only half of one, so it is written
 * down. pullChanges scopes hard by TENANT: it compares the requested schoolId
 * against the caller's and answers 403 on a mismatch, so nobody sees another
 * school. It does NOT scope by ROLE: every caller gets the same six
 * collections, which means a student's device receives the staff directory
 * (names, emails, active state) alongside its own timetable.
 *
 * It stays that way here because narrowing it is not a guard, it is a rewrite
 * of the payload — six collections with six different audiences, and the
 * student app depends on the slice it currently gets. Restricting the route
 * would take every student device offline for good. Worth fixing; not
 * fixable in a role audit.
 *
 * PUSH is a different matter and is closed now. It writes period definitions
 * and student promotion decisions — the shape of the school day, and which
 * children move up a class. Behind authenticate alone, any signed-in account
 * could send either, a student's included. No client calls it: both apps only
 * hold the endpoint constant, and the mobile engine pulls. So the guard costs
 * nothing today and shuts a write path that should never have been open.
 *
 * The bursar is out of both writes for the ordinary reason: neither periods nor
 * promotion is a finance decision.
 */
/**
 * The desktop change feed.
 *
 * Behind authenticate alone at the route, and scoped per COLLECTION inside —
 * see src/config/syncFeed.js. A single requirePermission here would be the
 * wrong shape: the endpoint returns many collections with different audiences,
 * and one capability covering all of them would be either uselessly broad or
 * refuse the whole feed to a bursar because it also carries exam marks.
 *
 * What the caller may not have is REFUSED BY NAME in the response rather than
 * silently omitted, so a desktop can tell "you have no payroll runs" from
 * "payroll is not yours" — an empty screen with no explanation is how people
 * conclude the software has lost their data.
 */
router.get( "/changes", authenticate, feedCtrl.changes);

router.get( "/pull", authenticate, syncCtrl.pullChanges);
router.post("/push", authenticate, requirePermission("sync.push"), syncCtrl.pushChanges);

module.exports = router;