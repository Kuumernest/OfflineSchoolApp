// desktop/src/main/api/writes/promotion.js
"use strict";

/**
 * Promotion writes: the map, and one pupil's decision inside a draft.
 *
 * ── Four of the six writes in this router are online-only ─────────────────
 *
 * POST /runs, DELETE /runs/:id, POST /runs/:id/commit and POST /runs/:id/reverse
 * are not here. Each for a different reason, and each reason is the kind that
 * does not soften with effort:
 *
 *   POST /runs  — generateRun() reads every approved pupil in the school and
 *     aggregates every PUBLISHED ResultSummary of the outgoing year, then writes
 *     one decision row per pupil. The number of rows is a property of the
 *     school, not of the request, and the request body says nothing about it. It
 *     also mints its own ids: PromotionRun.create() and the decisions'
 *     insertMany() both take uuidv4() from the schema default and the route never
 *     reads req.body._id, so a queued create would come back describing rows this
 *     machine has never heard of while the rows it invented sat orphaned. And the
 *     409 it can answer (RUN_EXISTS) comes from a partial unique index over the
 *     school's whole run collection — state a mirror may be a sync behind on.
 *
 *   DELETE /runs/:id — deleteMany on the decisions and deleteOne on the run.
 *     HARD deletes, both. A write here can only put a row; there is no way to ask
 *     for one to be forgotten, and the feed only ever sends documents that exist,
 *     so a hard-deleted run is never mentioned again and its local copy would
 *     stay on the review screen for ever. Faking it with a local deletedAt would
 *     be worse: the read handlers filter on deletedAt, so the row would vanish
 *     from this machine and reappear from no pull, and the run would look
 *     discarded on the desktop and drafted everywhere else.
 *
 *   POST /runs/:id/commit — this is the act. It writes two Enrollment upserts and
 *     a Student update per pupil, for every pupil in the school, and it is the
 *     one place where a screen saying "done" while nothing has happened does real
 *     damage: a school prints class lists off it. It also refuses on state only
 *     the server can total — UNASSIGNED counts every decision row, including any
 *     an office on another machine changed five minutes ago.
 *
 *   POST /runs/:id/reverse — same shape, and it DELETES the incoming year's
 *     enrolments, which is the removal a queued write cannot express either.
 *
 * ── What reversal does not restore, which is worth knowing here ───────────
 *
 * reverseRun() puts every pupil back using the decision's own fromClassId, so
 * that part is exact. It does not restore the outgoing year's enrolment row: the
 * commit UPSERTS that row and overwrites classId, className and outcome on
 * whatever was already there, and the reversal only sets outcome back to null.
 * A pupil who had been moved between classes mid-year, or whose enrolment had
 * been corrected by hand, does not get that correction back. Nor is the incoming
 * year's row safe: the commit stamps promotionRunId onto a row that already
 * existed, and the reversal deletes by that stamp — so a rollover that landed on
 * a pre-existing enrolment destroys it on the way out. Neither is a reason a
 * mirror could fix; both are reasons not to pretend either verb is local.
 *
 * ── What IS here ──────────────────────────────────────────────────────────
 *
 * The progression map, which is configuration a head fixes before generating
 * anything and is bounded entirely by the payload they typed. And overriding one
 * pupil's decision inside a DRAFT, which changes one decision row and the run's
 * count block and touches no pupil at all — nothing about a child changes until
 * commit, and commit is not local.
 */

const promotionReads = require("../handlers/promotion");

const { progressionRows, resolveSchoolId, mayRun } = promotionReads;

const nowIso = () => new Date().toISOString();

/** findOne({ _id, schoolId, deletedAt: null }) over one mirrored collection. */
const live = (docs, collection, id, schoolId) => {
  if (!id) return null;
  const row = docs.get(collection, String(id));
  if (!row) return null;
  if (String(row.schoolId) !== String(schoolId)) return null;
  if (row.deletedAt) return null;
  return row;
};

/** The mirror's local flag is not part of any document. */
const bare = (row) => {
  const { _pending, ...rest } = row;
  return rest;
};

