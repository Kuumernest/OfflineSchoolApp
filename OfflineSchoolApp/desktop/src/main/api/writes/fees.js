// desktop/src/main/api/writes/fees.js
"use strict";

/**
 * Fee structures and instalment plans, written with no connection.
 *
 * (The payment itself is in ../writes.js, with the notes on receipt numbering
 * that made it the first write in this layer.)
 *
 * ── The validators are not reimplemented here ─────────────────────────────
 *
 * What makes a fee structure valid lives in shared/feeStructures.js and is
 * required by BOTH this file and backend/src/routes/fees.routes.js. That is not
 * tidiness. A queued write the server refuses stops the whole outbox and waits
 * for a person — so a structure that passed here and failed there would hold up
 * every payment queued behind it, in the middle of a school day. The two
 * answers have to agree, which means one definition rather than two that drift.
 *
 * ── A price list is not a document like the others ────────────────────────
 *
 * Everything downstream is derived from it: what a family owes, who gets
 * reminded, who has earned a late fee. So the checks below are not defensive
 * clutter; each one is a way a school could end up billing the wrong amount, or
 * billing twice, or never chasing anybody because a deadline went in as null.
 */

const { randomUUID } = require("crypto");
const {
  asDueDate,
  asWholeAmount,
  cleanPenalty,
  cleanItems,
  normaliseClassIds,
  clashesWith,
} = require("../../../../../shared/feeStructures");
const { totalsFor } = require("../handlers/fees");

