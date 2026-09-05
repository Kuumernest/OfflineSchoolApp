// src/services/syncPolicy.js
"use strict";

/**
 * When the next periodic sync runs, and how many attempts a request inside it
 * gets.
 *
 * Pulled out of SyncManager as plain arithmetic on purpose. These two numbers
 * are the ones that can lose or duplicate work rather than merely waste time,
 * and SyncManager cannot be exercised outside a device — it wants NetInfo,
 * SQLite and AppState before it will even construct. A policy that is only
 * ever run on a phone is a policy nobody has checked.
 *
 * ── The failure this exists to avoid ─────────────────────────────────────────
 *
 * The cursor death-spiral. A pull failed, so the cursor was not committed, so
 * the next pull asked for everything since 1970, so it was larger and slower
 * and failed too. Each retry was bigger than the one before. Committing the
 * cursor the moment the pull succeeds fixed the cause, but the shape of the
 * bug is worth remembering: on a link that is down, trying MORE OFTEN and
 * trying HARDER both make things worse, and they were the two dials set to
 * fixed values.
 *
 * ── Backoff only ─────────────────────────────────────────────────────────────
 *
 * The interval never goes below its base, however healthy the link looks.
 *
 * That asymmetry is deliberate. The periodic tick is a safety net; the reconnect
 * and foreground triggers are what make the app feel live, and they are
 * immediate and unaffected by anything here. So there is nothing to win by
 * ticking more often — only battery, data, and the risk of a cycle starting
 * before the last one finished. There is plenty to win by ticking less often
 * when the link is down.
 */

/** The healthy interval: the value SyncManager has always used. */
export const BASE_INTERVAL_MS = 300_000;

/** However bad it gets, check back at least this often. */
export const MAX_INTERVAL_MS = 30 * 60_000;

/** Doubling stops here, so the cap is reached rather than overflowed. */
const MAX_DOUBLINGS = 8;

/** Attempts for one request inside a sync. Never zero — see retryBudget. */
const ATTEMPTS_HEALTHY   = 3;
const ATTEMPTS_STRUGGLING = 2;
const ATTEMPTS_DOWN      = 1;

/** A link this much slower than nominal is struggling, not merely slow. */
const STRUGGLING_FACTOR = 3;

/** Consecutive failed syncs after which the link is treated as down. */
const DOWN_AFTER_FAILURES = 2;

/**
 * The longest budget any single request inside a sync asks for: the pull,
 * which carries the whole school on a first run. Everything else is smaller,
 * so this bounds a cycle.
 */
const LONGEST_REQUEST_BUDGET_MS = 60_000;

/** linkQuality will not scale any timeout past this. Kept in step by hand. */
const TIMEOUT_CEILING_MS = 180_000;

/** Headroom over the worst case, so a cycle finishes before the next is due. */
const OVERLAP_MARGIN = 1.2;

/**
 * The longest a single request can actually take at this link quality.
 *
 * Not the global ceiling: a healthy link's requests time out at their base
 * budget, and charging every link the worst case would push a good one's
 * interval out to eleven minutes for no reason.
 */
export const effectiveTimeoutMs = (linkFactor = 1) => {
  const f = Number(linkFactor) > 0 ? Number(linkFactor) : 1;
  return Math.min(TIMEOUT_CEILING_MS, LONGEST_REQUEST_BUDGET_MS * f);
};

/**
 * How long until the next periodic tick.
 *
 * Applies to the periodic tick ONLY. A forced sync — reconnect, foreground,
 * pull to refresh — does not consult this and must not: those are the moments
 * a person is waiting, and the whole point of backing off is that nobody is.
 *
 * @param consecutiveFailures syncs that have thrown in a row. Skipped syncs
 *        (offline, not signed in, lock held) are not failures and must not be
 *        counted here — the link said nothing, so nothing was learned.
 * @param linkFactor the timeout multiplier from linkQuality: 1 is nominal.
 */
export const nextInterval = ({
  base = BASE_INTERVAL_MS,
  consecutiveFailures = 0,
  linkFactor = 1,
} = {}) => {
  const safeBase = Number(base) > 0 ? Number(base) : BASE_INTERVAL_MS;
  const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));

  const backoff = failures === 0
    ? safeBase
    : Math.min(MAX_INTERVAL_MS, safeBase * 2 ** Math.min(failures, MAX_DOUBLINGS));

  // A tick must not land while the previous cycle is still working.
  //
  // The lock would reject the overlapping run, so nothing breaks — but a sync
  // that is permanently being skipped by its own predecessor is how the app
  // ends up looking alive while doing nothing, and it is the state the cursor
  // spiral lived in. A slow link therefore stretches the interval as well as
  // a failing one, because on a slow link a cycle simply takes longer.
  const attempts = retryBudget({ consecutiveFailures, linkFactor });
  const floor    = Math.ceil(
    worstCaseCycleMs({
      attempts,
      timeoutCeilingMs: effectiveTimeoutMs(linkFactor),
    }) * OVERLAP_MARGIN
  );

  return Math.min(MAX_INTERVAL_MS, Math.max(backoff, floor));
};

/**
 * How many attempts one request inside a sync should get.
 *
 * Retrying only helps a transient failure. If the last two syncs both threw,
 * the link is not flaky, it is down — and a second attempt inside this cycle
 * buys nothing while holding the sync lock for twice as long. The reconnect
 * trigger is the right mechanism for a link that comes back, and it fires the
 * instant it does.
 *
 * The healthy number is higher than the 2 this replaces, and that is safe now
 * rather than reckless: attempts used to cost a fixed 60s each, so three of
 * them could outlast the interval. A healthy link's timeouts are short (see
 * linkQuality), so three cheap attempts beat two expensive ones.
 *
 * @param linkFactor the timeout multiplier from linkQuality: 1 is nominal.
 */
export const retryBudget = ({
  consecutiveFailures = 0,
  linkFactor = 1,
} = {}) => {
  const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
  const factor   = Number(linkFactor) > 0 ? Number(linkFactor) : 1;

  if (failures >= DOWN_AFTER_FAILURES) return ATTEMPTS_DOWN;
  if (factor >= STRUGGLING_FACTOR)     return ATTEMPTS_STRUGGLING;
  return ATTEMPTS_HEALTHY;
};

/**
 * How long to wait before attempt N+1.
 *
 * Doubling, so a link that is briefly saturated is given room rather than
 * hammered at a fixed cadence. Capped well inside the interval: a retry chain
 * that outlives its own tick is how cycles start overlapping.
 */
export const retryDelay = ({ attempt = 1, base = 1_000 } = {}) => {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const b = Number(base) > 0 ? Number(base) : 1_000;
  return Math.min(30_000, b * 2 ** (n - 1));
};

/**
 * The longest one sync cycle can take before the next tick is due.
 *
 * Not used to decide anything — it exists so the checks can assert the two
 * dials cannot be set to values that overlap cycles, which is the condition
 * the sync lock then has to paper over.
 */
export const worstCaseCycleMs = ({ attempts, timeoutCeilingMs }) =>
  attempts * timeoutCeilingMs + retryDelay({ attempt: attempts });

export default {
  BASE_INTERVAL_MS, MAX_INTERVAL_MS,
  nextInterval, retryBudget, retryDelay, worstCaseCycleMs,
};
