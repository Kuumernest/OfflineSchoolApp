// desktop/src/main/api/writes/exams.js
"use strict";

/**
 * Creating, editing, re-staging and archiving an exam, with no connection.
 *
 * ── The first edit shapes in this layer ────────────────────────────────────
 *
 * Everything queued until now was a create. An edit brings a rule a create can
 * avoid: the queued request must carry only the fields the user actually
 * changed. PUT /api/exams/:id builds its update from `field !== undefined`, so a
 * local handler that helpfully filled in the whole document would send back
 * values nobody touched — and overwrite whatever the office changed on another
 * machine in the meantime. What the user changed is what gets sent.
 *
 * The same rule decides the local row: the mirror is MERGED, not replaced, so a
 * field absent from the request keeps the value it already had.
 *
 * ── An id the server now accepts ──────────────────────────────────────────
 *
 * POST /api/exams called uuidv4() unconditionally until the change that came
 * with these handlers. That made the create unqueueable rather than merely
 * awkward: the reply would describe an exam this machine had never heard of,
 * while the row it did write sat orphaned in the mirror. The endpoint keeps a
 * supplied _id now, as POST /api/fees/payments already did.
 *
 * ── Two things here are deliberately left to the server ───────────────────
 *
 *   an invalid status      PATCH /:id/status answers 400 for anything outside
 *                          its list. Raising that error locally would be a
 *                          second implementation of one validation, so the
 *                          request goes out and the server refuses it.
 *
 *   publishing results     status "published" also marks every ResultSummary
 *                          for the exam published — one request changing an
 *                          unbounded number of documents, which this layer's
 *                          write contract (one row, one request) cannot express
 *                          honestly. Recorded in coverage.js as a partial.
 */

const { randomUUID } = require("crypto");

/** The statuses PATCH /:id/status accepts. Anything else is the server's to refuse. */
const STATUSES = ["draft", "scheduled", "ongoing", "completed", "published", "archived"];

/**
 * What the server's resolveClassData() produces, from the mirrored classes.
 *
 * Ordered by the ids as given and silently dropping ones that do not resolve —
 * both of which the server does, and both of which a screen can see: className
 * is what it prints.
 */
const classData = (docs, ids) => {
  if (!ids || ids.length === 0) {
    return { primaryClassId: null, primaryClassName: null, classIds: [], classNames: null };
  }
  const found = ids
    .map((id) => ({ id: String(id), row: docs.get("class", String(id)) }))
    .filter((c) => c.row);

  return {
    primaryClassId:   found[0]?.id ?? null,
    primaryClassName: found[0]?.row?.name ?? null,
    classIds:         found.map((c) => c.id),
    classNames:       found.map((c) => c.row.name).join(", ") || null,
  };
};

/** resolveClassIdsFromBody, as the endpoint does it — three accepted spellings. */
const classIdsFrom = (body) => {
  const { classes, classIds, classId } = body;
  if (Array.isArray(classes) && classes.length > 0) {
    return classes
      .map((c) => (typeof c === "object" ? String(c._id || c.id || c.classId || c) : String(c)))
      .filter(Boolean);
  }
  if (Array.isArray(classIds) && classIds.length > 0) return classIds.map(String).filter(Boolean);
  if (classId) return [String(classId)];
  return [];
};

/** The exam this request is for, or nothing — which sends the request out. */
const target = (docs, { params, schoolId }) => {
  const row = docs.get("exam", String(params.id));
  if (!row) return null;
  if (String(row.schoolId) !== String(schoolId)) return null;
  if (row.deletedAt) return null;
  return row;
};

