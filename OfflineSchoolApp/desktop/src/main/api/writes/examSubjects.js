// desktop/src/main/api/writes/examSubjects.js
"use strict";

/**
 * The subjects on an exam: adding one, setting its coefficient, and the
 * submit-approve-reject loop that marks move through.
 *
 * ── Why these four belong together ────────────────────────────────────────
 *
 * They are the marks workflow, and it is the part of the term a school cannot
 * pause. A teacher enters marks for their subject and submits them; the head
 * approves or sends them back with a reason. That happens in the days before
 * reports go out, which is exactly when nobody can afford to wait for the
 * connection to come back.
 *
 * ── A write must not queue something the server will refuse ───────────────
 *
 * The rule that shapes every handler here. A refused write STOPS the outbox and
 * waits for a person, so a queued request the server will 409 or 400 does not
 * merely fail — it holds up everything queued behind it, including work that has
 * nothing to do with exams.
 *
 * So each handler checks what the endpoint checks, and DECLINES when it cannot
 * be sure. Declining is not queueing: the request goes over the network exactly
 * as it did before, and with no connection it fails there and now, which is a
 * far better answer than a queue that stops tomorrow.
 *
 * ── What cannot be resolved locally is not guessed ────────────────────────
 *
 * Adding a subject stores its name and its teacher's name, read from two other
 * collections. The staff directory needs users.manage to mirror, so a teacher's
 * own machine does not hold it — and a subject row this layer wrote with
 * teacherName null would show a blank name on the screen until the next pull
 * corrected it. Absent rows mean decline, which happens to be exactly right per
 * role without any handler knowing about roles.
 */

const { randomUUID } = require("crypto");

/** The exam subject this request is for, matched as the endpoint matches it. */
const target = (docs, { examId, id, schoolId, requireLive }) => {
  const row = docs.get("examSubject", String(id));
  if (!row) return null;
  if (String(row.examId)   !== String(examId))  return null;
  if (String(row.schoolId) !== String(schoolId)) return null;

  // submit, approve and reject match WITHOUT deletedAt: null — a subject
  // removed from the exam can still have its marks approved, on the server, so
  // adding the filter here would decline a request the endpoint accepts.
  if (requireLive && row.deletedAt) return null;

  return row;
};

