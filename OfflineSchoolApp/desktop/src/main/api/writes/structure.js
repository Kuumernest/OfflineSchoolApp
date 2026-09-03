// desktop/src/main/api/writes/structure.js
"use strict";

/**
 * Changing the shape of the school with no connection: classes, subjects and
 * the periods of the school day.
 *
 * ── What is here and what is not ──────────────────────────────────────────
 *
 * Six writes are queued from this file. Seven more in the same domain are not,
 * and the reasons divide into three:
 *
 *   THE SERVER PICKS THE ID.  POST /admin/classes, POST /admin/subjects and
 *   POST /admin/assignments all let the model's default generate _id. The first
 *   two already read `id` from the body — but only to echo it back beside
 *   `serverId`, as a mapping hint for a client that can remap ids. This one
 *   cannot: the mirror stores a row under the id it chose, so the reply would
 *   describe a class this machine has never heard of while the row it wrote sat
 *   orphaned. Reported for a backend change rather than worked around.
 *
 *   THE MIRROR CANNOT DELETE A ROW.  DELETE /admin/subjects/:id and
 *   DELETE /admin/assignments/:id are HARD deletes, and DELETE /admin/classes/:id
 *   hard-deletes every subject and every teacher assignment for the class on its
 *   way past. A write handler describes rows to WRITE — `doc` and `also` both go
 *   through docs.put — and there is no way to say "and this row is gone". Nor
 *   can the sync feed ever say it: the feed sends documents that exist, so a row
 *   the server hard-deleted is never mentioned again and a local copy of it
 *   would sit on the machine for ever. Marking it deleted locally does not help
 *   either, because GET /admin/subjects applies no deleted filter — the subject
 *   would keep appearing on the screen that had just deleted it.
 *
 *   THE ROUTE DOES NOT EXIST.  PATCH /admin/classes/:id/toggle-active is called
 *   by the console and is not implemented on the server at all. Queueing it
 *   would guarantee a 404 in the outbox, which is the one thing this layer must
 *   never do.
 *
 * ── The rule these six were written against ───────────────────────────────
 *
 * A queued request the server answers 4xx stops the whole outbox, including
 * work from other parts of the school. So every condition under which these
 * endpoints refuse is checked here first, and where the check cannot be made
 * honestly the handler returns null and the request goes over the network.
 *
 * That includes the 500s. Two of these endpoints turn a plausible body into an
 * unhandled validation error rather than a 400 — a class name of "   " trims to
 * "" and fails `required` — and a 500 blocks the queue exactly as a 409 does.
 */

/**
 * The stored row without this machine's bookkeeping.
 *
 * docs.get() attaches `_pending`, and a doc built by spreading it would carry
 * the flag into the stored JSON and into the response body. The parity diff
 * ignores the key, so nothing would fail; it is simply not part of any
 * endpoint's contract and does not belong in an answer.
 */
const bare = (row) => {
  if (!row) return row;
  const { _pending, ...rest } = row;
  return rest;
};

/**
 * getTenantQuery(), reproduced.
 *
 * `{ _id, schoolId }` for everybody except a super_admin, who gets no schoolId
 * clause at all and may therefore edit any school's row. This machine mirrors
 * one school, so a super_admin reaching across schools finds nothing here and
 * the request goes to the network — stricter than the server, which is the safe
 * direction.
 *
 * Note what is NOT in it: no deletedAt condition. A soft-deleted class or
 * subject can still be edited, and these handlers allow that because the
 * endpoint does.
 */
const tenant = (docs, collection, id, schoolId) => {
  const row = docs.get(collection, String(id).trim());
  if (!row) return null;
  if (String(row.schoolId ?? "") !== String(schoolId)) return null;
  return row;
};

/**
 * The school this request acts on.
 *
 * The TOKEN's school, not the body's — getTenantQuery reads req.user.schoolId
 * and ignores whatever the body says, so a handler that trusted the body could
 * accept an edit the server will answer 404. The body is a fallback only for
 * callers with no session at all, which is how the parity harness asks.
 */
