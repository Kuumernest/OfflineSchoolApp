// mobile/src/services/syncState.js

/**
 * What a dirty local row is actually waiting for.
 *
 * `_synced = 0` says a row has not reached the server. It does not say why, and
 * the two reasons need different words in front of a teacher:
 *
 *   pending  — queued, and it will go by itself when there is a signal
 *   failed   — the server refused it, or the retries ran out; it needs a person
 *
 * Collapsing those into one "not uploaded" number is what makes an indicator
 * useless: a teacher who sees "3 marks not uploaded" every morning on a bad
 * line learns to ignore it, and the morning it means "the server rejected your
 * marks" looks exactly the same.
 *
 * There is a third state nobody designs for and every offline app grows:
 *
 *   orphaned — dirty, and nothing in the outbox is carrying it
 *
 * A row in that state is invisible to the queue. Nothing retries it, nothing
 * counts it, and it stays wrong for ever. One source of those has been fixed
 * (a refused save used to leave its local write behind), but "fixed the one we
 * found" is not the same as "cannot happen", so it is counted separately and
 * named rather than folded into either of the others.
 *
 * Kept pure — rows in, counts out — so the states above can be exercised
 * without a device. The database queries live in examCache.service.js.
 */

/** Outbox statuses that mean "this is still going to happen". */
const LIVE = new Set(["pending", "retrying"]);

/** Statuses that mean "this stopped, and a person has to look". */
const STUCK = new Set(["failed", "conflict"]);

/**
 * @param {object}   args
 * @param {string[]} args.dirtyIds    local ids with _synced = 0
 * @param {object[]} args.outboxRows  { status, payload } for the table in question,
 *                                    payload already parsed
 * @param {string}   args.table       the table these rows belong to
 * @returns {{pending: string[], failed: string[], orphaned: string[], total: number}}
 */
export function classifyDirtyRows({ dirtyIds = [], outboxRows = [], table }) {
  const pendingIds = new Set();
  const failedIds  = new Set();

  for (const row of outboxRows) {
    const meta = row?.payload?.__local;
    if (!meta || meta.table !== table || !Array.isArray(meta.ids)) continue;

    const status = String(row.status ?? "");
    const bucket = LIVE.has(status) ? pendingIds
                 : STUCK.has(status) ? failedIds
                 : null;
    if (!bucket) continue;               // 'synced' entries settle their own rows

    for (const id of meta.ids) bucket.add(String(id));
  }

  const pending  = [];
  const failed   = [];
  const orphaned = [];

  for (const raw of dirtyIds) {
    const id = String(raw);
    // Failed wins over pending: one entry may have been retried into a new one,
    // and a row that is both is a row somebody needs to look at.
    if (failedIds.has(id))       failed.push(id);
    else if (pendingIds.has(id)) pending.push(id);
    else                         orphaned.push(id);
  }

  return { pending, failed, orphaned, total: pending.length + failed.length + orphaned.length };
}

/**
 * The one line to put in front of a person.
 *
 * Returns a translation key and its count rather than a sentence, because the
 * app is bilingual and a school in Cameroon reads either.
 *
 * Orphaned rows are reported as failed. They are not waiting for anything, and
 * "waiting to upload" about a row nothing will ever upload is the lie this
 * whole module exists to stop telling.
 */
export function syncStateLabel({ pending = [], failed = [], orphaned = [] }) {
  const stuck = failed.length + orphaned.length;

  if (stuck > 0) {
    return { kind: "failed", count: stuck, key: "syncState.marksFailed" };
  }
  if (pending.length > 0) {
    return { kind: "pending", count: pending.length, key: "syncState.marksPending" };
  }
  return { kind: "synced", count: 0, key: "syncState.marksSynced" };
}

export default { classifyDirtyRows, syncStateLabel };
