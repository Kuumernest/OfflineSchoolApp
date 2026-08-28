// desktop/src/main/api/handlers/payroll.js
"use strict";

/**
 * Payroll runs, their payslips, who can be put on one, and what each is owed.
 *
 * ── Most of these cannot always be answered offline ───────────────────────
 *
 * The list of runs can. The other three all read the user collection — the
 * detail view joins each payslip to the member of staff it belongs to (name,
 * email and role), the salary structures do the same join, and the staff list
 * IS the user collection — and that is the collection a bursar cannot mirror.
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
 *
 * ── And a SECOND gap of the same shape, found writing this file ────────────
 *
 * GET /finance/salary-structures is gated on payroll.view, and the feed gates
 * the salaryStructure collection on payroll.setSalary — deliberately, because
 * what every colleague earns is a narrower thing than a payroll total. So a
 * bursar may READ the structures from the server and may not MIRROR them.
 *
 * An empty local answer is the dangerous one here: "this school has set no
 * salaries" and "this machine is not allowed a copy of them" look identical on
 * screen, and the first is a sentence somebody would act on. So that handler
 * declines outright unless the session holds payroll.setSalary, rather than
 * reporting an empty trail. Same reasoning for /finance/staff and the user
 * collection.
 *
 * Not recorded in KNOWN_GAPS yet — see the report accompanying this batch;
 * syncFeed.js is not this file's to edit.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * MongoDB's ascending string order — byte comparison, not localeCompare.
 *
 * Sorting names with localeCompare puts "M. Etoa" after "Mme Fomba" and Mongo
 * puts it before, which is a different page of a staff list.
 */
const byBytes = (field) => (a, b) => {
  const av = String(a[field] ?? "");
  const bv = String(b[field] ?? "");
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
};

/**
 * The member of staff a payslip or a salary structure belongs to.
 *
 * Three outcomes, and telling them apart is the whole point:
 *
 *   an object      the server would join this row to that person
 *   null           the server would join it to nothing — the id names somebody
 *                  in another school, so its User.find({ schoolId, _id }) misses
 *                  and the route's `?? null` fires. This machine HOLDS the
 *                  document and can see whose it is, which is a different fact
 *                  from not having it, so it answers rather than declining.
 *   NOT_MIRRORED   this machine has no such user. Indistinguishable here from
 *                  "no such user anywhere", and the caller must decline: a
 *                  payroll with every name blank reads as missing data rather
 *                  than as a missing permission.
 */
const NOT_MIRRORED = Symbol("staff not mirrored");

const staffFor = (docs, schoolId, userId) => {
  const staff = docs.get("user", String(userId));
  if (!staff) return NOT_MIRRORED;
  if (String(staff.schoolId ?? "") !== String(schoolId)) return null;

  // .select("name email role") — projected, so nothing the server does not send
  // is attached. A field the document does not carry stays absent rather than
  // becoming null, because that is what .lean() on a projection produces.
  return { _id: staff._id, name: staff.name, email: staff.email, role: staff.role };
};

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
        const staff = staffFor(docs, schoolId, p.userId);
        if (staff === NOT_MIRRORED) return null;
        joined.push({ ...p, staff });
      }

      return ok({ data: { run, payslips: joined } });
    },
  },

  {
    route: "GET /api/finance/staff",

    /**
     * Who can be put on payroll.
     *
     * ── The filter is stricter than it looks, twice over ────────────────────
     *
     * `isActive: true`, not `isActive: { $ne: false }`. A user document that
     * never had the field fails this one — so an account created before the
     * field existed is NOT on the payroll list, and reading it the permissive
     * way would put people on a payroll the server leaves off.
     *
     * `role: { $in: ["school_admin", "teacher"] }` — and that list does NOT
     * include the bursar, despite the endpoint's own comment saying it exists so
     * that the head and the bursar are not left off. Reproduced exactly, because
     * a mirror that helpfully added the bursar would offer a salary structure
     * for somebody the server then refuses to find. It looks wrong and it is
     * reported as wrong; it is not this layer's to correct on one side only.
     *
     * ── And it declines where a bursar cannot see ───────────────────────────
     *
     * This endpoint IS the user collection, which a bursar may read here
     * (payroll.view) and may not mirror (users.manage). Answering with an empty
     * list would say "this school has no staff" — a sentence somebody would act
     * on — so it declines instead. See the note at the top of the file.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("users.manage")) return null;

      const rows = docs
        .find("user", {
          schoolId,
          role:     { in: ["school_admin", "teacher"] },
          // Booleans cannot be bound by node:sqlite; the store's bindable()
          // turns this into the 1 that json_extract yields.
          isActive: true,
        })
        // No deletedAt filter, and none is missing: the User model has no such
        // field. Deactivation is what isActive above is for.
        .map((u) => ({ _id: u._id, name: u.name, email: u.email, role: u.role }))
        .sort(byBytes("name"));

      return ok({ count: rows.length, data: rows });
    },
  },

  {
    route: "GET /api/finance/salary-structures",

    /**
     * What each member of staff is owed, as it stands or as it has stood.
     *
     * ── The default is not "everything" ────────────────────────────────────
     *
     * Without ?history=1 the filter adds `effectiveTo: null`, which is only the
     * row currently in force. A raise closes the old row rather than editing it,
     * so the full trail is several rows per person and the screen showing all of
     * them by default would read as several concurrent salaries.
     *
     * The test is `history !== "1"` — the string, not truthiness. `history=0`
     * and `history=false` both mean the full trail to this endpoint, which is
     * surprising and is what it does.
     *
     * ── gross is computed, not stored ──────────────────────────────────────
     *
     * The model declares gross and net as VIRTUALS and the route uses .lean(),
     * which drops virtuals — so the route recomputes gross itself and there is
     * no `net` key in the response at all. Reproducing the virtual instead would
     * add a field the server never sends.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // payroll.setSalary, though the ENDPOINT only asks for payroll.view: that
      // is the permission the feed gates the collection on, so without it this
      // machine holds no structures and an empty answer would be a lie about the
      // school rather than about the mirror. See the note at the top.
      if (!session?.permissions?.includes("payroll.setSalary")) return null;

      const filter = { schoolId, deletedAt: null };
      if (query.userId) filter.userId = String(query.userId);
      if (query.history !== "1") filter.effectiveTo = null;

      // effectiveFrom descending. The mirror holds the ISO strings the server
      // sent, and ISO strings in one format compare as their dates do.
      //
      // Ties are NOT ordered by the endpoint — two structures effective the same
      // instant come back in whatever order the storage engine used. Sorted here
      // for stability and flagged to the parity check, which must compare these
      // by key rather than by position.
      const rows = docs
        .find("salaryStructure", filter)
        .sort((a, b) => -byBytes("effectiveFrom")(a, b));

      const data = [];
      for (const r of rows) {
        const staff = staffFor(docs, schoolId, r.userId);
        if (staff === NOT_MIRRORED) return null;

        data.push({
          ...r,
          // The route's own arithmetic, key for key: base plus allowances, with
          // deductions NOT taken off. "gross" on this screen is what the school
          // pays before deductions, and subtracting them here would show a
          // smaller salary than the payslip it produces.
          gross: (r.baseAmount ?? 0) + (r.allowances ?? []).reduce((s, a) => s + a.amount, 0),
          staff,
        });
      }

      return ok({ count: rows.length, data });
    },
  },
];