module.exports = [
  {
    route: "POST /api/fees/structures",

    /**
     * Publishing a price list.
     *
     * ── Every decline here is a 4xx that would stop the queue ───────────────
     *
     * The endpoint refuses a missing academic year, an unparseable or absent due
     * date, a bad penalty rule, an empty item list, an item with no code or
     * label, a fractional amount — XAF has no minor unit, so that is a typo
     * rather than a rounding question — and a class already billed by an active
     * structure for the same year and term.
     *
     * The last one is the one worth spelling out. FeeStructure's unique index
     * covers (schoolId, academicYear, classIds, term) on active rows, and
     * classIds is an ARRAY, so it is multikey: the constraint is per individual
     * class. Structures billing {cls-1, cls-2} and {cls-2, cls-3} collide on
     * cls-2 though neither list equals the other. clashesWith() in shared/ is
     * that rule, written once.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("fees.manage")) return null;
      if (!body.academicYear) return null;

      // undefined means "supplied and not a date"; null means "not supplied".
      // The endpoint refuses both, with different messages.
      const dueDate = asDueDate(body.dueDate);
      if (dueDate === undefined || dueDate === null) return null;

      const penalty = cleanPenalty(body.penalty);
      if (penalty.error) return null;

      const items = cleanItems(body.items);
      if (items.error) return null;

      const classIds = normaliseClassIds(body);
      const term      = body.term ?? null;
      const candidate = { schoolId, academicYear: body.academicYear, term, classIds };

      // The 409 the unique index would raise. Queueing through it would stop the
      // outbox on a request that can never succeed.
      const active = docs
        .find("feeStructure", { schoolId, deletedAt: null })
        .filter((s) => s.isActive !== false);
      if (active.some((s) => clashesWith(candidate, s))) return null;

      const id  = randomUUID();
      const now = new Date().toISOString();

      const doc = {
        _id:          id,
        schoolId,
        academicYear: body.academicYear,
        classIds,
        term,
        items:        items.value,
        // Stored as the instant the shared parser produced, so the mirror holds
        // what the server will hold rather than the string that arrived.
        dueDate:      dueDate.toISOString(),
        penalty:      penalty.value,
        isActive:     true,
        createdBy:    session?.userId ?? null,
        deletedAt:    null,
        createdAt:    now,
        updatedAt:    now,
      };

      return {
        collection: "feeStructure",
        doc,
        request: {
          method: "POST",
          path:   "/api/fees/structures",
          // This endpoint already read _id from the body, so unlike POST
          // /api/exams and POST /api/exams/:examId/subjects it needed no change.
          body:   { ...body, _id: id },
        },
        response: { status: 201, data: { success: true, data: doc } },
      };
    },
  },

  {
    route: "PATCH /api/fees/structures/:id/deactivate",

    /**
     * Taking a price list out of use.
     *
     * Never deleted: last year's structure is what last year's charges were
     * raised from, and a bill nobody can trace back to a published price is a
     * bill a parent can argue with. isActive false also releases the unique
     * index, which is how a replacement gets published.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("fees.manage")) return null;

      const row = docs.get("feeStructure", String(params.id));
      if (!row) return null;
      if (String(row.schoolId) !== String(schoolId)) return null;

      // Note the endpoint does NOT require deletedAt: null here, so neither
      // does this — adding the filter would decline a request it accepts.

      const doc = { ...row, isActive: false, updatedAt: new Date().toISOString() };

      return {
        collection: "feeStructure",
        doc,
        request: {
          method: "PATCH",
          path:   `/api/fees/structures/${row._id}/deactivate`,
          body,
        },
        response: { status: 200, data: { success: true, data: doc } },
      };
    },
  },

  {
    route: "POST /api/fees/plans/:id/cancel",

    /**
     * Ending an instalment arrangement.
     *
     * Cancelled, never deleted: "we gave them a plan and they broke it" is
     * something a school needs to see next year, and from the moment it is
     * cancelled the family is measured against the original due date again.
     *
     * A reason is required, and required HERE too — the endpoint answers 400
     * REASON_REQUIRED without one, and that 400 would stop the outbox. So would
     * cancelling a plan that is not active, which is the other check below.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("fees.plan")) return null;

      const reason = body.reason ? String(body.reason).trim() : null;
      if (!reason) return null;

      const row = docs.get("paymentPlan", String(params.id));
      if (!row) return null;
      if (String(row.schoolId) !== String(schoolId)) return null;
      if (row.deletedAt) return null;
      // "This plan is already cancelled" — a 400, and one a screen showing a
      // stale list could easily provoke.
      if (row.status !== "active") return null;

      const now = new Date().toISOString();
      const doc = {
        ...row,
        status:          "cancelled",
        cancelledBy:     session?.userId ?? null,
        cancelledAt:     now,
        cancelledReason: reason,
        updatedAt:       now,
      };

      return {
        collection: "paymentPlan",
        doc,
        request: {
          method: "POST",
          path:   `/api/fees/plans/${row._id}/cancel`,
          body,
        },
        response: { status: 200, data: { success: true, data: doc } },
      };
    },
  },

  {
    route: "POST /api/fees/plans",

    /**
     * An instalment arrangement with one family.
     *
     * ── A plan changes WHEN, never HOW MUCH ─────────────────────────────────
     *
     * Nothing here writes to the ledger, and balanceFor() does not know this
     * collection exists. What a plan changes is the date reminders and late fees
     * measure against. A school wanting to reduce a bill uses a waiver, which is
     * a different act with an approval behind it.
     *
     * Which is why the endpoint refuses a schedule that does not add up to what
     * is outstanding: a plan for less would quietly forgive the difference, and
     * one for more would have the family chased for money the ledger says they
     * do not owe. That comparison is reproduced here against the same totals the
     * ledger read uses — not a second implementation of what a family owes.
     *
     * ── Six refusals, every one checked ─────────────────────────────────────
     *
     * A missing student, year or reason; fewer than two instalments — one is
     * just a due date; an instalment that is not a whole number above zero, or
     * without a real calendar date; a family with nothing outstanding; a total
     * that does not match. And the unique index: one ACTIVE plan per student,
     * year and term, which is a 409.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("fees.plan")) return null;

      const studentId    = body.studentId ? String(body.studentId) : null;
      const academicYear = body.academicYear ?? null;
      const term         = body.term ?? null;
      if (!studentId || !academicYear) return null;

      // Required, like a refund and a waiver: "why" is the question asked about
      // a concession a year later, by an auditor or by the next bursar.
      const reason = body.reason ? String(body.reason).trim() : null;
      if (!reason) return null;

      if (!Array.isArray(body.instalments) || body.instalments.length < 2) return null;

      const student = docs.get("student", studentId);
      if (!student) return null;                                   // its 404
      if (String(student.schoolId) !== String(schoolId)) return null;
      if (student.deletedAt) return null;

      const instalments = [];
      for (const [i, raw] of body.instalments.entries()) {
        const amount = asWholeAmount(raw?.amount);
        if (amount === null || amount <= 0) return null;

        // undefined means "supplied and not a date"; null means "not supplied".
        // The endpoint refuses both for an instalment.
        const dueDate = asDueDate(raw?.dueDate);
        if (dueDate === undefined || dueDate === null) return null;

        instalments.push({ seq: i + 1, amount, dueDate: dueDate.toISOString() });
      }

      const totals = totalsFor(docs, { schoolId, studentId, academicYear });
      if (totals.balance <= 0) return null;                        // NOTHING_OUTSTANDING

      const planned = instalments.reduce((sum, one) => sum + one.amount, 0);
      if (planned !== totals.balance) return null;                 // PLAN_TOTAL_MISMATCH

      // The unique index: one active plan per student, year and term. Queueing
      // through it would stop the outbox on a request that can never succeed.
      const clash = docs
        .find("paymentPlan", { schoolId, studentId, academicYear, deletedAt: null })
        .filter((p) => p.status === "active" && (p.term ?? null) === term);
      if (clash.length > 0) return null;

      const id  = randomUUID();
      const now = new Date().toISOString();

      const doc = {
        _id:             id,
        schoolId, studentId, academicYear, term,
        instalments,
        reason,
        status:          "active",
        agreedBy:        session?.userId ?? null,
        cancelledBy:     null,
        cancelledAt:     null,
        cancelledReason: null,
        deletedAt:       null,
        createdAt:       now,
        updatedAt:       now,
      };

      return {
        collection: "paymentPlan",
        doc,
        request: {
          method: "POST",
          path:   "/api/fees/plans",
          body:   { ...body, _id: id },
        },
        response: { status: 201, data: { success: true, data: doc } },
      };
    },
  },
];
