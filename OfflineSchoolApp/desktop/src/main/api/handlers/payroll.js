// desktop/src/main/api/handlers/payroll.js
"use strict";

/**
 * Payroll runs and their payslips.
 *
 * ── One of these two cannot always be answered offline ────────────────────
 *
 * The list can. The detail view joins each payslip to the member of staff it
 * belongs to — name, email and role — and that join needs the user collection.
 *
 * A bursar can mirror payroll runs and payslips (payroll.view) but NOT users
 * (users.manage), while the server's endpoint reads staff names gated only by
 * payroll.view. So on a bursar's machine the join has nothing to join to.
 *
 * Rather than return payslips with every name blank — a payroll is unreadable
 * without names, and a blank column looks like missing data rather than a
 * missing permission — the detail handler declines when any payslip's staff is
 * absent from the mirror, and the request goes to the server. On a school
 * admin's machine, where users ARE mirrored, it is answered locally.
 *
 * This is a gap in the FEED's granularity rather than in this file: a bursar
 * needs staff names to read a payroll and does not need the account directory,
 * and the feed has no way to say that yet. Recorded in
 * backend/src/config/syncFeed.js under KNOWN_GAPS.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

module.exports = [
  {
    route: "GET /api/finance/payroll",
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      // periodMonth descending — a Mongo sort, so byte comparison. The values
      // are "2026-09" style, where that orders chronologically anyway.
      const rows = docs
        .find("payrollRun", { schoolId, deletedAt: null })
        .sort((a, b) => {
          const am = String(a.periodMonth ?? "");
          const bm = String(b.periodMonth ?? "");
          if (am === bm) return 0;
          return am < bm ? 1 : -1;
        });

      return ok({ count: rows.length, data: rows });
    },
  },

  {
    route: "GET /api/finance/payroll/:runId",
    handler: ({ params, query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const run = docs.get("payrollRun", params.runId);
      // Not found is a 404 the server owns. Declining rather than answering it
      // locally: "this machine has not seen that run" and "no such run" are
      // different facts, and only the server knows the second.
      if (!run || run.schoolId !== schoolId || run.deletedAt) return null;

      const payslips = docs.find("salaryPayment", {
        schoolId, runId: run._id, deletedAt: null,
      });

      // The join, and the reason this handler sometimes declines — see the note
      // at the top of the file.
      const joined = [];
      for (const p of payslips) {
        const staff = docs.get("user", String(p.userId));
        if (!staff) return null;

        // .select("name email role") — projected, so nothing the server does not
        // send is attached.
        joined.push({
          ...p,
          staff: { _id: staff._id, name: staff.name, email: staff.email, role: staff.role },
        });
      }

      return ok({ data: { run, payslips: joined } });
    },
  },
];
