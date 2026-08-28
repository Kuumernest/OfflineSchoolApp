// desktop/src/main/api/writes/templates.js
"use strict";

/**
 * Duplicating, defaulting and deleting a report-card template, with no
 * connection.
 *
 * ── READ THIS BEFORE REGISTERING THE DUPLICATE ────────────────────────────
 *
 * POST /api/templates/:id/duplicate hard-codes `_id: uuidv4()` —
 * backend/src/routes/template.routes.js:493. Until that endpoint honours
 * `req.body._id`, the handler below is NOT safe to register: the queued request
 * would create a row on the server under a different id from the one this machine
 * wrote, the outbox would drain with a cheerful 201, and the local copy would sit
 * in the mirror for ever. No pull removes it — the feed only adds and updates —
 * so the phantom stays in the template list, and the first person who presses
 * "set as default" on it queues a PATCH the server answers 404 to, which stops
 * the whole outbox. That is how a create with no client id turns into a stuck
 * queue two steps later.
 *
 * The change also needs an ordering rule: look the row up BY ID before anything
 * else, and answer with the stored row, so that a replayed request which already
 * succeeded gets 201-and-the-row rather than a duplicate-key error. A duplicate
 * key surfaces as a 500, and a 500 is retryable — so the queue would not block on
 * it, it would retry it for ever.
 *
 * ── Three writes, and two things left alone ───────────────────────────────
 *
 * POST /api/templates and PUT /api/templates/:id are online-only, and the reason
 * is `unknownTokens`. Both endpoints answer with that key whenever the html
 * contains a placeholder the render engine cannot resolve, and the builder reads
 * it to keep the author on the page rather than navigating away — it is the only
 * warning anybody gets before {{avarage}} prints as literal braces on every
 * child's report card. Computing it needs the token vocabulary inside
 * backend/engine/placeholder.engine.js, which is derived from the render map on
 * purpose so it cannot drift. A copy of that list in the desktop is exactly the
 * drift it was built to prevent, and the case where the two would disagree is
 * precisely the case that matters: a template with no typo gets an identical
 * response either way, and a template WITH one silently loses its warning.
 *
 * So they are declined until the vocabulary is somewhere both packages can read
 * it. That is one file — shared/reportTokens.js holding what knownTokens()
 * enumerates, with the engine importing it rather than owning it — and it turns
 * both endpoints into ordinary queued writes. Proposed, not written: shared/ is
 * not mine to edit.
 *
 * ── One request, several rows ─────────────────────────────────────────────
 *
 * Setting a default is a two-document write at least: the new default is set and
 * the old one is cleared. `also` carries the cleared rows so they commit with the
 * request and are settled with it — a row written and not listed there stays
 * pending for ever, and a pending row is deliberately never overwritten by a
 * pull, so it would disagree with the school's record permanently rather than
 * until the next sync.
 */

const { randomUUID } = require("crypto");

/**
 * resolveSchoolId() from template.routes.js. See the note in handlers/templates.js:
 * for anybody who is not a super_admin the request's schoolId is IGNORED.
 */
const resolveSchoolId = (session, provided) => {
  if (session?.role === "super_admin" && provided) return String(provided).trim();
  return session?.schoolId ? String(session.schoolId) : null;
};

/** The router's single guard — reports.manage over all nine endpoints. */
const mayManage = (session) =>
  Array.isArray(session?.permissions) && session.permissions.includes("reports.manage");

/** findOne({ _id, schoolId, deletedAt: null }), or nothing — which sends it out. */
const target = (docs, id, schoolId) => {
  const row = docs.get("reportTemplate", String(id));
  if (!row) return null;
  if (String(row.schoolId) !== String(schoolId)) return null;
  if (row.deletedAt) return null;
  return row;
};

/** Non-deleted templates of one school — the set every updateMany here covers. */
const schoolTemplates = (docs, schoolId) =>
  docs.find("reportTemplate", { schoolId, deletedAt: null });

/**
 * `?schoolId=` put back on a replayed path.
 *
 * DELETE reads schoolId from the QUERY, and for a super_admin — the one role
 * that may act outside its own school — dropping it would send the request to a
 * different school's template.
 */
const withSchool = (path, provided) =>
  provided
    ? `${path}?schoolId=${encodeURIComponent(String(provided).trim())}`
    : path;

