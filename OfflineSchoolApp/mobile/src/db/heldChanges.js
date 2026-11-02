// mobile/src/db/heldChanges.js
"use strict";

/**
 * Queued changes the signed-in account will not send — counted, never touched.
 *
 * On a phone more than one person signs in to, two kinds of unsent work sit in
 * the outbox that the pending screen did not mention, because every query it
 * ran was scoped to the signed-in account:
 *
 *   otherAccounts    rows queued by another account. Sent when that account
 *                    signs in on this phone again.
 *   ownerlessQueued  rows from before the outbox recorded an owner. No account
 *                    sends them (mutationQueue.service.js).
 *
 * READ ONLY. Nothing here sends, claims, discards or re-attributes anything;
 * what should happen to these rows is a decision written up in
 * docs/40-per-user-local-data.md.
 *
 * Dirty entity rows (_synced = 0) are deliberately NOT counted here: several
 * tables default _synced to 0 and some caches insert without setting it, so
 * "dirty" over-counts real unsent work by a wide margin. The backfill's own
 * filters are what decide which of them are changes; see the design doc.
 */

const signedInAccount = () => {
  try {
    const { getCurrentAuth } = require("../utils/authHelpers");
    const user = getCurrentAuth()?.user;
    const id = user?._id ?? user?.id ?? null;
    return id ? String(id) : null;
  } catch {
    return null;
  }
};

/**
 * @param {object} db   a database handle (getFirstAsync)
 * @param {{ ownerId?: string|null }} [options]  defaults to the signed-in account
 * @returns {Promise<{ otherAccounts:number, ownerlessQueued:number }>}
 */
export const countHeldChanges = async (db, { ownerId } = {}) => {
  if (!db) return { otherAccounts: 0, ownerlessQueued: 0 };
  const owner = ownerId === undefined ? signedInAccount() : ownerId;
  const n = async (sql, params = []) => {
    try { return Number((await db.getFirstAsync(sql, params))?.n ?? 0); } catch { return 0; }
  };

  // With nobody signed in, every owned row is "another account's".
  const otherAccounts = await n(
    `SELECT COUNT(*) AS n FROM mutation_outbox
     WHERE status != 'synced' AND owner_id IS NOT NULL AND owner_id != ?`,
    [owner ?? ""]
  );
  const ownerlessQueued = await n(
    `SELECT COUNT(*) AS n FROM mutation_outbox WHERE status != 'synced' AND owner_id IS NULL`
  );
  return { otherAccounts, ownerlessQueued };
};

export default { countHeldChanges };
