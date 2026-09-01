// desktop/src/main/api/writes/students.js
"use strict";

/**
 * Admin pupil-record writes, answered from the local mirror when the school
 * office has no connection.
 *
 * ── The lesson this file is built on ──────────────────────────────────────
 *
 * Eight of these routes on the server took a pupil id and never asked whose
 * pupil it was — anybody holding students.manage could suspend a child in a
 * school they had nothing to do with, and /move could even land one in another
 * school's class. check-student-tenancy.js exists to keep that fixed. So every
 * lookup here carries schoolId, taken from the SESSION rather than trusted from
 * the body, and a pupil not in this school's mirror is simply not found — the
 * same answer the fixed server gives, and the reason a wrong-school id here
 * declines to the queue instead of writing anything.
 *
 * ── Why a miss declines rather than fails ─────────────────────────────────
 *
 * Returning null hands the request to the outbox, which replays it against the
 * server when the connection returns — the server then answers with its own
 * 404/409/400 and the screen shows the honest reason. A local handler that
 * invented a success for a pupil it cannot see would be the drift this project
 * keeps finding: two implementations of one operation, only one of them right.
 */

const { normaliseStudentDoc } = require("../../../../../shared/students");

const nowISO = () => new Date().toISOString();

/**
 * The caller's school. The session is authoritative; a schoolId in the body is
 * accepted only when it agrees, because the server's resolveSchoolId lets it
 * through for super_admin alone — and the desktop session is never that.
 */
const schoolOf = (body, session) => {
  const fromBody = body?.schoolId ? String(body.schoolId).trim() : null;
  const fromSession = session?.schoolId ? String(session.schoolId).trim() : null;
  if (fromBody && fromSession && fromBody !== fromSession) return null;
  return fromSession || fromBody || null;
};

/** The pupil — found only inside the caller's school. */
const pupilOf = (docs, schoolId, id) => {
  if (!id || !schoolId) return null;
  const rows = docs.find("student", { _id: String(id).trim(), schoolId });
  return rows[0] ?? null;
};

/** The user account behind a pupil, for suspending/restoring the login. */
const userOf = (docs, schoolId, userId) => {
  if (!userId || !schoolId) return null;
  const rows = docs.find("user", { _id: String(userId), schoolId });
  return rows[0] ?? null;
};

/** A pending application, in whatever collection the mirror holds it under. */
const applicationOf = (docs, schoolId, id) => {
  if (!id || !schoolId) return null;
  for (const name of ["studentApplication"]) {
    try {
      const rows = docs.find(name, { _id: String(id).trim(), schoolId });
      if (rows[0]) return { collection: name, doc: rows[0] };
    } catch {
      // A collection the mirror does not hold at all — try the next name.
    }
  }
  return null;
};

const responseFor = (student, message, extra = {}) => ({
  success: true,
  message,
  student: normaliseStudentDoc({ ...student, _source: "student" }),
  ...extra,
});

const touch = (doc, fields) => ({
  ...doc,
  ...fields,
  updatedAt: nowISO(),
});

/**
 * The pupil's name as the server phrases it in messages — the same resolution
 * order normaliseStudentDoc uses, because both descend from the same reality:
 * two collections that spell a name three ways.
 */
const displayName = (doc) =>
  [doc?.firstName, doc?.lastName].filter(Boolean).join(" ").trim() ||
  doc?.studentName ||
  doc?.name ||
  "Student";

/**
 * The concurrent-edit guard, decided locally with the same rule the endpoint
 * applies at logOverwriteIfNeeded: the caller said what version of the record
 * it was editing, and if the mirror's row moved on since — under a DIFFERENT
 * editor — that edit is an overwrite and the caller is told. The SyncOverwrite
 * audit row itself is created by the server on replay; the id here is null and
 * the replayed answer carries the real one.
 */
const overwroteFor = (row, body, session) => {
  const base = body?.baseUpdatedAt ?? null;
  if (!base) return null;

  const baseline = new Date(base);
  if (isNaN(baseline.getTime())) return null;

  const rowTime = new Date(row.updatedAt ?? 0);
  if (rowTime.getTime() <= baseline.getTime()) return null;

  const prevEditor = row.updatedBy ? String(row.updatedBy) : null;
  const thisEditor = session?.userId ? String(session.userId) : null;
  if (prevEditor && thisEditor && prevEditor === thisEditor) return null;

  return {
    id:         null,
    lostEditAt: row.updatedAt ?? null,
    lostEditBy: row.updatedByName ?? null,
  };
};

