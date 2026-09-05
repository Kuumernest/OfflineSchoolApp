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

  // Additive increase, once a run of COMFORTABLE requests has earned it. A
  // success that only just made it resets the run rather than advancing it.
  const ratio = durationMs / budgetMs;
  if (ratio > BATCH_COMFORT) {
    cleanRun = 0;
  } else if (++cleanRun >= BATCH_RECOVERY) {
    cleanRun = 0;
    batchScale = Math.min(BATCH_MAX_SCALE, batchScale + BATCH_INCREASE);
  }
};

/**
 * A request hit its timeout.
 *
 * Recorded as having used its whole budget, because that is all that is known:
 * it needed at least this long and possibly far more. Counting it is what lets
 * a link that has genuinely slowed pull the budgets up, rather than sitting at
 * a median formed only from the requests that happened to survive.
 */
export const recordTimeout = (): void => {
  push(1);

  // Multiplicative decrease, and the recovery run starts again.
  cleanRun = 0;
  batchScale = Math.max(BATCH_MIN_SCALE, batchScale * BATCH_DECREASE);
};

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


// ═════════════════════════════════════════════════════════════════════════
// HOW MUCH ONE REQUEST SHOULD CARRY
//
// A separate control law from the timeout above, deliberately.
//
// The multiplier is a ratio of time to budget, and batch size CHANGES that
// time — so driving the batch from the multiplier closes a loop on itself:
// smaller batches finish sooner, which lowers the ratio, which grows the
// batch, which raises the ratio. It oscillates, and the oscillation is
// visible to the user as a save that is fast, then times out, then is fast.
//
// So this uses additive-increase / multiplicative-decrease instead — the
// rule TCP uses for the same problem, and stable for the same reason. Halve
// on a timeout, because a timeout means the last size was too big and the
// only safe move is a large one. Creep back up after a run of clean
// successes, because the link recovering is a guess until proven.
// ═════════════════════════════════════════════════════════════════════════

/** Fractions of the caller's preferred size. */
const BATCH_MIN_SCALE = 0.2;
const BATCH_MAX_SCALE = 2;

/** Halve on failure; creep up in quarters. */
const BATCH_DECREASE  = 0.5;
const BATCH_INCREASE  = 0.25;

/** Clean requests needed before growing. Slow on purpose. */
const BATCH_RECOVERY  = 8;

/**
 * How much of its budget a request may use and still count as evidence that
 * there is room for a bigger one.
 *
 * "It succeeded" is not that evidence. A link where every request finishes at
 * 80% of its budget is one hiccup from failing, and growing the batch is the
 * hiccup — the extra rows are exactly what pushes the next one over. Only a
 * request with real headroom argues for more.
 */
const BATCH_COMFORT   = 0.5;

let batchScale = 1;
let cleanRun   = 0;

/**
 * How many items the next request of this kind should carry.
 *
 * @param base the size the caller would use on a healthy link
 */
export const batchSize = (base: number): number => {
  const n = Number(base);
  if (!(n > 0)) return base;
  // Never zero: a batch of nothing is an infinite loop in every caller that
  // walks a list in slices.
  return Math.max(1, Math.round(n * batchScale));
};

/** The current fraction. Exposed for diagnostics and the checks. */
export const currentBatchScale = (): number => batchScale;

/** Testing only. */
export const _resetBatch = (): void => { batchScale = 1; cleanRun = 0; };

/** Testing only. */
export const _reset = (): void => {
  ratios.length = 0; factor = 1; batchScale = 1; cleanRun = 0;
};
