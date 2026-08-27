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

  // GET /api/admin/subjects is NOT here yet, and the reason is worth recording
  // rather than leaving as an absence.
  //
  // It looks like a sibling of the classes list and is not. The endpoint joins
  // Class records for a className, and populated TeacherAssignments to attach a
  // teacher name and email to each subject — so the response carries three
  // collections merged, not one listed. It also does NOT filter deleted rows,
  // and it matches a classId against BOTH `class` and `classId`.
  //
  // A handler returning bare subject documents would be shaped almost right,
  // which is the worst outcome available: the screen would render with an empty
  // teacher column and nobody would know whether that meant "unassigned" or
  // "offline". Left to the network until it can be done with the join.
];
