// backend/src/utils/announcementScope.js
"use strict";

const Announcement = require("../db/models/Announcement");

/**
 * One announcement by id, IN THIS CALLER'S SCHOOL.
 *
 * ── The tenancy filter this used to be missing ────────────────────────────
 *
 * Announcement.findByAnyId() looks up by _id and nothing else. It exists because
 * ids here may be stored as ObjectIds or as strings, and findById() raises a
 * CastError on a non-hex string — the "✅ FIX" comments through
 * announcement.routes.js are that repair.
 *
 * The repair replaced queries of the form findOne({ _id, schoolId }), and the
 * schoolId went with them. Every route that used it then decided authorisation
 * from `isAuthor || isAdmin`, where isAdmin is a ROLE check — so a school_admin
 * of one school could edit or delete an announcement belonging to another, and
 * any authenticated user could mark one read or acknowledged, given only its id.
 * Nothing in the path compared the announcement's school with the caller's.
 *
 * Fixed in ONE place rather than at each call site, so a new call site cannot
 * be added without it. A mismatch returns null and the caller answers 404, which
 * is the right answer: somebody outside a school should not learn that one of
 * its announcements exists.
 *
 * A super_admin still crosses schools, which is what that role is for.
 *
 * Lived in announcement.routes.js until the student read-receipt copies in
 * server.js and students.routes.js were found doing the same lookup unscoped;
 * it moved here so all three share one answer, the way utils/teacherScope.js
 * does for the mark-sheet question.
 */
const findAnnouncementById = async (id, req) => {
  const doc = await Announcement.findByAnyId(id);
  if (!doc) return null;

  if (req?.user?.role === "super_admin") return doc;

  const callerSchool = req?.user?.schoolId;
  if (!callerSchool) return null;
  if (String(doc.schoolId ?? "") !== String(callerSchool)) return null;

  return doc;
};

module.exports = { findAnnouncementById };