module.exports = [
  {
    route: "POST /api/templates/:id/duplicate",

    /**
     * A copy to experiment on, so the layout every card is printed from is not
     * the one being edited.
     *
     * Nothing is computed: the endpoint copies html, css and variables across
     * verbatim, resets version to 1, forces isDefault false and appends
     * " (Copy)" to the name. It does NOT re-scan the html for placeholders — a
     * copy inherits whatever `variables` the original had, stale or not. That
     * looks like an oversight and is reproduced anyway: the two lists would
     * disagree about how many placeholders a template has, which is a number the
     * template card prints.
     *
     * See the file header before registering this. It depends on the endpoint
     * accepting a client-supplied _id.
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!mayManage(session)) return null;

      const schoolId = resolveSchoolId(session, body.schoolId);
      if (!schoolId) return null;

      const original = target(docs, params.id, schoolId);
      if (!original) return null;   // the 404 is the server's to answer

      const id  = body._id ? String(body._id) : randomUUID();
      const now = new Date().toISOString();

      const doc = {
        _id:       id,
        schoolId,
        name:      `${original.name} (Copy)`,
        html:      original.html,
        css:       original.css || "",
        isDefault: false,
        version:   1,
        variables: original.variables || [],
        // The authenticated user is who the server stamps, and session.userId IS
        // that user — so this is the same value rather than a guess that would be
        // overwritten and show the wrong name in the meantime.
        createdBy: session?.userId ?? null,
        updatedBy: session?.userId ?? null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return {
        collection: "reportTemplate",
        doc,
        request: {
          method: "POST",
          path:   `/api/templates/${original._id}/duplicate`,
          // The id goes INTO the body: it is what makes a replay find the row
          // rather than create a second copy.
          body:   { ...body, _id: id },
          // No dedupeKey. Two presses of Copy are two copies on the server as
          // well — the endpoint has no uniqueness check and a school may
          // genuinely want two — and a key that collapsed them would drop one
          // the admin meant. Nothing here is unsafe to have twice.
        },
        // 201 and the endpoint's shape. `id` is there on purpose: the response
        // is built with toObject(), the schema sets toObject: { virtuals: true },
        // and mongoose's default `id` virtual therefore rides along. The row
        // STORED has no `id`, because the sync feed uses .lean() and lean rows
        // carry no virtuals — so the mirror keeps the feed's shape and the
        // response keeps the endpoint's.
        response: {
          status: 201,
          data:   { success: true, template: { ...doc, id } },
        },
      };
    },
  },

  {
    route: "PATCH /api/templates/:id/default",

    /**
     * Choosing which layout every report card in the school is rendered from.
     *
     * ── The unbounded updateMany, and what `also` can honestly say about it ──
     *
     * The endpoint clears the flag with
     * `updateMany({ schoolId, deletedAt: null }, { $set: { isDefault: false } })`
     * — every non-deleted template of the school, not just the current default,
     * and not excluding the target. Two things follow.
     *
     * First, the set is bounded and this machine holds all of it: reportTemplate
     * is mirrored whole, gated on the same reports.manage the router requires, so
     * anybody who can reach this endpoint has every row it touches. `also` can
     * therefore name them rather than approximate them.
     *
     * Second, mongoose adds `$set: { updatedAt: now }` to update queries, so the
     * rows that CHANGE are all of them, even the ones already false. `also` does
     * not list them all anyway, and the reason is which way the mirror heals:
     *
     *   listing them with a bumped updatedAt   if the server ever stopped bumping
     *                                          it, the local timestamp would be
     *                                          newer than the server's, the pull
     *                                          would never re-offer the row, and
     *                                          the list order would stay wrong
     *                                          for ever.
     *   leaving their timestamps alone         the server's copy is newer, the
     *                                          pull delivers it, the mirror
     *                                          corrects itself next cycle.
     *
     * Only one of those is self-healing, so only the rows whose isDefault
     * actually flips are written here — which is the part a screen can see. The
     * timestamps arrive with the pull.
     *
     * ── Setting the default on the template that already has it declines ────
     *
     * Because the endpoint does not do what its name says in that case. It clears
     * isDefault on every row INCLUDING the target, then assigns
     * `template.isDefault = true` on a document loaded before the updateMany —
     * which already held true, so mongoose marks nothing modified, `save()` finds
     * no delta and issues no write at all. The school ends up with NO default
     * template: GET /templates/default answers 404, DELETE stops refusing, and
     * any report card rendered without an explicit templateId has nothing to
     * render from.
     *
     * The console hides the button on the row that is already default, so nothing
     * reaches it today and declining costs nobody anything. Reproducing it would
     * mean writing "no default" into the mirror on an action whose whole point is
     * to set one; queueing the request and mirroring the intent would mean the
     * screen and the server disagreeing until a pull corrected the screen the
     * wrong way. Neither is an answer this layer should give. Reported instead —
     * the fix belongs on the server.
     */
    handler: ({ params, body, query }, { docs, session }) => {
      if (!mayManage(session)) return null;

      // Body first, then query — the endpoint reads `req.body.schoolId ||
      // req.query.schoolId`, and it is the only one in the router that takes
      // either.
      const provided = body.schoolId || query.schoolId;
      const schoolId = resolveSchoolId(session, provided);
      if (!schoolId) return null;

      const row = target(docs, params.id, schoolId);
      if (!row) return null;         // the 404 is the server's

      if (row.isDefault) return null;   // see the docstring: the server no-ops

      const now = new Date().toISOString();

      // Every other row still carrying the flag, not just one. Nothing enforces
      // a single default — a raw import or a sequence of PUTs can leave two —
      // and the updateMany clears all of them, so all of them are recorded.
      const cleared = schoolTemplates(docs, schoolId)
        .filter((t) => String(t._id) !== String(row._id) && t.isDefault)
        .map((t) => ({ collection: "reportTemplate", doc: { ...t, isDefault: false } }));

      // updatedAt bumped only here: this is the row the endpoint calls save() on,
      // and save() is what runs the timestamp hook. version is NOT bumped —
      // only PUT does that, and a template card prints the number.
      const doc = { ...row, isDefault: true, updatedAt: now };

      return {
        collection: "reportTemplate",
        doc,
        also: cleared,
        request: {
          method: "PATCH",
          // The schoolId travels in the body when the caller put it there, which
          // the console does. Appended to the query only when it did not, so a
          // super_admin's request still names the school it was meant for.
          path: body.schoolId
            ? `/api/templates/${row._id}/default`
            : withSchool(`/api/templates/${row._id}/default`, query.schoolId),
          body,
          // No dedupeKey: the local row is default the moment this commits, so
          // the guard above declines every repeat before it reaches the queue.
        },
        // A message, not the template — the endpoint returns no row here, and the
        // screen re-reads the list afterwards.
        response: {
          status: 200,
          data:   { success: true, message: "Default template updated" },
        },
      };
    },
  },

  {
    route: "DELETE /api/templates/:id",

    /**
     * Binning a layout. Soft: deletedAt is stamped and the row stays.
     *
     * ── The refusal that has to be checked here ────────────────────────────
     *
     * The endpoint answers 400 for the DEFAULT template — "Set another template
     * as default first" — and a queued 400 does not merely fail, it blocks the
     * outbox and holds up everything behind it, including work from other parts
     * of the school. So the flag is read locally and the request is never queued.
     *
     * The console checks the same thing before calling, but that is a courtesy
     * and not a guarantee: the check that matters is the one in front of the
     * queue.
     *
     * There is NO refusal for the last remaining template — a school may delete
     * every non-default template it has, and a school whose only template was the
     * default cannot delete it at all. Nothing extra to check.
     *
     * ── No dedupeKey ──────────────────────────────────────────────────────
     *
     * The local row is soft-deleted in the same transaction that queues the
     * request, so target() declines the second click before it reaches the queue.
     * A key here could never fire.
     */
    handler: ({ params, query }, { docs, session }) => {
      if (!mayManage(session)) return null;

      const schoolId = resolveSchoolId(session, query.schoolId);
      if (!schoolId) return null;

      const row = target(docs, params.id, schoolId);
      if (!row) return null;            // the 404 is the server's

      if (row.isDefault) return null;   // the 400 — see the docstring

      const now = new Date().toISOString();

      // deletedAt and updatedAt together: the endpoint sets deletedAt and calls
      // save(), and save() runs the timestamp hook. version stays put.
      const doc = { ...row, deletedAt: now, updatedAt: now };

      return {
        collection: "reportTemplate",
        doc,
        request: {
          method: "DELETE",
          path:   withSchool(`/api/templates/${row._id}`, query.schoolId),
          body:   null,
        },
        // The endpoint returns a message, not the template.
        response: {
          status: 200,
          data:   { success: true, message: "Template deleted" },
        },
      };
    },
  },
];
