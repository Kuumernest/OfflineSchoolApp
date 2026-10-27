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
const { DEFAULT_PASS_MARK } = require("../../../../../shared/passRate");
const { examAnalytics, rowsOn20, classesOf, classTopBottom } = require("../../../../../shared/examAnalytics");

/** The school's pass mark and remark bands from the local copy. */
const gradingOf = (docs, schoolId) => {
  const cfg = docs.find("gradingConfig", { schoolId })[0] ?? null;
  return { passMark: cfg?.passMark ?? DEFAULT_PASS_MARK, bands: cfg?.grades ?? null };
};



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

      const rows = docs.find("resultSummary", filter);
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

  {
    route: "GET /api/results/:examId/stats",

    /**
     * Aggregate statistics for an exam, computed over ResultSummary rows — the
     * same rows and the same arithmetic the server's generateStats runs. There
     * is no aggregation the mirror cannot reproduce: it is count, mean, min
     * and max over a filtered set, not a query the server resolves specially.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId
        ? String(query.schoolId).trim()
        : (session?.schoolId ?? null);
      if (!schoolId) return null;

      const filter = { examId: String(params.examId), schoolId, deletedAt: null };
      if (query.classId) filter.classId = String(query.classId).trim();

      // The server's examStatistics: shared/examAnalytics on /20, the school's
      // pass mark and remark bands; the classes for the page's filter and, once
      // one is chosen, that class's top and bottom pupils (A6).
      const rows = docs.find("resultSummary", filter);
      const grading = gradingOf(docs, schoolId);
      return ok({ data: {
        ...examAnalytics(rows, grading),
        classes:   classesOf(docs.find("resultSummary", { examId: filter.examId, schoolId, deletedAt: null })),
        topBottom: filter.classId ? classTopBottom(rows, grading) : null,
      } });
    },
  },

  {
    route: "GET /api/results/:examId/rankings",

    /**
     * Dense rankings by class, grade or school.
     *
     * The server sorts by the scope's position field ascending with NO
     * secondary key, and ties sit in storage order there — an order Mongo does
     * not define. The mirror adds _id as a tie-break for the same reason the
     * list endpoint does, so the desktop does not reshuffle between renders;
     * where the two orders differ they differ only within a tie.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId
        ? String(query.schoolId).trim()
        : (session?.schoolId ?? null);
      if (!schoolId) return null;

      const examId = String(params.examId);
      const scope  = ["class", "grade", "school"].includes(String(query.rankBy))
        ? String(query.rankBy) : "class";
      const sortField =
        scope === "school" ? "schoolPosition" :
        scope === "grade"  ? "gradePosition"  :
                             "classPosition";

      const filter = {
        examId,
        schoolId,
        deletedAt: null,
        // Position absent means the student was fully absent — the server's
        // $ne: null, spelled for the mirror's filter language.
        [sortField]: { not: null },
      };
      if (query.classId) filter.classId = String(query.classId).trim();

      const ordered = docs
        .find("resultSummary", filter, { order: sortField, dir: "ASC" })
        .slice()
        .sort((a, b) => {
          const ap = Number(a[sortField]);
          const bp = Number(b[sortField]);
          if (ap !== bp) return ap - bp;
          return String(a._id).localeCompare(String(b._id));
        });

      // Sliced in JS, not LIMIT in SQL: the server fetches then slices, and a
      // NaN or negative limit has to behave the same way here as there.
      const data = rowsOn20(ordered.slice(0, Number(query.limit ?? 100)), gradingOf(docs, schoolId));

      return ok({ rankBy: scope, count: data.length, data });
    },
  },

  {
    route: "GET /api/results/:examId/student/:studentId",

    /**
     * One student's marks for one exam: the summary row plus its scores.
     *
     * The server answers 404 when it has neither. The mirror cannot tell "not
     * yet processed" from "not yet synced" — so when both are absent locally
     * the request goes out and the server gives the authoritative answer,
     * exactly as GET /api/exams/:id returns nothing for an exam the mirror has
     * never seen rather than inventing a local 404.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId
        ? String(query.schoolId).trim()
        : (session?.schoolId ?? null);
      if (!schoolId) return null;

      const examId    = String(params.examId);
      const studentId = String(params.studentId);
      const filter    = { examId, studentId, schoolId, deletedAt: null };

      const summary = docs.find("resultSummary", filter)[0] ?? null;
      const scores  = docs.find("studentScore", filter);

      if (!summary && scores.length === 0) return null;

      // The server's rule, applied to what is drawn: a result the school has
      // not published is a 404 for anyone who is not an administrator, marks
      // included (results.controller getStudentResult). The mirror of a
      // non-administrator holds no unpublished summary, but a machine that
      // pulled as an administrator and is now read by a teacher or a bursar
      // does — so the request goes to the server, which answers 404, rather
      // than being answered here from rows the caller may not read.
      if (!session?.role) return null;
      if (!ADMIN_ROLES.includes(session.role) && !summary?.isPublished) return null;

      return ok({ data: { summary: summary ?? null, scores } });
    },
  },
];
