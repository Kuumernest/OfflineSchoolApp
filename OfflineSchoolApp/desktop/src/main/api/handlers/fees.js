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
      //
      // Return the charges and payments regardless — the screen needs them to
      // render the ledger. Only planStatus is unavailable locally.
      if (plan) return ok({ data: { charges, payments, totals, plan, planStatus: null } });

      return ok({ data: { charges, payments, totals, plan: null, planStatus: null } });
    },
  },
];

/**
 * Exposed for writes/feePayments.js, which needs the same totals in the answer
 * it gives a reversal — the endpoint returns them, and a second implementation
 * of "what does this family owe" is the last thing this codebase needs.
 */
module.exports.totalsFor = totalsFor;

/**
 * Balance computation for many students at once — the same SQL as outstanding
 * but returned as a Map for use by the penalties and reminders handlers.
 */
const balancesMap = (docs, schoolId, academicYear) => {
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

  const map = new Map();
  const ensure = (id) => {
    if (!map.has(id)) map.set(id, { charged: 0, waived: 0, paid: 0, balance: 0 });
    return map.get(id);
  };
  for (const row of charged) {
    const b = ensure(String(row.studentId));
    b.charged = row.charged ?? 0;
    b.waived  = row.waived  ?? 0;
  }
  for (const row of paid) ensure(String(row.studentId)).paid = row.paid ?? 0;
  for (const b of map.values()) b.balance = b.charged - b.waived - b.paid;
  return map;
};

/**
 * End-of-day in milliseconds, matching the server's endOfDay() helper.
 * A fee due on the 15th with 0 grace days becomes chargeable at the start
 * of the 16th (23:59:59.999 on the 15th + 1ms = 00:00:00.000 on the 16th).
 */
const endOfDay = (date) => {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime();
};

const DAY_MS = 86_400_000;

/**
 * Walk an active payment plan's instalments to determine status.
 *
 * Simplified from backend/src/services/feeReminders.service.js planStatus():
 * we check cumulative instalment amounts against what has been paid.
 */
const planStatusLocal = (plan, paid, asOf) => {
  if (!plan || !Array.isArray(plan.instalments) || plan.instalments.length === 0) {
    return { isBehind: false, behindBy: 0, nextDue: null, dueByNow: 0, missedSince: null };
  }

  const sorted = [...plan.instalments].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  let cumulativeDue = 0;
  let nextDue = null;
  let missedSince = null;

  for (const inst of sorted) {
    const dueDate = inst.dueDate ? new Date(inst.dueDate) : null;
    if (!dueDate) continue;

    cumulativeDue += inst.amount ?? 0;

    if (endOfDay(dueDate) < asOf) {
      // This instalment's day has ended
      if (paid < cumulativeDue && !missedSince) {
        missedSince = dueDate.toISOString();
      }
    } else {
      // Future instalment
      if (!nextDue) nextDue = dueDate.toISOString();
    }
  }

  const behindBy = Math.max(0, cumulativeDue - paid);
  const isBehind = missedSince !== null;

  return { isBehind, behindBy, nextDue, dueByNow: cumulativeDue, missedSince };
};

/**
 * Whether the school's notification channel has a valid address for a student.
 *
 * The server uses notify.resolveChannel() and notify.resolveRecipient(). We
 * approximate: the school document stores settings.notifications.channel as
 * "email" or "sms", and the student record has email and phone fields.
 */
const isReachable = (school, student, channel) => {
  if (channel === "email") return Boolean(student.email || student.guardianEmail);
  if (channel === "sms")   return Boolean(student.phone || student.guardianPhone);
  return false;
};

