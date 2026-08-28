// desktop/src/main/api/handlers/promotion.js
"use strict";

/**
 * End-of-year progression: the map, the drafts, and where a child has sat.
 *
 * ── What is here and what deliberately is not ─────────────────────────────
 *
 * Promotion is the one act in this system that rewrites every child's class at
 * once, and it is built as payroll is: generate a draft, review it, commit,
 * reverse if wrong. Of those four verbs this file mirrors NONE — they are all
 * online-only, with the reasons in writes/promotion.js. What is mirrored is the
 * reading around them:
 *
 *   the progression map      which class leads to which, the thing a head fixes
 *                            BEFORE generating anything
 *   the list of runs         what has been drafted, committed or reversed
 *   one run and its rows     the review screen, per pupil
 *   one pupil's history      the year-by-year basis of a transcript
 *
 * All four are the questions asked around a rollover rather than the rollover
 * itself, and they are asked at exactly the times a school office has no
 * connection: the week before term, over a printed list, in a corridor.
 *
 * ── The whole router is promotion.run ─────────────────────────────────────
 *
 * `router.use(requirePermission("promotion.run"))` — one guard over all ten
 * endpoints, held by admins only and NOT delegable. The feed gates promotionRun
 * and promotionDecision on the same key, so a bursar's machine holds no runs at
 * all; the check is still made here, for the reason handlers/templates.js gives
 * about templates — the feed decides what this machine STORES, and a machine
 * that pulled as the head and is now being read by the bursar still has the rows
 * on disk. `class` and `enrollment` are gated on other keys entirely
 * (classes.view, students.view), so without the check below a bursar would be
 * answered locally for /progression and /students/:id/history where the server
 * gives them 403.
 *
 * ── Every read here is .lean(), which is worth stating ────────────────────
 *
 * All four routes end in `.lean()`, so `res.json` sees plain rows: no `id`
 * virtual and no schema default filled in for a key the stored document does not
 * have. Class DOES declare `toJSON: { virtuals: true }` and defaults for
 * nextClassId and isFinalYear, and none of that fires on a lean row — so a class
 * stored without those keys comes back without them, and the projection below
 * copies key presence rather than filling blanks in. (writes/promotion.js has
 * the opposite problem and the note to match: PATCH answers with a HYDRATED
 * document.)
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * resolveSchoolId() from promotion.routes.js, verbatim in behaviour.
 *
 * For anybody who is not a super_admin the schoolId in the request is IGNORED
 * and the token's own is used, so a school admin passing another school's id
 * reads their own. With no session at all the request is the only thing that can
 * say which school, so it is used then — the parity harness asks some questions
 * without one.
 */
const resolveSchoolId = (session, provided) => {
  const asked = provided ? String(provided).trim() : null;
  if (session?.role === "super_admin" && asked) return asked;
  const own = session?.schoolId ? String(session.schoolId) : null;
  return own ?? asked;
};

/** The router's single guard. Without it there is nothing to answer with. */
const mayRun = (session) =>
  Array.isArray(session?.permissions) && session.permissions.includes("promotion.run");

/**
 * MongoDB's ascending order for a string field.
 *
 * Two things it is not. It is not localeCompare: Mongo compares strings by their
 * bytes, so "Zebra" precedes "apple" and a class list would come out in a
 * different order offline (handlers/school.js has the long version of this).
 * And it is not `String(x ?? "")`: in BSON order Null sorts BELOW every string,
 * so a decision with no fromClassName sorts FIRST, where `""` would also put it
 * first but a value like "null" would not. `.sort({ fromClassName: 1 })` on a
 * freshly generated run is mostly rows whose class was deleted — exactly the
 * ones with a null there.
 */
const asc = (field) => (a, b) => {
  const av = a[field];
  const bv = b[field];
  const an = av === null || av === undefined;
  const bn = bv === null || bv === undefined;
  if (an && bn) return 0;
  if (an) return -1;
  if (bn) return 1;
  const as = String(av);
  const bs = String(bv);
  return as === bs ? 0 : as < bs ? -1 : 1;
};

/** The same, reversed — and so nulls and missing keys sort LAST. */
const desc = (field) => (a, b) => asc(field)(b, a);

/** Stable last resort where the endpoint's own sort has nothing left to order by. */
const byId = (a, b) => {
  const as = String(a._id);
  const bs = String(b._id);
  return as === bs ? 0 : as < bs ? -1 : 1;
};

