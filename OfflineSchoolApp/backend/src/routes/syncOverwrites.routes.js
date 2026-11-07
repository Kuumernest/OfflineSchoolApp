// backend/src/routes/syncOverwrites.routes.js
"use strict";

/**
 * Telling the person whose edit was replaced.
 *
 * Student records are last-write-wins (docs/11-conflict-resolution.md) and stay
 * that way. The condition on it is that the losing write leaves a trace AND the
 * person who lost it hears about it. logOverwriteIfNeeded (students.routes.js)
 * writes the trace: a SyncOverwrite whose `lostEditBy` is the previous editor —
 * the author of the version that was replaced, not the request that replaced
 * it. Until now nothing read those rows back, so the only copy anybody saw was
 * the WINNER's, on the phone that did the overwriting.
 *
 * Mounted under /api/sync/overwrites (sync.routes.js):
 *
 *   GET  /mine          the caller's own overwritten edits, newest first
 *                       (?unseen=1 for unseen only)
 *   POST /:id/seen      mark one of the caller's own seen
 *   POST /seen-all      mark all of the caller's own seen
 *   GET  /              every overwrite in the school — students.manage
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 *
 * A loser sees only rows naming them. Marking seen is the loser's alone: an
 * id that is not theirs is a 404, as if it did not exist, whoever asks. The
 * snapshot (`lostVersion`) follows the permission to READ the student, as GET
 * /students/:id applies it: students.viewFull → the whole record;
 * students.view → the roster projection, taken at write time; neither → no
 * snapshot, only who, what and when.
 *
 * ── Why not the Notification collection ───────────────────────────────────
 *
 * Notification is the delivery queue to FAMILIES — `to` is a guardian's email
 * or phone, the dispatcher sends it, and the parent portal lists it. A staff
 * alert there would be emailed to, or shown to, the family. The web bell is
 * assembled client-side from several sources (services/notification.service.ts)
 * and reads this route as one more.
 */

const express = require("express");
const router  = express.Router();

const { authenticate }      = require("../../middleware/auth");
const { requirePermission } = require("../../middleware/permissions");
const permissions           = require("../services/permissions.service");
const applicationDocuments  = require("../utils/applicationDocuments");
const { resolveSchoolId }   = require("../utils/tenant");
const SyncOverwrite         = require("../db/models/SyncOverwrite");

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const MAX_LIMIT = 200;
const limitOf = (req) => {
  const n = Number.parseInt(req.query?.limit, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : 100;
};
const wantsUnseen = (req) => ["1", "true", "yes"].includes(String(req.query?.unseen ?? "").toLowerCase());

/** How much of a student this caller may read: "full", "roster" or null. */
const studentView = async (user) => {
  if (await permissions.can(user, "students.viewFull")) return "full";
  if (await permissions.can(user, "students.view"))     return "roster";
  return null;
};

const present = (req, row, view) => {
  let lostVersion = null;
  if (view === "full")   lostVersion = row.lostVersion ?? null;
  if (view === "roster") lostVersion = row.lostVersionRoster ?? null;
  return {
    id:                String(row._id),
    entityType:        row.entityType,
    entityId:          row.entityId,
    entityName:        row.entityName ?? null,
    schoolId:          row.schoolId,
    overwrittenBy:     row.overwrittenBy ?? null,
    overwrittenByName: row.overwrittenByName ?? null,
    overwrittenAt:     row.overwrittenAt ?? null,
    newAction:         row.newAction ?? null,
    lostEditBy:        row.lostEditBy ?? null,
    lostEditByName:    row.lostEditByName ?? null,
    lostEditAt:        row.lostEditAt ?? null,
    // Stored documents leave as their presentation, never a path on disk —
    // the same redaction every students.routes response goes through.
    lostVersion:       lostVersion ? applicationDocuments.redactDocumentsDeep(req, lostVersion) : null,
    seenByLoser:       Boolean(row.seenByLoser),
    seenAt:            row.seenAt ?? null,
    createdAt:         row.createdAt ?? null,
  };
};

/** The caller's own rows: their id, their school. */
const ownFilter = (req) => {
  const userId = req.user?._id ? String(req.user._id) : null;
  if (!userId) return null;
  const filter = { lostEditBy: userId };
  const schoolId = resolveSchoolId(req);
  if (schoolId) filter.schoolId = schoolId;
  else if (req.user?.role !== "super_admin") return null;
  return filter;
};

router.get("/mine", authenticate, asyncHandler(async (req, res) => {
  const filter = ownFilter(req);
  if (!filter) return res.json({ success: true, data: { overwrites: [], unseenCount: 0 } });

  const [rows, unseenCount, view] = await Promise.all([
    SyncOverwrite.find(wantsUnseen(req) ? { ...filter, seenByLoser: false } : filter)
      .sort({ createdAt: -1 }).limit(limitOf(req)).lean(),
    SyncOverwrite.countDocuments({ ...filter, seenByLoser: false }),
    studentView(req.user),
  ]);

  return res.json({
    success: true,
    data: { overwrites: rows.map((r) => present(req, r, view)), unseenCount },
  });
}));

router.post("/seen-all", authenticate, asyncHandler(async (req, res) => {
  const filter = ownFilter(req);
  if (!filter) return res.json({ success: true, data: { marked: 0 } });
  const now = new Date();
  const r = await SyncOverwrite.updateMany(
    { ...filter, seenByLoser: false },
    { $set: { seenByLoser: true, seenAt: now } },
  );
  return res.json({ success: true, data: { marked: r.modifiedCount ?? 0 } });
}));

router.post("/:id/seen", authenticate, asyncHandler(async (req, res) => {
  const filter = ownFilter(req);
  const row = filter
    ? await SyncOverwrite.findOne({ ...filter, _id: String(req.params.id) })
    : null;
  if (!row) return res.status(404).json({ success: false, message: "Not found" });

  if (!row.seenByLoser) {
    row.seenByLoser = true;
    row.seenAt      = new Date();
    await row.save();
  }
  return res.json({ success: true, data: { id: String(row._id), seenByLoser: true, seenAt: row.seenAt } });
}));

// The school's whole list: for the people who edit student records and so
// settle what was lost. Read-only — marking seen stays with the loser.
router.get("/", authenticate, requirePermission("students.manage"), asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req);
  if (!schoolId) {
    return res.status(400).json({ success: false, code: "SCHOOL_REQUIRED", message: "A school must be selected" });
  }
  const filter = { schoolId };
  if (wantsUnseen(req)) filter.seenByLoser = false;

  const [rows, view] = await Promise.all([
    SyncOverwrite.find(filter).sort({ createdAt: -1 }).limit(limitOf(req)).lean(),
    studentView(req.user),
  ]);
  return res.json({ success: true, data: { overwrites: rows.map((r) => present(req, r, view)) } });
}));

module.exports = router;
