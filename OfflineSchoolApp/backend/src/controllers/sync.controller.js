// backend/controllers/sync.controller.js
"use strict";

const Class            = require("../db/models/Class");
const User              = require("../db/models/User");
const Subject           = require("../db/models/Subject");
const Period            = require("../db/models/Period");
const TeacherAssignment = require("../db/models/TeacherAssignment");
const SyncTombstone     = require("../db/models/SyncTombstone");

// ── Optional models ───────────────────────────────────────────────────────────

let Student = null;
try {
  Student = require("../db/models/Student");
} catch {
  console.warn("[sync] ⚠️  Student model not found — students will be omitted from pull");
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this caller sync the named school?
 *
 * Their own school, or any school for a super_admin, who has none of their own
 * and names the one they are working inside (the phone's school picker). The
 * door (middleware/auth.js) has already refused a super_admin naming a school
 * that does not exist or was deleted.
 */
const mayUseSchool = (req, schoolId) =>
  req.user?.role === "super_admin" ||
  req.user?.schoolId?.toString() === String(schoolId);

/**
 * Builds a Mongoose updatedAt filter.
 * If lastSyncDate is in the future we clamp to epoch so the filter
 * is always present and we never accidentally return every record.
 *
 * ── Why this is $gte and not $gt ──────────────────────────────────────────
 *
 * The cursor handed back to the client is stamped BEFORE these queries run, so
 * that a row written while they are in flight is re-sent next time rather than
 * skipped. That reasoning is right and it had an off-by-one-millisecond hole
 * left in it, because the filter was exclusive.
 *
 * Take a cursor stamped at T. The queries begin in that same millisecond. A row
 * written at exactly T, after its collection's query has already run, is not in
 * the reply — and the next pull asks for updatedAt > T, which excludes it. That
 * row is never offered to that device again. Not a delay: a permanent hole, one
 * millisecond wide, in the collection somebody happened to be writing to.
 *
 * Inclusive closes it. The cost is that rows stamped exactly on the cursor come
 * back once more, which is what the client already tolerates — every pull
 * applies as an upsert, and the comment on pulledAt already accepts re-sending
 * as the safe direction. Skipping is the unsafe one.
 *
 * The desktop feed does not need this: its cursor is the pair (updatedAt, _id),
 * which is a total order, so it can be exclusive without a boundary at all.
 */
const sinceFilter = (lastSyncDate) => {
  const now = new Date();

  if (lastSyncDate > now) {
    console.warn(
      `[sync] ⚠️  lastSync (${lastSyncDate.toISOString()}) is in the future — ` +
      "clamping to epoch"
    );
    return { updatedAt: { $gt: new Date(0) } };
  }

  return { updatedAt: { $gte: lastSyncDate } };
};

/**
 * How many rows of ONE collection a single pull may carry.
 *
 * The pull used to answer with every changed row of all six collections in
 * one body, so a first sync of a large school was one unbounded response —
 * tens of thousands of students over a phone link that may not last a minute.
 *
 * Now each collection is read in (updatedAt, _id) order and cut at the limit.
 * When any collection is cut, `timestamp` is pulled back to the updatedAt of
 * the last row sent from the cut collection(s), and `hasMore: true` says so.
 * A client that knows nothing of paging — every phone build before the feed
 * moved to /sync/changes — stores `timestamp` as it always has, and its next
 * pull (inclusive `$gte`) continues from there. The data arrives over several
 * syncs instead of one, and nothing is skipped: every row after the cursor is
 * either in this answer or after the cursor that goes back.
 *
 * Known edge, documented rather than fixed: more than `limit` rows of one
 * collection sharing ONE millisecond cannot be split by a plain timestamp, so
 * an old client would be offered the same first `limit` of them every time.
 * New clients read /sync/changes, whose (updatedAt, _id) cursor has no such
 * edge; logged when it happens.
 */
const PULL_LIMIT_DEFAULT = 2000;
const PULL_LIMIT_MAX     = 2000;

const pullLimit = (raw) => {
  const n = Number.parseInt(raw, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : PULL_LIMIT_DEFAULT, 1), PULL_LIMIT_MAX);
};

/** Excludes soft-deleted documents from any query. */
const NOT_DELETED = {
  $or: [
    { deletedAt: { $exists: false } },
    { deletedAt: null               },
  ],
};

/**
 * Normalises a raw Student document into a stable, canonical shape.
 * Aliases are kept to a minimum — one resolved value per logical field.
 */
const normaliseStudentForSync = (s) => {
  if (!s) return null;

  const id          = String(s._id || s.id || "");
  const firstName   = s.firstName  || null;
  const lastName    = s.lastName   || null;
  const name        = [firstName, lastName].filter(Boolean).join(" ").trim()
                      || s.studentName || s.name || "Unknown";

  const classId    = s.classId   || s.class_id  || null;
  const enrollment = s.enrollmentNo || s.enrollment_no
                     || s.admissionNo || s.admissionNumber || null;

  return {
    id,
    _id:          id,
    name,
    firstName,
    lastName,
    studentName:  s.studentName || name,
    email:        (s.email || s.studentEmail || s.parentEmail || "").toLowerCase().trim(),
    phone:        s.phone || s.phoneNumber || s.guardianPhone || null,
    guardianName: s.guardianName || s.parentName  || null,
    guardianPhone:s.guardianPhone|| s.parentPhone || null,
    enrollmentNo: enrollment,
    admissionNo:  s.admissionNo  || enrollment,
    classId,
    className:    s.className    || s.class_name || null,
    status:       s.status       || "approved",
    isActive:     s.isActive     ?? true,
    schoolId:     s.schoolId     || null,
    userId:       s.userId       || null,
    approvedAt:   s.approvedAt   || null,
    createdAt:    s.createdAt    || null,
    updatedAt:    s.updatedAt    || null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PULL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /sync/pull?schoolId=&lastSync=
 *
 * Returns all entities that have changed since `lastSync` for the given school.
 * The caller must belong to the same school (enforced below).
 */
exports.pullChanges = async (req, res) => {
  try {
    const { schoolId, lastSync } = req.query;

    // ── Validate schoolId ────────────────────────────────────────────────
    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    // ── Ownership guard — caller must belong to the requested school ─────
    if (!mayUseSchool(req, schoolId)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // ── Parse lastSync date ──────────────────────────────────────────────
    const parsedDate    = lastSync ? new Date(lastSync) : new Date(0);
    const effectiveDate = isNaN(parsedDate.getTime()) ? new Date(0) : parsedDate;

    console.log(`📥 Pull requested for school ${schoolId} since ${effectiveDate.toISOString()}`);

    // The cursor the client will send back as `lastSync` next time, taken
    // BEFORE the queries below run. Taken after them, any record written
    // while they were in flight would carry an updatedAt earlier than the
    // returned timestamp, so the next pull's `since` filter would never
    // match it and the client would miss that row permanently. Taken
    // first, the worst case is re-sending a row the client already has.
    const pulledAt = new Date().toISOString();

    const since = sinceFilter(effectiveDate);

    // ── Who is asking ────────────────────────────────────────────────────
    //
    // This route scoped hard by TENANT and not at all by ROLE, so a pupil's
    // phone received the same payload as the head teacher's: every approved
    // student's name, email, phone, GUARDIAN NAME and GUARDIAN PHONE, plus
    // every teacher's email and account state.
    //
    // The tenancy guard above is untouched — it was always right. What is added
    // is a narrower slice for a student caller. Narrowed rather than refused,
    // because the student app is built on this payload and blocking the route
    // would take every student device offline permanently.
    const role       = req.user?.role ?? null;
    const isStudent  = role === "student";
    const callerId   = String(req.user?._id ?? req.user?.id ?? "");

    // A student keeps teacher NAMES — the timetable shows who teaches each
    // period and is unreadable without them — and loses everything else. An
    // email address and a mustResetPassword flag together tell a pupil which
    // staff accounts have never been signed into.
    // deletedAt for a student too: it is how a deleted teacher leaves the
    // timetable on their device, and it says nothing about the account.
    const teacherFields = isStudent
      ? "name role schoolId deletedAt createdAt updatedAt"
      : "name email role schoolId isActive mustResetPassword enrollmentNo staffNo deletedAt createdAt updatedAt";

    // ── Removals: how a deletion reaches a device ────────────────────────
    //
    // The contract is the one the desktop feed already keeps and every apply
    // function on the phone already reads: a row that arrives with deletedAt
    // set is marked deleted locally (syncManager syncClasses … syncStudents).
    // This route never sent one. Each query excluded soft-deleted rows, so a
    // deletion moved the row's updatedAt and then hid it; hard deletes
    // (subjects, assignments, students) left no row at all; and deletedItems
    // was always []. A device kept every deleted record for good.
    //
    // On an INCREMENTAL pull (a cursor was sent), so, three kinds of removal:
    //   - soft-deleted rows changed since the cursor, sent as they are;
    //   - students who left the roster this pull serves (no longer approved
    //     and active), sent as { _id, deletedAt };
    //   - hard deletes, from their tombstones (models/SyncTombstone.js),
    //     sent the same way — except where the row still exists (a delete
    //     that failed after its tombstone was written).
    // A FIRST pull (no cursor) is unchanged: the device has nothing to remove.
    // The cursor contract is unchanged too: the same inclusive `since`, so a
    // removal stamped on the cursor is sent twice rather than never, and
    // applying one twice is a no-op.
    const incremental = Boolean(lastSync) && effectiveDate.getTime() > 0;
    const live = incremental ? {} : NOT_DELETED;

    // A student caller gets their own row and nobody else's. Matched on either
    // key because the link between a User and a Student is recorded as userId
    // on most rows and as the shared _id on older ones. Under $and: spread
    // beside NOT_DELETED, whose key is also $or, this filter was overwritten,
    // and a student's token received every pupil in the school with their
    // guardians' names and phone numbers.
    const ownStudent = isStudent ? { $or: [{ userId: callerId }, { _id: callerId }] } : null;
    const studentFilter = {
      schoolId,
      ...since,
      ...(incremental ? {} : { status: "approved", isActive: true }),
      $and: [ownStudent, incremental ? null : NOT_DELETED].filter(Boolean),
    };
    if (!studentFilter.$and.length) delete studentFilter.$and;

    // ── Fetch all entity types in parallel, one bounded page each ────────
    const limit = pullLimit(req.query.limit);
    const page  = (q, key = "updatedAt") => q.sort({ [key]: 1, _id: 1 }).limit(limit + 1);

    const [rawClasses, rawTeachers, rawSubjects, rawPeriods, rawAssignments, rawStudentsPage, rawTombstones] =
      await Promise.all([
        page(Class.find({ schoolId, ...since, ...live })).lean(),

        page(User.find({ schoolId, role: "teacher", ...since })
          .select(teacherFields))
          .lean(),

        page(Subject.find({ schoolId, ...since, ...live })).lean(),

        page(Period.find({ schoolId, ...since, ...live })).lean(),

        page(TeacherAssignment.find({ schoolId, ...since, ...live })
          // Name only for a student: teacherFields above keeps staff emails
          // off a pupil's device, and this join handed them back.
          .populate("teacher", isStudent ? "name" : "name email")
          .populate("class",   "name")
          .populate("subject", "name"))
          .lean(),

        // Their own row is still sent to a student rather than dropped,
        // because the local students table is what several student screens
        // read their class and admission number from.
        Student ? page(Student.find(studentFilter)).lean() : Promise.resolve([]),

        incremental
          // The same bound as every row above (sinceFilter: a cursor from the
          // future reads from the beginning), on the deletion's own time.
          ? page(SyncTombstone.find({ schoolId: String(schoolId), deletedAt: since.updatedAt }), "deletedAt").lean()
          : Promise.resolve([]),
      ]);

    // Cut each collection at the limit. The cursor handed back may not pass
    // the last row SENT of any cut collection, or the rows after it in that
    // collection would sort before the next pull's `since` and never come.
    let hasMore  = false;
    let boundary = null;
    const cut = (rows, key = "updatedAt") => {
      if (rows.length <= limit) return rows;
      hasMore = true;
      const kept = rows.slice(0, limit);
      const at   = new Date(kept[kept.length - 1][key]);
      if (!boundary || at < boundary) boundary = at;
      return kept;
    };
    const classes     = cut(rawClasses);
    const teachers    = cut(rawTeachers);
    const subjects    = cut(rawSubjects);
    const periods     = cut(rawPeriods);
    const assignments = cut(rawAssignments);
    const rawStudents = cut(rawStudentsPage);
    const tombstones  = cut(rawTombstones, "deletedAt");

    // Students: on the roster → the full row; off it → a removal.
    const onRoster = (s) => s.status === "approved" && s.isActive === true && !s.deletedAt;
    const removal  = (id, sid, at) => ({ _id: String(id), id: String(id), schoolId: sid ?? null, deletedAt: at });
    const students = [];
    for (const s of rawStudents) {
      if (onRoster(s)) {
        const row = normaliseStudentForSync(s);
        if (row) students.push(row);
      } else {
        students.push(removal(s._id, s.schoolId, s.deletedAt || s.updatedAt || pulledAt));
      }
    }

    // Hard deletes. A student caller hears only of their own record.
    const stoneFor = { subject: subjects, teacherAssignment: assignments, student: students };
    const stoneModel = { subject: Subject, teacherAssignment: TeacherAssignment, student: Student };
    const relevant = tombstones.filter((t) => stoneFor[t.entity] && (!isStudent || t.entity !== "student" || t.docId === callerId));
    for (const entity of Object.keys(stoneFor)) {
      const ids = relevant.filter((t) => t.entity === entity).map((t) => t.docId);
      if (!ids.length || !stoneModel[entity]) continue;
      const stillThere = new Set((await stoneModel[entity].find({ _id: { $in: ids } }).distinct("_id")).map(String));
      const already = new Set(stoneFor[entity].map((r) => String(r._id)));
      for (const t of relevant) {
        if (t.entity !== entity || stillThere.has(t.docId) || already.has(t.docId)) continue;
        stoneFor[entity].push(removal(t.docId, t.schoolId, t.deletedAt));
      }
    }

    // The same removals, listed: informational, for a client that wants
    // them in one place. The rows above are what the phone applies.
    const deletedItems = [];
    for (const [collection, rows] of Object.entries({ classes, teachers, subjects, periods, assignments, students })) {
      for (const r of rows) {
        if (r.deletedAt) deletedItems.push({ collection, id: String(r._id), deletedAt: r.deletedAt });
      }
    }

    console.log(
      `📦 Pull results (${role ?? "unknown"}) — classes: ${classes.length}, ` +
      `teachers: ${teachers.length}, subjects: ${subjects.length}, ` +
      `periods: ${periods.length}, assignments: ${assignments.length}, ` +
      `students: ${students.length}` + (hasMore ? ` — page cut at ${limit}, more to come` : "")
    );

    // The cursor: the earlier of "before the queries ran" and the last row
    // sent from a collection that was cut (see PULL_LIMIT_DEFAULT).
    let timestamp = pulledAt;
    if (boundary && boundary < new Date(timestamp)) timestamp = boundary.toISOString();
    if (hasMore && boundary && boundary.getTime() <= effectiveDate.getTime()) {
      console.warn(
        `[sync] ⚠️  more than ${limit} rows share updatedAt ${boundary.toISOString()} — ` +
        "a timestamp cursor cannot split them; /sync/changes can"
      );
    }

    return res.json({
      success: true,
      data: {
        classes,
        teachers,
        subjects,
        periods,
        assignments,
        students,
        deletedItems,
      },
      timestamp,
      // True when a collection was cut at `limit`: pull again from `timestamp`
      // for the rest. Older clients ignore it and get the rest next sync.
      hasMore,
      limit,
    });

  } catch (err) {
    console.error("[sync] Pull changes error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch sync data" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUSH — retired
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /sync/push — 410 Gone.
 *
 * It wrote period definitions and student approve/reject decisions from a
 * device, and both were wrong in ways that mattered:
 *
 *   - an approval found the pupil's login by User.findOne({ email, role:
 *     "student" }). Siblings share the parent's email, so approving the second
 *     child renamed the FIRST child's account, reset its password and gave it
 *     the second child's admission number — an account takeover inside a family;
 *   - a period create discarded the client's UUID (only an ObjectId was kept),
 *     so the device's row and the server's never matched up again;
 *   - the wrapper answered success: true whatever the sub-handlers reported.
 *
 * No client calls it. The phone drains its outbox through the real routes
 * (PUT /admin/students/:id/approve, the periods routes) and pulls with GET
 * /sync/pull; the desktop pulls GET /sync/changes and replays the same real
 * routes. The web and mobile endpoint maps only held the constant.
 *
 * The route stays so that anything old still holding it is told plainly what
 * happened instead of meeting a 404 that reads like a deployment fault.
 * Nothing in the body is read and nothing is written.
 */
exports.pushRetired = (_req, res) =>
  res.status(410).json({
    success: false,
    code:    "SYNC_PUSH_RETIRED",
    message:
      "POST /sync/push has been retired. Send each change to its own route " +
      "(e.g. PUT /api/admin/students/:id/approve, the periods routes) and pull " +
      "with GET /api/sync/pull or GET /api/sync/changes.",
  });
