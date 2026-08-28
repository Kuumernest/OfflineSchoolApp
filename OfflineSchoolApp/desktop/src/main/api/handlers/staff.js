// desktop/src/main/api/handlers/staff.js
"use strict";

/**
 * The staff directory: who teaches here, and who takes which subject.
 *
 * ── Every read in this file is the `user` collection, and that decides them ─
 *
 * The feed gates `user` on users.manage (backend/src/config/syncFeed.js), which
 * is ADMIN_ROLES and NOT delegable — so no bursar and no teacher can ever hold
 * it, in any school, however the permissions screen is set. On their machines
 * this collection is EMPTY.
 *
 * The endpoints do not agree with that boundary. GET /admin/teachers is gated on
 * teachers.view, which IS delegable: a school may grant it to the bursar, and
 * then the server answers the staff list while the mirror holds nothing.
 * GET /admin/teachers/stats is gated on dashboard.view — also delegable, same
 * gap. An empty answer there does not read as "you may not see this"; it reads
 * as "this school has no teachers", and "no teachers" is a sentence somebody
 * acts on — they add one, and now there are two accounts for the same person.
 *
 * So every handler here declines unless the session actually holds users.manage.
 * Declining costs nothing: the request goes over the network exactly as it did
 * before this file existed. The same reasoning already declines GET
 * /finance/staff and GET /finance/salary-structures — see handlers/payroll.js
 * and the KNOWN_GAPS entry it points at.
 *
 * Each handler also checks the capability the ENDPOINT itself gates on. A local
 * answer where the server would have said 403 is a screen showing data the
 * caller is not entitled to, and it is not the mirror's place to widen a guard.
 *
 * ── What is NOT here, and why ──────────────────────────────────────────────
 *
 * GET /admin/permissions is online-only. It answers with the whole capability
 * registry — every key, its module, whether it is delegable, its note and its
 * per-role defaults — computed from backend/src/config/permissions.js, plus
 * `effective` per role from permissions.service. That registry is CODE, not a
 * mirrored collection: reproducing it here would be a second copy of
 * who-may-do-what, drifting silently every time a permission is added on the
 * server. The endpoint returns the matrix precisely so the screen needs no
 * client-side copy of it, and a mirror holding one would defeat the reason it
 * exists. Recorded for coverage.js in the report accompanying this batch.
 */

/** The two roles the router calls admin, written as authenticate() leaves them. */
const SUPER_ADMIN = "super_admin";

/** STAFF_ROLES from backend/src/config/roles.js — the isStaff virtual reads it. */
const STAFF_ROLES = ["super_admin", "school_admin", "bursar", "teacher"];

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/**
 * The stored row without this machine's bookkeeping.
 *
 * docs.get() attaches `_pending`, which is not part of any endpoint's contract.
 */
const bare = (row) => {
  if (!row) return row;
  const { _pending, ...rest } = row;
  return rest;
};

/**
 * `.select("-password -tempPassword")`, reproduced.
 *
 * password is `select: false` on the schema and the feed omits both keys, so a
 * row that arrived by sync carries neither. Stripped anyway: tempPassword is NOT
 * a schema path, so nothing but this projection keeps it out of an answer, and a
 * row that reached the mirror by any other route than the feed would carry it.
 */
const withoutSecrets = (row) => {
  const { password, tempPassword, ...rest } = bare(row);
  return rest;
};

/**
 * resolveSchoolId(), reproduced.
 *
 * The TOKEN's school, not the query's — for anybody but a super_admin the
 * endpoint ignores ?schoolId entirely and reads req.user.schoolId. A handler
 * that preferred the query would answer about a school the server would not
 * have answered about.
 *
 * The query is consulted only when there is no session at all, which is how the
 * parity harness asks the session-less handlers.
 */
const resolveSchoolId = (query, session) => {
  const provided = query?.schoolId ? String(query.schoolId).trim() : null;
  if (session?.role === SUPER_ADMIN && provided) return provided;
  if (session) return session.schoolId ? String(session.schoolId).trim() : null;
  return provided;
};

