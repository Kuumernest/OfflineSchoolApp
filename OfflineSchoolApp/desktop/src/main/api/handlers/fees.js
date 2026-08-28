// desktop/src/main/api/handlers/fees.js
"use strict";

/**
 * What a family owes, answered from the mirror.
 *
 * ── The arithmetic is the risk here, not the plumbing ─────────────────────
 *
 * These endpoints return money. A balance computed one way on the server and
 * another way here does not fail loudly — it produces a number that is merely
 * wrong, on a screen a bursar reads out to a parent.
 *
 * The rules below are the server's, and this file had two of them BACKWARDS
 * until the parity harness compared the two answers on the same data. Both
 * mistakes were the plausible reading:
 *
 *   PAYMENTS exclude deletedAt ONLY — never voidedAt. A reversal is not a flag
 *   on the original; it is a SEPARATE ROW with a negative amount and a
 *   reversesId (see POST /api/fees/payments/:id/reverse). A plain sum therefore
 *   nets it off on its own. Excluding voided rows as well would subtract the
 *   reversal twice and show a family owing money they had paid.
 *
 *   CHARGES exclude both deletedAt and voidedAt, which is the opposite way
 *   round, because voidedAt is a field on a CHARGE and not on a payment.
 *
 *   WAIVED sums waivedAmount, a number, not a `waived` boolean. A partial
 *   waiver is a real thing — half a trip fee forgiven — and a boolean cannot
 *   express it. Reading it as a flag counted the whole charge as forgiven.
 *
 * None of this is guessable from the endpoint alone: the sums live in
 * backend/src/services/fees.service.js and the reversal mechanism in the route.
 * Which is the argument for checking parity rather than reimplementing carefully.
 */

const { displayName } = require("../../../../../shared/studentName");

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * The totals for one pupil, as backend/src/services/fees.service.js computes them.
 *
 * SQL rather than the filter language: these are sums with exclusions, and the
 * SQL says what it means more plainly than a chain of filter objects would.
 */
const totalsFor = (docs, { schoolId, studentId, academicYear }) => {
  const yearClause = academicYear ? "AND json_extract(json,'$.academicYear') = ?" : "";
  const yearParam  = academicYear ? [academicYear] : [];

  // NOT_VOID in fees.service.js — voidedAt AND deletedAt, on charges.
  const charges = docs.sql(`
    SELECT
      COALESCE(SUM(json_extract(json,'$.amount')), 0) AS charged,
      COALESCE(SUM(COALESCE(json_extract(json,'$.waivedAmount'), 0)), 0) AS waived
    FROM docs
    WHERE collection = 'feeCharge'
      AND school_id = ?
      AND json_extract(json,'$.studentId') = ?
      AND deleted_at IS NULL
      AND json_extract(json,'$.voidedAt') IS NULL
      ${yearClause}
  `, schoolId, studentId, ...yearParam)[0];

  // NOT_DELETED only. The negative reversal row is part of the sum by design —
  // see the note at the top of this file.
  const payments = docs.sql(`
    SELECT COALESCE(SUM(json_extract(json,'$.amount')), 0) AS paid
    FROM docs
    WHERE collection = 'feePayment'
      AND school_id = ?
      AND json_extract(json,'$.studentId') = ?
      AND deleted_at IS NULL
      ${yearClause}
  `, schoolId, studentId, ...yearParam)[0];

  const charged = charges.charged ?? 0;
  const waived  = charges.waived  ?? 0;
  const paid    = payments.paid   ?? 0;

  return { charged, waived, paid, balance: charged - waived - paid };
};

