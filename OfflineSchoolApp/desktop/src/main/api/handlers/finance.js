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
];
