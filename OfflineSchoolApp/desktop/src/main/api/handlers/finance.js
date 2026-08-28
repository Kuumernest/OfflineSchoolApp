// desktop/src/main/api/handlers/finance.js
"use strict";

/**
 * What the school spent.
 *
 * ── Three things here are easy to get almost right ────────────────────────
 *
 *   A VOIDED EXPENSE IS RETURNED BUT NOT COUNTED. The row stays in the list so
 *   the ledger reads honestly — somebody looking for a payment they cancelled
 *   should find it, marked — and it is left out of the total. Filtering it from
 *   the list would make a cancelled expense look like it never happened;
 *   including it in the total would overstate what the school spent.
 *
 *   THE TOTAL IS OF THE RETURNED PAGE, not of everything that matched. The
 *   endpoint takes 500 rows and sums those. That is arguably a bug in a school
 *   with more than 500 expenses in range — the figure on screen is not the
 *   period's real total — but it is what the endpoint does, and a mirror that
 *   quietly summed all of them would disagree with the server on the one number
 *   the screen is about. Reproduced, and noted here rather than corrected on one
 *   side only.
 *
 *   DATES ARE INCLUSIVE AT BOTH ENDS. $gte and $lte, so an expense incurred
 *   exactly at the boundary belongs to the period. Off by one at either end
 *   moves money between months.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * What the finance report reads, expressed as the capabilities that mirror it.
 *
 * GET /finance/reports/summary is gated on finance.reports ALONE, and then sums
 * four collections the feed gates on three OTHER capabilities: fee payments and
 * charges (fees.view), expenses (expenses.view), payslips (payroll.view).
 *
 * For a bursar or a head those all come together, so nothing is lost in
 * practice. But finance.reports is delegable, so a school can hand it to
 * somebody holding none of the three — and that machine would mirror none of
 * the inputs and compute a report of zeros. Zero income is a figure a head
 * teacher would act on, and it would be indistinguishable from a bad month.
 *
 * So the handler declines unless all three are held. Being too strict here
 * sends the request to the server, which is the honest answer.
 */
const REPORT_INPUTS = ["fees.view", "expenses.view", "payroll.view"];

/** MongoDB's ascending string order — byte comparison, not localeCompare. */
const byLabel = (a, b) => {
  const al = String(a.label ?? "");
  const bl = String(b.label ?? "");
  if (al === bl) return 0;
  return al < bl ? -1 : 1;
};

/**
 * A query date as an ISO string, or undefined if it is not a date.
 *
 * The mirror stores dates as the ISO strings the server sent, and ISO strings in
 * the same format compare correctly as text — which is what makes a range query
 * possible in SQLite without a date type.
 *
 * An unparseable value returns undefined and the handler then declines, rather
 * than throwing on toISOString() or silently dropping the filter. Dropping it
 * would be the dangerous one: a bad `from` would widen the period instead of
 * narrowing it, and a bursar would read a total covering the whole year.
 */
const asIso = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

