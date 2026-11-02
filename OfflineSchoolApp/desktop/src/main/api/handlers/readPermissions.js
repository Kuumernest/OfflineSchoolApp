// desktop/src/main/api/handlers/readPermissions.js
"use strict";

/**
 * A local read answers only someone the server would answer.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * The mirror holds whatever the accounts that synced on this machine were
 * allowed to pull. A bursar's sync brings down every fee ledger; a teacher who
 * signs in after them on the same computer was answered from those rows by
 * GET /api/fees/outstanding, because the local handler checked the school and
 * nothing else — while the server, for the same request, says 403 (audit
 * finding F6).
 *
 * ── What this does ────────────────────────────────────────────────────────
 *
 * Wraps a handler with the guard the server route runs (requirePermission,
 * and the role gate on /api/admin). A session without it gets null — "not
 * answered here" — and the request goes to the server exactly as an
 * unimplemented route does: online, the server says 403 with the permission
 * it wanted; offline, it fails the way any online-only screen does.
 *
 * Purely a read restriction for the signed-in session. Nothing is removed from
 * disk, nothing is hidden from a session that holds the permission, and the
 * sync is untouched.
 *
 * The permission list is the one the server handed the renderer at sign-in
 * (auth.routes permissionsFor → session:set), the same list the other local
 * handlers already check (timetable, payroll, staff, announcements).
 */

/** backend/src/config/roles.js STAFF_ROLES — the gate in front of /api/admin. */
const STAFF_ROLES = ["super_admin", "school_admin", "bursar", "teacher"];

/** Does this session pass the server's guard for the route? */
const allowed = (session, { permissions = [], roles = null } = {}) => {
  if (!session || !session.role) return false;
  if (roles && !roles.includes(session.role)) return false;
  const held = Array.isArray(session.permissions) ? session.permissions : [];
  return permissions.every((p) => held.includes(p));
};

/**
 * Never hide a person's OWN unsent changes.
 *
 * Permissions can be revoked while a bursar has payments queued offline. The
 * guard must not then hide those payments from the person who took them: if
 * the signed-in account still has a request waiting under one of the file's
 * write paths (outbox.user_id = this account), the local answer is given as
 * before. Only the account's own rows qualify — another account's queue, or an
 * ownerless one, never opens a read.
 */
const hasOwnPending = (ctx, prefixes) => {
  try {
    const userId = ctx?.session?.userId;
    return Boolean(userId && prefixes?.length && ctx?.queue?.hasOwnPending?.(userId, prefixes));
  } catch {
    return false;
  }
};

/**
 * Guard read handlers in place.
 *
 * In place rather than returning a copy because handler modules hang extra
 * exports off their array (fees.js: totalsFor, outstandingOf) and build it in
 * more than one statement.
 *
 * @param {Array<{route:string, handler:Function}>} entries
 * @param {Record<string, {permissions?: string[], roles?: string[]}>} rules  route → guard
 * @param {{ ownWrites?: string[] }} [options]  outbox path prefixes whose own
 *        pending rows keep the local answer open (see hasOwnPending)
 * @returns the same array
 */
const guardReads = (entries, rules, { ownWrites = [] } = {}) => {
  const unknown = Object.keys(rules).filter((r) => !entries.some((e) => e.route === r));
  // Thrown at load, like the server's requirePermission with a typo: a rule for
  // a route that is not here protects nothing and must not ship silently.
  if (unknown.length) throw new Error(`guardReads: no handler for ${unknown.join(", ")}`);

  for (const entry of entries) {
    const rule = rules[entry.route];
    if (!rule || entry.__guarded) continue;
    const inner = entry.handler;
    entry.handler = (req, ctx) =>
      (allowed(ctx?.session, rule) || hasOwnPending(ctx, ownWrites) ? inner(req, ctx) : null);
    entry.requires = { ...rule, ownWrites };
    entry.__guarded = true;
  }
  return entries;
};

module.exports = { guardReads, allowed, STAFF_ROLES };