module.exports.push(
  // ─────────────────────────────────────────────────────────
  // GET /api/fees/penalties
  // ─────────────────────────────────────────────────────────
  //
  // Preview of late fees that would be charged. Grace-period arithmetic
  // computed locally from the mirror. The result is a preview — the actual
  // charges are raised by POST /api/fees/penalties which is online-only.
  //
  {
    route: "GET /api/fees/penalties",

    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const academicYear = query.academicYear || null;
      const structureId  = query.structureId || null;

      const now = Date.now();

      // Structures with a penalty rule and a due date
      let structures = docs.find("feeStructure", {
        schoolId, deletedAt: null,
        ...(academicYear ? { academicYear } : {}),
      }).filter((s) =>
        s.penalty && s.penalty.mode !== "none" &&
        s.penalty.amount > 0 &&
        s.dueDate
      );

      if (structureId) {
        structures = structures.filter((s) => String(s._id) === String(structureId));
      }

      if (structures.length === 0) {
        return ok({ count: 0, total: 0, data: [] });
      }

      const balances = balancesMap(docs, schoolId, academicYear);

      const results = [];

      for (const structure of structures) {
        const graceDays  = structure.penalty.graceDays ?? 0;
        const chargeableFrom = endOfDay(structure.dueDate) + graceDays * DAY_MS;

        // Still inside grace period — skip entirely
        if (now <= chargeableFrom) continue;

        // Students billed by this structure (non-voided, non-deleted charges)
        const billedStudentIds = docs.sql(`
          SELECT DISTINCT json_extract(json,'$.studentId') AS studentId
          FROM docs
          WHERE collection = 'feeCharge'
            AND school_id = ?
            AND json_extract(json,'$.structureId') = ?
            AND deleted_at IS NULL
            AND json_extract(json,'$.voidedAt') IS NULL
        `, schoolId, String(structure._id));

        // Students already penalised for this structure
        const penalisedStudentIds = docs.sql(`
          SELECT DISTINCT json_extract(json,'$.studentId') AS studentId
          FROM docs
          WHERE collection = 'feeCharge'
            AND school_id = ?
            AND json_extract(json,'$.structureId') = ?
            AND json_extract(json,'$.code') = 'LATE'
            AND deleted_at IS NULL
        `, schoolId, String(structure._id));

        const penalisedSet = new Set(penalisedStudentIds.map((r) => String(r.studentId)));
        const students = docs.find("student", { schoolId, deletedAt: null, status: "approved" });
        const studentMap = new Map(students.map((s) => [String(s._id), s]));

        const plans = docs.find("paymentPlan", {
          schoolId, status: "active", deletedAt: null,
          ...(academicYear ? { academicYear } : {}),
        });
        const plansByStudent = new Map(plans.map((p) => [String(p.studentId), p]));

        for (const { studentId } of billedStudentIds) {
          const sid = String(studentId);
          if (penalisedSet.has(sid)) continue;

          const bal = balances.get(sid);
          if (!bal || bal.balance <= 0) continue;

          // Plan exemption: on-track families are not penalised
          const plan = plansByStudent.get(sid);
          if (plan) {
            const ps = planStatusLocal(plan, bal.paid, now);
            if (!ps.isBehind) continue;
          }

          const mode  = structure.penalty.mode;
          const rate  = structure.penalty.amount;
          const amount = mode === "fixed"
            ? rate
            : Math.round((bal.balance * rate) / 100);

          if (amount <= 0) continue;

          const student = studentMap.get(sid);
          const daysOverdue = Math.floor(
            (now - new Date(structure.dueDate).getTime()) / DAY_MS
          );

          results.push({
            studentId:    sid,
            name:         student ? displayName(student) : null,
            enrollmentNo: student?.enrollmentNo ?? null,
            classId:      student?.classId ?? null,
            structureId:  String(structure._id),
            academicYear: structure.academicYear,
            term:         structure.term ?? null,
            dueDate:      structure.dueDate,
            graceDays,
            daysOverdue:  Math.max(0, daysOverdue),
            outstanding:  bal.balance,
            mode,
            rate,
            amount,
            onPlan:       Boolean(plan),
          });
        }
      }

      results.sort((a, b) => b.amount - a.amount || b.daysOverdue - a.daysOverdue);
      const total = results.reduce((sum, r) => sum + r.amount, 0);

      return ok({ count: results.length, total, data: results });
    },
  },

  // ─────────────────────────────────────────────────────────
  // GET /api/fees/reminders
  // ─────────────────────────────────────────────────────────
  //
  // Preview of families who need a nudge about unpaid fees. The candidate list
  // is computed locally from the mirror.
  //
  // The `recentlyReminded` flag is always false here because the Notification
  // collection is not synced. The cooldown check happens on the server when
  // reminders are actually sent (POST /api/fees/reminders, online-only).
  //
  {
    route: "GET /api/fees/reminders",

    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const academicYear = query.academicYear || null;
      const classId      = query.classId || null;
      const mode         = query.mode || "overdue";

      const now = Date.now();

      const school = docs.get("school", schoolId);
      const channel = school?.settings?.notifications?.channel || "sms";

      // All approved students
      const studentFilter = {
        schoolId, deletedAt: null, status: "approved",
        ...(classId ? { classId } : {}),
      };
      const students = docs.find("student", studentFilter);
      const studentMap = new Map(students.map((s) => [String(s._id), s]));

      const balances = balancesMap(docs, schoolId, academicYear);

      // Find dated charges and group by student
      const chargeFilter = {
        schoolId, deletedAt: null,
        ...(academicYear ? { academicYear } : {}),
      };
      const allCharges = docs.find("feeCharge", chargeFilter)
        .filter((c) => c.dueDate && !c.voidedAt);

      const byStudent = new Map();
      for (const c of allCharges) {
        const sid = String(c.studentId);
        if (!byStudent.has(sid)) byStudent.set(sid, []);
        byStudent.get(sid).push(c);
      }

      // Active payment plans
      const plans = docs.find("paymentPlan", {
        schoolId, status: "active", deletedAt: null,
        ...(academicYear ? { academicYear } : {}),
      });
      const plansByStudent = new Map(plans.map((p) => [String(p.studentId), p]));

      const results = [];

      // Group ALL charges (dated and undated) by student
      const allChargesAll = docs.find("feeCharge", chargeFilter)
        .filter((c) => !c.voidedAt);

      const byStudentAll = new Map();
      for (const c of allChargesAll) {
        const sid = String(c.studentId);
        if (!byStudentAll.has(sid)) byStudentAll.set(sid, []);
        byStudentAll.get(sid).push(c);
      }

      for (const [sid, charges] of byStudentAll) {
        const bal = balances.get(sid);
        if (!bal || bal.balance <= 0) continue;

        const student = studentMap.get(sid);
        if (!student) continue;

        const plan = plansByStudent.get(sid);
        let earliestDue = null;
        let latestDue = null;
        let isOverdue = false;
        let daysOverdue = 0;
        let onPlan = false;
        let planBehindBy = 0;
        let planNextDue = null;
        let planDueByNow = 0;

        // Separate dated and undated charges
        const datedCharges = charges.filter((c) => c.dueDate);
        const undatedCharges = charges.filter((c) => !c.dueDate);
        const hasUndated = undatedCharges.length > 0;

        for (const c of datedCharges) {
          const due = new Date(c.dueDate).getTime();
          if (!earliestDue || due < earliestDue) earliestDue = due;
          if (!latestDue || due > latestDue) latestDue = due;
        }

        if (plan) {
          onPlan = true;
          const ps = planStatusLocal(plan, bal.paid, now);
          planBehindBy = ps.behindBy;
          planNextDue  = ps.nextDue;
          planDueByNow = ps.dueByNow;

          if (ps.isBehind) {
            isOverdue = true;
            daysOverdue = Math.floor((now - new Date(ps.missedSince).getTime()) / DAY_MS);
          } else {
            // On track — use the next instalment date
            if (ps.nextDue) {
              const nextTime = new Date(ps.nextDue).getTime();
              if (endOfDay(nextTime) < now) {
                isOverdue = true;
                daysOverdue = Math.floor((now - nextTime) / DAY_MS);
              }
            }
          }
        } else {
          // No plan — overdue if any due date has passed
          if (earliestDue && endOfDay(earliestDue) < now) {
            isOverdue = true;
            daysOverdue = Math.floor((now - earliestDue) / DAY_MS);
          }
          // Undated charges are immediately overdue
          if (hasUndated && !isOverdue) {
            isOverdue = true;
          }
        }

        // Mode filter
        if (mode === "overdue" && !isOverdue) continue;
        if (mode === "dueSoon" && isOverdue) continue;
        if (mode === "dueSoon" && earliestDue) {
          const dueSoonCutoff = now + 14 * DAY_MS;
          if (earliestDue > dueSoonCutoff) continue;
        }

        const reachable = isReachable(school, student, channel);

        results.push({
          studentId:        sid,
          name:             displayName(student) || null,
          enrollmentNo:     student.enrollmentNo ?? null,
          classId:          student.classId ?? null,
          guardianName:     student.guardianName ?? null,
          balance:          bal.balance,
          charged:          bal.charged,
          paid:             bal.paid,
          earliestDue:      earliestDue ? new Date(earliestDue).toISOString() : null,
          latestDue:        latestDue ? new Date(latestDue).toISOString() : null,
          totalCharges:     charges.length,
          datedCharges:     datedCharges.length,
          undatedCharges:   undatedCharges.length,
          isOverdue,
          daysOverdue:      Math.max(0, daysOverdue),
          onPlan,
          planBehindBy,
          planNextDue,
          planDueByNow,
          reachable,
          recentlyReminded: false,  // Notification collection not synced
        });
      }

      // Sort: worst first — most overdue, then largest balance
      results.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balance - a.balance);

      return ok({
        count:        results.length,
        mode,
        cooldownDays: 7,
        data:         results,
      });
    },
  }
);
