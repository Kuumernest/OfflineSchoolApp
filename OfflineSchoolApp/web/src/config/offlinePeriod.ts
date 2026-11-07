// web/src/config/offlinePeriod.ts
//
// How long the desktop may go without syncing — the one place the numbers live.
//
// Owner decision: the supported offline period is 30 days. The server keeps a
// queued change's Idempotency-Key for 45 days (backend models/IdempotencyKey.js),
// so a change replayed within 30 days is never recorded twice.
//
//   from day 21  a gentle notice: connect soon
//   from day 30  a stronger warning: connect now
//
// Neither blocks anything. Counted from the desktop engine's lastSyncedAt — the
// last pull the server answered, for this server and school (engine.js). An
// unknown time shows nothing; InitialSyncBanner speaks for a machine that has
// never synced.
//
// The phone has the same rule in mobile/src/config/offlinePeriod.js.

export const OFFLINE_NOTICE_DAYS = 21;
export const OFFLINE_LIMIT_DAYS  = 30;

export const DAY_MS = 24 * 60 * 60 * 1000;

// Before this, a stored time is a placeholder (the 1970 epoch), not a sync.
const SANE_AFTER_MS = Date.UTC(2000, 0, 1);

export type OfflineAgeLevel = "none" | "notice" | "warning";

/** Whole days since `lastSyncedAt`, or null when there is no real sync time. */
export function daysSinceSync(lastSyncedAt: string | Date | null | undefined, now: number | Date = Date.now()): number | null {
  if (lastSyncedAt == null || lastSyncedAt === "") return null;
  const at = lastSyncedAt instanceof Date ? lastSyncedAt.getTime() : new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(at) || at < SANE_AFTER_MS) return null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  // A clock behind the server's makes the sync look like the future: not stale.
  if (at >= nowMs) return 0;
  return Math.floor((nowMs - at) / DAY_MS);
}

export function offlineAge(
  lastSyncedAt: string | Date | null | undefined,
  now: number | Date = Date.now(),
): { level: OfflineAgeLevel; days: number | null } {
  const days = daysSinceSync(lastSyncedAt, now);
  if (days == null) return { level: "none", days: null };
  if (days >= OFFLINE_LIMIT_DAYS)  return { level: "warning", days };
  if (days >= OFFLINE_NOTICE_DAYS) return { level: "notice", days };
  return { level: "none", days };
}