/**
 * getTenantQuery(), reproduced — with one deliberate difference.
 *
 * `{ _id, schoolId }` for everybody except a super_admin, who gets no schoolId
 * clause and may therefore read any school's row. This machine mirrors one
 * school, so a super_admin reaching across schools finds nothing here and the
 * request goes to the network: stricter than the server, which is the safe
 * direction.
 *
 * No deletedAt condition, because there is none on the endpoint — and none is
 * missing from the User schema either: it has no such path, and deactivation is
 * what isActive is for. A row that carries deletedAt anyway (nothing stops one)
 * is still returned, exactly as the server returns it.
 */
const tenantRow = (docs, id, schoolId) => {
  const row = docs.get("user", String(id).trim());
  if (!row) return null;
  if (String(row.schoolId ?? "") !== String(schoolId)) return null;
  return row;
};

/**
 * statusFilter(), reproduced — and the default is ACTIVE-ONLY.
 *
 * Not "all". A deactivated teacher offered as somebody who could take a class
 * would be worse than the missing filter, which is the endpoint's own reasoning
 * and is quoted here so nobody "fixes" this to show everyone.
 *
 * `isActive: true`, not `{ $ne: false }`: an account created before the field
 * existed has no isActive at all and is therefore NOT in the default list. The
 * store's json_extract yields NULL for an absent key, which fails `= 1` the same
 * way Mongo's `{ isActive: true }` fails an absent field — so the two agree
 * without any special case.
 */
const statusFilter = (raw) => {
  const s = String(raw ?? "").toLowerCase();
  if (s === "all")      return {};
  if (s === "inactive") return { isActive: false };
  return { isActive: true };
};

/**
 * MongoDB's ascending string order — byte comparison, not localeCompare.
 *
 * Used on _id only, and only for stability: GET /admin/teachers has NO .sort()
 * at all, so the server returns storage order, which is not a promise anybody
 * may rely on. Sorting by name would be worse than sorting by id — it would look
 * like an order the endpoint guarantees. The parity section compares these rows
 * BY KEY rather than by position for the same reason.
 */
const byId = (a, b) => {
  const av = String(a._id ?? "");
  const bv = String(b._id ?? "");
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
};

/**
 * GET /admin/teacher-assignments is the SAME function as GET /admin/assignments.
 *
 * admin.routes.js registers one handler at both paths (handleGetAssignments),
 * and handlers/school.js already mirrors the /assignments spelling — including
 * the two things about it that look like bugs and are the endpoint's own: the
 * classId parameter is matched against the assignment's `class` field only, and
 * the subject's coefficient always reads as 1 because the projection never
 * selects it.
 *
 * Taken by reference rather than copied. A second copy of a hundred lines of
 * join-and-dedupe would drift from the first, and the parity harness only checks
 * one path at a time — so the copy that drifted would be the one nobody asked
 * about. Looked up by route string, and if that string ever changes this file
 * quietly stops answering the second path rather than throwing: a throw here
 * happens at require time inside api/index.js and would take every other
 * handler down with it.
 */
const assignmentsHandler =
  require("./school").find((h) => h.route === "GET /api/admin/assignments")?.handler ?? null;