module.exports = [
  {
    route: "POST /api/exams",

    /**
     * A new exam.
     *
     * Declines when `subjects` is present. The endpoint then creates an
     * ExamSubject per entry, with ids it generates itself — several documents
     * from one request, and no way for this layer to write rows the server will
     * agree with afterwards. POST /api/exams/:examId/subjects exists for adding
     * them one at a time, so nothing is out of reach; it is one request that
     * cannot be queued rather than a capability that is missing.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // The server's own validation, and its 400s are its to raise.
      if (!String(body.name ?? "").trim()) return null;
      if (!body.academicYear) return null;
      if (!body.term)         return null;

      if (Array.isArray(body.subjects) && body.subjects.length > 0) return null;

      const id  = randomUUID();
      const now = new Date().toISOString();
      const cls = classData(docs, classIdsFrom(body));

      const doc = {
        _id:                id,
        schoolId,
        classId:            cls.primaryClassId,
        className:          cls.primaryClassName,
        classIds:           cls.classIds,
        classNames:         cls.classNames,
        name:               String(body.name).trim(),
        type:               body.type         || "first_test",
        academicYear:       body.academicYear,
        term:               body.term,
        startDate:          body.startDate    || null,
        endDate:            body.endDate      || null,
        description:        body.description   || null,
        instructions:       body.instructions || null,
        totalMarks:         body.totalMarks   ?? 100,
        passMark:           body.passMark     ?? 50,
        status:             body.status       || "draft",
        resultsPublished:   false,
        resultsLockedAt:    null,
        resultsPublishedAt: null,
        publishedBy:        null,
        createdBy:          session?.userId ?? null,
        updatedBy:          null,
        syncStatus:         "synced",
        lastSyncedAt:       null,
        deletedAt:          null,
        createdAt:          now,
        updatedAt:          now,
      };

      return {
        collection: "exam",
        doc,
        request: {
          method: "POST",
          path:   "/api/exams",
          // The id goes INTO the body: it is what makes the replay find the row
          // rather than create a second exam.
          body:   { ...body, _id: id },
        },
        // 201 and the endpoint's own shape, including the empty subjects array a
        // freshly created exam carries.
        response: {
          status: 201,
          data: { success: true, exam: { ...doc, subjects: [] }, serverId: id },
        },
      };
    },
  },

  {
    route: "PUT /api/exams/:id",

    /**
     * An edit.
     *
     * Only what the caller sent, for the reason in the file note: sending the
     * whole document would quietly revert a change made elsewhere.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const row = target(docs, { params, schoolId });
      if (!row) return null;   // a 404 is the server's answer to give

      const fields = [
        "name", "type", "academicYear", "term", "startDate", "endDate",
        "description", "instructions", "totalMarks", "passMark", "status",
      ];

      const updates = {};
      for (const field of fields) {
        if (body[field] === undefined) continue;
        updates[field] = field === "name" ? String(body[field]).trim() : body[field];
      }
      updates.updatedBy = session?.userId ?? null;

      // Classes only when the request names some — matching the endpoint, which
      // leaves them alone otherwise rather than clearing them.
      const ids = classIdsFrom(body);
      if (ids.length > 0) {
        const cls = classData(docs, ids);
        updates.classId    = cls.primaryClassId;
        updates.className  = cls.primaryClassName;
        updates.classIds   = cls.classIds;
        updates.classNames = cls.classNames;
      }

      const doc = { ...row, ...updates, updatedAt: new Date().toISOString() };

      return {
        collection: "exam",
        doc,
        request: { method: "PUT", path: `/api/exams/${row._id}`, body },
        response: { status: 200, data: { success: true, exam: doc } },
      };
    },
  },

  {
    route: "PATCH /api/exams/:id/status",

    /**
     * Moving an exam through its stages — draft to scheduled to ongoing.
     *
     * "published" is declined: see the file note. It also marks every
     * ResultSummary for the exam published, which is one request against an
     * unbounded number of documents.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const status = body.status;
      if (!STATUSES.includes(status)) return null;   // the server's 400
      if (status === "published")     return null;   // see the docstring

      const row = target(docs, { params, schoolId });
      if (!row) return null;

      const doc = {
        ...row,
        status,
        updatedBy: session?.userId ?? null,
        updatedAt: new Date().toISOString(),
      };

      return {
        collection: "exam",
        doc,
        request: { method: "PATCH", path: `/api/exams/${row._id}/status`, body },
        response: { status: 200, data: { success: true, exam: doc } },
      };
    },
  },

  {
    route: "DELETE /api/exams/:id",

    /**
     * Archiving an exam. A soft delete: deletedAt is set and the status becomes
     * "archived", which is what the endpoint does.
     *
     * ── Why there is no dedupe key here ────────────────────────────────────
     *
     * There was one, on the reasoning that a request queued twice would meet an
     * exam already gone, take the endpoint's 404, and stop the queue on work
     * that had in fact succeeded.
     *
     * It could never fire. The local row is archived in the same transaction
     * that queues the request, so target() declines every later attempt — the
     * second click does not reach the queue at all, it goes to the network and
     * the server answers the 404 there, which is the right place for it.
     *
     * The outbox's dedupe_key stays for shapes that do need it (a write whose
     * local row is unchanged, so nothing declines the repeat); a guard that
     * cannot fire, with a comment claiming it protects something, is worse than
     * no guard. Pinned by the parity round trip.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const row = target(docs, { params, schoolId });
      if (!row) return null;

      const doc = {
        ...row,
        status:    "archived",
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return {
        collection: "exam",
        doc,
        request: {
          method: "DELETE",
          // The query goes back with it: this endpoint reads schoolId from the
          // query string, and for a super_admin — the one role that may act
          // outside its own school — dropping it would send the request to a
          // different school's exam.
          path: `/api/exams/${row._id}` +
            (query.schoolId ? `?schoolId=${encodeURIComponent(String(query.schoolId).trim())}` : ""),
          body: null,
        },
        // The endpoint returns a message, not the exam.
        response: { status: 200, data: { success: true, message: "Exam archived" } },
      };
    },
  },
];