module.exports = [
  {
    route: "PUT /api/promotion/progression",

    /**
     * Set which class leads to which, for as many classes as were sent.
     *
     * ── Why a multi-document write is safe here and not in commit ──────────
     *
     * Because the number of documents is the length of `entries`, which is the
     * payload. Nothing is read out of the school to decide the size of the work:
     * every row this touches is named in the request, and every one of them is
     * already in the mirror or the handler declines. That is the whole difference
     * between this and the rollover, which decides how much to write by counting
     * pupils.
     *
     * ── The update sets exactly two fields ────────────────────────────────
     *
     * `Class.updateOne(filter, { nextClassId, isFinalYear })` — mongoose wraps a
     * bare update in $set, so nothing else on the class is touched. The local
     * merge does the same and keeps every sibling key, which matters: a class row
     * carries capacity, section, isActive and createdBy, and this screen has
     * never heard of any of them.
     *
     * Both fields are ALWAYS written. `Boolean(e.isFinalYear)` means an entry
     * that omits the flag stores `false`, not nothing, and
     * `e.isFinalYear ? null : nextId` means marking a class final-year clears its
     * destination rather than leaving a stale one behind. So after this call the
     * two keys exist on every class named — which is why the read projection is
     * written to copy key PRESENCE and not to fill blanks in.
     *
     * ── Where the server would half-apply, this declines ──────────────────
     *
     * The endpoint validates and writes in the SAME loop: a bad destination on
     * the fifth entry answers 404 with the first four already written. That is
     * not something a mirror should reproduce — a partial local write plus a
     * queued request the server will refuse is a stuck outbox — so every entry is
     * checked first and the whole request goes to the network if any of them
     * fails. Being stricter than the server is invisible; being looser stops the
     * queue.
     */
    handler: ({ body }, { docs, session }) => {
      if (!mayRun(session)) return null;

      const schoolId = resolveSchoolId(session, body.schoolId);
      if (!schoolId) return null;

      const entries = body.entries;
      // `entries must be an array` — the endpoint's 400.
      if (!Array.isArray(entries)) return null;
      // An empty array is a 200 on the server that writes nothing. A write here
      // has to produce at least one row, so the read path answers this shape
      // better than a queue entry that changes nothing ever could.
      if (!entries.length) return null;
      // A null or primitive entry makes the endpoint throw inside its own
      // .map(), which surfaces as a 500. Not something to queue.
      if (entries.some((e) => !e || typeof e !== "object")) return null;

      const ownIds = new Set(entries.map((e) => String(e.classId)));

      // Every named class must be this school's and not deleted — the endpoint's
      // CLASS_NOT_FOUND, checked for all of them before anything is written,
      // exactly as the endpoint's own $in query does.
      for (const id of ownIds) {
        if (!live(docs, "class", id, schoolId)) return null;
      }

      const changed = new Map();

      for (const e of entries) {
        const classId = String(e.classId);
        const nextId  = e.nextClassId ? String(e.nextClassId) : null;

        // A class that led to itself would promote a year group into the room it
        // just left, which reads as a successful rollover and is not one.
        if (nextId && nextId === classId) return null;

        // Checked even when isFinalYear is set, because the endpoint checks it
        // there too — the destination is validated before the branch that throws
        // it away, so { isFinalYear: true, nextClassId: "nonsense" } is a 404 and
        // not a silent success.
        if (nextId && !ownIds.has(nextId) && !live(docs, "class", nextId, schoolId)) {
          return null;
        }

        // Later entries for the same class win, as they do server-side: the
        // endpoint issues one updateOne each, in order.
        const base = changed.get(classId) ?? bare(docs.get("class", classId));

        changed.set(classId, {
          ...base,
          nextClassId: e.isFinalYear ? null : nextId,
          isFinalYear: Boolean(e.isFinalYear),
          // mongoose stamps this on an update query; a row left with its old
          // timestamp would be handed back by the next overlapping pull and
          // quietly revert what was just set.
          updatedAt: nowIso(),
        });
      }

      const rows = [...changed.values()];

      return {
        collection: "class",
        doc: rows[0],
        also: rows.slice(1).map((doc) => ({ collection: "class", doc })),
        request: {
          method: "PUT",
          path:   "/api/promotion/progression",
          // Verbatim. The endpoint reads entries and nothing else, and a
          // reconstructed body would send back fields nobody touched.
          body,
        },
        /**
         * The reply is the map re-read, so it has to be computed after the rows
         * land — hence the function form.
         *
         * Note what it does NOT carry: `incomplete`. The GET reports it and the
         * PUT does not, and a screen reading the PUT's answer for it would get
         * undefined. Reproduced as written.
         */
        response: (ctx) => {
          const data = progressionRows(ctx.docs, schoolId) ?? [];
          return { status: 200, data: { success: true, count: data.length, data } };
        },
      };
    },
  },

  {
    route: "PATCH /api/promotion/runs/:runId/decisions/:studentId",

    /**
     * Override what the draft proposes for one pupil.
     *
     * ── Note the parameter: it is the PUPIL's id, not the decision's ───────
     *
     * `/decisions/:studentId`, and the service looks the row up by
     * { runId, studentId }. A screen holding decision._id and putting it in the
     * path would 404 every time. Mirrored with the same key, so the two agree
     * about what the segment means.
     *
     * ── Two documents, and both are computable from the payload ────────────
     *
     * The decision row, and the run's `counts` block, which the service
     * recomputes from every decision of the run after each override. The second
     * is why the completeness check below is not optional: a tally taken over a
     * mirror that holds half the decisions would put a wrong total on the run,
     * and the run row is stored PENDING, which a pull deliberately refuses to
     * overwrite. It would settle eventually — the replayed PATCH makes the server
     * recompute the same block and the next pull brings the true one back — but
     * in between, the review screen's "12 unassigned" would be a number nobody
     * can act on.
     *
     * ── Nothing about a child changes here ────────────────────────────────
     *
     * Which is the reason this one is queueable at all. A decision is a proposal
     * inside a draft; the pupil's classId, their enrolments and their status are
     * untouched until commit, and commit is online-only. So the worst a queued
     * override can be is a draft that differs from the school's for a few hours,
     * which is what a draft is for.
     *
     * ── The staleness this cannot rule out ────────────────────────────────
     *
     * The run must be a draft, and "is it still a draft" is the server's fact.
     * If somebody commits or discards the run from the web while this machine is
     * offline, the replay gets 409 NOT_DRAFT or 404 and blocks the outbox until a
     * person clears it. That risk is accepted here on the same terms as
     * withdrawing an approval request or renaming an exam: the local state is
     * checked, the window is short, and the person overriding decisions is the
     * same person who would be committing. It is written down because it is the
     * one way this write can fail.
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!mayRun(session)) return null;

      const schoolId = resolveSchoolId(session, body.schoolId);
      if (!schoolId) return null;

      // "unassigned" is deliberately NOT accepted — a head may decide, not
      // un-decide, and the endpoint's 400 says so.
      const outcome = body.outcome;
      if (!["promoted", "repeated", "graduated"].includes(outcome)) return null;

      const runId = String(params.runId);
      const run   = live(docs, "promotionRun", runId, schoolId);
      if (!run) return null;
      // `This run is already committed` / `reversed` — 409 NOT_DRAFT.
      if (run.status !== "draft") return null;

      const held = docs.count("promotionDecision", { runId, deletedAt: null });
      if (typeof run.counts?.total !== "number" || held !== run.counts.total) return null;

      const studentId = String(params.studentId);
      const existing = docs
        .find("promotionDecision", { runId, studentId, deletedAt: null })
        .sort((a, b) => String(a._id).localeCompare(String(b._id)))[0];
      if (!existing) return null;

      // A promotion or a repeat must land somewhere real; graduating lands
      // nowhere on purpose. Both of the endpoint's refusals — the 400 for a
      // missing destination and the 404 for one that is not this school's.
      let toClassId = null;
      let toClassName = null;
      if (outcome === "promoted" || outcome === "repeated") {
        if (!body.toClassId) return null;
        const target = live(docs, "class", body.toClassId, schoolId);
        if (!target) return null;
        toClassId   = String(body.toClassId);
        toClassName = target.name;
      }

      /**
       * The endpoint answers with a HYDRATED mongoose document, not a lean row.
       *
       * `decision.save()` then `res.json(decision)` runs toJSON, which emits
       * every path the schema declares — including a default for a key the stored
       * document does not have. PromotionDecision has no toJSON options, so there
       * is no `id` virtual to add; what there is, is nine defaults. A decision
       * written by generateRun() through insertMany() already carries all of
       * them, so in practice the merge below changes nothing — but a row that
       * reached the mirror any other way would answer short, and the difference
       * would be a screen missing `overridden` immediately after somebody set it.
       */
      const defaults = {
        studentName:   null,
        enrollmentNo:  null,
        fromClassId:   null,
        fromClassName: null,
        toClassId:     null,
        toClassName:   null,
        outcome:       "unassigned",
        basis:         "no_results",
        average:       null,
        overridden:    false,
        deletedAt:     null,
      };

      const decision = {
        ...defaults,
        ...bare(existing),
        outcome,
        toClassId,
        toClassName,
        // The basis stops being a machine's reading of the marks the moment a
        // person overrules it, and `overridden` is what makes the override
        // survive a recount.
        basis:      "manual",
        overridden: true,
        updatedAt:  nowIso(),
      };

      // refreshCounts(): the tally is taken over the run's decisions with this
      // one already changed, which is what the server does — it saves first and
      // re-reads afterwards.
      const all = docs
        .find("promotionDecision", { runId, deletedAt: null })
        .map((d) => (String(d._id) === String(decision._id) ? decision : d));

      const counts = {
        total:      all.length,
        promoted:   all.filter((d) => d.outcome === "promoted").length,
        repeated:   all.filter((d) => d.outcome === "repeated").length,
        graduated:  all.filter((d) => d.outcome === "graduated").length,
        unassigned: all.filter((d) => d.outcome === "unassigned").length,
      };

      const runDoc = { ...bare(run), counts, updatedAt: nowIso() };

      return {
        collection: "promotionDecision",
        doc: decision,
        // Recorded on the queue entry too, or the run row stays pending for ever
        // — and a pending row is never overwritten by a pull, so its counts would
        // disagree with the school's permanently rather than until the next sync.
        also: [{ collection: "promotionRun", doc: runDoc }],
        request: {
          method: "PATCH",
          path:   `/api/promotion/runs/${runId}/decisions/${studentId}`,
          // As it arrived. No dedupeKey: two overrides of the same pupil are two
          // different intents — "repeat her" then "no, promote her" — and
          // suppressing the second would leave the school with the first.
          body,
        },
        response: { status: 200, data: { success: true, data: decision, counts } },
      };
    },
  },
];
