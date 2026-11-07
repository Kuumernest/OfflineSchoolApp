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
 *   create with subjects   POST /api/exams with a subjects array creates
 *                          ExamSubject entries inline with server-generated ids.
 *                          The local handler cannot queue those, so the UI should
 *                          create the exam first and add subjects one at a time.
 */

const { randomUUID } = require("crypto");
const { computeGrade } = require("../gradeUtils");

/** Exam.term as the server's schema holds it: an integer 1-3 (a numeric string casts). */
const isTermNumber = (term) => {
  const n = Number(term);
  return term !== null && term !== "" && Number.isInteger(n) && n >= 1 && n <= 3;
};

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

/**
 * The sequence as it is stored: a number, or null.
 *
 * Blank means "no sequence" rather than "leave it alone" — a promotion exam
 * belongs to none — so it becomes null rather than the empty string a select
 * hands over.
 */
const sequenceOf = (value) =>
  value === null || value === undefined || value === "" ? null : Number(value);

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
      // The server's 1-3 (its 400 "term must be 1-3"); a label such as
      // "Term 1" or a 4 is its refusal to give, not a row to store here.
      if (!isTermNumber(body.term)) return null;

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
        type:               body.type         || "test",
        academicYear:       body.academicYear,
        term:               Number(body.term),
        // Which sequence this is, and so whether the card printed from it is a
        // sequence card. Neither this nor the edit below read it, so an exam
        // created offline came out belonging to no sequence — the same fault
        // the endpoint had, and it has to be mirrored to agree with it.
        sequenceNumber:     sequenceOf(body.sequenceNumber),
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

      if (body.term !== undefined && !isTermNumber(body.term)) return null;

      const updates = {};
      for (const field of fields) {
        if (body[field] === undefined) continue;
        updates[field] = field === "name" ? String(body[field]).trim()
          : field === "term" ? Number(body[field])
          : body[field];
      }

      // Separately from the loop, because blank has to become null here rather
      // than the empty string: the key being present is the instruction, and
      // clearing the sequence is a thing an edit is allowed to say.
      if (body.sequenceNumber !== undefined) {
        updates.sequenceNumber = sequenceOf(body.sequenceNumber);
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
     * "published" is handled locally too: it marks every ResultSummary for the
     * exam as published, which is one request against an unbounded number of
     * documents. The local handler enumerates all ResultSummaries in the mirror
     * and marks them via `also`, so the screen shows published results
     * immediately. The mirror holds all of them — resultSummary is in the sync
     * feed unscoped, on results.view — so the enumeration is complete rather
     * than a partial guess.
     *
     * Publishing is the one status with effects outside this exam, and those
     * effects are what a parent then reads. The server gates the whole route on
     * exams.manage; a session that cannot prove that capability would have this
     * accepted locally, show published results on the strength of it, and then
     * be refused by the server — which stops the outbox for the entire school.
     * So publishing specifically is checked here.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const status = body.status;
      if (!STATUSES.includes(status)) return null;   // the server's 400

      if (status === "published"
          && !session?.permissions?.includes("exams.manage")) return null;

      const row = target(docs, { params, schoolId });
      if (!row) return null;

      const now = new Date().toISOString();

      const doc = {
        ...row,
        status,
        updatedBy: session?.userId ?? null,
        updatedAt: now,
      };

      // "published" also marks every ResultSummary for the exam as published.
      // Enumerate them all from the mirror — the collection is bounded by the
      // exam's students, and the mirror holds all of them for this school.
      const also = [];
      if (status === "published") {
        doc.resultsPublished   = true;
        doc.resultsPublishedAt = now;
        doc.publishedBy        = session?.userId ?? null;

        const summaries = docs.find("resultSummary", { examId: row._id, schoolId });
        for (const s of summaries) {
          also.push({
            collection: "resultSummary",
            doc: {
              ...s,
              isPublished: true,
              publishedAt: now,
            },
          });
        }
      }

      return {
        collection: "exam",
        doc,
        also,
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

  // ─────────────────────────────────────────────────────────
  // POST /api/exams/:examId/scores/bulk
  // ─────────────────────────────────────────────────────────
  //
  // Writing a whole sheet of marks at once. Grade fields (percentage, grade,
  // remark, isPassing) are computed here, mirroring the server's computeGrade
  // so the marksheet screen shows the same per-subject grade before sync.
  //
  // Process is NOT run locally: it needs every subject in the exam, not just
  // the one being scored. The request is queued and the server recomputes
  // from the complete sheet — strict queue ordering guarantees it.
  //
  {
    route: "POST /api/exams/:examId/scores/bulk",

    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const examId = String(params.examId);
      const exam   = docs.get("exam", examId);
      if (!exam) return null;
      if (String(exam.schoolId) !== String(schoolId)) return null;
      if (exam.deletedAt) return null;

      const { classId, subjectId } = body;
      // The server's rule: a draft leaves blank rows alone; a submit with a
      // blank for a present pupil is refused (400) — so it is declined here
      // rather than queued, where a refusal would stop the outbox.
      const draft   = body.draft === true || body.draft === "true";
      const isBlank = (r) => r && !r.isAbsent && !r.isExempt &&
        (r.score === null || r.score === undefined || r.score === "");
      if (!draft && Array.isArray(body.scores) && body.scores.some(isBlank)) return null;
      const scores = Array.isArray(body.scores) && draft ? body.scores.filter((r) => !isBlank(r)) : body.scores;
      if (!Array.isArray(scores) || scores.length === 0) return null;

      // By schoolId: GradingConfig's _id is a Mongo ObjectId, not the school's
      // id, so get(…, schoolId) never found the school's bands and every mark
      // was graded on the built-in scale (docs/39 §4.6b).
      const gradingConfig = docs.find("gradingConfig", { schoolId })[0] ?? null;

      const now = new Date().toISOString();
      const saved = [];
      const failed = [];

      for (const row of scores) {
        const studentId = row?.studentId ? String(row.studentId).trim() : null;
        if (!studentId) {
          failed.push({ ...row, reason: "Missing studentId" });
          continue;
        }

        // The paper's own maximum, as the server resolves it: the ExamSubject's,
        // and the row's only when there is no ExamSubject (docs/39 §4.6a — the
        // server stores and grades against the ExamSubject's). The old fallback
        // was exam.passMark, which is a mark out of 20, not a maximum — a row
        // without maxScore was graded against 10.
        const es = (row.examSubjectId && docs.get("examSubject", String(row.examSubjectId)))
          || docs.find("examSubject", { examId, schoolId, subjectId: String(row.subjectId ?? subjectId ?? ""), classId: String(row.classId ?? classId ?? exam.classId ?? "") })[0]
          || null;
        const maxScore = Number(es?.maxScore ?? row.maxScore ?? 100);
        const computed = computeGrade(row.score, maxScore, gradingConfig);

        const doc = {
          _id:           row._id ? String(row._id) : randomUUID(),
          examId,
          examSubjectId: row.examSubjectId ?? null,
          studentId,
          subjectId:     row.subjectId ?? subjectId ?? null,
          classId:       row.classId ?? classId ?? exam.classId ?? null,
          schoolId,
          score:         row.score         ?? null,
          maxScore:      maxScore,
          percentage:    computed.percentage,
          grade:         computed.grade,
          remark:        computed.remark,
          gpaPoints:     computed.gpaPoints,
          isPassing:     computed.isPassing,
          teacherRemark: row.teacherRemark ?? null,
          isAbsent:      row.isAbsent      ?? false,
          isExempt:      row.isExempt      ?? false,
          enteredBy:     session?.userId ?? null,
          enteredAt:     row.enteredAt ?? now,
          updatedBy:     session?.userId ?? null,
          syncStatus:    "synced",
          lastSyncedAt:  now,
        };

        docs.put("studentScore", doc);
        saved.push(doc);
      }

      return {
        collection: "studentScore",
        doc: saved[0],
        also: saved.slice(1).map((r) => ({ collection: "studentScore", doc: r })),
        request: { method: "POST", path: `/api/exams/${examId}/scores/bulk`, body },
        response: {
          status: 201,
          data: {
            success: true,
            saved:   saved.length,
            failed:  failed.length,
            failedRecords: failed,
            draft,
          },
        },
      };
    },
  },

  // ─────────────────────────────────────────────────────────
  // POST /api/exams/:examId/process
  // ─────────────────────────────────────────────────────────
  //
  // Not computed on the desk. Every school's results are the decided
  // calculation (shared/academicRules, docs/39 §21.1): CA blended by the
  // school's split, coefficients, a subject with no paper mark left out, and
  // a published result never recomputed. The desk used to compute the old
  // raw-mark mean here, which would now be a second, different answer for
  // the same marks; the request goes to the server instead (the dispatcher's
  // "not handled here", src/main/api/index.js), which answers or refuses it.
  //
  {
    route: "POST /api/exams/:examId/process",

    handler: () => null,
  },
];
