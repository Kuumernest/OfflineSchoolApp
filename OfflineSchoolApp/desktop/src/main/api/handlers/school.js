// desktop/src/main/api/handlers/school.js
"use strict";

/**
 * The shape of the school: classes and subjects.
 *
 * ── The subtlety here is the sort order ───────────────────────────────────
 *
 * These lists are sorted by MongoDB — .sort({ name: 1 }) — and Mongo compares
 * strings by their bytes. The pupil roster in handlers/students.js is sorted by
 * the SERVER IN JAVASCRIPT, with localeCompare, after the documents come back.
 *
 * The two disagree, and not subtly. Binary comparison puts every uppercase
 * letter before every lowercase one, so "Zebra" sorts before "apple";
 * localeCompare puts "apple" first. A school with a class named "form 1"
 * alongside "Form 2" would see them in one order online and another offline,
 * which reads as the list being unstable rather than as two sorts.
 *
 * So these use plain comparison to match Mongo, and the roster uses
 * localeCompare to match the server's JavaScript. Neither is "the right way to
 * sort names" — each is the way its endpoint already does it, which is the only
 * thing that matters for a mirror.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * MongoDB's ascending string order.
 *
 * Byte comparison, which for the names in this data means code-unit order.
 * Deliberately NOT localeCompare — see the note above.
 */
const byMongoName = (a, b) => {
  const an = String(a.name ?? "");
  const bn = String(b.name ?? "");
  if (an === bn) return 0;
  return an < bn ? -1 : 1;
};

/**
 * The server's resolveSchoolId(), which is NOT "the schoolId in the query".
 *
 * Only a super_admin may name a school other than their own; for everybody else
 * the endpoint uses the school in the token and ignores whatever the query
 * asked for. The two existing handlers above read query.schoolId alone, which
 * is harmless while the mirror holds one school — but the counts and the
 * assignment list below are joined against several collections, and answering
 * for a school this machine is not signed in to would produce a page of empty
 * joins rather than the refusal the server gives.
 *
 * With no session at all (the parity harness asks some questions without one)
 * the query is the only thing that can say which school, so it is used then.
 */
const schoolOf = (query, session) => {
  const provided = query.schoolId ? String(query.schoolId).trim() : null;
  if (session?.role === "super_admin" && provided) return provided;
  const own = session?.schoolId ? String(session.schoolId).trim() : null;
  return own ?? provided;
};

/**
 * addNotDeleted(), which is three conditions rather than one.
 *
 * The server's helper counts a MISSING deletedAt, a null one and an EMPTY
 * STRING as "not deleted". A store filter of { deletedAt: null } compiles to
 * `deleted_at IS NULL`, which misses the empty string — so a class whose
 * deletedAt had been blanked rather than cleared would be counted by the server
 * and not here, and the dashboard would show one class fewer offline. Applied
 * in JavaScript because the store's filter language has no OR.
 */
const notDeleted = (row) =>
  row.deletedAt === undefined || row.deletedAt === null || row.deletedAt === "";

/**
 * What .select("a b c").lean() produces.
 *
 * lean() does NOT fill in schema defaults and .select() does not invent keys, so
 * a field the document simply does not have is ABSENT from the server's answer
 * rather than null. The parity diff compares key sets, so a handler that
 * helpfully wrote `section: undefined → null` would differ on every class that
 * never had a section — which is most of them.
 *
 * _id is always included because Mongo always returns it, and `_pending` is
 * never included because it is this machine's bookkeeping, not the contract.
 */
const project = (row, fields) => {
  if (!row) return null;
  const out = { _id: row._id };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) out[field] = row[field];
  }
  return out;
};

/** Mongo's { sortOrder: 1, startTime: 1 } over the period list. */
const byPeriodOrder = (a, b) => {
  const as = typeof a.sortOrder === "number" ? a.sortOrder : null;
  const bs = typeof b.sortOrder === "number" ? b.sortOrder : null;
  if (as !== bs) {
    // A missing or non-numeric sortOrder is null to Mongo, and null sorts
    // before every number ascending.
    if (as === null) return -1;
    if (bs === null) return 1;
    return as - bs;
  }
  const at = String(a.startTime ?? "");
  const bt = String(b.startTime ?? "");
  if (at === bt) return 0;
  return at < bt ? -1 : 1;
};