module.exports = [
  {
    route: "PATCH /api/admin/students/:id/suspend",

    /**
     * Mirrors the safe server path, not the admin one that drifted: refuses a
     * second suspend (409) and deactivates the pupil's login alongside the
     * record, because a suspended child must not keep a working account.
     */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? body?.id ?? "").trim();
      const pupil = pupilOf(docs, schoolId, id);
      if (!pupil) return null;

      // The safe endpoint's 409 — already suspended is a conflict, not a no-op.
      if (pupil.status === "suspended") return null;

      const doc = touch(pupil, {
        status:   "suspended",
        isActive: false,
        suspendedAt: nowISO(),
      });

      const user = userOf(docs, schoolId, pupil.userId);
      const userDoc = user
        ? touch(user, { isActive: false, updatedAt: nowISO() })
        : null;

      return {
        collection: "student",
        doc,
        also: userDoc ? [{ collection: "user", doc: userDoc }] : [],

        request: {
          method: "PATCH",
          path:   `/api/admin/students/${id}/suspend`,
          body:   { schoolId },
        },

        response: {
          status: 200,
          data:   responseFor(doc, "Student suspended successfully"),
        },
      };
    },
  },

  {
    route: "PATCH /api/admin/students/:id/restore",

    /** The mirror of suspend: reactivates the record and the login. */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? body?.id ?? "").trim();
      const pupil = pupilOf(docs, schoolId, id);
      if (!pupil) return null;

      if (pupil.status !== "suspended") return null;

      const doc = touch(pupil, {
        status:   "active",
        isActive: true,
        restoredAt: nowISO(),
      });

      const user = userOf(docs, schoolId, pupil.userId);
      const userDoc = user
        ? touch(user, { isActive: true, updatedAt: nowISO() })
        : null;

      return {
        collection: "student",
        doc,
        also: userDoc ? [{ collection: "user", doc: userDoc }] : [],

        request: {
          method: "PATCH",
          path:   `/api/admin/students/${id}/restore`,
          body:   { schoolId },
        },

        response: {
          status: 200,
          data:   responseFor(doc, "Student restored successfully"),
        },
      };
    },
  },

  {
    route: "PATCH /api/admin/students/:id/move",

    /**
     * The one that corrupted a register at both ends on the server: the
     * destination class MUST come from this school's mirror. A class id the
     * mirror does not hold under this schoolId declines to the queue — which is
     * exactly how the fixed endpoint behaves (400 "Class not found").
     */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? body?.id ?? "").trim();
      const classId = String(body?.classId ?? "").trim();
      if (!classId) return null;

      const pupil = pupilOf(docs, schoolId, id);
      if (!pupil) return null;

      const classRows = docs.find("class", { _id: classId, schoolId });
      const cls = classRows[0];
      if (!cls) return null;

      if (String(pupil.classId ?? "") === classId) return null;

      const className = cls.name ?? cls.className ?? null;
      const doc = touch(pupil, {
        classId,
        class_id:   classId,
        className,
        class_name: className,
      });

      return {
        collection: "student",
        doc,
        also: [],

        request: {
          method: "PATCH",
          path:   `/api/admin/students/${id}/move`,
          body:   { classId, schoolId },
        },

        response: {
          status: 200,
          data:   responseFor(doc, "Student moved successfully"),
        },
      };
    },
  },

  {
    route: "PUT /api/admin/students/:id/approve",

    /**
     * Approve reads Student AND StudentApplication on the server, and both
     * paths were open — so both are checked here. The replay-tolerant shape the
     * endpoint answers for an already-approved record is reproduced, because
     * the outbox parks bare 409s for a human and the work was already done.
     */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? body?.id ?? "").trim();
      const classId = String(body?.classId ?? "").trim();
      if (!classId) return null;

      const pupil = pupilOf(docs, schoolId, id);
      const app = pupil ? null : applicationOf(docs, schoolId, id);
      const record = pupil ?? app?.doc;
      const source = pupil ? "student" : app?.collection ?? null;
      if (!record) return null;

      const classRows = docs.find("class", { _id: classId, schoolId });
      const cls = classRows[0];
      if (!cls) return null;

      // Already approved — the endpoint's 200 replay answer, not a conflict.
      if (record.status === "approved") {
        return {
          collection: source,
          doc:        record,
          also:       [],

          request: {
            method: "PUT",
            path:   `/api/admin/students/${id}/approve`,
            body:   { classId, schoolId },
          },

          response: {
            status: 200,
            data: {
              success: true,
              replay:  true,
              message: "This application was already approved",
              student: normaliseStudentDoc(record),
            },
          },
        };
      }

      if (record.status !== "pending") return null;

      const className = cls.name ?? cls.className ?? null;
      const doc = touch(record, {
        status:     "approved",
        isActive:   true,
        classId,
        class_id:   classId,
        className,
        class_name: className,
        approvedAt: nowISO(),
        reviewedAt: nowISO(),
        enrolledAt: nowISO(),
        deletedAt:  null,
      });

      return {
        collection: source,
        doc,
        also: [],

        request: {
          method: "PUT",
          path:   `/api/admin/students/${id}/approve`,
          body:   { classId, schoolId },
        },

        response: {
          status: 200,
          data: {
            success: true,
            message: "Application approved successfully",
            student: normaliseStudentDoc({ ...doc, _source: pupil ? "student" : "application" }),
          },
        },
      };
    },
  },

  {
    route: "PUT /api/admin/students/:id/reject",

    /** The route the first pass of the tenancy fix missed entirely. */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? body?.id ?? "").trim();
      const reason = body?.reason ?? null;

      const pupil = pupilOf(docs, schoolId, id);
      const app = pupil ? null : applicationOf(docs, schoolId, id);
      const record = pupil ?? app?.doc;
      const source = pupil ? "student" : app?.collection ?? null;
      if (!record) return null;

      if (record.status === "rejected") return null;
      if (record.status !== "pending") return null;

      const doc = touch(record, {
        status:          "rejected",
        isActive:        false,
        rejectionReason: reason,
        reviewedAt:      nowISO(),
      });

      return {
        collection: source,
        doc,
        also: [],

        request: {
          method: "PUT",
          path:   `/api/admin/students/${id}/reject`,
          body:   { reason, schoolId },
        },

        response: {
          status: 200,
          data: {
            success: true,
            message: "Application rejected successfully",
            student: normaliseStudentDoc({ ...doc, _source: pupil ? "student" : "application" }),
          },
        },
      };
    },
  },

  {
    route: "DELETE /api/admin/students/:id",

    /**
     * Withdraw. The server marks rather than destroys — the record survives as
     * an audit trail — and deactivates the login, which the local mirror does
     * too.
     */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? body?.id ?? "").trim();
      const pupil = pupilOf(docs, schoolId, id);
      if (!pupil) return null;

      if (pupil.deletedAt) return null;

      const when = nowISO();
      const doc = touch(pupil, {
        status:      "withdrawn",
        isActive:    false,
        deletedAt:   when,
        withdrawnAt: when,
      });

      const user = userOf(docs, schoolId, pupil.userId);
      const userDoc = user
        ? touch(user, { isActive: false, updatedAt: when })
        : null;

      return {
        collection: "student",
        doc,
        also: userDoc ? [{ collection: "user", doc: userDoc }] : [],

        request: {
          method: "DELETE",
          path:   `/api/admin/students/${id}`,
          body:   { schoolId },
        },

        response: {
          status: 200,
          data:   responseFor(doc, "Student withdrawn successfully"),
        },
      };
    },
  },

  {
    route: "POST /api/admin/students/:id/enrollment-number",

    /**
     * Renumber. Minting a number offline is where the desktop must NOT be
     * clever: the server derives the next sequence from every number already in
     * use across both collections, and a locally invented one can collide the
     * moment it is replayed. So this stamps nothing — it declines to the queue
     * and lets the server mint, and the screen waits for the pull like it does
     * for any other server-owned value.
     */
    handler: () => null,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // The SAFE paths — students.routes.js, which the console actually calls for
  // suspend, restore and delete. Same operations as the admin routes above, a
  // different router with its own shapes: restore returns the pupil to
  // "approved" rather than "active", delete is a hard delete of the record AND
  // the login, and every response carries the concurrent-edit guard's verdict.
  // ───────────────────────────────────────────────────────────────────────────

  {
    route: "PATCH /api/students/:id/suspend",

    /**
     * The endpoint's own wording and shape, including the 409 for a pupil
     * already suspended — declined here so the request falls through rather
     * than inventing a success the server would refuse.
     */
    handler: ({ body, params, query }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? "").trim();
      const pupil = pupilOf(docs, schoolId, id);
      if (!pupil) return null;
      if (pupil.status === "suspended") return null;

      const when = nowISO();
      const doc = touch(pupil, {
        status:        "suspended",
        isActive:      false,
        updatedBy:     session?.userId ?? null,
        updatedByName: session?.name   ?? null,
        updatedAt:     when,
      });

      const user = userOf(docs, schoolId, pupil.userId);
      const userDoc = user
        ? touch(user, { isActive: false, updatedAt: when })
        : null;

      return {
        collection: "student",
        doc,
        also: userDoc ? [{ collection: "user", doc: userDoc }] : [],

        request: {
          method: "PATCH",
          path:   `/api/students/${id}/suspend`,
          body:   { ...body, schoolId },
        },

        response: {
          status: 200,
          data: {
            success: true,
            message: `"${displayName(doc)}" has been suspended`,
            data:    normaliseStudentDoc(doc),
            overwrote: overwroteFor(pupil, { ...body, baseUpdatedAt: body?.baseUpdatedAt ?? query?.baseUpdatedAt }, session),
          },
        },
      };
    },
  },

  {
    route: "PATCH /api/students/:id/restore",

    /**
     * The safe endpoint returns a pupil to "approved" — not "active", which is
     * what the admin router's restore writes. Reproduced exactly, because a
     * status the schema never expected would either fail validation on replay
     * or, worse, pass and read as a different lifecycle state in every list.
     */
    handler: ({ body, params, query }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? "").trim();
      const pupil = pupilOf(docs, schoolId, id);
      if (!pupil) return null;
      if (pupil.status === "approved") return null;

      const when = nowISO();
      const doc = touch(pupil, {
        status:        "approved",
        isActive:      true,
        updatedBy:     session?.userId ?? null,
        updatedByName: session?.name   ?? null,
        updatedAt:     when,
      });

      const user = userOf(docs, schoolId, pupil.userId);
      const userDoc = user
        ? touch(user, { isActive: true, updatedAt: when })
        : null;

      return {
        collection: "student",
        doc,
        also: userDoc ? [{ collection: "user", doc: userDoc }] : [],

        request: {
          method: "PATCH",
          path:   `/api/students/${id}/restore`,
          body:   { ...body, schoolId },
        },

        response: {
          status: 200,
          data: {
            success: true,
            message: `"${displayName(doc)}" has been restored`,
            data:    normaliseStudentDoc(doc),
            overwrote: overwroteFor(pupil, { baseUpdatedAt: body?.baseUpdatedAt ?? query?.baseUpdatedAt }, session),
          },
        },
      };
    },
  },

  {
    route: "DELETE /api/students/:id",

    /**
     * The one write whose local answer is a MARK, not the real thing: the
     * endpoint hard-deletes the Student row AND the login behind it, and a
     * mirror cannot un-write a child's record. So the row is tombstoned —
     * every read that filters deletedAt stops showing it, which is what the
     * screen promises — and the queued DELETE does the real deletion when the
     * connection returns. Deleting the user doc locally too, because a
     * suspended login that still resolves would be the worst of both.
     */
    handler: ({ body, params }, { docs, session }) => {
      const schoolId = schoolOf(body, session);
      if (!schoolId) return null;

      const id = String(params?.id ?? "").trim();
      const pupil = pupilOf(docs, schoolId, id);
      if (!pupil) return null;

      const when = nowISO();
      const doc = touch(pupil, {
        status:        "withdrawn",
        isActive:      false,
        deletedAt:     when,
        updatedBy:     session?.userId ?? null,
        updatedByName: session?.name   ?? null,
        updatedAt:     when,
      });

      const user = userOf(docs, schoolId, pupil.userId);
      const userDoc = user
        ? touch(user, { isActive: false, updatedAt: when })
        : null;

      return {
        collection: "student",
        doc,
        also: userDoc ? [{ collection: "user", doc: userDoc }] : [],

        request: {
          method: "DELETE",
          path:   `/api/students/${id}`,
          body:   { ...body, schoolId },
        },

        response: {
          status: 200,
          data: {
            success: true,
            message: "Student deleted successfully",
            data:    { studentId: id },
            overwrote: overwroteFor(pupil, body, session),
          },
        },
      };
    },
  },
];

