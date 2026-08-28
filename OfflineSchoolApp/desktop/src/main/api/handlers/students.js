// desktop/src/main/api/handlers/students.js
"use strict";

/**
 * The pupil roster, answered from the mirror.
 *
 * The normaliser is the SAME function the server uses — required from
 * shared/students.js rather than reimplemented — so the only thing these
 * handlers are responsible for is selecting the right documents in the right
 * order. That is deliberate: the shape is 130 lines of field-aliasing, and a
 * second copy of it would differ eventually in a way that renders a pupil's
 * name blank on one platform only.
 *
 * ── Two routers answer for a pupil, and they do not agree ─────────────────
 *
 * `/api/students/*` (backend/src/routes/students.routes.js) and
 * `/api/admin/students/*` (backend/src/routes/admin.routes.js) both carry a
 * suspend, a restore, a delete, a move and an enrolment-number mint. The pairs
 * are NOT the same endpoint under two names — the deletes differ in whether a
 * row survives at all — so every route below names which file it reproduces,
 * and the choice follows what web/src/services/student.service.ts actually
 * calls rather than which path reads better. A handler that mirrored the other
 * twin would be a correct implementation of an endpoint nobody asks for.
 */

const { normaliseStudentDoc } = require("../../../../../shared/students");

/**
 * The server's success envelope.
 *
 * sendSuccess spreads its payload next to `success: true`, so an envelope built
 * any other way would be a different response even with identical data.
 */
const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/** The server treats a missing or blank status parameter as "no filter". */
const statusFilter = (raw) => {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s && s !== "all" ? s : null;
};

/**
 * "Not deleted", TWICE, because the two routers spell it differently.
 *
 * admin.routes.js notDeletedClause() accepts three shapes; students.routes.js
 * NOT_DELETED accepts five, adding the numeric 0 and the boolean false. A row
 * carrying `deletedAt: 0` is therefore live to /api/students/stats/summary and
 * deleted to /api/admin/students — and both are reproduced rather than
 * reconciled, because a mirror that disagreed with the server about who is on
 * the register is a silent problem and this one is only an odd one.
 *
 * Filtered in JavaScript rather than through the store's filter language: `$or`
 * over five alternatives is not something it expresses, and the alternative —
 * `deleted_at IS NULL` alone — would quietly drop the other four.
 */
const notDeletedAdmin = (row) =>
  row.deletedAt === undefined || row.deletedAt === null || row.deletedAt === "";

const notDeletedStudentsRouter = (row) =>
  notDeletedAdmin(row) || row.deletedAt === 0 || row.deletedAt === false;

/**
 * Whose school this request is about, as admin.routes.js resolveSchoolId()
 * decides it.
 *
 * The part that surprises: for anybody who is not a super_admin the query
 * parameter is IGNORED and the token's school is used. Every console screen
 * passes ?schoolId= and it happens to agree, so the parameter looks load-
 * bearing and is not.
 *
 * No session means no answer. The mirror holds one school, but which school
 * that is comes from whoever signed in, and inventing it from a query
 * parameter would let a stale or hand-typed id pick a tenant the server would
 * not have picked.
 */
const adminSchoolId = (session, query, body) => {
  const provided = query?.schoolId || body?.schoolId || null;
  if (session?.role === "super_admin" && provided) return String(provided).trim();
  return session?.schoolId ? String(session.schoolId) : null;
};

/**
 * The same question as students.routes.js resolveSchoolId() answers it.
 *
 * Nearly identical, with one real difference: this one falls back to the
 * explicit value when the account carries no school of its own, where the admin
 * router returns nothing. Reproduced separately rather than shared, because
 * the two files are two functions and making them one here would be asserting
 * something about the server that is not true.
 */
const studentsRouterSchoolId = (session, query, body) => {
  const explicit = query?.schoolId || body?.schoolId || null;
  if (session?.role === "super_admin" && explicit) return String(explicit).trim();
  if (session?.schoolId) return String(session.schoolId);
  return null;
};

/** The name precedence both list endpoints sort on, lowercased as they do. */
const sortName = (s) =>
  (s.studentName || s.name || s.firstName || "").toLowerCase();

/**
 * A pupil record from EITHER collection, merged the way the server merges them.
 *
 * An admission exists as a StudentApplication until it is approved and as a
 * Student afterwards — and during the overlap, as both. The endpoint queries both
 * and lets the Student document win, stamping _source so a screen can tell which
 * it is looking at.
 *
 * The comment on the server's helper records why: an earlier version checked
 * Student first and returned early if it found anything, so an application sat
 * invisible whenever any Student record matched. Reproducing the merge rather
 * than the shortcut.
 */
