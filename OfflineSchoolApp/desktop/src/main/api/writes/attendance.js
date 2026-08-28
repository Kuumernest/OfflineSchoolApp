// desktop/src/main/api/writes/attendance.js
"use strict";

/**
 * Taking a register with no connection.
 *
 * ── The clearest case for any of this ─────────────────────────────────────
 *
 * A classroom is where a school is least likely to have a connection and most
 * certain to need one: the register is taken at a fixed moment, for a room full
 * of children, and it cannot wait until the wifi comes back. Everything else in
 * this layer is convenience beside it.
 *
 * ── Identity is not invented here ─────────────────────────────────────────
 *
 * A mark's _id is DERIVED from its natural key by shared/attendance.js, and both
 * this file and the endpoint compute it the same way. That is what makes the
 * whole thing safe rather than merely queued:
 *
 *   the endpoints upsert on (school, class, subject, student, day), so marking a
 *   register twice corrects the row instead of adding one. But if the id were
 *   invented, a register marked here while the office marked the same class from
 *   the web would leave the server holding that row under a different id — the
 *   queued request would correctly update the server's row, and the next pull
 *   would hand this machine a SECOND row for the same child on the same day.
 *
 * With the id derived, both sides land on the same row whoever writes first, and
 * a replay is simply another upsert. No reconciliation, and no duplicate to find
 * later in a report that quietly counts a pupil twice.
 */

const {
  STATUSES,
  dateStr,
  attendanceId,
} = require("../../../../../shared/attendance");

/**
 * The students of a class, as the endpoint verifies them.
 *
 * Both write routes check that each id belongs to a student in THIS class and
 * school before upserting. That check was added to the endpoints because the
 * upsert would otherwise create attendance for somebody who is not in the school
 * at all, and there is no route that can delete such a row.
 */
const studentsOfClass = (docs, { schoolId, classId }) =>
  new Set(
    docs.find("student", { schoolId, classId }).map((s) => String(s._id))
  );

/**
 * The row to store for one mark, with an id derived rather than invented.
 *
 * ── Marking a register twice is an UPDATE, and looks like one ─────────────
 *
 * Because the id comes from the natural key, a mark for a pupil already marked
 * today resolves to the row that is already there. That is the point — it is how
 * a correction reaches the same row on both sides — but it means this cannot
 * simply build a fresh document: doing so would stamp a new createdAt over the
 * moment the register was first taken, and the endpoint's upsert leaves that
 * field alone ($setOnInsert applies only when inserting).
 *
 * So an existing row is merged under the new values, and only the fields the
 * endpoint's $set touches are changed.
 */
const markFor = (docs, { schoolId, classId, subjectId, periodId, studentId, date, status, note, by }) => {
  const _id = attendanceId({ schoolId, classId, subjectId, studentId, date });
  const now = new Date().toISOString();

  // _pending is added when a row is read, not a field of the document — see the
  // note on it in the sync engine.
  const { _pending, ...existing } = docs.get("studentAttendance", _id) ?? {};

  return {
    // What $setOnInsert would have written, kept from the row if it is there.
    _id,
    schoolId,
    classId,
    subjectId: subjectId || null,
    studentId: String(studentId),
    date,
    createdAt: existing.createdAt ?? now,
    deletedAt: existing.deletedAt ?? null,

    ...existing,

    // What $set writes, which is what a second marking actually changes.
    periodId:  periodId || null,
    status,
    note:      note || null,
    markedBy:  by ?? null,
    markedAt:  now,
    updatedAt: now,
  };
};

module.exports = [
  {
    route: "POST /api/attendance/students/bulk",

    /**
     * A whole class at once — the request a teacher actually makes.
     *
     * ── A partial failure is a success, and must stay one ───────────────────
     *
     * The endpoint does not refuse the batch when a record is bad. It sorts the
     * records into saved and failed, upserts the good ones, and answers 201 with
     * the counts and the rejected rows. Reproduced exactly, because a screen
     * reads those counts to tell the teacher what happened — and because a
     * local answer that refused the whole batch would lose the marks that were
     * perfectly good.
     *
     * The one case declined outright is a batch where NOTHING would be saved.
     * The endpoint would write nothing either, so queueing it is pointless; sent
     * over the network it fails visibly, which is the honest answer to a
     * register in which no id belongs to the class.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // The endpoint's 400.
      if (!body.classId) return null;
      if (!Array.isArray(body.records) || body.records.length === 0) return null;

      const classId   = String(body.classId);
      const subjectId = body.subjectId || null;
      const date      = dateStr(body.date);
      const known     = studentsOfClass(docs, { schoolId, classId });

      const rows   = [];
      const failed = [];

      for (const row of body.records) {
        // The endpoint's own two reasons, with its own wording — a screen shows
        // them to whoever is marking.
        if (!row.studentId || !STATUSES.includes(row.status)) {
          failed.push({ ...row, reason: "Invalid studentId or status" });
          continue;
        }
        if (!known.has(String(row.studentId))) {
          failed.push({ ...row, reason: "Student not found in this class" });
          continue;
        }
        rows.push(markFor(docs, {
          schoolId, classId, subjectId, periodId: body.periodId,
          studentId: row.studentId, date,
          status: row.status, note: row.note,
          by: session?.userId,
        }));
      }

      // Nothing to write — see the docstring.
      if (rows.length === 0) return null;

      const [primary, ...rest] = rows;

      return {
        collection: "studentAttendance",
        doc:        primary,
        also:       rest.map((doc) => ({ collection: "studentAttendance", doc })),

        request: {
          method: "POST",
          path:   "/api/attendance/students/bulk",
          // Unchanged: the server re-derives every id from the natural key, so
          // there is nothing for this layer to add to the body.
          body,
        },

        // Counts, not documents — exactly what the endpoint answers with.
        response: {
          status: 201,
          data: {
            success:       true,
            saved:         rows.length,
            failed:        failed.length,
            failedRecords: failed,
          },
        },
      };
    },
  },

  {
    route: "POST /api/attendance/students",

    /**
     * One pupil — a correction after the register was taken, usually.
     *
     * Unlike the batch, every failure here is a refusal: a bad status is a 400
     * and an unknown student a 404. Both are checked, because either queued
     * would stop the outbox.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // The endpoint's 400s.
      if (!body.classId || !body.studentId || !body.status) return null;
      if (!STATUSES.includes(body.status)) return null;

      const classId = String(body.classId);

      // Its 404. The endpoint added this check because the upsert would
      // otherwise create a row for somebody outside the school, and no route can
      // remove one.
      if (!studentsOfClass(docs, { schoolId, classId }).has(String(body.studentId))) {
        return null;
      }

      const doc = markFor(docs, {
        schoolId, classId,
        subjectId: body.subjectId || null,
        periodId:  body.periodId,
        studentId: body.studentId,
        date:      dateStr(body.date),
        status:    body.status,
        note:      body.note,
        by:        session?.userId,
      });

      return {
        collection: "studentAttendance",
        doc,
        request: {
          method: "POST",
          path:   "/api/attendance/students",
          body,
        },
        response: { status: 201, data: { success: true, record: doc } },
      };
    },
  },
];
