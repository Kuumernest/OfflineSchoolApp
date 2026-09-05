// web/src/lib/linkQuality.ts
//
// How fast this link is, measured rather than assumed. The console's half of
// what mobile/src/services/linkQuality.js does for the phone.
//
// Deliberately a second copy rather than a shared module. shared/ is reachable
// from web and backend but not from mobile — Metro will not resolve outside the
// project root without a watchFolders change, and changing the bundler's config
// to deduplicate eighty lines of arithmetic is a poor trade. If a third surface
// ever needs this, that is the moment to move all three.
//
// ── Why a fixed timeout is wrong in both directions ─────────────────────────
//
// A school on fibre and a school on a village 3G tower run the same build, and
// so does one person on an office connection and the same person tethered to a
// phone. Too long a timeout and a dead link takes thirty or sixty seconds to
// admit it with somebody watching; too short and a request that would have
// succeeded is killed, its work discarded, and retried into the same wall.
//
// ── What is measured ────────────────────────────────────────────────────────
//
// Not duration — the ratio of duration to the budget the caller asked for.
//
// That normalisation is what lets one number serve every request. Publishing a
// cohort's results asks for 120s and is legitimately slower than a class list,
// and a median over raw durations would let it inflate the timeout of every
// small request behind it. Measured against its own budget, both answer the
// same question: how much of what we allowed did this need.

/** Requests kept in the rolling window. Small enough to follow a change. */
const WINDOW = 24;

/** Ignore the first few: one sample is noise, not a measurement. */
const MIN_SAMPLES = 5;

/** The fraction of its budget a healthy request should use. */
const TARGET_RATIO = 0.25;

/**
 * How far the multiplier may travel. The ceiling is not politeness — it is the
 * point past which waiting longer stops being a strategy. The floor stops a
 * burst of cached responses from cutting budgets so fine that the next real
 * request fails.
 */
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 6;

/** Absolute bounds, whatever the factor says. */
const MIN_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 180_000;

const ratios: number[] = [];
let factor = 1;

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const recompute = (): void => {
  if (ratios.length < MIN_SAMPLES) { factor = 1; return; }
  factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, median(ratios) / TARGET_RATIO));
};

const push = (ratio: number): void => {
  ratios.push(ratio);
  if (ratios.length > WINDOW) ratios.shift();
  recompute();
};

/**
 * A request came back.
 *
 * @param durationMs time on the wire
 * @param budgetMs   the timeout it was given
 */
export const recordSuccess = (durationMs: number, budgetMs: number): void => {
  if (!(durationMs > 0) || !(budgetMs > 0)) return;
  push(Math.min(1, durationMs / budgetMs));
};

/**
 * A request hit its timeout.
 *
 * Recorded as having used its whole budget, because that is all that is known:
 * it needed at least this long and possibly far more. Counting it is what lets
 * a link that has genuinely slowed pull the budgets up, rather than sitting at
 * a median formed only from the requests that happened to survive.
 */
export const recordTimeout = (): void => push(1);

/** Non-timeout failures say nothing about speed, so they are dropped. */
export const recordFailure = (): void => {};

/** The current multiplier. Exposed for diagnostics. */
export const currentFactor = (): number => factor;

/** How many samples are behind it. Below MIN_SAMPLES the factor is 1. */
export const sampleCount = (): number => ratios.length;

/**
 * Scale a caller's budget to this link.
 *
 * The caller's number is kept as the statement of intent it is — publishing a
 * cohort is allowed longer than fetching a list, and that relationship
 * survives — while its absolute size follows the connection.
 */
export const scaleTimeout = (baseMs: number | undefined): number | undefined => {
  const base = Number(baseMs);
  if (!(base > 0)) return baseMs;
  return Math.round(Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, base * factor)));
};

/** Testing only. */
export const _reset = (): void => { ratios.length = 0; factor = 1; };