module.exports = [
  {
    route: "GET /api/fees/plans",

    /**
     * The instalment arrangements a school has agreed.
     *
     * ── status is a filter with a default that is not "everything" ───────────
     *
     * Absent or "all" means active, completed and cancelled — which is every
     * status the collection has, so it reads as "everything" and is not: a plan
     * in any other state would be invisible. Reproduced as the three named
     * values rather than "no filter", because the two stop being the same the
     * day a fourth status is added, and a screen would silently start listing
     * something the server never showed it.
     *
     * ── The 500 is the server's, and it is kept ─────────────────────────────
     *
     * Sorted newest first and capped. A mirror answering with more rows than the
     * endpoint would is not more helpful — it is a different answer, and a
     * screen that pages through it would disagree with the same screen online.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const filter = { schoolId, deletedAt: null };
      if (query.studentId)    filter.studentId    = String(query.studentId);
      if (query.academicYear) filter.academicYear = String(query.academicYear);

      const wanted = query.status && query.status !== "all"
        ? [String(query.status)]
        : ["active", "completed", "cancelled"];

      const rows = docs
        .find("paymentPlan", filter)
        .filter((p) => wanted.includes(String(p.status)))
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
        .slice(0, 500);

      return ok({ count: rows.length, data: rows });
    },
  },

  {
    route: "GET /api/fees/structures",
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const filter = { schoolId, deletedAt: null };
      if (query.academicYear) filter.academicYear = query.academicYear;

      let rows = docs.find("feeStructure", filter);

      // classIds is an ARRAY on the document and the server matches a single
      // value against it — Mongo does that implicitly, SQLite does not, so the
      // membership test is explicit here.
      if (query.classId) {
        const wanted = String(query.classId).trim();
        rows = rows.filter((r) => Array.isArray(r.classIds) && r.classIds.includes(wanted));
      }

      // academicYear descending, then term ascending, as the server sorts.
      const sorted = rows.slice().sort((a, b) => {
        const year = String(b.academicYear ?? "").localeCompare(String(a.academicYear ?? ""));
        if (year !== 0) return year;
        return String(a.term ?? "").localeCompare(String(b.term ?? ""));
      });

      // `data`, not `students`-style aliases: this endpoint answers
      // { success, count, data }.
      return ok({ count: sorted.length, data: sorted });
    },
  },

  {
    route: "GET /api/fees/outstanding",

    /**
     * Who owes money — the screen a bursar works down.
     *
     * The arithmetic is balancesFor() in the server's fees.service, which is the
     * same sums as one pupil's totals applied to many, and it has the same two
     * traps: waivedAmount is a number, and a reversal is a negative row that the
     * sum nets off rather than a flag to exclude.
     *
     * One SQL statement per collection rather than one per pupil, for the same
     * reason the server uses two aggregations: a school with six hundred pupils
     * would otherwise mean twelve hundred queries to draw one screen.
     */
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const academicYear = query.academicYear || null;
      const classId      = query.classId || null;

      // status: "approved" — an applicant who has not been admitted is not
      // somebody the school chases for fees.
      const students = docs.find("student", {
        schoolId, deletedAt: null, status: "approved",
        ...(classId ? { classId } : {}),
      });
      if (!students.length) {
        return ok({ count: 0, totalOutstanding: 0, data: [] });
      }

      const yearClause = academicYear ? "AND json_extract(json,'$.academicYear') = ?" : "";
      const yearParam  = academicYear ? [academicYear] : [];

      const charged = docs.sql(`
        SELECT json_extract(json,'$.studentId') AS studentId,
               COALESCE(SUM(json_extract(json,'$.amount')), 0) AS charged,
               COALESCE(SUM(COALESCE(json_extract(json,'$.waivedAmount'), 0)), 0) AS waived
        FROM docs
        WHERE collection = 'feeCharge'
          AND school_id = ?
          AND deleted_at IS NULL
          AND json_extract(json,'$.voidedAt') IS NULL
          ${yearClause}
        GROUP BY studentId
      `, schoolId, ...yearParam);

      const paid = docs.sql(`
        SELECT json_extract(json,'$.studentId') AS studentId,
               COALESCE(SUM(json_extract(json,'$.amount')), 0) AS paid
        FROM docs
        WHERE collection = 'feePayment'
          AND school_id = ?
          AND deleted_at IS NULL
          ${yearClause}
        GROUP BY studentId
      `, schoolId, ...yearParam);

      const balances = new Map();
      const ensure = (id) => {
        if (!balances.has(id)) balances.set(id, { charged: 0, waived: 0, paid: 0, balance: 0 });
        return balances.get(id);
      };
      for (const row of charged) {
        const b = ensure(String(row.studentId));
        b.charged = row.charged ?? 0;
        b.waived  = row.waived  ?? 0;
      }
      for (const row of paid) ensure(String(row.studentId)).paid = row.paid ?? 0;
      for (const b of balances.values()) b.balance = b.charged - b.waived - b.paid;

      const rows = students
        .map((s) => ({
          studentId:    String(s._id),
          // The shared resolver, not a field read: a pupil's name lives in one
          // of three fields and reading the wrong one blanks them.
          name:         displayName(s) || null,
          enrollmentNo: s.enrollmentNo ?? null,
          classId:      s.classId ?? null,
          ...(balances.get(String(s._id)) ?? { charged: 0, waived: 0, paid: 0, balance: 0 }),
        }))
        // A zero balance is not an arrears row, and a credit is not either.
        .filter((r) => r.balance > 0)
        .sort((a, b) => b.balance - a.balance);

      return ok({
        count: rows.length,
        totalOutstanding: rows.reduce((sum, r) => sum + r.balance, 0),
        data: rows,
      });
    },
  },

  {
    route: "GET /api/fees/students/:studentId",
    handler: ({ params, query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const studentId    = params.studentId;
      const academicYear = query.academicYear || null;

      const scope = { schoolId, studentId, deletedAt: null };
      if (academicYear) scope.academicYear = academicYear;

      // createdAt for charges and receivedAt for payments — the server's
      // orders, and a ledger read in a different order is a ledger that does
      // not match the printed one.
      const charges  = docs.find("feeCharge",  scope, { order: "createdAt",  dir: "ASC" });
      const payments = docs.find("feePayment", scope, { order: "receivedAt", dir: "ASC" });

      const totals = totalsFor(docs, { schoolId, studentId, academicYear });

      const plans = docs.find("paymentPlan", {
        schoolId, studentId, status: "active", deletedAt: null,
        ...(academicYear ? { academicYear } : {}),
      });
      const plan = plans[0] ?? null;

      // planStatus is cumulative instalment arithmetic living in
      // backend/src/services/feeReminders.service.js — real logic, not a shape.
      // Declining rather than reimplementing it: a wrong answer here says a
      // family is behind on a plan they are keeping to, and there is no version
      // of that which is better than falling back to the network.
      if (plan) return null;

      return ok({ data: { charges, payments, totals, plan: null, planStatus: null } });
    },
  },
];
