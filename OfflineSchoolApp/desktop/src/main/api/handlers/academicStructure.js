// desktop/src/main/api/handlers/academicStructure.js
"use strict";

/**
 * GET /api/academic-structure/:schoolId/:year, from the mirror.
 *
 * The year's terms and sequences, so the exam screens offer the school's own
 * periods offline (web/src/hooks/useAcademicPeriods), instead of falling back
 * to three terms of two sequences. The sync feed already ships the document
 * under exams.view (backend/src/config/syncFeed.js); only this read was missing.
 *
 * The server's rule, reproduced (academicStructure.routes.js, docs/39 D4):
 *   - settings.view reads the whole document;
 *   - exams.view alone reads its shape — terms, promotion exams, pass marks —
 *     never the rules;
 *   - neither: refused there, so declined here.
 *
 * Declined, so the request goes out, wherever this copy cannot give the
 * server's answer: a path naming another school (the server refuses it), and
 * a year the mirror does not hold (the server would create the default, or
 * answer with it, from schema defaults this file does not duplicate).
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

const SHAPE_FIELDS = ["schoolId", "academicYear", "terms", "promotionExams", "passMark", "promotionThreshold"];

const withoutPending = (row) => {
  if (!row) return row;
  const { _pending, ...rest } = row;
  return rest;
};

module.exports = [
  {
    route: "GET /api/academic-structure/:schoolId/:year",

    handler: ({ params }, { docs, session }) => {
      const perms = session?.permissions ?? [];
      const full  = session?.role === "super_admin" || perms.includes("settings.view");
      if (!full && !perms.includes("exams.view")) return null;

      if (session?.role === "super_admin") return null;   // reads across schools: the server's call
      const schoolId = session?.schoolId ? String(session.schoolId) : null;
      if (!schoolId || String(params.schoolId) !== schoolId) return null;

      const structure = docs.find("academicStructure", {
        schoolId, academicYear: String(params.year), deletedAt: null,
      })[0] ?? null;
      if (!structure) return null;

      const doc = withoutPending(structure);
      return ok({
        structure: full ? doc : Object.fromEntries(SHAPE_FIELDS.map((k) => [k, doc[k] ?? null])),
      });
    },
  },
];
