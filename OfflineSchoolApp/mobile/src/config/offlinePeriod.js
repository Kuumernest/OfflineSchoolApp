// src/config/offlinePeriod.js
"use strict";

/**
 * How long this device may go without syncing — the one place the numbers live.
 *
 * Owner decision: the supported offline period is 30 days. The server keeps
 * the Idempotency-Key of a queued change for 45 days (backend
 * models/IdempotencyKey.js), so a change replayed within 30 days is never
 * recorded twice; past that the margin is being used up.
 *
 *   from day 21  a gentle notice: connect soon
 *   from day 30  a stronger warning: connect now
 *
 * Neither blocks anything. The person keeps working; the strip just says it.
 *
 * Counted from the last SUCCESSFUL sync with the server (SyncManager's pull
 * cursor, which is the server's own time of that pull). An unknown time —
 * never synced, or the cursor reset to the epoch — shows nothing: the initial
 * sync screens speak for a device that has never synced.
 *
 * The desktop has the same rule in web/src/config/offlinePeriod.ts.
 */

export const OFFLINE_NOTICE_DAYS = 21;
export const OFFLINE_LIMIT_DAYS  = 30;

export const DAY_MS = 24 * 60 * 60 * 1000;

// Before this, a stored time is a placeholder (the 1970 epoch), not a sync.
const SANE_AFTER_MS = Date.UTC(2000, 0, 1);

/** Whole days since `lastSyncedAt`, or null when there is no real sync time. */
export const daysSinceSync = (lastSyncedAt, now = Date.now()) => {
  if (lastSyncedAt == null || lastSyncedAt === "") return null;
  const at = lastSyncedAt instanceof Date ? lastSyncedAt.getTime() : new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(at) || at < SANE_AFTER_MS) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  // A clock behind the server's makes the sync look like the future: not stale.
  if (at >= nowMs) return 0;
  return Math.floor((nowMs - at) / DAY_MS);
};

/**
 * @returns {{ level: "none" | "notice" | "warning", days: number | null }}
 */
export const offlineAge = (lastSyncedAt, now = Date.now()) => {
  const days = daysSinceSync(lastSyncedAt, now);
  if (days == null) return { level: "none", days: null };
  if (days >= OFFLINE_LIMIT_DAYS)  return { level: "warning", days };
  if (days >= OFFLINE_NOTICE_DAYS) return { level: "notice", days };
  return { level: "none", days };
};