module.exports = [
  {
    route: "POST /api/exams/:examId/subjects",

    /**
     * Putting a subject on an exam.
     *
     * ── The coefficient, and where it comes from ────────────────────────────
     *
     * Subject.coefficient is a plain multiplier — 1, 2, 3 — because that is what
     * an admin types. ExamSubject.weight is percentage-style, 100 meaning ×1,
     * because that is what the grading service and the report card renderer
     * read. The endpoint scales one into the other, and an explicit weight in
     * the request overrides it. Getting that scaling wrong by a factor of a
     * hundred would rescale every average in the class, so it is reproduced
     * exactly rather than approximated.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!body.subjectId) return null;      // the endpoint's own 400

      const examId = String(params.examId);
      const exam   = docs.get("exam", examId);
      // The endpoint's 404. Note it does NOT require deletedAt: null here —
      // a subject may be added to an archived exam.
      if (!exam) return null;
      if (String(exam.schoolId) !== String(schoolId)) return null;

      const subjectId = String(body.subjectId);
      const subject   = docs.get("subject", subjectId);
      // Absent means either no such subject or a collection this machine does
      // not mirror, and the two are indistinguishable from here. See the file
      // note: the name it would store is the name a screen prints.
      if (!subject) return null;

      let teacherName = null;
      if (body.teacherId) {
        const teacher = docs.get("user", String(body.teacherId));
        if (!teacher) return null;
        teacherName = teacher.name || null;
      }

      const classId = body.classId || exam.classId;

      // The endpoint's 409. Queueing through it would stop the whole outbox on
      // a request that can never succeed.
      const clash = docs.find("examSubject", {
        examId, subjectId, classId, deletedAt: null,
      });
      if (clash.length > 0) return null;

      // Percentage-style from the plain multiplier — see the docstring.
      const coefficient = Number(subject.coefficient) > 0 ? Number(subject.coefficient) : 1;
      const weight      = body.weight ?? Math.round(coefficient * 100);

      const id  = randomUUID();
      const now = new Date().toISOString();

      const doc = {
        _id:              id,
        examId,
        subjectId,
        classId,
        schoolId,
        teacherId:        body.teacherId   || null,
        subjectName:      subject.name     || null,
        teacherName,
        maxScore:         body.maxScore    ?? 100,
        passMark:         body.passMark    ?? 50,
        weight,
        isPractical:      body.isPractical ?? false,
        isTheory:         body.isTheory    ?? true,
        isOral:           body.isOral      ?? false,
        submissionStatus: "pending",
        submittedBy:      null,
        submittedAt:      null,
        approvedBy:       null,
        approvedAt:       null,
        rejectedBy:       null,
        rejectedAt:       null,
        rejectReason:     null,
        deletedAt:        null,
        createdAt:        now,
        updatedAt:        now,
      };

      return {
        collection: "examSubject",
        doc,
        request: {
          method: "POST",
          path:   `/api/exams/${examId}/subjects`,
          body:   { ...body, _id: id },
        },
        response: { status: 201, data: { success: true, subject: doc } },
      };
    },
  },

  {
    route: "PUT /api/exams/:examId/subjects/:id",

    /**
     * The settings of one exam subject — including its coefficient.
     *
     * ── Two things this handler must not get wrong ──────────────────────────
     *
     * It is guarded by exams.manage, because a coefficient rescales every
     * student's average in the class: a head's decision, not a marker's. The
     * session's permissions are checked here rather than left to the server,
     * since a queued request that comes back 403 stops the outbox.
     *
     * And `reprocessRequired` in the response is not decoration. A changed
     * coefficient or maxScore makes already-computed averages stale; the
     * endpoint refuses to recompute silently, because that would rewrite
     * results an admin may already have published, and tells the caller
     * instead. A local answer that always said false would leave a screen
     * quietly presenting stale averages as current.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("exams.manage")) return null;

      const row = target(docs, {
        examId: params.examId, id: params.id, schoolId, requireLive: true,
      });
      if (!row) return null;

      const updates = {};
      for (const key of ["maxScore", "passMark", "weight"]) {
        if (body[key] === undefined) continue;
        const n = Number(body[key]);
        // The endpoint's 400. Its message names the field, and reproducing that
        // text here would be a second copy of it.
        if (!Number.isFinite(n) || n <= 0) return null;
        updates[key] = n;
      }

      if (body.teacherId !== undefined) {
        updates.teacherId = body.teacherId || null;
        if (body.teacherId) {
          const teacher = docs.get("user", String(body.teacherId));
          if (!teacher) return null;          // see the file note
          updates.teacherName = teacher.name || null;
        } else {
          updates.teacherName = null;
        }
      }

      for (const flag of ["isPractical", "isTheory", "isOral"]) {
        if (body[flag] !== undefined) updates[flag] = Boolean(body[flag]);
      }

      // The endpoint's "Nothing to update" 400.
      if (Object.keys(updates).length === 0) return null;

      const doc = { ...row, ...updates, updatedAt: new Date().toISOString() };

      // Exactly the endpoint's condition: marks already entered, AND one of the
      // two fields that invalidate an average actually changed.
      const hasScores = docs.count("studentScore", {
        examId: row.examId, subjectId: row.subjectId, schoolId, deletedAt: null,
      }) > 0;
      const reprocessRequired = Boolean(
        hasScores && (updates.weight !== undefined || updates.maxScore !== undefined)
      );

      return {
        collection: "examSubject",
        doc,
        request: {
          method: "PUT",
          path:   `/api/exams/${row.examId}/subjects/${row._id}`,
          body,
        },
        response: { status: 200, data: { success: true, subject: doc, reprocessRequired } },
      };
    },
  },

  {
    route: "PATCH /api/exams/:examId/subjects/:examSubjectId/approve",

    /**
     * The head accepts a teacher's marks.
     *
     * Clears the rejection stamps as well as setting the approval ones — a
     * subject approved after having been sent back must not still read as
     * rejected, which is what a screen showing both would say.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const row = target(docs, {
        examId: params.examId, id: params.examSubjectId, schoolId,
      });
      if (!row) return null;

      const now = new Date().toISOString();
      const doc = {
        ...row,
        submissionStatus: "approved",
        approvedBy:       session?.userId ?? null,
        approvedAt:       now,
        rejectedBy:       null,
        rejectedAt:       null,
        rejectReason:     null,
        updatedAt:        now,
      };

      return {
        collection: "examSubject",
        doc,
        request: {
          method: "PATCH",
          path:   `/api/exams/${row.examId}/subjects/${row._id}/approve`,
          body,
        },
        response: { status: 200, data: { success: true, subject: doc } },
      };
    },
  },

  {
    route: "PATCH /api/exams/:examId/subjects/:examSubjectId/reject",

    /**
     * The head sends marks back, with a reason.
     *
     * The reason is required, and it is required HERE as well as on the server:
     * a rejection queued without one comes back 400, and a 400 stops the outbox
     * until somebody works out why. The reason is also trimmed the way the
     * endpoint trims it, since it is what the teacher reads.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const reason = String(body.reason ?? "").trim();
      if (!reason) return null;          // the endpoint's 400

      const row = target(docs, {
        examId: params.examId, id: params.examSubjectId, schoolId,
      });
      if (!row) return null;

      const now = new Date().toISOString();
      const doc = {
        ...row,
        submissionStatus: "rejected",
        rejectedBy:       session?.userId ?? null,
        rejectedAt:       now,
        rejectReason:     reason,
        approvedBy:       null,
        approvedAt:       null,
        updatedAt:        now,
      };

      return {
        collection: "examSubject",
        doc,
        request: {
          method: "PATCH",
          path:   `/api/exams/${row.examId}/subjects/${row._id}/reject`,
          body,
        },
        response: { status: 200, data: { success: true, subject: doc } },
      };
    },
  },
];
