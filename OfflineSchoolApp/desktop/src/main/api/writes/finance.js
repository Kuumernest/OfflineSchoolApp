// desktop/src/main/api/writes/finance.js
"use strict";

/**
 * Money out, with no connection: categories, voids, and what staff are owed.
 *
 * ── Three of this domain's writes are here, and three are not ─────────────
 *
 * Queued:  POST /finance/expense-categories
 *          POST /finance/expenses/:id/void
 *          POST /finance/salary-structures
 *
 * Online only, with the argument in each case below the point it applies:
 *          POST /finance/payroll/generate
 *          POST /finance/payroll/:runId/confirm
 *          POST /finance/payroll/:runId/reverse
 *
 * ── Why the whole payroll run stays on the server ─────────────────────────
 *
 * These three are not declined for being large. They are declined because each
 * of them mints values only the server can mint, for an unbounded number of
 * rows, and a queued write that invents them produces a mirror the school's
 * record can never be reconciled with.
 *
 *   GENERATE writes a PayrollRun plus one payslip per member of staff with a
 *   structure in force. The arithmetic is genuinely a shape — base plus
 *   allowances, minus deductions, computed by a pure function — and "which
 *   structure was in force at the end of that month" is a filter this layer
 *   could reproduce. The blocker is identity: payroll.service.js creates the
 *   run with no client id (it lets the model's uuidv4() default fire) and then
 *   builds the payslip rows with NO _id AT ALL before insertMany. So a local
 *   generate would write a run and N payslips under ids this machine invented,
 *   the server would create a second run and N more payslips under its own, and
 *   the pull would deliver them alongside — a month with two runs and every
 *   payslip twice, on the screen a bursar pays people from. Passing one id in
 *   the body does not fix it either; the payslips need N ids, keyed by staff
 *   member, which is a new request shape and not a mirror's decision to make.
 *
 *   Worse, and quite separate: the run is computed FROM salary structures, and
 *   the feed gates salaryStructure on payroll.setSalary while this endpoint is
 *   gated on payroll.process. A bursar holds the second and not the first, so
 *   the one role that runs payroll cannot mirror the inputs it is computed
 *   from. Offline, a bursar's machine would generate a run for nobody.
 *
 *   CONFIRM is where the money moves, and it MINTS A GAPLESS PAYSLIP NUMBER per
 *   row from an atomic Counter — the same mechanism as a receipt number, except
 *   that receipts have shared/receipts.js and a device code precisely so an
 *   offline machine can issue one safely, and payslip numbers have no such
 *   scheme. Counter is deliberately excluded from the feed ("two offline
 *   machines holding a copy would both believe they knew the next value"), and
 *   a payslip numbered here would either collide with the server's sequence or
 *   leave a hole in it. An auditor asks about both.
 *
 *   REVERSE has confirm's problem twice: it CREATES a negative mirror payslip
 *   per paid row — server-side ids, server-minted payslip numbers — and stamps
 *   each original. Its state checks are also the server's to make: only a
 *   confirmed run can be reversed, and whether a run is confirmed is a fact
 *   this machine may be a sync behind on.
 *
 * There is a real cost to this. A school whose connection is out at the end of
 * the month cannot run its payroll, and that is a worse day than not being able
 * to record an expense. It is still the right answer: a payroll paid twice, or
 * paid with numbers that do not match the school's book, is not recoverable by
 * a sync. What WOULD make it possible is written up in the report — client ids
 * for the run and its payslips, and a device-prefixed payslip number — and both
 * are backend changes, not something to fake from here.
 */

const { randomUUID } = require("crypto");

/** Whole XAF, or null. The currency has no minor unit and the server refuses one. */
const whole = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
};

/**
 * An allowance or deduction list, as backend cleanComponents() would store it.
 *
 * Returns null when the server would answer 400, which is the only thing this
 * layer needs from it — but it also produces the CLEANED rows, because those go
 * into the local document and a screen that read back an untrimmed label or a
 * missing labelFr would differ from the row the school ends up with.
 */
const components = (list) => {
  if (!Array.isArray(list)) return [];
  const rows = [];
  for (const c of list) {
    if (!c?.code || !c?.label) return null;
    const amount = whole(c.amount);
    if (amount === null || amount < 0) return null;
    rows.push({
      code:    String(c.code).trim(),
      label:   String(c.label).trim(),
      labelFr: c.labelFr ? String(c.labelFr).trim() : null,
      amount,
    });
  }
  return rows;
};

