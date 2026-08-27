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

module.exports = [
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