/** A timestamp Mongo would sort on, or null for one it would treat as absent. */
const stamp = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
};

/**
 * Mongo's { createdAt: -1 }, with the tie behaviour named.
 *
 * TeacherAssignment rows written before the timestamps option was added carry
 * no createdAt, and descending order puts those LAST — null is the lowest of
 * these values, so it comes last when the sort is reversed.
 *
 * Where two rows have the SAME createdAt neither side is promising anything:
 * the endpoint has no second sort key, so Mongo returns them in whatever order
 * it scanned. Array.prototype.sort is stable in V8, so ties here keep the order
 * the store returned them in, which is insertion order — the same order Mongo's
 * collection scan produces on the same inserts. That agreement is a
 * coincidence of both sides scanning in insertion order, not a contract, so a
 * parity check over this list should compare by _id rather than by position.
 */
const byCreatedAtDesc = (a, b) => {
  const at = stamp(a.createdAt);
  const bt = stamp(b.createdAt);
  if (at === bt) return 0;
  if (at === null) return 1;
  if (bt === null) return -1;
  return bt - at;
};

/**
 * One period as the ENDPOINT serialises it, not as the feed stores it.
 *
 * ── Two shapes for one document ───────────────────────────────────────────
 *
 * periods.controller.js answers with hydrated mongoose documents, so res.json()
 * runs toJSON — and Period sets toJSON: { virtuals: true }. Every row therefore
 * carries an `id` alias of `_id`, and any field the schema declares a default
 * for is present even when the stored document has no such key.
 *
 * The sync feed uses .lean(), which does neither. So a mirror answering with its
 * rows as stored is missing `id` and every unset default — which is exactly what
 * the parity comparison found: `assignedBy` and `id` absent on every row.
 *
 * The defaults are listed rather than derived because the desktop cannot load a
 * mongoose model. If Period gains another defaulted field, this needs it too;
 * the parity check is what will say so.
 */
const asServedPeriod = (row) => ({
  ...row,
  id:         row.id ?? row._id,
  sortOrder:  row.sortOrder  ?? 0,
  isBreak:    row.isBreak    ?? false,
  isActive:   row.isActive   ?? true,
  deletedAt:  row.deletedAt  ?? null,
  version:    row.version    ?? 1,
  assignedBy: row.assignedBy ?? null,
});