module.exports = [
  {
    // BEFORE /api/admin/teachers/:id, and that order is load-bearing: the
    // dispatcher takes the first pattern that matches, and ":id" would happily
    // capture "stats". The router has the same hazard and answers it the same
    // way — /teachers/stats is declared above /teachers/:id.
    route: "GET /api/admin/teachers/stats",

    /**
     * Two numbers for the dashboard: how many teachers, how many active.
     *
     * `total` has NO isActive filter and `active` has `isActive: true`, so a
     * deactivated teacher is counted in the first and not the second — the
     * difference between them is the number of dormant accounts. Neither counts
     * on deletedAt, which the User schema does not have.
     *
     * Gated on dashboard.view by the endpoint, which is DELEGABLE — a school may
     * grant it to the bursar, whose mirror holds no users at all. Answering
     * "0 teachers, 0 active" on that machine would put a nought on a dashboard
     * that somebody reads as a fact about the school.
     */
    handler: ({ query }, { docs, session }) => {
      if (session && !session.permissions?.includes("dashboard.view")) return null;
      if (!session?.permissions?.includes("users.manage")) return null;

      const schoolId = resolveSchoolId(query, session);
      // The endpoint answers 400 without one. Its 400 to give, not ours.
      if (!schoolId) return null;

      return ok({
        total:  docs.count("user", { schoolId, role: "teacher" }),
        active: docs.count("user", { schoolId, role: "teacher", isActive: true }),
      });
    },
  },

  {
    route: "GET /api/admin/teachers",

    /**
     * The staff list, which is the teachers only.
     *
     * ── Three things about the filter ─────────────────────────────────────
     *
     *   role: "teacher" exactly. Not STAFF_ROLES — a bursar or an administrator
     *   is not on this screen, and the settings section has its own endpoint for
     *   those accounts.
     *
     *   ?status defaults to ACTIVE. See statusFilter above.
     *
     *   ?email is matched lowercased and trimmed, and there is no partial
     *   match — it is an exact-address lookup the screens use to check whether
     *   an address is taken, not a search box.
     *
     * ── And no schoolId is not a 400 here ─────────────────────────────────
     *
     * Unlike /teachers/stats, this endpoint simply omits the clause and answers
     * across every school. This machine holds one school, so it declines instead
     * of answering a question about schools it cannot see.
     */
    handler: ({ query }, { docs, session }) => {
      if (session && !session.permissions?.includes("teachers.view")) return null;
      if (!session?.permissions?.includes("users.manage")) return null;

      const schoolId = resolveSchoolId(query, session);
      if (!schoolId) return null;

      const filter = { schoolId, role: "teacher", ...statusFilter(query.status) };

      if (query.email !== undefined) {
        // `req.query.email?.trim()` — a TypeError, and so a 500, on anything
        // that is not a string. Declined rather than reproduced.
        if (typeof query.email !== "string") return null;
        if (query.email.trim()) filter.email = query.email.toLowerCase().trim();
      }

      const teachers = docs.find("user", filter).map(withoutSecrets).sort(byId);

      // Both keys, same array. The screens read `teachers`; `data` is what the
      // rest of the admin API answers with, and a shorter shape here would break
      // whichever of the two a caller happened to pick.
      return ok({ data: teachers, teachers });
    },
  },

  {
    route: "GET /api/admin/teachers/:id",

    /**
     * One teacher's record.
     *
     * The 404 is the server's to give: "this machine has not mirrored that row"
     * and "no such teacher" are different facts, and only the server knows the
     * second. So an id that is absent, another school's, or not a teacher at all
     * falls through to the network rather than being answered 404 locally.
     */
    handler: ({ params, query }, { docs, session }) => {
      if (session && !session.permissions?.includes("teachers.view")) return null;
      if (!session?.permissions?.includes("users.manage")) return null;

      const schoolId = resolveSchoolId(query, session);
      if (!schoolId) return null;

      const row = tenantRow(docs, params.id, schoolId);
      if (!row || row.role !== "teacher") return null;

      return ok({ data: withoutSecrets(row) });
    },
  },

  ...(assignmentsHandler ? [{
    route: "GET /api/admin/teacher-assignments",

    /**
     * Who takes which subject in which class — the second path of one endpoint.
     *
     * ── Four collections, four capabilities ───────────────────────────────
     *
     * The answer is one assignment row joined to three other collections, and
     * the feed gates each of them separately:
     *
     *   teacherAssignment  subjects.view
     *   subject            subjects.view
     *   class              classes.view
     *   user               users.manage      (teacher AND assignedBy)
     *
     * A caller missing any one of them gets a mirror with a hole in it, and the
     * endpoint turns every hole into `{ _id }` with no name — because it spreads
     * an empty map rather than dropping the reference. So a machine without the
     * staff directory answers with a full list of nameless ids, which reads as
     * corrupted data rather than as a missing permission. All four are required
     * here, and the request goes to the network otherwise.
     *
     * teachers.manage is checked as well, because that is what the ENDPOINT
     * gates on — and it is not delegable, so a bursar can never hold it. Without
     * this check a bursar's desktop would answer 200 where the server answers
     * 403. Note that GET /admin/assignments, the same endpoint under its other
     * name in handlers/school.js, has no such check; reported rather than
     * changed, since that file belongs to another domain.
     */
    handler: (req, ctx) => {
      const held = ctx.session?.permissions;
      if (!held) return null;
      for (const key of ["teachers.manage", "users.manage", "subjects.view", "classes.view"]) {
        if (!held.includes(key)) return null;
      }
      return assignmentsHandler(req, ctx);
    },
  }] : []),
];
