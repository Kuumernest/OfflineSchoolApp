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
    route: "GET /api/admin/exams/stats",

    /**
     * Lightweight exam status breakdown for the admin dashboard tile.
     *
     * Different from GET /api/exams/stats (exam.routes.js) which also queries
     * ResultSummary and StudentScore. This one only counts Exam rows by status.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const base = { schoolId, deletedAt: null };

      return ok({
        total:     docs.count("exam", base),
        ongoing:   docs.count("exam", { ...base, status: "ongoing"   }),
        completed: docs.count("exam", { ...base, status: "completed" }),
        draft:     docs.count("exam", { ...base, status: "draft"     }),
        scheduled: docs.count("exam", { ...base, status: "scheduled" }),
      });
    },
  },

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
      // Exam.term is a Number since the sequence model landed, and the server
      // hands mongoose a query string that it casts before the query runs. The
      // raw string would match nothing here: the stored rows hold 1, not "1".
      // A term that is not a number is left to the server, which answers it
      // with a cast error this layer should not imitate.
      if (query.term !== undefined && String(query.term).trim() !== "") {
        const term = Number(String(query.term).trim());
        if (!Number.isFinite(term)) return null;
        filter.term = term;
      }

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

  {
    route: "GET /api/exams/:examId/results",

    /**
     * Computed results for an exam (optionally narrowed to one class).
     *
     * The endpoint reads ResultSummary rows sorted by classPosition — data the
     * mirror holds under results.view. An absent ExamSubject set would make the
     * server answer 404; the mirror answers an empty list, which is the same
     * thing a fresh exam produces.
     *
     * No pagination: the server does not honour page/limit here, and inventing
     * one would let a screen think it has seen the whole register when it has
     * only seen the first page.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const exam = docs.get("exam", String(params.examId));
      if (!exam) return null;
      if (String(exam.schoolId) !== String(schoolId)) return null;
      if (exam.deletedAt) return null;

      const filter = { examId: String(params.examId), schoolId };
      if (query.classId) filter.classId = String(query.classId);

      const rows = docs.find("resultSummary", filter, { order: "classPosition", dir: "ASC" });

      return ok({ results: rows });
    },
  },

  {
    route: "GET /api/exams/dashboard",

    /**
     * The dashboard tile — counts and a couple of aggregations, all reducible to
     * things the mirror holds: exam rows grouped by status, ResultSummary rows
     * flagged published, StudentScore rows still blank, and an average over the
     * published percentages.
     *
     * The grading config is NOT consulted here — the dashboard shows positions,
     * not grades, so the computation that lives in gradeUtils.js is not needed.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const base = { schoolId, deletedAt: null };

      const results = {
        exams: {
          total:     docs.count("exam", base),
          draft:     docs.count("exam", { ...base, status: "draft"     }),
          scheduled: docs.count("exam", { ...base, status: "scheduled" }),
          ongoing:   docs.count("exam", { ...base, status: "ongoing"   }),
          completed: docs.count("exam", { ...base, status: "completed" }),
          published: docs.count("exam", { ...base, status: "published" }),
          archived:  docs.count("exam", { ...base, status: "archived"  }),
        },
        results: {
          published:       docs.count("resultSummary", { schoolId, isPublished: true  }),
          pending:         docs.count("resultSummary", { schoolId, isPublished: false }),
          missingGrades:   docs.count("studentScore", {
            schoolId, score: null, isAbsent: false, isExempt: false, deletedAt: null,
          }),
          averagePerformance: (() => {
            const rows = docs.find("resultSummary", { schoolId, isPublished: true });
            if (!rows.length) return 0;
            const valid = rows.map((r) => r.percentage).filter((p) => p != null);
            if (!valid.length) return 0;
            return Math.round(valid.reduce((s, v) => s + v, 0) / valid.length);
          })(),
          passRate: (() => {
            const rows = docs.find("resultSummary", { schoolId, isPublished: true });
            if (!rows.length) return 0;
            const passed = rows.filter((r) => r.isPassing).length;
            return Math.round((passed / rows.length) * 100);
          })(),
        },
        recentExams: docs
          .find("exam", base, { order: "createdAt", dir: "DESC", limit: 5 }),
      };

      return ok({ dashboard: results });
    },
  },

  {
    route: "GET /api/exams/reports/results",

    /**
     * The results export screen — paginated ResultSummary, the same data shape
     * as /exams/:examId/results but with page/limit honoured.
     *
     * The web screen asks for this as a blob for download, but the server
     * answers JSON — so the envelope mirrors the server's exactly.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // examId is an optional query parameter on this route, not a path param.
      const examId = query.examId ? String(query.examId).trim() : null;

      if (examId) {
        const exam = docs.get("exam", examId);
        if (!exam) return null;
        if (String(exam.schoolId) !== String(schoolId)) return null;
        if (exam.deletedAt) return null;
      }

      const page  = query.page  === undefined ? 1  : Number(query.page);
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isFinite(page) || !Number.isFinite(limit)) return null;
      if (page < 1 || limit < 1) return null;

      const filter = { schoolId };
      if (examId)   filter.examId  = examId;
      if (query.classId) filter.classId = String(query.classId);

      const rows = docs.find(
        "resultSummary", filter,
        { order: "classPosition", dir: "ASC" }
      );

      const total = rows.length;
      const skip  = (page - 1) * limit;
      const results = rows.slice(skip, skip + limit);

      return ok({
        results,
        total,
        page:  Number(page),
        pages: Math.ceil(total / Number(limit)),
      });
    },
  },
];
