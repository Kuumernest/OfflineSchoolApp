// backend/routes/sync.routes.js
"use strict";

const express    = require("express");
const router     = express.Router();
const syncCtrl   = require("../controllers/sync.controller");
const feedCtrl   = require("../controllers/syncFeed.controller");
const { authenticate } = require("../../middleware/auth");

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
 * PUSH is retired (410 Gone, code SYNC_PUSH_RETIRED). It wrote period
 * definitions and student approve/reject decisions, found a pupil's login by
 * the shared parent email (approving one sibling took over another's account),
 * dropped client UUIDs on periods and reported success whatever happened. No
 * client calls it: both apps only held the endpoint constant, the phone drains
 * its outbox through the real routes and the desktop replays them too.
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
// Retired: 410 Gone with code SYNC_PUSH_RETIRED (see pushRetired). Kept as a
// route so an old client gets that answer rather than a 404. Authenticated so
// it answers only callers who could ever have used it; no permission check,
// because there is nothing left to authorise.
router.post("/push", authenticate, syncCtrl.pushRetired);

module.exports = router;