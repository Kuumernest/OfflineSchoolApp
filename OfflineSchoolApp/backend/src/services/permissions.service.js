// backend/src/services/permissions.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EFFECTIVE PERMISSIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What one account may actually do, once a school's own adjustments are
 * applied over the defaults in config/permissions.js.
 *
 *   effective = defaults(role) + granted − revoked
 *
 * with every term filtered so that nothing outside the registry, nothing
 * locked, and no role other than bursar or teacher can be touched. The filter
 * runs on read as well as on write, which is the point: a database edited by
 * hand, a restored backup from a build where a permission was still delegable,
 * or a bug in a future endpoint cannot grant the fee desk results.edit.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 *
 * A permission check has to know the school's overrides, and the naive version
 * of that is one extra database read on every guarded request. Two things keep
 * it off the hot path:
 *
 *   Only bursar and teacher can carry an override, so super_admin,
 *   school_admin and student are answered from the frozen defaults with no
 *   read at all. That covers the whole admin console.
 *
 *   What is left is cached per school for CACHE_TTL_MS, and the cache is
 *   dropped explicitly when the overrides are written. A permission change
 *   therefore takes effect on the next request rather than in a minute.
 *
 * The cache is per process. Several instances behind a load balancer each hold
 * their own, so a change made on one is visible immediately there and within
 * the TTL everywhere else. For a permission grant — an administrator doing
 * something deliberate and then telling somebody about it — that is a good
 * trade against a read per request. It would not be if these were revocations
 * used to shut out a compromised account; that case wants the TTL at zero, and
 * it is one constant below.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const {
  ROLES,
  normalizeRole,
} = require("../config/roles");

const {
  DEFAULTS_BY_ROLE,
  DELEGABLE_KEYS,
  ADJUSTABLE_ROLES,
  isPermission,
} = require("../config/permissions");

const School = require("../db/models/School");

/** How long a school's overrides are trusted without re-reading. */
const CACHE_TTL_MS = 60_000;

const DELEGABLE = new Set(DELEGABLE_KEYS);

/** schoolId → { at: epochMs, overrides } */
const cache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SANITISING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce whatever was stored (or submitted) to keys this codebase will honour.
 *
 * Unknown keys and locked keys are dropped silently here. Callers that need to
 * tell a user why — the PUT endpoint does — check first and report; this
 * function exists so that every OTHER path is safe by default.
 */
const cleanKeys = (list) =>
  Array.isArray(list)
    ? [...new Set(
        list
          .map((k) => String(k ?? "").trim())
          .filter((k) => isPermission(k) && DELEGABLE.has(k))
      )]
    : [];

/**
 * Normalise a stored overrides blob into { bursar: {granted, revoked}, ... }
 * covering exactly the adjustable roles and nothing else.
 */