const chain = (...comparators) => (a, b) => {
  for (const cmp of comparators) {
    const r = cmp(a, b);
    if (r !== 0) return r;
  }
  return 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE PROGRESSION MAP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `.select("name level nextClassId isFinalYear")` — four fields plus `_id`.
 *
 * Copied by PRESENCE, not by name. A projection asks Mongo for four paths and
 * gets back however many of them the stored document actually has; the row is
 * lean, so nothing fills the others in. Every class in a school that has never
 * opened the progression screen is stored without nextClassId or isFinalYear,
 * which is the common case rather than the edge one — a handler that emitted
 * `nextClassId: null` for those would differ from the server on every row of the
 * first load.
 *
 * Iterating the row's own keys rather than a fixed list keeps the field ORDER
 * the server's too, which matters only to a whole-object JSON compare but costs
 * nothing.
 */
const PROGRESSION_FIELDS = new Set(["name", "level", "nextClassId", "isFinalYear"]);

const projectClass = (row) => {
  const out = { _id: row._id };
  for (const key of Object.keys(row)) {
    if (key !== "_id" && PROGRESSION_FIELDS.has(key)) out[key] = row[key];
  }
  return out;
};

/**
 * The map as both GET /progression and PUT /progression answer it.
 *
 * Shared because the PUT replies with the whole list re-read after its updates,
 * and two copies of a projection this fiddly would drift. Attached to the
 * exported array below so writes/promotion.js can reach it: spreading an array
 * copies its elements only, so the extra property is invisible to index.js.
 *
 * Returns null where this machine holds no classes for the school at all — see
 * the note on the GET.
 */
const progressionRows = (docs, schoolId) => {
  if (docs.count("class", { schoolId }) === 0) return null;

  return docs
    .find("class", { schoolId, deletedAt: null })
    .map(projectClass)
    // `.sort({ name: 1 })` with no tie-break. Two classes of the same name are
    // possible — nothing stops it — and the server would then return them in
    // storage order, which is not a promise. _id keeps this machine from
    // reshuffling them between renders.
    .sort(chain(asc("name"), byId));
};

// ─────────────────────────────────────────────────────────────────────────────
// RUNS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this machine hold ALL of a run's decisions?
 *
 * `counts` on the run is a tally of its decision rows, refreshed by the service
 * after generate and after every override, and nothing ever soft-deletes a
 * decision — so counts.total is exactly how many rows there should be. If the
 * mirror has fewer, the pull is part way through and the review screen would
 * show a head 300 of 500 children with nothing saying so. That is the one
 * outcome worth declining over: a short list looks complete, and the pupils
 * missing from it are the ones nobody then decides about.
 *
 * A run with no counts at all cannot be checked, so it is treated as incomplete
 * rather than trusted.
 */
const decisionsComplete = (docs, run) => {
  const expected = run?.counts?.total;
  if (typeof expected !== "number") return false;
  return docs.count("promotionDecision", { runId: String(run._id), deletedAt: null }) === expected;
};

/** findOne({ _id, schoolId, deletedAt: null }) over the mirror. */
const runOf = (docs, runId, schoolId) => {
  const row = docs.get("promotionRun", String(runId));
  if (!row) return null;
  if (String(row.schoolId) !== String(schoolId)) return null;
  if (row.deletedAt) return null;
  return row;
};

module.exports = [
  {
    route: "GET /api/promotion/progression",

    /**
     * Which class leads to which, and how much of the map is still missing.
     *
     * ── `incomplete` is the whole reason this screen exists ────────────────
     *
     * A class that is neither final-year nor pointed anywhere strands its pupils
     * at generate time — they come out "unassigned", and an unassigned decision
     * BLOCKS the commit. So the count is computed the endpoint's way,
     * `!isFinalYear && !nextClassId`, which is falsiness and not equality: a
     * class with the keys absent counts as incomplete, and so does one with
     * nextClassId: "" .
     *
     * ── Why a school with no mirrored classes declines ───────────────────
     *
     * The empty answer for "this machine has not pulled the class list" and the
     * empty answer for "this school has no classes" are the same JSON, and one
     * of them is a lie that reads as a school with nothing in it. There is no
     * class filter to hide behind here — the map is the whole class list — so
     * zero rows means the mirror, not the school.
     */
    handler: ({ query }, { docs, session }) => {
      if (!mayRun(session)) return null;

      const schoolId = resolveSchoolId(session, query.schoolId);
      if (!schoolId) return null;

      const rows = progressionRows(docs, schoolId);
      if (!rows) return null;

      return ok({
        count: rows.length,
        incomplete: rows.filter((c) => !c.isFinalYear && !c.nextClassId).length,
        data: rows,
      });
    },
  },

  {
    route: "GET /api/promotion/runs",

    /**
     * Every rollover the school has, newest first — drafts, commits, reversals.
     *
     * No projection: the endpoint has no `.select()`, so the whole run document
     * ships, counts and reversal reason and all. The mirror answers with the
     * whole row for the same reason.
     *
     * Not declined when empty, unlike the map above. A school that has never
     * rolled over genuinely has no runs, and that is the normal state for most
     * of the year — declining would send the commonest case to the network.
     */
    handler: ({ query }, { docs, session }) => {
      if (!mayRun(session)) return null;

      const schoolId = resolveSchoolId(session, query.schoolId);
      if (!schoolId) return null;

      // `.sort({ createdAt: -1 })`, with _id after it: two runs created in the
      // same millisecond tie, and the server would then answer in storage order.
      const rows = docs
        .find("promotionRun", { schoolId, deletedAt: null })
        .sort(chain(desc("createdAt"), byId));

      return ok({ count: rows.length, data: rows });
    },
  },

  {
    route: "GET /api/promotion/runs/:runId",

    /**
     * One run with its per-pupil decisions — the review screen.
     *
     * ── The decisions are NOT filtered by school ──────────────────────────
     *
     * `PromotionDecision.find({ runId, deletedAt: null })` and nothing more. The
     * run has already been checked for tenancy, so runId is trusted to imply it,
     * and every decision the service writes carries the run's schoolId anyway.
     * Reproduced as written rather than tightened: adding a schoolId filter here
     * would make the mirror disagree with the server about the contents of a run
     * for any row whose schoolId was ever wrong, and disagree silently.
     *
     * ── A missing run declines rather than answering 404 ──────────────────
     *
     * "Not found" and "not pulled yet" are the same sentence from this machine,
     * and one of them is wrong. The server gets to say it.
     */
    handler: ({ params, query }, { docs, session }) => {
      if (!mayRun(session)) return null;

      const schoolId = resolveSchoolId(session, query.schoolId);
      if (!schoolId) return null;

      const run = runOf(docs, params.runId, schoolId);
      if (!run) return null;
      if (!decisionsComplete(docs, run)) return null;

      const decisions = docs
        .find("promotionDecision", { runId: String(run._id), deletedAt: null })
        // `.sort({ fromClassName: 1, studentName: 1 })`. Nulls first in both,
        // then bytes; _id last because two pupils of the same name in the same
        // class is ordinary and the server has nothing to separate them.
        .sort(chain(asc("fromClassName"), asc("studentName"), byId));

      return ok({ data: { run, decisions } });
    },
  },

  {
    route: "GET /api/promotion/students/:studentId/history",

    /**
     * Where one pupil has sat, year by year. The basis of a transcript.
     *
     * ── The endpoint does not check that the pupil exists ─────────────────
     *
     * `Enrollment.find({ schoolId, studentId, deletedAt: null })` and nothing
     * else, so an id nobody has ever heard of answers 200 with an empty array
     * rather than 404. This machine cannot afford to copy that: "no enrolment
     * rows" is also what an unpulled mirror says, and an empty transcript for a
     * pupil who has been at the school five years is a document somebody would
     * hand to a parent.
     *
     * So the pupil is required to be in the mirror for this school — not as a
     * tenancy check, which the enrolment filter already does, but as this
     * machine's only evidence that it holds the school's roster at all. A pupil
     * it has never heard of goes to the network, where the honest answer is.
     * Soft-deleted and graduated pupils still answer, because the endpoint has
     * no status filter and their history is exactly what a leaver's transcript
     * needs.
     */
    handler: ({ params, query }, { docs, session }) => {
      if (!mayRun(session)) return null;

      const schoolId = resolveSchoolId(session, query.schoolId);
      if (!schoolId) return null;

      const studentId = String(params.studentId);
      const student = docs.get("student", studentId);
      if (!student || String(student.schoolId) !== String(schoolId)) return null;

      const rows = docs
        .find("enrollment", { schoolId, studentId, deletedAt: null })
        // `.sort({ academicYear: 1 })`. The unique index makes one live row per
        // pupil per year, so the tie-break is belt and braces rather than load
        // bearing — but a partial index only covers non-deleted rows and this
        // filter is the same one, so it costs nothing to be sure.
        .sort(chain(asc("academicYear"), byId));

      return ok({ count: rows.length, data: rows });
    },
  },
];

// Reached by writes/promotion.js, which has to answer PUT /progression with the
// same projection this file's GET uses. Not an element of the array, so
// index.js's spread never sees it.
module.exports.progressionRows = progressionRows;
module.exports.resolveSchoolId = resolveSchoolId;
module.exports.mayRun = mayRun;
