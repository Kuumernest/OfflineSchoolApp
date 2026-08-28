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
];