module.exports = [
  {
    route: "GET /api/finance/expense-categories",
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const rows = docs.find("expenseCategory", { schoolId, deletedAt: null }).sort(byLabel);
      return ok({ count: rows.length, data: rows });
    },
  },

  {
    route: "GET /api/finance/expenses",
    handler: ({ query }, { docs }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      const filter = { schoolId, deletedAt: null };
      if (query.categoryId) filter.categoryId = String(query.categoryId).trim();

      // Declined rather than guessed: a date the server would have read
      // differently, or not at all, is not something to interpret here.
      let from;
      let to;
      if (query.from) {
        from = asIso(query.from);
        if (!from) return null;
      }
      if (query.to) {
        to = asIso(query.to);
        if (!to) return null;
      }
      // The store's filter language takes one operator per field, so a RANGE is
      // applied after the query rather than inside it. Written out here instead
      // of extending that language: two comparisons in one visible place are
      // easier to review than a more capable filter, and the row count at this
      // point is one school's expenses.
      //
      // ISO strings in the same format compare correctly as text, which is what
      // makes a date range possible without a date type.
      let rows = docs.find("expense", filter);
      if (from) rows = rows.filter((r) => String(r.incurredAt ?? "") >= from);
      if (to)   rows = rows.filter((r) => String(r.incurredAt ?? "") <= to);

      // Newest first, then capped — in that order, so the 500 returned are the
      // most recent 500 and not an arbitrary 500.
      rows = rows
        .sort((a, b) => String(b.incurredAt ?? "").localeCompare(String(a.incurredAt ?? "")))
        .slice(0, 500);

      // Of the returned page, excluding voided. See the note at the top.
      const total = rows
        .filter((r) => !r.voidedAt)
        .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

      return ok({ count: rows.length, total, data: rows });
    },
  },

  {
    route: "GET /api/finance/reports/summary",

    /**
     * Income against expenditure for a period, plus arrears as they stand now.
     *
     * ── Six filters here are load-bearing and none of them is guessable ─────
     *
     * All of them live in backend/src/services/financeReports.service.js rather
     * than in the route, which is why reading the route alone would produce a
     * plausible and wrong report.
     *
     *   FEE PAYMENTS exclude deletedAt ONLY — never voidedAt. A reversal is a
     *   separate row with a negative amount, so a plain sum already nets it off;
     *   excluding voided rows as well would subtract the reversal twice and
     *   report the school as having collected less than it did.
     *
     *   CHARGES (arrears only) exclude deletedAt AND voidedAt, which is the
     *   opposite way round, because voidedAt on a charge means the bill was
     *   withdrawn.
     *
     *   EXPENSES exclude voided rows, and also `status $nin [pending, rejected]`
     *   — approval state, not deletion. A pending expense must not count: saying
     *   the money is gone before anybody agreed it should be would change the
     *   figure under the reader on approval. $nin and not $eq: rows written
     *   before the field existed have no status at all, and a missing field is
     *   not in the list, so every historic expense keeps counting. That is the
     *   `IS NULL OR NOT IN` below, and reading it as `= 'approved'` would drop
     *   every expense in an older school's ledger.
     *
     *   PAYSLIPS use `status != draft`, NOT `status = paid`. Reversing a run
     *   flips each original to "reversed" and appends a negative mirror row that
     *   is itself "paid" — so summing only "paid" keeps the mirror and drops the
     *   original, and a reversed month reports as a large NEGATIVE expenditure.
     *   Excluding drafts keeps both halves, which cancel. `!= draft` also
     *   matches a row with no status at all in Mongo, which is why the SQL says
     *   `IS NULL OR <> 'draft'` — `json_extract(...) <> 'draft'` alone yields
     *   NULL for a missing field and silently drops the row.
     *
     *   ARREARS ARE NOT BOUNDED BY THE PERIOD. A debt raised in October is still
     *   owed in March; clipping it to from/to would report it as settled. Only
     *   academicYear narrows it.
     *
     * ── What this shares with the whole mirror, and cannot fix ─────────────
     *
     * A total is only as complete as the mirror. A machine part-way through its
     * first sync will answer with a smaller figure than the school's, and unlike
     * a short list a wrong total does not look wrong. The same is already true
     * of every fee balance answered here; it is worth knowing rather than
     * hiding, and it is an argument for the sync status being visible on the
     * screen that shows these numbers.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      if (!REPORT_INPUTS.every((p) => session?.permissions?.includes(p))) return null;

      // The endpoint's own two 400s, declined rather than answered: an
      // unreadable date and a reversed range are refusals the server words, and
      // guessing what it meant would widen the period instead of refusing it.
      for (const value of [query.from, query.to]) {
        if (value && asIso(value) === undefined) return null;
      }
      if (query.from && query.to && new Date(query.from) > new Date(query.to)) return null;

      const gte = query.from ? asIso(query.from) : null;
      const lte = query.to   ? asIso(query.to)   : null;

      /** The period clause for one collection's date field. */
      const period = (field) => {
        const sql    = [];
        const params = [];
        if (gte) { sql.push(`AND json_extract(json,'$.${field}') >= ?`); params.push(gte); }
        if (lte) { sql.push(`AND json_extract(json,'$.${field}') <= ?`); params.push(lte); }
        return { sql: sql.join(" "), params };
      };

      const feePeriod = period("receivedAt");
      const expPeriod = period("incurredAt");
      const payPeriod = period("paidAt");

      const feeWhere = {
        sql: `collection = 'feePayment' AND school_id = ? AND deleted_at IS NULL
              ${feePeriod.sql}`,
        params: [schoolId, ...feePeriod.params],
      };

      const expWhere = {
        sql: `collection = 'expense' AND school_id = ? AND deleted_at IS NULL
              AND json_extract(json,'$.voidedAt') IS NULL
              AND (json_extract(json,'$.status') IS NULL
                   OR json_extract(json,'$.status') NOT IN ('pending','rejected'))
              ${expPeriod.sql}`,
        params: [schoolId, ...expPeriod.params],
      };

      const payWhere = {
        sql: `collection = 'salaryPayment' AND school_id = ? AND deleted_at IS NULL
              AND (json_extract(json,'$.status') IS NULL
                   OR json_extract(json,'$.status') <> 'draft')
              ${payPeriod.sql}`,
        params: [schoolId, ...payPeriod.params],
      };

      /** As the service's sum() helper: a total and a row count, zero when empty. */
      const sumOf = (where, field) => {
        const row = docs.sql(`
          SELECT COALESCE(SUM(json_extract(json,'$.${field}')), 0) AS total,
                 COUNT(*) AS count
          FROM docs WHERE ${where.sql}
        `, ...where.params)[0];
        return { total: row?.total ?? 0, count: row?.count ?? 0 };
      };

      const fees     = sumOf(feeWhere, "amount");
      const expenses = sumOf(expWhere, "amount");
      const payroll  = sumOf(payWhere, "net");

      // ── Expenditure split by category ────────────────────────────────────
      //
      // The label comes from the category document whether or not it has been
      // deleted — the server's $lookup joins on _id and nothing else — because a
      // retired category still named the money that went through it. A category
      // this machine does not hold, or an expense with no category at all,
      // becomes "—", which is the endpoint's own $ifNull.
      const byCategory = docs.sql(`
        SELECT json_extract(json,'$.categoryId') AS categoryId,
               COALESCE(SUM(json_extract(json,'$.amount')), 0) AS total,
               COUNT(*) AS count
        FROM docs WHERE ${expWhere.sql}
        GROUP BY json_extract(json,'$.categoryId')
      `, ...expWhere.params)
        .map((r) => ({
          categoryId: r.categoryId,
          total:      r.total ?? 0,
          count:      r.count ?? 0,
          label:      docs.get("expenseCategory", String(r.categoryId))?.label ?? "—",
        }))
        // Largest first, as the endpoint sorts. Two categories with the same
        // total are not ordered by either side — flagged to the parity check.
        .sort((a, b) => b.total - a.total);

      // ── Month by month ───────────────────────────────────────────────────
      //
      // The server keys these with $dateToString in UTC, and the mirror holds
      // the UTC ISO strings the server sent — so the first seven characters ARE
      // that key, with no date arithmetic to get wrong.
      //
      // A row whose date field is missing groups under null on both sides, and
      // then sorts LAST, because the shared `.sort()` compares String(null).
      // That is odd and it is what the endpoint does; reproduced rather than
      // dropped, because dropping it would lose the money in that row from the
      // series while leaving it in the totals above.
      const series = (where, dateField, valueField) => {
        const rows = docs.sql(`
          SELECT substr(json_extract(json,'$.${dateField}'), 1, 7) AS month,
                 COALESCE(SUM(json_extract(json,'$.${valueField}')), 0) AS total
          FROM docs WHERE ${where.sql}
          GROUP BY substr(json_extract(json,'$.${dateField}'), 1, 7)
        `, ...where.params);
        return new Map(rows.map((r) => [r.month, r.total ?? 0]));
      };

      const feeMonths = series(feeWhere, "receivedAt", "amount");
      const expMonths = series(expWhere, "incurredAt", "amount");
      const payMonths = series(payWhere, "paidAt", "net");

      const months = [...new Set([
        ...feeMonths.keys(), ...expMonths.keys(), ...payMonths.keys(),
      ])]
        .sort()
        .map((month) => {
          const income = feeMonths.get(month) ?? 0;
          const out    = (expMonths.get(month) ?? 0) + (payMonths.get(month) ?? 0);
          return { month, income, expenditure: out, net: income - out };
        });

      const expenditureTotal = expenses.total + payroll.total;

      // ── Arrears: a position, not a flow ──────────────────────────────────
      const year = query.academicYear ? String(query.academicYear) : null;
      const yearSql    = year ? "AND json_extract(json,'$.academicYear') = ?" : "";
      const yearParams = year ? [year] : [];

      const charges = docs.sql(`
        SELECT COALESCE(SUM(json_extract(json,'$.amount')), 0) AS charged,
               COALESCE(SUM(COALESCE(json_extract(json,'$.waivedAmount'), 0)), 0) AS waived
        FROM docs
        WHERE collection = 'feeCharge' AND school_id = ? AND deleted_at IS NULL
          AND json_extract(json,'$.voidedAt') IS NULL
          ${yearSql}
      `, schoolId, ...yearParams)[0];

      // waivedAmount, a number — not a `waived` boolean. Half a trip fee
      // forgiven is a real thing and reading it as a flag writes off the lot.
      const charged = charges?.charged ?? 0;
      const waived  = charges?.waived  ?? 0;
      const billed  = charged - waived;

      const paid = sumOf({
        sql: `collection = 'feePayment' AND school_id = ? AND deleted_at IS NULL ${yearSql}`,
        params: [schoolId, ...yearParams],
      }, "amount").total;

      return ok({
        data: {
          summary: {
            // The RAW query values, echoed as the endpoint echoes them — not the
            // parsed dates. A screen showing the period back to the reader shows
            // what they asked for.
            period: { from: query.from ?? null, to: query.to ?? null },
            income: {
              fees:  fees.total,
              count: fees.count,
              total: fees.total,
            },
            expenditure: {
              expenses: expenses.total,
              payroll:  payroll.total,
              total:    expenditureTotal,
            },
            net: fees.total - expenditureTotal,
            byCategory,
            months,
          },
          arrears: {
            // Raw again, and `?academicYear=` is the case that shows why: the
            // service filters on a truthy value and echoes the value it was
            // given, so an empty parameter narrows nothing and still comes back.
            academicYear: query.academicYear ?? null,
            charged,
            waived,
            billed,
            paid,
            // Negative means the school holds more than it billed, which happens
            // after an overpayment. Reported, not clamped — clamping it to zero
            // would hide a credit the family is owed.
            outstanding: billed - paid,
            collectionRate: billed > 0 ? Math.round((paid / billed) * 100) : null,
          },
        },
      });
    },
  },
];
