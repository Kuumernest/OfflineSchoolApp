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
 *
 * ── One exam carries its subjects ─────────────────────────────────────────
 *
 * GET /api/exams/:id answers with the exam and the ExamSubject rows belonging to
 * it, so the two collections have to be mirrored together. Both are in the feed
 * under exams.view, which is what makes this answerable at all — a handler
 * cannot answer from data the feed does not send.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

module.exports = [
  {
    route: "GET /api/exams/:examId/scores",

    /** The marks entered for an exam, optionally narrowed to a class or subject. */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const filter = { examId: String(params.examId), schoolId, deletedAt: null };
      if (query.classId)   filter.classId   = String(query.classId);
      if (query.subjectId) filter.subjectId = String(query.subjectId);

      return ok({ scores: docs.find("studentScore", filter) });
    },
  },

  {
    route: "GET /api/exams/:examId/submissions",

    /**
     * Which subjects have had their marks entered, and how far.
     *
     * ── The count is per subject AND per class ──────────────────────────────
     *
     * Each row's count is of scores matching the exam, the SUBJECT and the
     * CLASS of that row — not of every score for the subject. An exam may cover
     * several classes, so counting by subject alone makes each row report the
     * whole exam's progress and every class look finished as soon as one is.
     *
     * And score: { $ne: null } counts entered marks, not rows. A row is created
     * for each student when marking starts; the blank ones are precisely what
     * this screen is asking about, so counting them would show every subject
     * complete before anybody had typed a number.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const examId = String(params.examId);
      const filter = { examId, schoolId, deletedAt: null };
      if (query.teacherId) filter.teacherId = String(query.teacherId);

      const submissions = docs.find("examSubject", filter).map((es) => ({
        ...es,
        totalScoresEntered: docs
          .find("studentScore", {
            examId, subjectId: es.subjectId, classId: es.classId, schoolId, deletedAt: null,
          })
          .filter((s) => s.score !== null && s.score !== undefined)
          .length,
      }));

      return ok({ submissions });
    },
  },

  {
    route: "GET /api/exams/:id",

    /**
     * One exam, with its subjects.
     *
     * A missing exam returns nothing rather than a local 404. The endpoint's 404
     * carries { message: "Exam not found" } and no success flag, and a screen
     * distinguishing "not here" from "not synced yet" would need to know which it
     * was — so the request goes out and the server answers it.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const exam = docs.get("exam", String(params.id));
      if (!exam) return null;
      if (String(exam.schoolId) !== String(schoolId)) return null;
      if (exam.deletedAt) return null;

      const subjects = docs.find("examSubject", { examId: exam._id, deletedAt: null });

      return ok({ exam: { ...exam, subjects } });
    },
  },

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