module.exports = [
  {
    route: "POST /api/finance/expense-categories",

    /**
     * A new heading in the expense book.
     *
     * ── The 409 is the whole difficulty ────────────────────────────────────
     *
     * The unique index is on (schoolId, code) among rows that are not deleted,
     * and a duplicate answers 409 CATEGORY_EXISTS. A 409 is not retryable, so it
     * does not merely fail: it blocks the outbox and everything queued behind it
     * until somebody attends to it — including work from other parts of the
     * school. So the code is checked here against the mirror, trimmed the same
     * way the endpoint trims it.
     *
     * A code that was added on the web since this machine last synced still gets
     * through and still blocks. That cannot be closed from this side; what it
     * argues for is the endpoint answering a duplicate with the row it already
     * has, the way POST /finance/expenses answers a replay.
     *
     * ── Deleted rows do NOT reserve their code ────────────────────────────
     *
     * The index is partial on deletedAt: null, so a retired category's code is
     * free again. Checking against deleted rows too would refuse a name the
     * server would accept, which is the safe direction but a screen that says
     * "that code is taken" about nothing anybody can see.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // canWriteExpenses on the route. A 403 is a full stop for the queue, and
      // this is the cheapest place to know it will not happen.
      if (!session?.permissions?.includes("expenses.manage")) return null;

      // Its 400. Left to the server to word rather than reproduced here.
      if (!body.code || !body.label) return null;

      const code  = String(body.code).trim();
      const label = String(body.label).trim();

      const taken = docs
        .find("expenseCategory", { schoolId, deletedAt: null })
        .some((c) => String(c.code ?? "").trim() === code);
      if (taken) return null;

      const id  = body._id ? String(body._id) : randomUUID();
      const now = new Date().toISOString();

      // The endpoint reads req.body._id, so the id goes into the body and the
      // reply describes a row this machine already holds. Without it a replay
      // creates a second category and the local one is orphaned.
      const doc = {
        _id: id,
        schoolId,
        code,
        label,
        labelFr:  body.labelFr ? String(body.labelFr).trim() : null,
        parentId: body.parentId ?? null,
        // Not validated by the endpoint either — a parentId naming nothing is
        // stored as given. Reproduced rather than tightened: refusing it here
        // would decline a request the server accepts.
        isActive:  true,
        createdBy: session?.userId ?? null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      return {
        collection: "expenseCategory",
        doc,
        request: {
          method: "POST",
          path:   "/api/finance/expense-categories",
          body:   { ...body, _id: id },
        },
        // 201 and { success, data } — the endpoint's shape. The server's own
        // reply also carries mongoose's `id` virtual and `__v`; neither is in the
        // document the feed later delivers, so neither is invented here.
        response: { status: 201, data: { success: true, data: doc } },
      };
    },
  },

  {
    route: "POST /api/finance/expenses/:id/void",

    /**
     * Cancelling an expense without erasing it.
     *
     * ── Voiding is a stamp, not a reversing row ────────────────────────────
     *
     * This is the opposite of a fee payment reversal, and the two live a screen
     * apart. A payment is undone by APPENDING a negative row, because the ledger
     * must not edit its own history and a balance is a sum. An expense is undone
     * by stamping voidedAt on the row itself, and every expense total then
     * excludes voided rows — which is why the two must never be reasoned about
     * together: excluding voided rows from a PAYMENT sum would subtract the
     * reversal twice, and appending a negative EXPENSE would count the void
     * twice. One row is stamped here; nothing is appended.
     *
     * The row stays in the list, marked. A bursar looking for the payment they
     * cancelled has to be able to find it.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("expenses.manage")) return null;

      // Its 400 REASON_REQUIRED. Money moved for no recorded reason is the
      // question an auditor asks first, and the endpoint trims before testing —
      // so a reason of spaces is no reason.
      const reason = String(body.reason ?? "").trim();
      if (!reason) return null;

      const row = docs.get("expense", String(params.id));
      // Its 404. Not answered locally: "this machine has not seen that expense"
      // and "no such expense" are different facts and only the server knows the
      // second.
      if (!row) return null;
      if (String(row.schoolId ?? "") !== String(schoolId)) return null;

      // NO deletedAt check, deliberately. The endpoint looks the row up by
      // { _id, schoolId } and nothing else, so it would void a soft-deleted
      // expense — which looks like an oversight and is reproduced anyway,
      // because refusing here what the server accepts is a screen failing for a
      // reason nobody can see. Nothing lists a deleted expense, so in practice
      // this arm is unreachable.

      // Already void. The endpoint answers 200 with replay: true, so queueing
      // this again would be harmless — and pointless, because there is nothing
      // to store: the row is already in the state the caller asked for. Declined
      // rather than answered locally, because a write handler that reports
      // success without queueing anything is claiming to have done something it
      // did not do.
      if (row.voidedAt) return null;

      const now = new Date().toISOString();

      const doc = {
        ...row,
        voidedAt:   now,
        // The signed-in user IS the user the server will stamp from the token,
        // so this is the final value rather than a guess to be corrected. The
        // timestamp is not: the server stamps its own clock at replay, and the
        // push copies its answer back over this row.
        voidedBy:   session?.userId ?? null,
        voidReason: reason,
        updatedAt:  now,
      };

      return {
        collection: "expense",
        doc,
        request: {
          method: "POST",
          path:   `/api/finance/expenses/${row._id}/void`,
          // As it arrived. No id to inject — nothing is created — and no dedupe
          // key: the local row now carries voidedAt, so this handler declines a
          // second attempt and a key could never fire.
          body,
        },
        // 200, not 201: nothing was created.
        response: { status: 200, data: { success: true, data: doc } },
      };
    },
  },

  {
    route: "POST /api/finance/salary-structures",

    /**
     * What a member of staff is owed each month.
     *
     * ── Two rows, because a raise closes the old one ───────────────────────
     *
     * The endpoint does not overwrite: it stamps the structure currently in
     * force with effectiveTo = effectiveFrom - 1ms and creates a new row. That
     * is what makes a payslip from six months ago still reproduce the figures
     * that were in force when it was issued.
     *
     * So this write commits both, through `also` — and it has to. The unique
     * index allows ONE open-ended structure per person, so a local row written
     * without closing the previous one would leave the mirror showing two
     * concurrent salaries for the same person, and the screen would offer a
     * figure the server does not hold. The set is bounded by that same index:
     * at most one row to close, and the loop below stamps whatever it finds
     * rather than assuming one, because the mirror is not the place to enforce
     * the server's constraint.
     *
     * ── Who may do this is the point of the endpoint ───────────────────────
     *
     * payroll.setSalary, which is non-delegable and admin-only: the bursar reads
     * the structure, calculates against it and pays it, and does not get to set
     * the figure. A queued write from somebody without it would be a 403, which
     * stops the whole outbox — so it is checked here, and the check is also the
     * reason this handler can trust the salaryStructure collection to be
     * mirrored at all (the feed gates it on the same capability).
     *
     * ── An unparseable date is not a 400 ──────────────────────────────────
     *
     * effectiveFrom goes straight into new Date() and then into a required Date
     * field, so "soon" is a cast error and a 500 — and a 500 is RETRYABLE, which
     * means it would not block the queue, it would retry it for ever with a row
     * that never settles. Checked here for that reason.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("payroll.setSalary")) return null;

      const userId = body.userId ? String(body.userId).trim() : null;
      if (!userId) return null;
      if (!body.effectiveFrom) return null;

      const from = new Date(body.effectiveFrom);
      if (Number.isNaN(from.getTime())) return null;

      const baseAmount = whole(body.baseAmount);
      if (baseAmount === null || baseAmount < 0) return null;

      // Absent means monthly, exactly as the endpoint reads it. Any other
      // value — the endpoint would answer a mongoose enum-cast error — is
      // declined so the request goes to the network and picks up the real
      // 400/500 rather than a mirror row that guesses.
      const payType = body.payType ?? "monthly";
      if (payType !== "monthly" && payType !== "hourly") return null;
      // The endpoint lets a monthly base be 0 (allowances only); a rate of
      // zero per hour would silently pay nobody, so it refuses it.
      if (payType === "hourly" && baseAmount <= 0) return null;

      const allowances = components(body.allowances);
      const deductions = components(body.deductions);
      if (allowances === null || deductions === null) return null;

      // Its 404 STAFF_NOT_FOUND, looked up by { _id, schoolId } with no
      // isActive or role filter — a deactivated account can still be given a
      // structure, which is right: last month's salary is still owed.
      const staff = docs.get("user", userId);
      if (!staff) return null;
      if (String(staff.schoolId ?? "") !== String(schoolId)) return null;

      const id  = randomUUID();
      const now = new Date().toISOString();

      const doc = {
        _id: id,
        schoolId,
        userId,
        payType,
        baseAmount,
        allowances,
        deductions,
        effectiveFrom: from.toISOString(),
        effectiveTo:   null,
        createdBy:     session?.userId ?? null,
        deletedAt:     null,
        createdAt:     now,
        updatedAt:     now,
      };

      // Closed at one millisecond before the new one starts, exactly as the
      // endpoint's updateMany does it. A day, or the same instant, would leave
      // either a gap or an overlap — and structuresInForce() asks which row
      // covered the END of a month, so an overlap is two payslips for one
      // person and a gap is none.
      const closedAt = new Date(from.getTime() - 1).toISOString();

      const also = docs
        .find("salaryStructure", { schoolId, userId, effectiveTo: null, deletedAt: null })
        .map((open) => ({
          collection: "salaryStructure",
          doc: { ...open, effectiveTo: closedAt, updatedAt: now },
        }));

      return {
        collection: "salaryStructure",
        doc,
        also,
        request: {
          method: "POST",
          path:   "/api/finance/salary-structures",
          // The endpoint reads req.body._id, so the id travels with it.
          body:   { ...body, _id: id },
        },
        // 201 and { success, data }. The server's reply is a mongoose document
        // with toJSON virtuals on, so it also carries gross, net and id; the fed
        // document carries none of them and the salary-structures read computes
        // gross itself, so nothing here depends on inventing them.
        response: { status: 201, data: { success: true, data: doc } },
      };
    },
  },
];