const cleanOverrides = (raw) => {
  const out = {};
  for (const role of ADJUSTABLE_ROLES) {
    const entry = raw?.[role] ?? {};
    const granted = cleanKeys(entry.granted);
    const revoked = cleanKeys(entry.revoked);

    // A key in both lists is a contradiction rather than a choice. Revoked
    // wins: between two readings of an ambiguous instruction, take the one
    // that grants less.
    out[role] = {
      granted: granted.filter((k) => !revoked.includes(k)),
      revoked,
    };
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// READING
// ─────────────────────────────────────────────────────────────────────────────

/** Drop a school's cached overrides. Called after a write. */
const invalidate = (schoolId) => {
  if (schoolId) cache.delete(String(schoolId));
  else cache.clear();
};

/**
 * A school's overrides, cached.
 *
 * A school that cannot be found gets empty overrides rather than an error: the
 * caller is asking "may this person do X", and the answer for a missing school
 * is whatever the defaults say, not a 500.
 */
const overridesFor = async (schoolId) => {
  if (!schoolId) return cleanOverrides(null);

  const id  = String(schoolId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.overrides;

  let stored = null;
  try {
    const school = await School.findById(id).select("settings.permissions").lean();
    stored = school?.settings?.permissions ?? null;
  } catch (err) {
    // A database blip must not escalate into "everybody may do everything" or
    // "nobody may do anything mid-request". Falling back to the defaults is the
    // conservative reading: it is the state the school shipped with.
    console.warn(`[permissions] could not read overrides for ${id}: ${err.message}`);
  }

  const overrides = cleanOverrides(stored);
  cache.set(id, { at: Date.now(), overrides });
  return overrides;
};

/**
 * Every permission this role holds in this school.
 *
 * @param {string} role
 * @param {string} [schoolId]
 * @returns {Promise<string[]>} sorted, deduplicated
 */
const effectiveFor = async (role, schoolId) => {
  const canonical = normalizeRole(role);
  if (!canonical) return [];

  const defaults = DEFAULTS_BY_ROLE[canonical] ?? [];

  // Not an adjustable role: the frozen default set, no read.
  if (!ADJUSTABLE_ROLES.includes(canonical)) return [...defaults];

  const { granted, revoked } = (await overridesFor(schoolId))[canonical];
  if (!granted.length && !revoked.length) return [...defaults];

  const set = new Set(defaults);
  granted.forEach((k) => set.add(k));
  revoked.forEach((k) => set.delete(k));
  return [...set].sort();
};

/** Synchronous, defaults only. For callers with no school in hand. */
const defaultsFor = (role) => {
  const canonical = normalizeRole(role);
  return canonical ? [...(DEFAULTS_BY_ROLE[canonical] ?? [])] : [];
};

/**
 * May this user do this?
 *
 * @param {{role: string, schoolId?: string}} user
 * @param {string} key
 */
const can = async (user, key) => {
  if (!user || !isPermission(key)) return false;
  const role = normalizeRole(user.role);
  if (!role) return false;
  if (role === ROLES.SUPER_ADMIN) return true;
  return (await effectiveFor(role, user.schoolId)).includes(key);
};

// ─────────────────────────────────────────────────────────────────────────────
// WRITING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store one role's adjustments.
 *
 * Takes the DESIRED permission set rather than granted/revoked lists, because
 * that is what a screen of checkboxes produces and it removes a whole class of
 * ambiguity — a caller cannot send a key in both lists, or forget to remove it
 * from one when adding it to the other. The diff against the defaults is
 * computed here, which is also what keeps the stored form future-proof: a
 * capability added in a later release reaches this school through the defaults
 * rather than being frozen out by an old snapshot.
 *
 * @returns {Promise<{granted: string[], revoked: string[], effective: string[]}>}
 */
const setRolePermissions = async ({ schoolId, role, desired }) => {
  const canonical = normalizeRole(role);

  if (!canonical || !ADJUSTABLE_ROLES.includes(canonical)) {
    const err = new Error(
      `Permissions can only be adjusted for: ${ADJUSTABLE_ROLES.join(", ")}`
    );
    err.status = 400;
    err.code   = "ROLE_NOT_ADJUSTABLE";
    throw err;
  }

  if (!schoolId) {
    const err = new Error("schoolId is required");
    err.status = 400;
    err.code   = "BAD_REQUEST";
    throw err;
  }

  const asked = Array.isArray(desired) ? desired.map((k) => String(k ?? "").trim()) : [];

  // Reported rather than silently dropped: a screen that sends a key it cannot
  // change is a bug in the screen, and the administrator should be told the
  // request did not do what it looked like it did.
  const unknown = asked.filter((k) => !isPermission(k));
  if (unknown.length) {
    const err = new Error(`Not a permission: ${unknown.join(", ")}`);
    err.status = 400;
    err.code   = "UNKNOWN_PERMISSION";
    throw err;
  }

  const defaults = new Set(DEFAULTS_BY_ROLE[canonical] ?? []);
  const wanted   = new Set(asked.filter((k) => DELEGABLE.has(k)));

  // A locked permission the role already holds must stay held, and one it does
  // not hold must stay unheld — regardless of what arrived. Checked against
  // what was asked so a caller trying to change one gets a 403 rather than a
  // quiet no-op.
  const lockedViolation = asked
    .filter((k) => !DELEGABLE.has(k))
    .filter((k) => !defaults.has(k))
    .concat(
      [...defaults].filter((k) => !DELEGABLE.has(k) && !asked.includes(k))
    );

  if (lockedViolation.length) {
    const err = new Error(
      `These permissions cannot be granted or revoked: ${
        [...new Set(lockedViolation)].join(", ")
      }`
    );
    err.status = 403;
    err.code   = "PERMISSION_LOCKED";
    throw err;
  }

  const granted = [...wanted].filter((k) => !defaults.has(k)).sort();
  const revoked = [...defaults]
    .filter((k) => DELEGABLE.has(k) && !wanted.has(k))
    .sort();

  await School.updateOne(
    { _id: schoolId },
    {
      $set: {
        [`settings.permissions.${canonical}.granted`]: granted,
        [`settings.permissions.${canonical}.revoked`]: revoked,
      },
    }
  );

  invalidate(schoolId);

  return { granted, revoked, effective: await effectiveFor(canonical, schoolId) };
};

module.exports = {
  CACHE_TTL_MS,
  can,
  effectiveFor,
  defaultsFor,
  overridesFor,
  setRolePermissions,
  invalidate,
  // Exported for the check script, which exercises the filtering without a
  // database in front of it.
  cleanOverrides,
  cleanKeys,
};