const actingSchool = (body, session) =>
  session?.schoolId
    ? String(session.schoolId).trim()
    : (body?.schoolId ? String(body.schoolId).trim() : null);

/** A value the schema's String caster accepts, or null for one it does not. */
const asTrimmedString = (value) => (typeof value === "string" ? value.trim() : null);

/**
 * parseCoefficient(), reproduced exactly.
 *
 * Returns { ok, value }. Absent means "leave it alone"; present but outside
 * 0.1–20 is the endpoint's 400 — a coefficient of 0 would erase every average
 * in the class, so it is refused rather than coerced.
 */
const parseCoefficient = (raw) => {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.1 || n > 20) return { ok: false, value: undefined };
  return { ok: true, value: Math.round(n * 100) / 100 };
};

// ── Periods ─────────────────────────────────────────────────────────────────

/** isValidTime(): two digits, a colon, two digits. Nothing about whether it is a real time. */
/**
 * The endpoint's coefficient cascade, mirrored.
 *
 * PUT /admin/subjects/:id pushes a new coefficient into the exam subjects that
 * were still following the old one — see backend services/subjectCoefficient.
 * The rule, in full, because a mirror that wrote only the subject row would
 * show the head a coefficient the marks sheet on this same machine disagreed
 * with, until the next sync corrected it:
 *
 *   ExamSubject.weight is percentage-style, 100 = coefficient 1
 *   a row whose weight is not the OLD default was set per exam, and is kept
 *   a row on a published, locked or archived exam is never touched
 *
 * @returns {{rows: Array<{collection: string, doc: object}>,
 *            skippedFinalised: number, skippedOverridden: number}}
 *   `rows` goes straight into `also`; the counts go into the response, which
 *   reports them the way the endpoint does.
 */
const cascadeCoefficient = (docs, { schoolId, subjectId, from, to }) => {
  const none = { rows: [], skippedFinalised: 0, skippedOverridden: 0 };
  if (!(Number.isFinite(from) && Number.isFinite(to) && from !== to)) return none;

  const finalised = (examId) => {
    const exam = docs.get("exam", String(examId));
    return Boolean(exam?.resultsPublished) ||
           Boolean(exam?.resultsLockedAt) ||
           ["published", "archived"].includes(String(exam?.status || ""));
  };

  const now = new Date().toISOString();
  const rows = [];
  let skippedFinalised = 0, skippedOverridden = 0;

  for (const row of docs.find("examSubject", { subjectId: String(subjectId) })) {
    if (row.deletedAt) continue;
    if (String(row.schoolId) !== String(schoolId)) continue;
    if (finalised(row.examId))            { skippedFinalised += 1; continue; }
    if (Number(row.weight) === to * 100)  continue;              // already right
    if (Number(row.weight) !== from * 100) { skippedOverridden += 1; continue; }
    rows.push({
      collection: "examSubject",
      doc: { ...bare(row), weight: to * 100, updatedAt: now },
    });
  }
  return { rows, skippedFinalised, skippedOverridden };
};

/** A coefficient as everything downstream reads it: absent means 1. */
const coefficientOf = (row) =>
  Number(row?.coefficient) > 0 ? Number(row.coefficient) : 1;

const isValidTime = (t) => typeof t === "string" && /^\d{2}:\d{2}$/.test(t);

