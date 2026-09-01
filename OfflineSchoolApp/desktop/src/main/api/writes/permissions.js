// desktop/src/main/api/writes/permissions.js
"use strict";

/**
 * The role permission matrix, with no connection.
 *
 * One write: PUT /admin/permissions/:role   { permissions: [...] }
 *
 * The server stores the difference against the shipped defaults, not the set
 * itself — so a capability added in a later release still reaches this school
 * even though it was never explicitly granted. The mirror does the same thing
 * with the defaults the read handler's matrix already carries.
 *
 * A role that is not adjustable, a key that is locked, and a body that is not an
 * array are all refused by the endpoint; each is checked here, because a queued
 * 4xx would stop the outbox for work from other parts of the school.
 */

module.exports = [
  {
    route: "PUT /api/admin/permissions/:role",

    handler: ({ body, params }, { docs, session }) => {
      if (!session?.schoolId) return null;
      if (!session?.permissions?.includes("permissions.manage")) return null;

      const role = String(params.role ?? "").trim();
      if (!role) return null;

      if (!Array.isArray(body?.permissions)) return null;
      const desired = body.permissions.map((k) => String(k).trim()).filter(Boolean);

      // The read handler stores the matrix, adjustableRoles and lockedKeys.
      const matrix = docs.get("permissionMatrix", "matrix");
      if (!matrix) return null;

      const adjustable = new Set(matrix.adjustableRoles ?? []);
      if (!adjustable.has(role)) return null;

      const locked = new Set(matrix.lockedKeys ?? []);
      if (desired.some((k) => locked.has(k))) return null;

      // Every key the school wants must be in the registry — the endpoint
      // refuses an unknown key rather than ignoring it, because a key that
      // arrived through a typo would silently not grant anything.
      const known = new Set((matrix.matrix ?? []).map((m) => m.key));
      if (desired.some((k) => !known.has(k))) return null;

      // Compute the change from the current effective set.
      const effective = matrix.effective ?? {};
      const current = new Set(effective[role] ?? []);
      const granted  = desired.filter((k) => !current.has(k));
      const revoked  = [...current].filter((k) => !desired.includes(k));
      if (!granted.length && !revoked.length) return null; // nothing changed

      const updated = { ...matrix, effective: { ...effective, [role]: desired } };
      docs.put("permissionMatrix", updated);

      return { success: true, data: { role, granted, revoked } };
    },
  },
];