const mergeBothCollections = (docs, filter) => {
  const merged = new Map();

  // Applications first — lower priority.
  for (const doc of docs.find("studentApplication", filter)) {
    merged.set(String(doc._id), { ...doc, _source: "application" });
  }
  // Students second, overwriting on collision.
  for (const doc of docs.find("student", filter)) {
    merged.set(String(doc._id), { ...doc, _source: "student" });
  }

  return [...merged.values()];
};

/**
 * fetchAllStudents(), which is NOT the merge above.
 *
 * It reads Student and consults StudentApplication only when Student answered
 * with NOTHING — so one enrolled pupil in a class hides every unapproved
 * application in it, and emptying the class makes them all appear. That is the
 * endpoint's rule and the emptiness test comes AFTER the deleted filter, which
 * is why the filtering happens here rather than in the caller.
 *
 * No `_source` is stamped by this path, so normaliseStudentDoc reports
 * "unknown" — unlike the pending queue, which stamps it. Reproduced.
 */
const fetchAllStudents = (docs, filter, keep) => {
  const students = docs.find("student", filter).filter(keep);
  if (students.length > 0) return students;
  return docs.find("studentApplication", filter).filter(keep);
};

module.exports = [
  {
    route: "GET /api/admin/students/pending",

    /**
     * The admissions queue.
     *
     * Newest first, by createdAt — an office works down the applications that
     * arrived most recently, not alphabetically.
     *
     * Note what is NOT here: approving one. That creates the pupil's LOGIN — an
     * enrollment number derived by scanning the roster for the next free one,
     * plus a user account and a password. Two machines working offline would
     * each pick the same next number, and an enrollment number is the username a
     * child types, so a collision is two children sharing an account. A receipt
     * number can carry a device code because it is a reference; a username
     * cannot usefully, and the account creation is the larger problem anyway.
     * So reviewing the queue works offline and acting on it does not.
     */
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const rows = mergeBothCollections(docs, {
        schoolId, status: "pending", deletedAt: null,
      });

      // new Date(x || 0) — a record with no createdAt sorts to the epoch and so
      // to the end, which is what the server does with it.
      const sorted = rows.slice().sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
      );

      const normalised = sorted.map(normaliseStudentDoc).filter(Boolean);

      // students, data AND total — this endpoint's envelope, which is not the
      // same as the roster's (count, students, data).
      return ok({ students: normalised, data: normalised, total: normalised.length });
    },
  },

  {
    route: "GET /api/admin/students",
    handler: ({ query }, { docs }) => {
      // schoolId is required in practice — every screen passes it — and without
      // it the server would answer across tenants, which a mirror cannot do
      // anyway since it only holds one school. Declining is more honest than
      // answering a question this cannot answer the same way.
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const filter = { schoolId, deletedAt: null };

      const status = statusFilter(query.status);
      if (status) filter.status = status;
      if (query.classId) filter.classId = String(query.classId).trim();

      const rows = docs.find("student", filter);

      // Sorted the way the server sorts, including the field precedence: it
      // reads studentName, then name, then firstName, and lowercases before
      // comparing. localeCompare, not <, because that is what the server uses
      // and the two disagree on accented names — which matters in a French
      // speaking school.
      const sorted = rows.slice().sort((a, b) => {
        const nameA = (a.studentName || a.name || a.firstName || "").toLowerCase();
        const nameB = (b.studentName || b.name || b.firstName || "").toLowerCase();
        return nameA.localeCompare(nameB);
      });

      const normalised = sorted.map(normaliseStudentDoc).filter(Boolean);

      // count, students AND data: three keys carrying the same array, because
      // different screens read different ones and the server sends all three.
      return ok({ count: normalised.length, students: normalised, data: normalised });
    },
  },

  {
    route: "GET /api/admin/students/approved",

    /**
     * The register — everybody actually at the school.
     *
     * ── Three things this does not do that its sibling does ────────────────
     *
     * `status: { $in: ["approved", "active"] }`, and nothing else. Not the
     * four-way clause students.routes.js calls APPROVED_STATUS, which also
     * admits a record whose status is MISSING or null. So a legacy pupil with
     * no status is on the register according to /api/students and off it
     * according to this endpoint, and the two screens that read them disagree
     * about the school's size. Reproduced exactly; the difference belongs to
     * the server.
     *
     * There is no sort on the query either — the sort happens in JavaScript
     * with localeCompare, over a name precedence of studentName, then name,
     * then firstName, lowercased. Binary order and localeCompare disagree on
     * accented names, which in a French-speaking school is most of the roll.
     *
     * ── The class name is looked up, and the lookup is unscoped ────────────
     *
     * Class.find({ _id: { $in: … } }) with no school and no deleted filter, so
     * a class id belonging to another school still resolves to its name. The
     * mirror holds one school so that cannot be reached from here; the join is
     * `[name, section]` joined by a space, which is a DIFFERENT string from the
     * bare `name` that the pupil record stores — so a screen reading className
     * from this endpoint and from GET /api/admin/students gets "Form 1 A" from
     * one and "Form 1" from the other.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = adminSchoolId(session, query);
      if (!schoolId) return null;

      const filter = { schoolId, status: { in: ["approved", "active"] } };
      if (query.classId) filter.classId = String(query.classId).trim();

      // `since` is dropped when unparseable rather than refused — new Date of
      // rubbish gives NaN and the endpoint simply omits the clause.
      if (query.since) {
        const when = new Date(String(query.since));
        if (!Number.isNaN(when.getTime())) filter.updatedAt = { gte: when.toISOString() };
      }

      const rows   = fetchAllStudents(docs, filter, notDeletedAdmin);
      const sorted = rows.slice().sort((a, b) => sortName(a).localeCompare(sortName(b)));

      const classNames = new Map();
      for (const s of sorted) {
        const cid = s.classId || s.class_id;
        if (!cid || classNames.has(String(cid))) continue;
        const cls = docs.get("class", String(cid));
        if (cls) classNames.set(String(cid), [cls.name, cls.section].filter(Boolean).join(" "));
      }

      const normalised = sorted
        .map((s) => {
          const doc = normaliseStudentDoc(s);
          if (!doc) return null;
          // The endpoint overwrites the normaliser's classId with the raw one,
          // which matters for an application record whose class arrived as a
          // populated object: the normaliser digs the id out and this puts the
          // object back.
          const cid = s.classId || s.class_id || null;
          return {
            ...doc,
            classId:   cid,
            class_id:  cid,
            className: classNames.get(String(cid)) || s.className || s.class_name || null,
          };
        })
        .filter(Boolean);

      // count AND total AND students AND data — four keys, two of them numbers
      // that are always equal, because this endpoint grew a second reader.
      return ok({
        count:    normalised.length,
        total:    normalised.length,
        students: normalised,
        data:     normalised,
      });
    },
  },

  {
    route: "GET /api/admin/students/stats",

    /**
     * The dashboard tile: how many pupils, how many active, how many new.
     *
     * ── isActive: true, not isActive: { $ne: false } ───────────────────────
     *
     * `active` counts records whose isActive is EXACTLY true. A pupil record
     * written before the field existed has no isActive at all and is counted in
     * `total` and not in `active` — so a school that has never edited its older
     * records sees "312 pupils, 40 active" on the dashboard and reads it as a
     * data loss. Two endpoints in this project read the same field the two
     * different ways; this is the strict one, and answering it the generous way
     * would make the offline dashboard disagree with the online one.
     *
     * ── `new` is relative to the moment of asking ──────────────────────────
     *
     * Thirty days back from now, not from the start of a month or a term. So
     * the number moves every day whether or not anybody enrols, and two
     * requests either side of midnight legitimately differ.
     *
     * ── The StudentApplication branch is dead ──────────────────────────────
     *
     * The endpoint reads applications only `else if` the Student model is
     * missing, and it never is. Not reproduced, because reproducing it would
     * mean writing a branch that cannot run.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = adminSchoolId(session, query);
      if (!schoolId) return null;

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const rows = docs
        .find("student", { schoolId, status: { in: ["approved", "active"] } })
        .filter(notDeletedAdmin);

      return ok({
        total:  rows.length,
        active: rows.filter((r) => r.isActive === true).length,
        // A record with no createdAt does not match { $gte: … } in Mongo
        // either, so the truthiness test is the filter and not a guard.
        new:    rows.filter((r) => r.createdAt && String(r.createdAt) >= since).length,
      });
    },
  },

  {
    route: "GET /api/admin/students/:id",

    /**
     * One pupil, in full — which on this collection means a guardian's name and
     * telephone number, so it is the read that most needs to answer with the
     * server's projection and not the stored document. It does: the reply is
     * normaliseStudentDoc's fixed shape, which names every field it emits, so a
     * column somebody adds to the mirror later cannot leak through it.
     *
     * ── A deleted pupil is still returned ──────────────────────────────────
     *
     * There is no deletedAt filter here, unlike every list endpoint. So a
     * record the office removed from the register opens perfectly well by id,
     * and a screen holding a stale link shows it. That looks like an oversight
     * and is reproduced anyway: a mirror that 404'd where the server answers
     * would make the desktop the thing that is broken.
     *
     * ── Absent from the mirror is not the same as absent ───────────────────
     *
     * The endpoint's 404 is not reproduced. This machine not holding a pupil is
     * far more likely to mean the feed has not reached them — a pupil admitted
     * an hour ago, a permission that gates the collection — than that the
     * school has no such record. So it declines and the request goes out, which
     * offline fails visibly rather than asserting a child does not exist.
     *
     * The envelope is `student` ALONE. The list endpoints send `data` as well
     * and this one does not, which is why student.service.ts unwraps
     * `data?.student ?? data?.data ?? data`.
     */
    handler: ({ params }, { docs, session }) => {
      const isSuper  = session?.role === "super_admin";
      const schoolId = session?.schoolId ? String(session.schoolId) : null;
      if (!isSuper && !schoolId) return null;

      const id = String(params.id).trim();

      const pick = (collection) => {
        const row = docs.get(collection, id);
        if (!row) return null;
        // getTenantQuery puts schoolId in the FILTER, so another school's pupil
        // is a 404 rather than a 403. Unreachable from a single-school mirror,
        // and declining rather than 404ing keeps the one honest answer for both
        // reasons a row might be missing here.
        if (!isSuper && String(row.schoolId ?? "") !== schoolId) return null;
        const { _pending, ...clean } = row;
        return clean;
      };

      const row = pick("student") || pick("studentApplication");
      if (!row) return null;

      return ok({ student: normaliseStudentDoc(row) });
    },
  },

  {
    route: "GET /api/students/stats/summary",

    /**
     * The admissions counters above the student list.
     *
     * ── `pending` is two collections added together, and nothing else is ────
     *
     * Pending Student records PLUS pending StudentApplication records. Every
     * other counter here reads Student only. So an application that is rejected
     * leaves `pending` and does not arrive in `rejected`, and the four counters
     * do not sum to `total` — which is not a bug to fix here but is worth
     * knowing before anybody uses the numbers as a breakdown.
     *
     * The two collections are also filtered differently on the same two fields:
     * applications must have `isActive: { $ne: false }` and a deletedAt that is
     * absent or null, while students are not filtered on isActive at all and
     * accept five spellings of "not deleted". `$ne: false` is the important
     * one — a record with no isActive PASSES it, and most older records have no
     * isActive, so writing it as `=== true` would drop them.
     *
     * ── `approved` admits a record with no status ──────────────────────────
     *
     * APPROVED_STATUS is four alternatives: "approved", "active", missing, or
     * null. GET /api/admin/students/approved uses two. The same pupil is
     * therefore on one screen's register and off the other's.
     *
     * ── `thisMonth` uses the machine's calendar month, in LOCAL time ───────
     *
     * setDate(1) then setHours(0,0,0,0) on a local Date, so in Douala the
     * boundary is 23:00 UTC on the last day of the previous month. Computed the
     * same way here; a UTC month boundary would move the count by whatever
     * enrolled in that one hour.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = studentsRouterSchoolId(session, query);
      if (!schoolId) return null;

      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const monthStart = startOfMonth.toISOString();

      const rows = docs.find("student", { schoolId }).filter(notDeletedStudentsRouter);

      const approvedish = (r) =>
        r.status === "approved" || r.status === "active" ||
        r.status === undefined  || r.status === null;

      const apps = docs
        .find("studentApplication", { schoolId, status: "pending" })
        .filter((r) => r.isActive !== false)
        .filter((r) => r.deletedAt === undefined || r.deletedAt === null);

      const data = {
        pending:   rows.filter((r) => r.status === "pending").length + apps.length,
        approved:  rows.filter(approvedish).length,
        rejected:  rows.filter((r) => r.status === "rejected").length,
        suspended: rows.filter((r) => r.status === "suspended").length,
        total:     rows.length,
        thisMonth: rows.filter((r) => r.createdAt && String(r.createdAt) >= monthStart).length,
      };

      // Under both names, as the endpoint sends it.
      return ok({ data, stats: data });
    },
  },
];