module.exports = [
  {
    route: "GET /api/admin/classes",
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      // includeInactive=true drops BOTH filters, deleted rows included. That is
      // what the endpoint does — the two conditions are applied together — and
      // a mirror that kept the not-deleted filter would show fewer classes than
      // the server for the one caller who asked to see everything.
      const includeInactive = query.includeInactive === "true";

      const filter = includeInactive
        ? { schoolId }
        : { schoolId, isActive: true, deletedAt: null };

      const classes = docs.find("class", filter).sort(byMongoName);

      return ok({ classes });
    },
  },

  {
    route: "GET /api/admin/subjects",

    /**
     * Subjects, with their class and the teacher who takes them.
     *
     * Three collections merged rather than one listed, and almost every line
     * below is reproducing a specific decision the endpoint makes rather than an
     * obvious one:
     *
     *   · NO deleted filter. The endpoint does not apply one, so neither does
     *     this — a mirror that "improved" on it would show fewer subjects than
     *     the server and the difference would look like missing data.
     *
     *   · classId matches EITHER `class` OR `classId` on the document. Both
     *     spellings are in the data and the endpoint accepts both.
     *
     *   · The joined class is PROJECTED to name, section and level. The mirror
     *     holds whole class documents, so sending the whole thing would attach
     *     fields the server never sends.
     *
     *   · The teacher map takes the FIRST assignment for a subject and ignores
     *     the rest. Two teachers on one subject is possible in the data, and the
     *     endpoint shows one of them — the first it happens to read.
     *
     *   · A teacher id that resolves to no user produces NO teacher. That is
     *     what populate does when it finds nothing — it sets the field to null
     *     rather than leaving the id behind, so the endpoint's `if (t)` fails
     *     and the subject comes back unassigned. This handler had it the other
     *     way round at first, attaching a teacher with empty strings for name
     *     and email, and the parity harness caught it.
     *
     *     One consequence is worth naming: locally, "no such user" also covers
     *     "that user has not synced to this machine yet", so a freshly-installed
     *     desktop can show a subject as unassigned when the server knows who
     *     teaches it. It corrects itself when the user collection arrives, and
     *     the alternative — a teacher with a blank name — would be a worse thing
     *     to put on a screen.
     *
     *   · Finally deduped by lower-cased name plus class, first wins.
     */
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const classId = query.classId ? String(query.classId).trim() : null;

      // No deletedAt condition — see the note above.
      let raw = docs.find("subject", { schoolId });

      if (classId) {
        raw = raw.filter((s) =>
          String(s.class ?? "") === classId || String(s.classId ?? "") === classId);
      }

      raw = raw.sort(byMongoName);
      if (!raw.length) return ok({ subjects: [] });

      // ── The class join, projected as the server projects it ──────────────
      const classIds = [...new Set(
        raw.map((s) => s.class || s.classId).filter(Boolean).map(String)
      )];

      const classMap = new Map();
      for (const id of classIds) {
        const record = docs.get("class", id);
        if (!record) continue;
        // .select("name section level") — plus _id, which Mongo always returns.
        classMap.set(id, {
          _id:     record._id,
          name:    record.name,
          section: record.section,
          level:   record.level,
        });
      }

      // ── The teacher join ────────────────────────────────────────────────
      const subjectIds = new Set(raw.map((s) => String(s._id)));
      const assignments = docs.find("teacherAssignment", { schoolId });

      const subjectTeacher = new Map();
      for (const a of assignments) {
        const sid = String(a.subject?._id ?? a.subject ?? "");
        if (!sid || !subjectIds.has(sid) || subjectTeacher.has(sid)) continue;

        // `teacher` only. The endpoint reads a.teacher and nothing else, so an
        // assignment recorded under teacherId attaches no teacher there either —
        // reproducing that rather than being cleverer than it.
        const ref = a.teacher;
        if (!ref) continue;

        const id   = String(ref?._id ?? ref);
        const user = docs.get("user", id);

        // No user, no teacher — populate sets the field to null when it finds
        // nothing, so the endpoint attaches nothing. See the note above.
        if (!user) continue;

        subjectTeacher.set(sid, {
          _id:   id,
          name:  user.name  ?? "",
          email: user.email ?? "",
        });
      }

      const subjects = raw.map((s) => {
        const canonicalClassId = s.class || s.classId || null;
        const classRecord = canonicalClassId
          ? classMap.get(String(canonicalClassId)) ?? null
          : null;
        const teacher = subjectTeacher.get(String(s._id)) ?? null;

        return {
          ...s,
          class:    canonicalClassId,
          classId:  canonicalClassId,
          classObj: classRecord ? { _id: String(classRecord._id), ...classRecord } : null,
          teacherId:   teacher?._id  || s.teacherId  || s.teacher_id || null,
          teacher_id:  teacher?._id  || s.teacher_id || s.teacherId  || null,
          teacherName: teacher?.name || s.teacherName || null,
          teacher:     teacher       || null,
        };
      });

      // Deduped on name and class, first kept. Two subjects with the same name
      // in the same class is a data-entry artefact the endpoint hides.
      const seen = new Set();
      const deduped = subjects.filter((s) => {
        const key = `${(s.name || "").toLowerCase().trim()}|${s.class || s.classId || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return ok({ subjects: deduped });
    },
  },

  {
    route: "GET /api/admin/classes/stats",

    /**
     * The two numbers the dashboard prints as "N classes, M with subjects".
     *
     * ── `total` and the class list agree; `withSubjects` agrees with nothing ──
     *
     * `total` uses isActive: true plus not-deleted, which is exactly the filter
     * GET /admin/classes uses — so the count and the list cannot disagree, and
     * that is worth stating because the pair `isActive: { $ne: false }` against
     * `isActive: true` has already produced a count that did not match its own
     * list elsewhere in this file's server.
     *
     * `withSubjects` is a different question than it looks. It counts DISTINCT
     * CLASS IDS MENTIONED BY SUBJECTS, with no filter on the class at all: not
     * active, not undeleted, not even existing. So a school that deleted a class
     * without deleting its subjects — which is possible, because DELETE
     * /admin/subjects/:id and DELETE /admin/classes/:id are the only things that
     * remove subjects and neither runs on a rename — sees withSubjects exceed
     * total, and the dashboard reads "4 classes, 6 with subjects".
     *
     * Reproduced rather than corrected. A mirror that filtered the class would
     * show a different number offline, and the honest reading of a wrong number
     * is the server's number.
     *
     * Both spellings are unioned because the endpoint runs two distinct() calls
     * and unions them: a subject filed under `class` and one filed under
     * `classId` are the same reference, and counting the two lists separately
     * would double-count every class that has both.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = schoolOf(query, session);
      if (!schoolId) return null;   // the endpoint's 400 is its own to give

      const total = docs
        .find("class", { schoolId, isActive: true })
        .filter(notDeleted)
        .length;

      const referenced = new Set();
      for (const s of docs.find("subject", { schoolId })) {
        // { $exists: true, $ne: null } — a missing field and a null one are both
        // out, but an EMPTY STRING is a distinct value and does get counted.
        if (s.class   !== undefined && s.class   !== null) referenced.add(String(s.class));
        if (s.classId !== undefined && s.classId !== null) referenced.add(String(s.classId));
      }

      return ok({ total, withSubjects: referenced.size });
    },
  },

  {
    route: "GET /api/admin/subjects/stats",

    /**
     * One number, and no filters on it.
     *
     * Subject.countDocuments({ schoolId }) — no isActive, no deletedAt. That
     * matches GET /admin/subjects, which applies no deleted filter either, so
     * the count and the list agree with each other. It also means a school's
     * subject total never goes down: deleting a subject is a hard delete on the
     * server, so the row leaves the collection and the count follows, but a
     * SOFT-deleted one (there are such rows in the data) keeps being counted.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = schoolOf(query, session);
      if (!schoolId) return null;

      return ok({ total: docs.count("subject", { schoolId }) });
    },
  },

  {
    route: "GET /api/admin/periods",

    /**
     * The shape of the school day.
     *
     * ── Why this is here when nobody asked for it ─────────────────────────────
     *
     * It is not in the console's endpoint census. period.service.ts calls
     * `api.get(BASE)` with the constant passed bare rather than interpolated
     * into a template literal, and the scanner in scripts/coverage.js only sees
     * literals — so GET /admin/periods and POST /admin/periods are both invisible
     * to it. They are called all the same, by the periods screen and by the
     * timetable.
     *
     * Without it the four period WRITES mirrored in writes/structure.js are
     * unreachable: an offline user cannot edit, reorder or retire a period on a
     * screen that could not list them in the first place.
     *
     * ── Filters ──────────────────────────────────────────────────────────────
     *
     * `deletedAt: null` literally, not the server's three-way addNotDeleted
     * helper — this controller is not the admin router and does not use it. In
     * Mongo that matches a missing field as well as a null one, which is what
     * `deleted_at IS NULL` does here, so the two agree; a row with "" would be
     * treated as alive by the admin router and dead by this one, and that
     * disagreement is the server's, not this handler's.
     *
     * includeInactive drops ONLY the isActive filter here, unlike
     * GET /admin/classes where it drops the deleted filter too. Two endpoints,
     * one parameter name, two meanings.
     *
     * The response is keyed `data`, not `periods`, and carries a `count`.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = schoolOf(query, session);
      if (!schoolId) return null;

      const filter = { schoolId, deletedAt: null };
      if (query.includeInactive !== "true") filter.isActive = true;

      const periods = docs.find("period", filter).sort(byPeriodOrder).map(asServedPeriod);

      return ok({ data: periods, count: periods.length });
    },
  },

  {
    route: "GET /api/admin/assignments",

    /**
     * Who takes which subject in which class.
     *
     * The same handler serves GET /admin/teacher-assignments — one function
     * registered at two paths — so registering that path against this handler
     * would mirror it too. Left out here because admin/teacher-assignments is
     * counted as its own area and belongs to whoever takes the teachers domain.
     *
     * ── Four decisions worth naming ──────────────────────────────────────────
     *
     *   · The class filter reads `class` ONLY. The query parameter is classId
     *     and it is matched against the assignment's `class` field, never
     *     against `classId` — unlike GET /admin/subjects, which accepts both
     *     spellings. Both spellings exist in this collection, so filtering the
     *     assignment list by class silently returns nothing for every row
     *     recorded under classId. Reproduced; reported.
     *
     *   · The subject is projected WITHOUT its coefficient, and then run
     *     through normaliseSubject(), which defaults a missing coefficient to 1.
     *     So every subject on this screen reads as coefficient 1 whatever the
     *     school set. That is the endpoint's answer and it is the answer given
     *     here.
     *
     *   · A reference that resolves to nothing yields `{ _id }` and no other
     *     key — the endpoint spreads an empty map rather than dropping the
     *     object — so a teacher this machine has not synced yet appears as a
     *     nameless id rather than as null. Different from GET /admin/subjects,
     *     where an unresolvable teacher becomes null because that one goes
     *     through populate().
     *
     *   · Deduped by teacher, class and subject together, first kept. That is
     *     the unique index on the collection, so a duplicate here means the
     *     index was never built.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = schoolOf(query, session);

      const filter = {};
      if (query.teacherId) filter.teacher = String(query.teacherId).trim();
      // `class`, not `classId`. See the note above.
      if (query.classId)   filter.class   = String(query.classId).trim();
      if (query.subjectId) filter.subject = String(query.subjectId).trim();
      if (schoolId)        filter.schoolId = schoolId;

      const raw = docs.find("teacherAssignment", filter).sort(byCreatedAtDesc);

      // The endpoint returns early with all three keys, so an empty list still
      // carries `data` and `count` — a screen reading data.length would throw on
      // a shorter shape.
      if (!raw.length) return ok({ assignments: [], data: [], count: 0 });

      const ref = (id, collection, fields) => {
        const row = docs.get(collection, String(id));
        // `{ _id: id, ...(map.get(id) || {}) }` — the id survives even when
        // nothing resolves. See the note above.
        return row ? project(row, fields) : { _id: String(id) };
      };

      const seen = new Set();
      const normalized = [];

      for (const a of raw) {
        const tId  = a.teacher    ? String(a.teacher)    : null;
        const cId  = a.class      ? String(a.class)      : null;
        const sId  = a.subject    ? String(a.subject)    : null;
        const abId = a.assignedBy ? String(a.assignedBy) : null;

        const key = `${tId}|${cId}|${sId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let subject = null;
        if (sId) {
          const row = docs.get("subject", sId);
          if (row) {
            const projected = project(row, ["name", "code", "class", "classId"]);
            const classRef  = projected.class || projected.classId || null;
            subject = {
              ...projected,
              class:   classRef,
              classId: classRef,
              // normaliseSubject's default, over a projection that never
              // selected the real value. See the note above.
              coefficient: 1,
            };
          } else {
            subject = { _id: sId };
          }
        }

        normalized.push({
          _id: a._id, id: a._id,
          schoolId:   a.schoolId   || null,
          isActive:   a.isActive   ?? true,
          validFrom:  a.validFrom  || null,
          validUntil: a.validUntil || null,
          // Left undefined when the row has none, which drops the key — the
          // server's lean() does the same rather than sending null.
          createdAt:  a.createdAt,
          updatedAt:  a.updatedAt,
          teacher:    tId  ? ref(tId,  "user",    ["name", "email", "role"])   : null,
          class:      cId  ? ref(cId,  "class",   ["name", "level", "section"]) : null,
          subject,
          assignedBy: abId ? ref(abId, "user",    ["name"])                     : null,
          teacherId: tId, classId: cId, subjectId: sId,
        });
      }

      return ok({ assignments: normalized, data: normalized, count: normalized.length });
    },
  },
];
