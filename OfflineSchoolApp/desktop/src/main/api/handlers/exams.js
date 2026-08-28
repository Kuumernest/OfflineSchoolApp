// desktop/src/main/api/handlers/exams.js
"use strict";

/**
 * Exams.
 *
 * ── The first paginated endpoint mirrored here ────────────────────────────
 *
 * Which brings its own way of being subtly wrong. The response carries a
 * `pagination` block, and every field in it has to agree with the server:
 *
 *   total       counted over the WHOLE query, before skip and limit. A total of
 *               "how many are on this page" would make the last page look like
 *               the only page.
 *   totalPages  Math.ceil(total / limit) — so 51 exams at 50 a page is 2, and
 *               zero exams is 0 rather than 1. A screen that draws page numbers
 *               from this shows one page too few or too many if it disagrees.
 *   page, limit echoed back as NUMBERS, not the strings they arrived as. A
 *               screen comparing page === 2 against "2" would never match.
 *
 * ── classId matches two fields ────────────────────────────────────────────
 *
 * An exam may name one class in `classId` or several in `classIds`, and the
 * endpoint matches either. Mongo tests a scalar against an array member
 * implicitly; SQLite does not, so the array case is explicit here.
 *
 * ── A non-numeric page is left to the server ──────────────────────────────
 *
 * Number("abc") is NaN, and .skip(NaN) throws on the server — so the request
 * fails there. Declining rather than reproducing that: an error is the server's
 * to raise, and inventing a local one would mean two implementations of the same
 * failure.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

module.exports = [
  {
    route: "GET /api/exams",
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const page  = query.page  === undefined ? 1  : Number(query.page);
      const limit = query.limit === undefined ? 50 : Number(query.limit);

      // See the note above: the server throws on these, and raising the error is
      // its job rather than this layer's.
      if (!Number.isFinite(page) || !Number.isFinite(limit)) return null;
      if (page < 1 || limit < 1) return null;

      const filter = { schoolId, deletedAt: null };
      if (query.status)       filter.status       = String(query.status).trim();
      if (query.academicYear) filter.academicYear = String(query.academicYear).trim();
      if (query.term)         filter.term         = String(query.term).trim();

      let rows = docs.find("exam", filter);

      if (query.classId) {
        const wanted = String(query.classId).trim();
        rows = rows.filter((e) =>
          String(e.classId ?? "") === wanted ||
          (Array.isArray(e.classIds) && e.classIds.map(String).includes(wanted)));
      }

      // Counted before the page is cut — see the note on `total`.
      const total = rows.length;

      const ordered = rows
        .slice()
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));

      const skip  = (page - 1) * limit;
      const exams = ordered.slice(skip, skip + limit);

      return ok({
        exams,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      });
    },
  },
];
