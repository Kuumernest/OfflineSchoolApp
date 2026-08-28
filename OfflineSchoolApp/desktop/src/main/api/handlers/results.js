// desktop/src/main/api/handlers/results.js
"use strict";

/**
 * Exam results.
 *
 * ── Published, unless you are an admin ────────────────────────────────────
 *
 * The endpoint is gated on results.view — which a bursar and a teacher both hold
 * — and then forces isPublished: true inside the handler for anybody who is not
 * an admin. An admin may ask for either by passing isPublished explicitly.
 *
 * The same rule is applied twice on purpose. The FEED scopes what a non-admin
 * mirrors, so unpublished marks never reach their machine; this filters what is
 * drawn, so a machine that pulled them as an admin and is now being read by a
 * bursar still does not show them. Neither is redundant: the feed decides what is
 * on disk, and this decides what is on screen, and the two answer to different
 * moments.
 *
 * ── The order is not total, and cannot be made so from here ───────────────
 *
 * The endpoint sorts by classPosition with NO secondary key, and classPosition is
 * not unique: a published result and an unpublished draft for the same class can
 * both be second. Mongo does not define the order of tied documents, so the
 * server's own page boundaries can shift between two identical requests.
 *
 * A mirror cannot reproduce an order that is not defined. What it can do is be
 * self-consistent, so the desktop does not reshuffle a list between renders —
 * hence _id as a tie-break below. Where the two orders differ, they differ only
 * within a tie, which is the most that can be promised.
 *
 * Fixing it properly means giving the endpoint a secondary sort key, which
 * changes what the server returns and belongs in its own change.
 *
 * ── A different envelope from the exam list ───────────────────────────────
 *
 * The exam list returns a nested `pagination` object. This returns the same
 * numbers FLAT — count, total, page, pages — and calls the last one `pages`
 * rather than `totalPages`. There is no reason for the difference beyond the two
 * endpoints having been written at different times, and a mirror does not get to
 * tidy it up: the screens read what they were given.
 */

const ADMIN_ROLES = ["super_admin", "school_admin", "admin"];

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

module.exports = [
  {
    route: "GET /api/results/:examId",
    handler: ({ params, query }, { docs, session }) => {
      // schoolId is applied only if resolvable — the endpoint omits it from the
      // filter rather than failing, so results for an exam can be read without
      // it. Taken from the session when the query does not carry it.
      const schoolId = query.schoolId
        ? String(query.schoolId).trim()
        : (session?.schoolId ?? null);

      // Without a role there is no way to know whether unpublished results
      // should be visible, and guessing in either direction is wrong: hide them
      // from an admin and the screen looks empty, show them to a teacher and the
      // school's provisional marks are on display.
      if (!session?.role) return null;

      const isAdmin = ADMIN_ROLES.includes(session.role);

      const page  = query.page  === undefined ? 1  : Number(query.page);
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      // The server throws on these — .skip(NaN) — so raising the error is its
      // job, not a second implementation of it here.
      if (!Number.isFinite(page) || !Number.isFinite(limit)) return null;
      if (page < 1 || limit < 1) return null;

      const filter = { examId: params.examId, deletedAt: null };
      if (schoolId)      filter.schoolId = schoolId;
      if (query.classId) filter.classId  = String(query.classId).trim();

      if (!isAdmin) {
        filter.isPublished = true;
      } else if (query.isPublished !== undefined) {
        // Compared to the string "true", as the endpoint does — so
        // isPublished=1 means FALSE there, and must here too.
        filter.isPublished = query.isPublished === "true";
      }

      const rows = docs.find("examResult", filter);
      const total = rows.length;

      // classPosition ascending: first in the class first. Numeric, so compared
      // as numbers rather than as text — "10" sorts before "9" as a string, and
      // a ranked list in the wrong order is worse than no order at all.
      const ordered = rows.slice().sort((a, b) => {
        const ap = Number(a.classPosition);
        const bp = Number(b.classPosition);
        const aMissing = !Number.isFinite(ap);
        const bMissing = !Number.isFinite(bp);
        // Mongo sorts missing values first on an ascending sort.
        if (aMissing && bMissing) return 0;
        if (aMissing) return -1;
        if (bMissing) return 1;
        if (ap !== bp) return ap - bp;
        // Tied. See the note above: the server does not define this order, so
        // this exists to keep the desktop stable rather than to match it.
        return String(a._id).localeCompare(String(b._id));
      });

      const skip    = (page - 1) * limit;
      const results = ordered.slice(skip, skip + limit);

      // Flat, and `pages` not `totalPages` — see the note above.
      return ok({
        count: results.length,
        total,
        page,
        pages: Math.ceil(total / limit),
        data:  results,
      });
    },
  },
];
