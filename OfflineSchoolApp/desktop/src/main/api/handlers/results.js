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

/**
 * True when the student sat none of the subjects — used to keep a fully-absent
 * child out of the averages, exactly as the server's service helper decides.
 * A child who never sat the exam is not a child who scored zero.
 */
const isFullyAbsent = (result) => {
  if (!result.subjectScores || result.subjectScores.length === 0) return false;
  return result.subjectScores.every((s) => s.isAbsent);
};

/**
 * Aggregate stats over mirrored result rows — a faithful copy of the server's
 * getExamStats controller, which is pure arithmetic over rows the mirror
 * already holds. Nothing here can disagree with the server except about how
 * much has synced.
 *
 * ── Scales ────────────────────────────────────────────────────────────────
 * average / highest / lowest are PERCENTAGES (0-100), taken from each row's
 * `percentage` field — not the /20 `average` the row also carries. The server
 * was fixed for exactly this: a 12/20 average must not render as 12%. Rows
 * mirrored before the server denormalized `percentage` get it derived from
 * average and maxTotalScore, and rows with neither are skipped, as the
 * server's filter does.
 *
 * subjectStats aggregates each student's subjectBreakdown the way the
 * controller does, so a subject analysis rendered offline reads the same
 * shape (and the same percentage scale) as one rendered online.
 */
const generateStats = (results) => {
  if (!results.length) {
    return {
      totalStudents:     0,
      present:           0,
      absent:            0,
      passed:            0,
      failed:            0,
      passRate:          0,
      average:           0,
      classAverage:      0,
      highest:           0,
      lowest:            0,
      averageGpa:        0,
      gradeDistribution: {},
      subjectStats:      [],
    };
  }

  const present = results.filter((r) => !isFullyAbsent(r));
  const absent  = results.filter((r) =>  isFullyAbsent(r));
  const passed  = present.filter((r) => r.isPassing);
  const failed  = present.filter((r) => !r.isPassing);

  // Percentage per row: the denormalized field when the mirror has it, else
  // derived from the /20-style average against the row's max total, else the
  // row does not count — matching the server's `p != null` filter.
  const pctOf = (r) => {
    if (r.percentage != null && Number.isFinite(Number(r.percentage)))
      return Number(r.percentage);
    const avg = Number(r.average);
    const max = Number(r.maxTotalScore);
    if (Number.isFinite(avg) && Number.isFinite(max) && max > 0)
      return Math.round((avg / max) * 10000) / 100;
    return null;
  };

  const percentages = present.map(pctOf).filter((p) => p != null);
  const average = percentages.length
    ? Math.round((percentages.reduce((s, v) => s + v, 0) / percentages.length) * 100) / 100
    : 0;
  const highest = percentages.length ? Math.max(...percentages) : 0;
  const lowest  = percentages.length ? Math.min(...percentages) : 0;

  const gpas = results
    .map((r) => r.gpa)
    .filter((g) => g != null && Number.isFinite(Number(g)))
    .map(Number);
  const averageGpa = gpas.length
    ? Math.round((gpas.reduce((s, v) => s + v, 0) / gpas.length) * 100) / 100
    : 0;

  const gradeDistribution = {};
  for (const r of present) {
    const g = r.overallGrade || "N/A";
    gradeDistribution[g] = (gradeDistribution[g] || 0) + 1;
  }

  // Per-subject aggregation over subjectBreakdown — percentages throughout,
  // absent/exempt/scoreless entries skipped, exactly as the controller does.
  const subjectAgg = new Map();
  for (const r of results) {
    for (const s of r.subjectBreakdown || []) {
      if (s.isAbsent || s.isExempt || s.score == null) continue;
      const key = String(s.subjectId || s.subjectName || "");
      if (!key) continue;
      if (!subjectAgg.has(key)) {
        subjectAgg.set(key, {
          subjectId:   s.subjectId || key,
          subjectName: s.subjectName || key,
          total:       0,
          sum:         0,
          highest:     -Infinity,
          lowest:      Infinity,
          passed:      0,
        });
      }
      const agg = subjectAgg.get(key);
      agg.total += 1;
      const pct = s.percentage != null && Number.isFinite(Number(s.percentage))
        ? Number(s.percentage)
        : Number(s.maxScore) > 0
          ? Math.round((Number(s.score) / Number(s.maxScore)) * 10000) / 100
          : 0;
      agg.sum += pct;
      if (pct > agg.highest) agg.highest = pct;
      if (pct < agg.lowest)  agg.lowest  = pct;
      if (s.isPassing) agg.passed += 1;
    }
  }
  const subjectStats = [...subjectAgg.values()].map((a) => ({
    subjectId:   a.subjectId,
    subjectName: a.subjectName,
    average:     a.total > 0 ? Math.round((a.sum / a.total) * 100) / 100 : 0,
    highest:     a.total > 0 ? a.highest : 0,
    lowest:      a.total > 0 ? a.lowest  : 0,
    passRate:    a.total > 0 ? Math.round((a.passed / a.total) * 10000) / 100 : 0,
    total:       a.total,
  }));

  const passRate = present.length
    ? Math.round((passed.length / present.length) * 10000) / 100
    : 0;

  // `classAverage` is kept as an alias of `average` for any screen still
  // reading the old key; the server's controller speaks `average`.
  return {
    totalStudents: results.length,
    present:       present.length,
    absent:        absent.length,
    passed:        passed.length,
    failed:        failed.length,
    passRate,
    average,
    classAverage:  average,
    highest,
    lowest,
    averageGpa,
    gradeDistribution,
    subjectStats,
  };
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

      return ok({ data: generateStats(docs.find("resultSummary", filter)) });
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
      const data = ordered.slice(0, Number(query.limit ?? 100));

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

      return ok({ data: { summary: summary ?? null, scores } });
    },
  },
];