/** toMinutes(), which is why "25:99" gets through — see the note on PUT below. */
const toMinutes = (t) => {
  if (!t || typeof t !== "string") return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/**
 * A period as the controller sees it after mongoose has hydrated it.
 *
 * Mongoose applies schema defaults when it builds a document from the database,
 * not only when it creates one — so a row stored without `version`, `isActive`,
 * `isBreak` or `sortOrder` is read by the controller as 1, true, false and 0
 * respectively. That is what stops `existing.version + 1` being NaN on the
 * oldest rows, and it is why the toggle flips a missing isActive to false
 * rather than to true.
 */
const hydrated = (row) => ({
  version:   typeof row.version   === "number" ? row.version   : 1,
  isActive:  typeof row.isActive  === "boolean" ? row.isActive : true,
  isBreak:   typeof row.isBreak   === "boolean" ? row.isBreak  : false,
  sortOrder: typeof row.sortOrder === "number" ? row.sortOrder : 0,
});

/**
 * The period this request is for.
 *
 * ── The controller does NOT scope this by school ──────────────────────────
 *
 * Period.findById(req.params.id), with no schoolId condition anywhere in the
 * update, toggle, reorder or delete paths. Any account holding periods.manage —
 * which is every school admin — can rewrite ANOTHER school's school day by id.
 * Reported; not reproduced, because it cannot be: this machine holds one
 * school's periods, so an id belonging to another school is simply not here and
 * the request goes to the network.
 */
const period = (docs, id, schoolId) => {
  const row = docs.get("period", String(id).trim());
  if (!row) return null;
  if (String(row.schoolId ?? "") !== String(schoolId)) return null;
  return row;
};

/**
 * checkOverlap(), reproduced.
 *
 * ACTIVE, not-deleted periods only. Two consequences that look like bugs and
 * are the endpoint's own: an inactive period's times may overlap anything, and
 * an inactive period is invisible to everyone else's overlap check — so
 * re-activating one through PATCH /:id/toggle can produce an overlap that
 * neither POST nor PUT would have allowed, because the toggle does not check.
 *
 * Returns the clashing period, or null.
 */
const overlapping = (docs, schoolId, startTime, endTime, excludeId) => {
  const startMin = toMinutes(startTime);
  const endMin   = toMinutes(endTime);

  for (const p of docs.find("period", { schoolId, isActive: true, deletedAt: null })) {
    if (excludeId && String(p._id) === String(excludeId)) continue;
    if (startMin < toMinutes(p.endTime) && endMin > toMinutes(p.startTime)) return p;
  }
  return null;
};

/**
 * The period document as res.json() renders it.
 *
 * NOT just an `id` alias. These endpoints answer with a HYDRATED mongoose
 * document, so its toJSON adds the id virtual AND every schema default the
 * stored row happens to be missing — while the sync feed uses .lean() and sends
 * the row exactly as it is. A period stored without `assignedBy` therefore reads
 * back as assignedBy: null from the server, and would have read as absent here.
 *
 * The same shaper the read side needs (asServedPeriod in handlers/school.js) and
 * for the same reason, kept as a second copy rather than required across the
 * handler/write boundary: the two files are registered separately and a require
 * between them would make one depend on the other's load order. If a third
 * caller ever wants it, it belongs in shared/.
 */
const asPeriodResponse = (doc) => ({
  ...doc,
  id:         doc.id         ?? doc._id,
  sortOrder:  doc.sortOrder  ?? 0,
  isBreak:    doc.isBreak    ?? false,
  isActive:   doc.isActive   ?? true,
  deletedAt:  doc.deletedAt  ?? null,
  version:    doc.version    ?? 1,
  assignedBy: doc.assignedBy ?? null,
});

module.exports = [
  {
    route: "PUT /api/admin/classes/:id",

    /**
     * Renaming a class, moving it to another level, retiring it.
     *
     * ── Only what changed, and what "changed" means here ──────────────────
     *
     * The endpoint builds its update from four independent tests, and each has a
     * different idea of "not supplied":
     *
     *   name      `name && { name: name.trim() }`      — falsy is IGNORED
     *   level     `level !== undefined && { level }`   — null is a real value
     *   section   `section !== undefined && { section }`
     *   isActive  `isActive !== undefined && { isActive }`
     *
     * So an empty name is not an error, it is a no-op. The queued body is the
     * body that arrived, so a colleague's change to a field this user did not
     * touch survives.
     *
     * ── There is NO uniqueness check on this path ─────────────────────────
     *
     * POST /admin/classes refuses a duplicate name with a 409. This does not,
     * and there is no unique index on { schoolId, name } to catch it either — the
     * Class model declares { schoolId: 1, name: 1 } without `unique`. So renaming
     * "Form 2" to "Form 1" is accepted and the school ends up with two. No local
     * check, because a check the server does not make would decline a write it
     * would have accepted, and the whole screen would then need a connection.
     *
     * ── The 500s ─────────────────────────────────────────────────────────
     *
     * runValidators is on, so a name that trims to "" fails `required` and a
     * name over 100 characters fails `maxlength`. Neither is a 400: the
     * validation error goes to next(err) and comes back as a 500.
     *
     * Which is worse than a 409 rather than merely as bad. The outbox blocks on
     * a 4xx and asks a person to look; it treats 5xx as retryable, because a
     * server error is usually transient. This one never is — the same body fails
     * the same way for ever — so a queued write like it would retry on every
     * cycle, indefinitely, with nobody told. Confirmed against the real
     * endpoint by the parity section, and reported for the same
     * ValidationError-to-400 mapping the grading settings just got. Both are refused here.
     *
     * A non-string name is worse — `name.trim` is not a function, so it is a
     * TypeError before mongoose sees it. Same treatment.
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!session?.permissions?.includes("classes.manage")) return null;

      const schoolId = actingSchool(body, session);
      if (!schoolId) return null;

      const row = tenant(docs, "class", params.id, schoolId);
      if (!row) return null;   // the endpoint's 404 is its own to give

      const updates = {};

      // Falsy name — undefined, null, "" — is skipped by the endpoint, not
      // refused. Anything truthy has to survive trim(), the length limit and
      // being a string at all.
      if (body.name) {
        const name = asTrimmedString(body.name);
        if (name === null) return null;        // a TypeError on the server
        if (!name)         return null;        // required — a 500, and retryable
        if (name.length > 100) return null;    // maxlength — the same
        updates.name = name;
      }

      // level and section are `trim: true` on the schema, so mongoose stores
      // them trimmed. A mirror holding the untrimmed string the user typed would
      // disagree with the server about the value of a field nobody had changed.
      for (const field of ["level", "section"]) {
        if (body[field] === undefined) continue;
        if (body[field] === null) { updates[field] = null; continue; }
        const value = asTrimmedString(body[field]);
        if (value === null) return null;   // a CastError, and so a 500
        updates[field] = value;
      }

      if (body.isActive !== undefined) {
        // Mongoose casts some non-booleans and throws on the rest. Only a real
        // boolean is accepted rather than working out which is which.
        if (typeof body.isActive !== "boolean") return null;
        updates.isActive = body.isActive;
      }

      /*
       * The form master, stored as the id AND the name the card prints.
       *
       * The endpoint resolves the name from the teacher's User row and refuses
       * a teacher this school does not have — a 403 it is not this layer's to
       * invent. So a teacher the mirror cannot find locally is DECLINED, and
       * the request goes to the network where that check lives. Only a
       * teacher this machine can see is answered offline.
       */
      if (body.classTeacherId !== undefined) {
        const id = String(body.classTeacherId ?? "").trim();
        if (!id) {
          updates.classTeacherId   = null;
          updates.classTeacherName = null;
        } else {
          const teacher = tenant(docs, "user", id, schoolId);
          if (!teacher) return null;          // the endpoint's 403
          updates.classTeacherId   = id;
          updates.classTeacherName = teacher.name || null;
        }
      }

      const doc = { ...bare(row), ...updates, updatedAt: new Date().toISOString() };

      return {
        collection: "class",
        doc,
        request: { method: "PUT", path: `/api/admin/classes/${row._id}`, body },
        // cls.toObject() with virtuals, which is how the Class schema is
        // configured — so the class comes back with an `id` alias beside _id.
        // Kept out of the stored row: the sync feed sends lean documents and a
        // mirror row with an extra key would differ from every other machine's.
        response: { status: 200, data: { success: true, class: { ...doc, id: doc._id } } },
      };
    },
  },

  {
    route: "PUT /api/admin/subjects/:id",

    /**
     * Renaming a subject, moving it to another class, setting its coefficient.
     *
     * ── Coefficient is a MULTIPLIER here ─────────────────────────────────
     *
     * Subject.coefficient is the Cameroon sense: 1 is normal, 2 counts double.
     * ExamSubject.weight is percentage-style, where 100 means coefficient 1, and
     * attaching a subject to an exam seeds weight = coefficient × 100. Nothing
     * in this handler converts between them; it is written down because the two
     * numbers look interchangeable and are not.
     *
     * ── Three refusals, in the endpoint's own order ───────────────────────
     *
     *   400  a coefficient outside 0.1–20, or one that is not a number
     *   403  a classId naming a class this school does not have. Note 403 and
     *        not 404 or 422 — POST /admin/subjects answers 422 with a
     *        CLASS_NOT_SYNCED code for the identical condition, and the screen
     *        that handles one does not handle the other.
     *   404  no such subject in this school
     *
     * The class check has no deletedAt condition, so moving a subject into a
     * soft-deleted class is allowed. Reproduced.
     *
     * ── And one 500 ──────────────────────────────────────────────────────
     *
     * `code: code?.trim() || ""` throws on a non-string code, and a name that
     * trims to "" fails `required` under runValidators. Both refused here.
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!session?.permissions?.includes("subjects.manage")) return null;

      const schoolId = actingSchool(body, session);
      if (!schoolId) return null;

      const coefficient = parseCoefficient(body.coefficient);
      if (!coefficient.ok) return null;   // the endpoint's 400

      let classIdStr;
      if (body.classId) {
        classIdStr = String(body.classId).trim();
        // Under getTenantQuery, so another school's class is a 403 as surely as
        // one that does not exist.
        if (!tenant(docs, "class", classIdStr, schoolId)) return null;
      }

      const row = tenant(docs, "subject", params.id, schoolId);
      if (!row) return null;   // the endpoint's 404

      const updates = {};

      if (body.name) {
        const name = asTrimmedString(body.name);
        if (name === null) return null;   // a TypeError on the server
        if (!name)         return null;   // required, raised as a 500
        updates.name = name;
      }

      if (body.code !== undefined) {
        // `code?.trim() || ""` — null becomes "", a non-string throws.
        if (body.code === null) {
          updates.code = "";
        } else {
          const code = asTrimmedString(body.code);
          if (code === null) return null;
          updates.code = code;
        }
      }

      // Both spellings, always together. The endpoint writes the pair from one
      // value, and a mirror that set only one would answer the subject list with
      // a class the server does not report.
      if (classIdStr) {
        updates.class   = classIdStr;
        updates.classId = classIdStr;
      }

      if (coefficient.value !== undefined) updates.coefficient = coefficient.value;

      const doc = { ...bare(row), ...updates, updatedAt: new Date().toISOString() };

      // The exam subjects that were following the old coefficient, written in
      // the same transaction as the subject itself.
      const cascaded = updates.coefficient === undefined
        ? { rows: [], skippedFinalised: 0, skippedOverridden: 0 }
        : cascadeCoefficient(docs, {
            schoolId, subjectId: String(row._id),
            from: coefficientOf(row), to: updates.coefficient,
          });

      /**
       * The teacher on the response, which is a different join from the one the
       * subject LIST does.
       *
       * findOne({ subject: id }) with no schoolId and no sort: the first
       * assignment the collection happens to hold for this subject, which is the
       * same "first wins" the list applies. populate() then yields null rather
       * than the id when the user is not there, so an unresolvable teacher makes
       * the whole teacher block null — and locally "not there" also covers "has
       * not synced to this machine yet".
       */
      let teacher = null;
      for (const a of docs.find("teacherAssignment", { subject: String(row._id) })) {
        const ref = a.teacher;
        if (!ref) { teacher = null; break; }   // an assignment with no teacher: still the first one
        const user = docs.get("user", String(ref?._id ?? ref));
        if (user) {
          teacher = { _id: String(user._id), name: user.name || "", email: user.email || "" };
        }
        break;
      }

      // normaliseSubject(): the canonical class reference under both names, and a
      // coefficient defaulted to 1 for the rows written before the field existed.
      // On the RESPONSE only — the stored row keeps no coefficient it never had,
      // because the sync feed would not send one either.
      const classRef = doc.class || doc.classId || null;
      const shown = {
        ...doc,
        class:   classRef,
        classId: classRef,
        coefficient: Number(doc.coefficient) > 0 ? Number(doc.coefficient) : 1,
        teacherId:   teacher?._id  || null,
        teacher_id:  teacher?._id  || null,
        teacherName: teacher?.name || null,
        teacher:     teacher       || null,
      };

      // Whether any of the touched exams already has marks, which is what
      // decides reprocessRequired. Local rows, so the same question the
      // endpoint asks of StudentScore.
      const touched = new Set(cascaded.rows.map((c) => String(c.doc.examId)));
      const marked  = [...touched].some((examId) =>
        [...docs.find("studentScore", { examId })].some(
          (sc) => !sc.deletedAt && String(sc.subjectId) === String(row._id)
        )
      );

      return {
        collection: "subject",
        doc,
        also: cascaded.rows,
        request: { method: "PUT", path: `/api/admin/subjects/${row._id}`, body },
        // .lean(), so no `id` alias on this one — unlike the class response two
        // handlers up. Same router, two conventions.
        response: {
          status: 200,
          data: {
            success: true,
            subject: shown,
            coefficientCascade: {
              examSubjectsUpdated: cascaded.rows.length,
              examsAffected:       touched.size,
              skippedFinalised:    cascaded.skippedFinalised,
              skippedOverridden:   cascaded.skippedOverridden,
              reprocessRequired:   marked,
            },
          },
        },
      };
    },
  },

  {
    route: "PUT /api/admin/periods/:id",

    /**
     * Retiming a period of the school day.
     *
     * ── "25:99" is a valid time to this endpoint ──────────────────────────
     *
     * isValidTime is /^\d{2}:\d{2}$/ — two digits, a colon, two digits, and
     * nothing about hours below 24 or minutes below 60. toMinutes("25:99") is
     * 1599, so it compares and stores happily. What it rejects is "9:05", which
     * is why period.service.ts pads before sending.
     *
     * Reproduced, because the alternative is a mirror that refuses a period the
     * server would have accepted — the timetable would then have a period
     * online that cannot be edited offline, which is harder to explain than a
     * nonsense time.
     *
     * ── Falling back, not clearing ────────────────────────────────────────
     *
     * `startTime || existing.startTime` and `name?.trim() || existing.name`: an
     * empty or whitespace-only value keeps what was there. So unlike
     * PUT /admin/classes, a whitespace name here is harmless rather than a 500.
     *
     * ── The refusals ─────────────────────────────────────────────────────
     *
     *   404  no such period, or one already deleted
     *   400  a time not matching HH:MM, or an end at or before the start
     *   409  an overlap with another ACTIVE, undeleted period in the school
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!session?.permissions?.includes("periods.manage")) return null;

      const schoolId = actingSchool(body, session);
      if (!schoolId) return null;

      const row = period(docs, params.id, schoolId);
      if (!row) return null;             // the endpoint's 404
      if (row.deletedAt) return null;    // and its 404 on a deleted one

      const state = hydrated(row);
      // Defensive, and stricter than the server. If mongoose did NOT fill the
      // default in, `existing.version + 1` is NaN and the cast fails with a 500
      // — so a row with a non-numeric version is left to the network rather than
      // queued on a belief about when defaults are applied.
      if (typeof row.version !== "number") return null;

      const startTime = body.startTime || row.startTime;
      const endTime   = body.endTime   || row.endTime;

      if (!isValidTime(startTime) || !isValidTime(endTime)) return null;   // 400
      if (toMinutes(endTime) <= toMinutes(startTime))       return null;   // 400

      const clash = overlapping(docs, schoolId, startTime, endTime, row._id);
      if (clash) return null;   // 409 — and a 409 in the outbox stops everything

      const name = body.name && typeof body.name === "string"
        ? (body.name.trim() || row.name)
        : row.name;

      const doc = {
        ...bare(row),
        name,
        startTime,
        endTime,
        isBreak: body.isBreak !== undefined ? Boolean(body.isBreak) : state.isBreak,
        version: state.version + 1,
        updatedAt: new Date().toISOString(),
      };

      return {
        collection: "period",
        doc,
        request: { method: "PUT", path: `/api/admin/periods/${row._id}`, body },
        // Keyed `data`, and the Period schema's toJSON adds an `id` alias.
        response: { status: 200, data: { success: true, data: asPeriodResponse(doc) } },
      };
    },
  },

  {
    route: "PATCH /api/admin/periods/:id/toggle",

    /**
     * Taking a period out of use, or putting it back.
     *
     * No overlap check on this path, in either direction — so re-activating a
     * period whose times were changed while it was inactive can produce exactly
     * the clash PUT and POST refuse. That is the endpoint's behaviour and it is
     * reproduced; a local check would refuse a write the server accepts and the
     * button would stop working offline for no reason the user could see.
     *
     * There is no dedupe key. The local row flips in the same transaction that
     * queues the request, so a second click describes the opposite change and is
     * a legitimately different request — suppressing it would lose it.
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!session?.permissions?.includes("periods.manage")) return null;

      const schoolId = actingSchool(body, session);
      if (!schoolId) return null;

      const row = period(docs, params.id, schoolId);
      if (!row) return null;
      if (row.deletedAt) return null;   // 404, same as the update path

      if (typeof row.version !== "number") return null;   // see PUT above
      const state = hydrated(row);

      const doc = {
        ...bare(row),
        isActive: !state.isActive,
        version:  state.version + 1,
        updatedAt: new Date().toISOString(),
      };

      return {
        collection: "period",
        doc,
        request: {
          method: "PATCH",
          // The console sends no body, and the endpoint reads none.
          path: `/api/admin/periods/${row._id}/toggle`,
          body: null,
        },
        response: { status: 200, data: { success: true, data: asPeriodResponse(doc) } },
      };
    },
  },

  {
    route: "POST /api/admin/periods/:id/reorder",

    /**
     * Moving a period one place up or down the school day.
     *
     * ── Two documents, one request ───────────────────────────────────────
     *
     * This is a neighbour SWAP, not an assignment: the endpoint finds the
     * adjacent period by sortOrder and exchanges the two values. So it writes
     * TWO rows, and the second one goes in `also` — not as a nicety, but because
     * a row nothing settles stays pending for ever, and a pending row is
     * deliberately never overwritten by a pull. The neighbour would then hold
     * this machine's guess at its position permanently, and the two halves of
     * one swap would disagree about the order of the school day.
     *
     * It is a bounded write, which is why it can be queued at all: two
     * documents, named individually, no bulkWrite and no updateMany. A whole-set
     * reorder would be a different shape and this layer could not express it
     * honestly.
     *
     * ── Where the neighbour comes from ───────────────────────────────────
     *
     * findOne({ schoolId, deletedAt: null, sortOrder: { $lt } }).sort({ -1 }) —
     * so:
     *
     *   · deleted periods are skipped, but INACTIVE ones are not. A retired
     *     period still occupies a place in the order and still gets swapped.
     *   · the comparison is strict, so a period sharing its neighbour's
     *     sortOrder is not a neighbour. A school whose periods all have
     *     sortOrder 0 — which is the schema default — cannot reorder at all and
     *     gets a 400 on every arrow.
     *   · a row whose sortOrder is missing or not a number never matches a
     *     numeric $lt/$gt, so it is out of the ordering entirely.
     *
     * ── The refusals ─────────────────────────────────────────────────────
     *
     *   400  a direction other than "up" or "down"
     *   404  no such period. NOTE: this path does NOT check deletedAt on the
     *        target, unlike update, toggle and delete — a soft-deleted period
     *        can be reordered. Reproduced; it looks like an oversight and
     *        correcting it would make the mirror refuse a write the server takes.
     *   400  already at that end
     */
    handler: ({ params, body }, { docs, session }) => {
      if (!session?.permissions?.includes("periods.manage")) return null;

      const schoolId = actingSchool(body, session);
      if (!schoolId) return null;

      const direction = body.direction;
      if (direction !== "up" && direction !== "down") return null;   // 400

      const row = period(docs, params.id, schoolId);
      if (!row) return null;   // 404 — and no deletedAt condition here

      const state = hydrated(row);

      const candidates = docs
        .find("period", { schoolId, deletedAt: null })
        .filter((p) => String(p._id) !== String(row._id))
        .filter((p) => typeof p.sortOrder === "number")
        .filter((p) => (direction === "up"
          ? p.sortOrder < state.sortOrder
          : p.sortOrder > state.sortOrder));

      if (!candidates.length) return null;   // 400, "cannot move any further"

      const edge = direction === "up"
        ? Math.max(...candidates.map((p) => p.sortOrder))
        : Math.min(...candidates.map((p) => p.sortOrder));

      const nearest = candidates.filter((p) => p.sortOrder === edge);

      // More than one period sitting on the neighbouring sortOrder means the
      // endpoint's .sort() picks between equals and nothing says which. The two
      // sides would then swap DIFFERENT pairs of rows, and the queue entry would
      // name a row the server never touched — so this one goes to the network,
      // where whichever choice the server makes is the only choice made.
      if (nearest.length > 1) return null;

      const neighbour = nearest[0];

      const now = new Date().toISOString();
      const moved = {
        ...bare(row),
        sortOrder: neighbour.sortOrder,
        // version is deliberately NOT incremented: this is the one period write
        // that leaves it alone.
        updatedAt: now,
      };
      const swapped = { ...bare(neighbour), sortOrder: state.sortOrder, updatedAt: now };

      return {
        collection: "period",
        doc:  moved,
        also: [{ collection: "period", doc: swapped }],
        request: {
          method: "POST",
          path:   `/api/admin/periods/${row._id}/reorder`,
          body,
        },
        /**
         * An ARRAY, in [moved, neighbour] order.
         *
         * Worth knowing what that does to the push: the engine copies the
         * server's answer over the local row when the response carries a single
         * document under `data`, and an array has no _id — so it is skipped and
         * the pull in the same cycle delivers both rows instead. Which is what
         * should happen here; the note is so that nobody later "fixes" the
         * engine into storing an array.
         */
        response: {
          status: 200,
          data: {
            success: true,
            data: [asPeriodResponse(moved), asPeriodResponse(swapped)],
          },
        },
      };
    },
  },

  {
    route: "DELETE /api/admin/periods/:id",

    /**
     * Retiring a period.
     *
     * The one delete in this domain that a mirror can express: it is SOFT —
     * deletedAt is stamped and the row stays — so the local copy can say the
     * same thing, and GET /admin/periods filters deletedAt, so the period leaves
     * the screen at once. The class, subject and assignment deletes all remove
     * rows outright and are declined for that reason; see the note at the top.
     *
     * ── 410, not 404, on a second attempt ────────────────────────────────
     *
     * An already-deleted period answers 410 Gone. That is a refusal and it would
     * stop the outbox, so it is checked: once the local row carries a deletedAt
     * this handler declines and the request goes to the network, where the 410 is
     * the server's to give and blocks nothing.
     *
     * No dedupe key for the same reason DELETE /api/exams/:id has none — the
     * local row is stamped in the same transaction that queues the request, so
     * the check above already suppresses the repeat and a key could never fire.
     */
    handler: ({ params, query }, { docs, session }) => {
      if (!session?.permissions?.includes("periods.manage")) return null;

      const schoolId = session?.schoolId
        ? String(session.schoolId).trim()
        : (query.schoolId ? String(query.schoolId).trim() : null);
      if (!schoolId) return null;

      const row = period(docs, params.id, schoolId);
      if (!row) return null;             // 404
      if (row.deletedAt) return null;    // 410

      if (typeof row.version !== "number") return null;   // see PUT above
      const state = hydrated(row);

      const now = new Date().toISOString();
      const doc = {
        ...bare(row),
        deletedAt: now,
        version:   state.version + 1,
        updatedAt: now,
      };

      return {
        collection: "period",
        doc,
        request: {
          method: "DELETE",
          path:   `/api/admin/periods/${row._id}`,
          body:   null,
        },
        // A message, not the period.
        response: { status: 200, data: { success: true, message: "Period deleted" } },
      };
    },
  },
];
